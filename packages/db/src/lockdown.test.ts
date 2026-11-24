// Lockdown, stream K1 (docs/plan.md §1.243, docs/lockdown-plan.md §3): every scope goes through
// `app_scope_tenant_ids`. A locked client's own scope is refused and nothing in it runs; scopes over
// several clients leave it out; an investigation keeps it, read only. And the lock and unlock
// functions, as cs_worker.

import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  admitTenant,
  ClientLockedError,
  isClientLocked,
  narrowToTenant,
  ScopeError,
  type Tx,
  withInvestigation,
  withOperator,
  withSession,
  withTenant,
  withTenants,
  withUser,
} from "./client";
import { type ClientFixture, insertClient } from "./fixtures.test-helper";
import {
  countLockedInbound,
  LockError,
  lockClient,
  lockEverything,
  lockState,
  unlockClient,
  unlockEverything,
} from "./lockdown";
import { tenant, tenantChange } from "./schema";
import { asWorker, createTestDatabase, databaseAvailable, type TestDatabase } from "./testing";

const online = await databaseAvailable();

describe.skipIf(!online)("lockdown, as cs_worker", () => {
  let t: TestDatabase;
  let A: ClientFixture;
  let B: ClientFixture;

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    A = await insertClient(t.db, "A");
    B = await insertClient(t.db, "B");
  });
  afterEach(async () => {
    await t.db.$client`update tenant set locked_at = null, lock = null`;
    await t.db.$client`delete from platform_lock`;
  });
  afterAll(async () => {
    await t?.drop();
  });

  /** The clients whose connections this transaction can see. */
  const seen = async (tx: Tx) => {
    const rows = await tx.execute<{ id: string }>(
      sql`select distinct tenant_id::text as id from connection order by 1`,
    );
    return [...rows].map((r) => r.id).sort();
  };
  /** As cs_worker: the clients whose connections this transaction can see. */
  const look = async (tx: Tx) => {
    await asWorker(tx);
    return seen(tx);
  };
  const both = () => [A.tenantId, B.tenantId].sort();

  /** Locks a client as an operator who serves it would, and commits. */
  const lock = (c: ClientFixture, side: "operator" | "client" = "operator") =>
    withOperator(t.db, [c.tenantId], async (tx) => {
      await asWorker(tx);
      return lockClient(tx, {
        tenantId: c.tenantId,
        side,
        by: c.userId,
        reason: "Looking into it",
      });
    });
  const lockAll = () =>
    withOperator(t.db, [], async (tx) => {
      await asWorker(tx);
      return lockEverything(tx, { by: A.userId, reason: "Leaked key" });
    });

  describe("the scopes", () => {
    it("refuses a locked client's own scope, and runs nothing in it", async () => {
      await lock(A);
      let ran = false;
      const attempt = withTenant(t.db, A.tenantId, async (tx) => {
        await asWorker(tx);
        await tx.update(tenant).set({ name: "Changed" }).where(eq(tenant.id, B.tenantId));
        ran = true;
      });
      await expect(attempt).rejects.toBeInstanceOf(ClientLockedError);
      await expect(attempt).rejects.toMatchObject({ tenantIds: [A.tenantId] });
      expect(ran).toBe(false);
      const [b] = await t.db
        .select({ name: tenant.name })
        .from(tenant)
        .where(eq(tenant.id, B.tenantId));
      expect(b?.name).toBe("B");
      // Another client is untouched.
      expect(await withTenant(t.db, B.tenantId, look)).toEqual([B.tenantId]);
    });

    it("sees a lock at once: no cache between transactions", async () => {
      expect(await withTenant(t.db, A.tenantId, look)).toEqual([A.tenantId]);
      await lock(A);
      await expect(withTenant(t.db, A.tenantId, async () => 1)).rejects.toBeInstanceOf(
        ClientLockedError,
      );
    });

    it("leaves a locked client out of the back office and of sweeps, and says which", async () => {
      await lock(A);
      for (const open of [withOperator, withTenants]) {
        const out = await open(t.db, [A.tenantId, B.tenantId], async (tx) => {
          await asWorker(tx);
          const rows = await tx.execute<{ locked: string }>(
            sql`select current_setting('app.locked_tenant_ids', true) as locked`,
          );
          return { seen: await seen(tx), locked: [...rows][0]?.locked };
        });
        expect(out).toEqual({ seen: [B.tenantId], locked: `{${A.tenantId}}` });
      }
    });

    it("narrows to an unlocked client, and calls a locked one locked, not foreign", async () => {
      await lock(A);
      await withOperator(t.db, [A.tenantId, B.tenantId], async (tx) => {
        await asWorker(tx);
        expect(await narrowToTenant(tx, B.tenantId, seen)).toEqual([B.tenantId]);
        await expect(narrowToTenant(tx, A.tenantId, seen)).rejects.toBeInstanceOf(
          ClientLockedError,
        );
      });
      const outside = "00000000-0000-4000-8000-0000000000ff";
      await withOperator(t.db, [B.tenantId], async (tx) => {
        await expect(narrowToTenant(tx, outside, seen)).rejects.toBeInstanceOf(ScopeError);
      });
    });

    it("locks every client while everything is locked, and still lets people sign in", async () => {
      await lockAll();
      await expect(withTenant(t.db, B.tenantId, async () => 1)).rejects.toBeInstanceOf(
        ClientLockedError,
      );
      expect(await withOperator(t.db, [A.tenantId, B.tenantId], look)).toEqual([]);
      // Sign-in reads only the user's own memberships, which name no client's data.
      const memberships = await withUser(t.db, A.userId, async (tx) => {
        await asWorker(tx);
        const rows = await tx.execute<{ n: number }>(
          sql`select count(*)::int as n from membership`,
        );
        return [...rows][0]?.n;
      });
      expect(memberships).toBe(1);
      await withOperator(t.db, [], async (tx) => {
        await asWorker(tx);
        expect(await unlockEverything(tx)).toEqual({ changed: true });
      });
      expect(await withOperator(t.db, [A.tenantId, B.tenantId], look)).toEqual(both());
    });

    it("lets an investigation read a locked client, and never write", async () => {
      await lock(A);
      await lockAll();
      expect(await withInvestigation(t.db, [A.tenantId], look)).toEqual([A.tenantId]);
      const write = withInvestigation(t.db, [A.tenantId], async (tx) => {
        await asWorker(tx);
        await tx.insert(tenantChange).values({ tenantId: A.tenantId, change: {}, reason: "x" });
      });
      await expect(write).rejects.toMatchObject({ cause: { code: "25006" } });
    });
  });

  describe("session requests", () => {
    const session = (
      c: ClientFixture,
      scope: { tenantIds: string[]; operator: boolean; investigate?: boolean },
    ) =>
      withSession(
        t.db,
        c.userId,
        async () => ({ ok: true as const, scope, value: null }),
        async (tx) => {
          await asWorker(tx);
          const rows = await tx.execute<{ ro: string }>(
            sql`select current_setting('transaction_read_only') as ro`,
          );
          return { seen: await seen(tx), readOnly: [...rows][0]?.ro === "on" };
        },
      );

    it("refuses a locked client's session, leaves it out of the back office's, investigates read only", async () => {
      await lock(A);
      await expect(session(A, { tenantIds: [A.tenantId], operator: false })).rejects.toBeInstanceOf(
        ClientLockedError,
      );
      expect(await session(B, { tenantIds: [B.tenantId], operator: false })).toEqual({
        ok: true,
        value: { seen: [B.tenantId], readOnly: false },
      });
      expect(await session(A, { tenantIds: [A.tenantId, B.tenantId], operator: true })).toEqual({
        ok: true,
        value: { seen: [B.tenantId], readOnly: false },
      });
      expect(
        await session(A, {
          tenantIds: [A.tenantId, B.tenantId],
          operator: true,
          investigate: true,
        }),
      ).toEqual({ ok: true, value: { seen: both(), readOnly: true } });
    });

    it("refuses an investigation that isn't a back-office session", async () => {
      await expect(
        session(A, { tenantIds: [A.tenantId], operator: false, investigate: true }),
      ).rejects.toBeInstanceOf(ScopeError);
    });
  });

  describe("locking and unlocking", () => {
    const changes = async (c: ClientFixture) =>
      (
        await t.db.$client<{ change: unknown; reason: string }[]>`
          select change, reason from tenant_change where tenant_id = ${c.tenantId} order by created_at`
      ).map((r) => ({ change: r.change, reason: r.reason }));

    it("locks once, records who, when and why, and keeps the history", async () => {
      const before = (await changes(A)).length;
      const first = await lock(A, "client");
      expect(first.changed).toBe(true);
      expect(first.lock).toMatchObject({ side: "client", by: A.userId, reason: "Looking into it" });
      // Locking again changes nothing; the client is outside the scope by now, which is fine.
      const again = await withOperator(t.db, [A.tenantId], async (tx) => {
        await asWorker(tx);
        return lockClient(tx, {
          tenantId: A.tenantId,
          side: "operator",
          by: B.userId,
          reason: "x",
        });
      });
      expect(again).toEqual({ changed: false, lock: first.lock });
      expect((await changes(A)).slice(before)).toEqual([
        { change: { lock: { from: null, to: "client" } }, reason: "Looking into it" },
      ]);
    });

    it("refuses a lock without a reason, or of a client outside the transaction", async () => {
      await withOperator(t.db, [A.tenantId], async (tx) => {
        await asWorker(tx);
        await expect(
          lockClient(tx, { tenantId: A.tenantId, side: "operator", by: A.userId, reason: "  " }),
        ).rejects.toMatchObject({ code: "invalid_input" });
        await expect(
          lockClient(tx, { tenantId: B.tenantId, side: "operator", by: A.userId, reason: "x" }),
        ).rejects.toMatchObject({ code: "not_in_scope" });
      });
      expect((await withOperator(t.db, [], lockState)).clients).toEqual([]);
    });

    it("unlocks a client the back office asked for, in the same commit as its history", async () => {
      await lock(A);
      const out = await withOperator(t.db, [A.tenantId, B.tenantId], async (tx) => {
        await asWorker(tx);
        expect(await seen(tx)).toEqual([B.tenantId]);
        const result = await unlockClient(tx, {
          tenantId: A.tenantId,
          by: A.userId,
          note: "False alarm",
        });
        return { result, seen: await seen(tx) };
      });
      expect(out.result.changed).toBe(true);
      expect(out.result.was).toMatchObject({ side: "operator" });
      expect(out.seen).toEqual(both());
      expect((await changes(A)).at(-1)).toEqual({
        change: { lock: { from: "operator", to: null } },
        reason: "False alarm",
      });
      expect(await withTenant(t.db, A.tenantId, look)).toEqual([A.tenantId]);
    });

    it("refuses to unlock a client outside the transaction, or while everything is locked", async () => {
      await lock(A);
      await withOperator(t.db, [B.tenantId], async (tx) => {
        await asWorker(tx);
        await expect(
          unlockClient(tx, { tenantId: A.tenantId, by: B.userId, note: "x" }),
        ).rejects.toMatchObject({ code: "not_in_scope" });
      });
      await lockAll();
      await withOperator(t.db, [A.tenantId], async (tx) => {
        await asWorker(tx);
        await expect(
          unlockClient(tx, { tenantId: A.tenantId, by: A.userId, note: "x" }),
        ).rejects.toBeInstanceOf(LockError);
      });
      await withOperator(t.db, [B.tenantId], async (tx) => {
        await asWorker(tx);
        // Nothing to unlock: no change.
        await unlockEverything(tx);
        expect(await unlockClient(tx, { tenantId: B.tenantId, by: B.userId, note: "x" })).toEqual({
          changed: false,
          was: null,
        });
      });
    });

    it("locks everything once and reads every standing lock", async () => {
      expect((await lockAll()).changed).toBe(true);
      expect((await lockAll()).changed).toBe(false);
      await t.db.$client`delete from platform_lock`;
      await lock(A);
      await lockAll();
      const state = await withOperator(t.db, [], async (tx) => {
        await asWorker(tx);
        return { all: await lockState(tx), justB: await lockState(tx, [B.tenantId]) };
      });
      expect(state.all.everything).toMatchObject({ lockedBy: A.userId, reason: "Leaked key" });
      expect(state.all.clients.map((c) => c.tenantId)).toEqual([A.tenantId]);
      expect(state.justB.clients).toEqual([]);
    });

    it("counts what came in for a locked client, by kind, and nothing for an unlocked one", async () => {
      await lock(A);
      const counted = await withOperator(t.db, [], async (tx) => {
        await asWorker(tx);
        return [
          await countLockedInbound(tx, A.tenantId, "email"),
          await countLockedInbound(tx, A.tenantId, "email"),
          await countLockedInbound(tx, A.tenantId, "webhook"),
          await countLockedInbound(tx, B.tenantId, "email"),
        ];
      });
      expect(counted).toEqual([true, true, true, false]);
      const [row] = await t.db
        .select({ lock: tenant.lock })
        .from(tenant)
        .where(eq(tenant.id, A.tenantId));
      expect(row?.lock?.inbound).toEqual({ email: 2, webhook: 1 });
      await withOperator(t.db, [], async (tx) => {
        await expect(countLockedInbound(tx, A.tenantId, "Bad kind")).rejects.toBeInstanceOf(
          LockError,
        );
      });
    });
  });

  describe("admitting a client to a transaction", () => {
    it("admits a new client, and none while everything is locked", async () => {
      const ids = await withOperator(t.db, [B.tenantId], async (tx) => {
        await asWorker(tx);
        const admitted = await admitTenant(tx, A.tenantId);
        return { admitted, seen: await seen(tx) };
      });
      expect(ids).toEqual({ admitted: true, seen: both() });
      await lockAll();
      expect(await withOperator(t.db, [], async (tx) => admitTenant(tx, A.tenantId))).toBe(false);
    });

    it("doesn't admit a locked client", async () => {
      await lock(A);
      expect(
        await withOperator(t.db, [B.tenantId], async (tx) => admitTenant(tx, A.tenantId)),
      ).toBe(false);
    });
  });

  it("recognises the refusal however it is wrapped", () => {
    expect(isClientLocked(new ClientLockedError([]))).toBe(true);
    expect(isClientLocked({ cause: { cause: { code: "MZLCK" } } })).toBe(true);
    expect(isClientLocked(new Error("other"))).toBe(false);
    expect(isClientLocked(undefined)).toBe(false);
  });
});
