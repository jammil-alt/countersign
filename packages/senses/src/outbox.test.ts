// The outbox against a throwaway Postgres, acting as the Worker's role (cs_worker), so RLS holds.

import { event, type Tx, tenant, withTenant, withTenants } from "@countersign/db";
import {
  asWorker,
  createTestDatabase,
  databaseAvailable,
  type TestDatabase,
} from "@countersign/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emit, markDispatched, undispatched } from "./outbox";
import { EventPayloadError, EventTypeRegistry, UnknownEventTypeError } from "./registry";

const online = await databaseAvailable();

const DOC = "0192f7a0-0000-7000-8000-0000000000d1";
const EXTRACTION = "0192f7a0-0000-7000-8000-0000000000e1";

describe.skipIf(!online)("senses outbox", () => {
  let t: TestDatabase;
  let A: string;
  let B: string;

  const asClient = <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) =>
    withTenant(t.db, tenantId, async (tx) => {
      await asWorker(tx);
      return fn(tx);
    });

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    const rows = await t.db
      .insert(tenant)
      .values([{ name: "A" }, { name: "B" }])
      .returning();
    A = rows[0]?.id as string;
    B = rows[1]?.id as string;
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("emits inside the caller's transaction, typed and validated", async () => {
    const row = await asClient(A, (tx) =>
      emit(tx, {
        tenantId: A,
        type: "document.extracted",
        subjectId: DOC,
        payload: { documentId: DOC, extractionId: EXTRACTION, lineCount: 3, totalsValid: true },
      }),
    );
    expect(row).toMatchObject({
      tenantId: A,
      type: "document.extracted",
      subjectType: "document",
      subjectId: DOC,
      dispatchedAt: null,
    });
    expect(row?.payload).toEqual({
      documentId: DOC,
      extractionId: EXTRACTION,
      lineCount: 3,
      totalsValid: true,
    });
  });

  it("rolls back with the change it reports", async () => {
    const before = await t.db.$count(event);
    await expect(
      asClient(A, async (tx) => {
        await emit(tx, {
          tenantId: A,
          type: "document.extraction_failed",
          payload: { documentId: DOC, error: "x" },
        });
        throw new Error("the change failed");
      }),
    ).rejects.toThrow("the change failed");
    expect(await t.db.$count(event)).toBe(before);
  });

  it("refuses unknown types, bad payloads and another client's id", async () => {
    await expect(
      asClient(A, (tx) => emit(tx, { tenantId: A, type: "nope.never", payload: {} })),
    ).rejects.toThrow(UnknownEventTypeError);
    await expect(
      asClient(A, (tx) =>
        emit(tx, {
          tenantId: A,
          type: "document.extraction_failed",
          payload: { documentId: "not-a-uuid", error: "x" },
        }),
      ),
    ).rejects.toThrow(EventPayloadError);
    // RLS: a session for A can't write B's events.
    await expect(
      asClient(A, (tx) =>
        emit(tx, {
          tenantId: B,
          type: "document.extraction_failed",
          payload: { documentId: DOC, error: "x" },
        }),
      ),
    ).rejects.toThrow();
  });

  it("emits pack types through the registry it is given, and nothing in a test run", async () => {
    const registry = new EventTypeRegistry().registerPack("testpack", [
      {
        type: "testpack.thing.happened",
        description: "x",
        payload: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] },
        sample: { n: 1 },
      },
    ]);
    const row = await asClient(B, (tx) =>
      emit(tx, { tenantId: B, type: "testpack.thing.happened", payload: { n: 2 } }, { registry }),
    );
    expect(row?.type).toBe("testpack.thing.happened");
    const before = await t.db.$count(event);
    const none = await asClient(B, (tx) =>
      emit(
        tx,
        { tenantId: B, type: "testpack.thing.happened", payload: { n: 3 } },
        { registry, testRun: true },
      ),
    );
    expect(none).toBeNull();
    expect(await t.db.$count(event)).toBe(before);
  });

  it("sweeps only old, undispatched events of the scoped clients, and stamps them once", async () => {
    const old = new Date(Date.now() - 120_000);
    const [oldA] = await t.db
      .insert(event)
      .values({ tenantId: A, type: "schedule.tick", payload: {}, createdAt: old })
      .returning();
    const [oldB] = await t.db
      .insert(event)
      .values({ tenantId: B, type: "schedule.tick", payload: {}, createdAt: old })
      .returning();
    const fresh = await asClient(A, (tx) =>
      emit(tx, {
        tenantId: A,
        type: "schedule.tick",
        payload: { scheduledAt: new Date().toISOString() },
      }),
    );
    if (!oldA || !oldB || !fresh) throw new Error("setup");

    const forA = await asClient(A, (tx) => undispatched(tx, { olderThanSeconds: 30 }));
    expect(forA.map((e) => e.id)).toContain(oldA.id);
    expect(forA.map((e) => e.id)).not.toContain(fresh.id);
    expect(forA.every((e) => e.tenantId === A)).toBe(true);

    const all = await withTenants(t.db, [A, B], async (tx) => {
      await asWorker(tx);
      return undispatched(tx, { olderThanSeconds: 30 });
    });
    expect(all.map((e) => e.id)).toEqual(expect.arrayContaining([oldA.id, oldB.id]));
    // Oldest first.
    const times = all.map((e) => e.createdAt.getTime());
    expect([...times].sort((x, y) => x - y)).toEqual(times);

    // A's session can't stamp B's event.
    const stamped = await asClient(A, (tx) => markDispatched(tx, [oldA.id, oldB.id]));
    expect(stamped).toEqual([oldA.id]);
    const again = await asClient(A, (tx) => markDispatched(tx, [oldA.id]));
    expect(again).toEqual([]);

    const left = await withTenants(t.db, [A, B], async (tx) => {
      await asWorker(tx);
      return undispatched(tx, { olderThanSeconds: 30 });
    });
    expect(left.map((e) => e.id)).not.toContain(oldA.id);
    expect(left.map((e) => e.id)).toContain(oldB.id);

    // With no age limit the fresh event shows up too.
    const now = await asClient(A, (tx) => undispatched(tx, { olderThanSeconds: 0 }));
    expect(now.map((e) => e.id)).toContain(fresh.id);
  });

  it("refuses ids that aren't uuids", async () => {
    await expect(asClient(A, (tx) => markDispatched(tx, ["1' or '1'='1"]))).rejects.toThrow(
      /not an event id/,
    );
    expect(await asClient(A, (tx) => markDispatched(tx, []))).toEqual([]);
  });
});
