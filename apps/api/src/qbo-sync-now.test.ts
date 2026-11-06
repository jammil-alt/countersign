// v0.12 W1-H: "sync now" is never lost (ARCHITECTURE §6.2, docs/plan.md §1.43). One sync of a
// connection at a time: an ask while one runs is queued in `sync_cursor.pending` and the running
// sync starts it when it ends; a page keeps the claim; a dead sync's claim lapses; a start that
// fails lets go.
import { connection, withTenant } from "@countersign/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { type ApiHarness, createApiHarness } from "./api.test-helper";
import { MemoryQboSyncInstances, type QboSyncParams } from "./qbo/instances";
import { cursorKeepingClaim } from "./qbo/sync-cursor";
import {
  beginQboSync,
  claimQboSync,
  endQboSync,
  requestQboSync,
  SYNC_LEASE_MS,
} from "./qbo/sync-now";

const h = await createApiHarness();
afterAll(() => h?.close());

describe.skipIf(!h)("sync now", () => {
  const H = h as ApiHarness;
  let params: QboSyncParams;
  let syncs: MemoryQboSyncInstances;
  const cursor = async () => {
    const [row] = await H.t.db
      .select({ c: connection.syncCursor })
      .from(connection)
      .where(eq(connection.id, params.connectionId));
    return (row?.c ?? {}) as Record<string, unknown>;
  };

  beforeEach(async () => {
    const [row] = await H.t.db
      .insert(connection)
      .values({
        tenantId: H.A.tenantId,
        connector: "qbo",
        status: "connected",
        syncCursor: { v: 1, phase: "cdc", changedSince: "2026-11-01T00:00:00.000Z" },
      })
      .returning();
    params = { tenantId: H.A.tenantId, connectionId: row?.id as string, reason: "connected" };
    syncs = new MemoryQboSyncInstances();
  });

  it("starts one when none runs, queues one while it runs, and the ending sync starts it", async () => {
    const first = await requestQboSync(H.db, syncs, params);
    expect(first).toMatchObject({ started: true, queued: false });
    expect(first.instanceId).toMatch(new RegExp(`^qbo-${params.connectionId}-now-`));
    // Within the same minute: queued, not merged into the first one's slot.
    const now = await requestQboSync(H.db, syncs, { ...params, reason: "operator" });
    expect(now).toEqual({ started: false, queued: true, instanceId: first.instanceId });
    // More asks while it runs add nothing: one pending sync reads everything.
    await requestQboSync(H.db, syncs, { ...params, reason: "webhook" });
    expect(syncs.started.size).toBe(1);
    expect(await cursor()).toMatchObject({
      phase: "cdc",
      running: { instanceId: first.instanceId },
      pending: { reason: "operator" },
    });

    // The first sync takes the connection, stores a page (the claim stays), and ends.
    expect(await beginQboSync(H.db, params, first.instanceId as string)).toBe(true);
    await withTenant(H.db, params.tenantId, (tx) =>
      tx
        .update(connection)
        .set({
          syncCursor: cursorKeepingClaim(
            { v: 1, phase: "cdc", changedSince: "2026-11-06T00:00:00.000Z" },
            new Date(),
          ),
        })
        .where(eq(connection.id, params.connectionId)),
    );
    expect(await cursor()).toMatchObject({
      changedSince: "2026-11-06T00:00:00.000Z",
      running: { instanceId: first.instanceId },
      pending: { reason: "operator" },
    });
    const next = await endQboSync(H.db, params, first.instanceId as string);
    expect(next?.params.reason).toBe("operator");
    expect(next?.instanceId).not.toBe(first.instanceId);
    // Its last step, retried, hands over to the same instance.
    expect(await endQboSync(H.db, params, first.instanceId as string)).toEqual(next);
    expect(await cursor()).toMatchObject({ running: { instanceId: next?.instanceId } });
    expect((await cursor()).pending).toBeUndefined();

    // The follow-on ends with nothing asked: the connection is free, and the next ask starts.
    expect(await endQboSync(H.db, params, next?.instanceId as string)).toBeNull();
    expect((await cursor()).running).toBeUndefined();
    expect(await requestQboSync(H.db, syncs, params)).toMatchObject({ started: true });
  });

  it("never claims twice when two asks race", async () => {
    const asks = await Promise.all(
      [1, 2, 3].map(() =>
        withTenant(H.db, params.tenantId, (tx) =>
          claimQboSync(tx, { ...params, reason: "operator" }),
        ),
      ),
    );
    expect(asks.filter((a) => a.kind === "start")).toHaveLength(1);
    expect(asks.filter((a) => a.kind === "queued")).toHaveLength(2);
  });

  it("an instance that finds another sync holding the connection queues itself and reads nothing", async () => {
    const first = await requestQboSync(H.db, syncs, params);
    expect(await beginQboSync(H.db, params, "qbo-stray-instance")).toBe(false);
    expect(await cursor()).toMatchObject({
      running: { instanceId: first.instanceId },
      pending: { reason: "connected" },
    });
  });

  it("takes over from a sync that died, and lets go when a start fails", async () => {
    const first = await requestQboSync(H.db, syncs, params);
    const late = new Date(Date.now() + SYNC_LEASE_MS + 60_000);
    const after = await requestQboSync(H.db, syncs, { ...params, reason: "operator" }, late);
    expect(after.started).toBe(true);
    expect(after.instanceId).not.toBe(first.instanceId);
    // The dead one, if it ever ends, hands nothing on and frees nothing.
    expect(await endQboSync(H.db, params, first.instanceId as string)).toBeNull();
    expect(await cursor()).toMatchObject({ running: { instanceId: after.instanceId } });

    await H.t.db.execute(
      sql`update connection set sync_cursor = sync_cursor - 'running' where id = ${params.connectionId}`,
    );
    const down = {
      start: async () => {
        throw new Error("the Workflows engine is unreachable");
      },
    };
    await expect(requestQboSync(H.db, down, params)).rejects.toThrow("unreachable");
    expect((await cursor()).running).toBeUndefined();
    expect(await requestQboSync(H.db, syncs, params)).toMatchObject({ started: true });
  });

  it("lets a cron or webhook slot already used go, as before", async () => {
    const at = new Date();
    const cron = { ...params, reason: "cron" as const };
    const one = await requestQboSync(H.db, syncs, cron, at);
    expect(one.started).toBe(true);
    await endQboSync(H.db, cron, one.instanceId as string);
    // The same tick again: the engine has the slot's id; nothing new, and nothing held.
    const two = await requestQboSync(H.db, syncs, cron, at);
    expect(two).toMatchObject({ started: false, queued: false });
    expect((await cursor()).running).toBeUndefined();
  });
});
