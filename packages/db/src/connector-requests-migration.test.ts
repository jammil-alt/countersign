// Connectors C3 (migration 0069, docs/plan.md §1.157) as the Worker's role sees it. A change request
// is its client's own: forced RLS, and one client's session never reads or writes another's. One
// open request per connection; what was asked never changes, only its status and answer; nothing is
// deleted. A connection's Changes by Mezonas and a custom connector's clients hold only their shapes.

import {
  MEZONAS_MAY_CHOICES as CORE_MEZONAS_MAY_CHOICES,
  CONNECTION_CHANGE_REQUEST_STATUSES as CORE_REQUEST_STATUSES,
  DEFAULT_PERMISSIONS,
  MezonasMay,
} from "@countersign/core";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withOperator, withTenant } from "./client";
import { type ClientFixture, insertClient } from "./fixtures.test-helper";
import {
  CONNECTION_CHANGE_REQUEST_STATUSES,
  connection,
  connectionChange,
  connectionChangeRequest,
  connectorSetting,
  MEZONAS_MAY_CHOICES,
} from "./schema";
import { asWorker, createTestDatabase, databaseAvailable, type TestDatabase } from "./testing";

const online = await databaseAvailable();

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.code ?? e.cause?.code ?? "unknown";
  }
  return undefined;
}

const DAY = 24 * 60 * 60 * 1000;
const against = {
  permissions: { ...DEFAULT_PERMISSIONS, create: "off" as const, update: "off" as const },
  config: {},
};
const proposed = { permissions: DEFAULT_PERMISSIONS, config: {} };

describe("the stored values match core's", () => {
  it("statuses and choices", () => {
    expect(CONNECTION_CHANGE_REQUEST_STATUSES).toEqual(CORE_REQUEST_STATUSES);
    expect(MEZONAS_MAY_CHOICES).toEqual(CORE_MEZONAS_MAY_CHOICES);
  });
});

describe.skipIf(!online)(
  "connection change requests, Changes by Mezonas and custom connectors",
  () => {
    let t: TestDatabase;
    let A: ClientFixture;
    let B: ClientFixture;

    const request = (
      c: ClientFixture,
      over: Partial<typeof connectionChangeRequest.$inferInsert> = {},
    ) => ({
      tenantId: c.tenantId,
      connectionId: c.connectionId,
      against,
      proposed,
      reason: "The Buyer adds purchase orders.",
      requestedBy: c.userId,
      expiresAt: new Date(Date.now() + 14 * DAY),
      ...over,
    });

    beforeAll(async () => {
      const created = await createTestDatabase();
      if (!created) throw new Error("database vanished");
      t = created;
      A = await insertClient(t.db, "A");
      B = await insertClient(t.db, "B");
    });
    afterAll(async () => {
      await t?.drop();
    });

    const count = async (tx: Parameters<Parameters<typeof withTenant>[2]>[0], table: string) =>
      Number(
        [
          ...(await tx.execute<{ n: number }>(sql.raw(`select count(*)::int as n from ${table}`))),
        ][0]?.n ?? 0,
      );
    const can = async (table: string, privilege: string) =>
      (
        await t.db.$client<{ ok: boolean }[]>`
        select has_table_privilege('cs_runtime', ${table}, ${privilege}) as ok`
      )[0]?.ok;

    it("force row-level security on requests, with one policy", async () => {
      const [row] = await t.db.$client<{ rls: boolean; forced: boolean; policies: number }[]>`
      select c.relrowsecurity as rls, c.relforcerowsecurity as forced,
        (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
      from pg_class c join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
      where c.relname = 'connection_change_request'`;
      expect(row).toEqual({ rls: true, forced: true, policies: 1 });
      expect(await can("connection_change_request", "SELECT")).toBe(true);
      expect(await can("connection_change_request", "INSERT")).toBe(true);
      expect(await can("connection_change_request", "UPDATE")).toBe(true);
      expect(await can("connection_change_request", "DELETE")).toBe(false);
    });

    it("show a client its own requests only, and let it write none for another", async () => {
      // The fixture gives each client one open request.
      await withTenant(t.db, A.tenantId, async (tx) => {
        await asWorker(tx);
        expect(await count(tx, "connection_change_request")).toBe(1);
      });
      await withOperator(t.db, [B.tenantId], async (tx) => {
        await asWorker(tx);
        expect(await count(tx, "connection_change_request")).toBe(1);
      });
      expect(
        await errorCode(
          withTenant(t.db, A.tenantId, async (tx) => {
            await asWorker(tx);
            await tx
              .insert(connectionChangeRequest)
              .values(request(B, { status: "expired", closedAt: new Date() }));
          }),
        ),
      ).toBe("42501");
    });

    it("keep one open request per connection; a closed one leaves room for the next", async () => {
      expect(await errorCode(t.db.insert(connectionChangeRequest).values(request(A)))).toBe(
        "23505",
      );
      await t.db
        .update(connectionChangeRequest)
        .set({ status: "replaced", closedAt: new Date() })
        .where(eq(connectionChangeRequest.tenantId, A.tenantId));
      expect(
        await errorCode(t.db.insert(connectionChangeRequest).values(request(A))),
      ).toBeUndefined();
    });

    it("hold a request's status, answer and reason to their shapes", async () => {
      const closed = { status: "approved" as const, closedAt: new Date() };
      // Approved, declined and withdrawn name who ended them; only an answer carries a note.
      expect(await errorCode(t.db.insert(connectionChangeRequest).values(request(B, closed)))).toBe(
        "23514",
      );
      expect(
        await errorCode(
          t.db
            .insert(connectionChangeRequest)
            .values(request(B, { status: "expired", closedAt: new Date(), answerNote: "no" })),
        ),
      ).toBe("23514");
      // Open means not closed.
      expect(
        await errorCode(
          t.db.insert(connectionChangeRequest).values(request(B, { closedAt: new Date() })),
        ),
      ).toBe("23514");
      expect(
        await errorCode(t.db.insert(connectionChangeRequest).values(request(B, { reason: "" }))),
      ).toBe("23514");
      expect(
        await errorCode(
          t.db.insert(connectionChangeRequest).values(request(B, { expiresAt: new Date(0) })),
        ),
      ).toBe("23514");
      expect(
        await errorCode(
          t.db.insert(connectionChangeRequest).values(request(B, { status: "unknown" as "open" })),
        ),
      ).toBe("23514");
      // An agent of another client is not one it can be for.
      expect(
        await errorCode(
          t.db
            .insert(connectionChangeRequest)
            .values(request(B, { forAgentId: A.agentId, status: "expired", closedAt: new Date() })),
        ),
      ).toBe("23503");
    });

    it("change only a request's status and answer; delete nothing", async () => {
      const [open] = await t.db
        .select({ id: connectionChangeRequest.id })
        .from(connectionChangeRequest)
        .where(eq(connectionChangeRequest.status, "open"))
        .limit(1);
      const id = open?.id ?? "";
      expect(
        await errorCode(
          t.db
            .update(connectionChangeRequest)
            .set({ reason: "Something else." })
            .where(eq(connectionChangeRequest.id, id)),
        ),
      ).toBeDefined();
      expect(
        await errorCode(
          t.db
            .update(connectionChangeRequest)
            .set({ proposed: against })
            .where(eq(connectionChangeRequest.id, id)),
        ),
      ).toBeDefined();
      expect(
        await errorCode(
          t.db
            .update(connectionChangeRequest)
            .set({
              status: "declined",
              closedAt: new Date(),
              closedBy: A.userId,
              answerNote: "Not yet.",
            })
            .where(eq(connectionChangeRequest.id, id)),
        ),
      ).toBeUndefined();
      expect(
        await errorCode(
          t.db.delete(connectionChangeRequest).where(eq(connectionChangeRequest.id, id)),
        ),
      ).toBeDefined();
    });

    it("let a connection change name the request it applied, of its own client only", async () => {
      const [a] = await t.db
        .select({ id: connectionChangeRequest.id })
        .from(connectionChangeRequest)
        .where(eq(connectionChangeRequest.tenantId, A.tenantId))
        .limit(1);
      const values = {
        tenantId: A.tenantId,
        connectionId: A.connectionId,
        actorId: A.userId,
        change: { permissions: DEFAULT_PERMISSIONS },
      };
      expect(
        await errorCode(
          t.db.insert(connectionChange).values({ ...values, requestId: a?.id ?? "" }),
        ),
      ).toBeUndefined();
      const [b] = await t.db
        .select({ id: connectionChangeRequest.id })
        .from(connectionChangeRequest)
        .where(eq(connectionChangeRequest.tenantId, B.tenantId))
        .limit(1);
      expect(
        await errorCode(
          t.db.insert(connectionChange).values({ ...values, requestId: b?.id ?? "" }),
        ),
      ).toBe("23503");
    });

    it("store Changes by Mezonas only as its shape; null is Ask me each time", async () => {
      const may = MezonasMay.parse({
        choice: "needs",
        until: new Date(Date.now() + 30 * DAY).toISOString(),
        setBy: A.userId,
        setAt: new Date().toISOString(),
      });
      await withTenant(t.db, A.tenantId, async (tx) => {
        await asWorker(tx);
        await tx
          .update(connection)
          .set({ mezonasMay: may })
          .where(eq(connection.id, A.connectionId));
      });
      const [row] = await t.db
        .select({ may: connection.mezonasMay })
        .from(connection)
        .where(eq(connection.id, A.connectionId));
      expect(row?.may).toEqual(may);
      const [other] = await t.db
        .select({ may: connection.mezonasMay })
        .from(connection)
        .where(eq(connection.id, B.connectionId));
      expect(other?.may).toBeNull();
      for (const bad of [{ ...may, choice: "everything" }, { choice: "any" }, ["any"]]) {
        expect(
          await errorCode(
            t.db
              .update(connection)
              .set({ mezonasMay: bad as typeof may })
              .where(eq(connection.id, A.connectionId)),
          ),
          JSON.stringify(bad),
        ).toBe("23514");
      }
    });

    it("limit a custom connector to its clients, in the operator's catalogue only", async () => {
      await withOperator(t.db, [A.tenantId], async (tx) => {
        await asWorker(tx);
        await tx
          .insert(connectorSetting)
          .values({ connector: "hartley_erp", status: "live", clients: [A.tenantId] });
      });
      const [row] = await t.db
        .select({ clients: connectorSetting.clients })
        .from(connectorSetting)
        .where(eq(connectorSetting.connector, "hartley_erp"));
      expect(row?.clients).toEqual([A.tenantId]);
      // An empty list would hide it from everyone: null is everyone.
      expect(
        await errorCode(
          t.db
            .insert(connectorSetting)
            .values({ connector: "nobody", status: "live", clients: [] }),
        ),
      ).toBe("23514");
      await withTenant(t.db, A.tenantId, async (tx) => {
        await asWorker(tx);
        expect(await count(tx, "connector_setting")).toBe(0);
      });
    });
  },
);
