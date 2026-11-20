// The audit log (migrations 0017 and 0071, docs/plan.md §1.35) as the Worker's role sees it:
// append-only, written into the scope's own client or into no client, and read back only within
// scope. A row with no client reaches an operator session only when its actor is none, the session's
// own user, a person of a client it serves, or in no client at all (PLATFORM_QA SEC-6).

import { like, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withOperator, withTenant, withUser } from "./client";
import { type ClientFixture, insertClient } from "./fixtures.test-helper";
import { appUser, auditEvent, membership, tenant } from "./schema";
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

describe.skipIf(!online)("audit_event", () => {
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
  afterAll(async () => {
    await t?.drop();
  });

  const row = (tenantId: string | null) => ({
    tenantId,
    actorKind: "user" as const,
    action: "GET /api/documents/:id",
    outcome: "ok" as const,
    target: { id: "x" },
  });

  it("a client session writes its own client's rows and rows with no client, never another's", async () => {
    await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      await tx.insert(auditEvent).values(row(A.tenantId));
      await tx.insert(auditEvent).values(row(null));
    });
    const code = await errorCode(
      withTenant(t.db, A.tenantId, async (tx) => {
        await asWorker(tx);
        await tx.insert(auditEvent).values(row(B.tenantId));
      }),
    );
    expect(code).toBe("42501");
  });

  it("a client session reads only its client's rows; rows with no client are operator-only", async () => {
    const seen = await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      return tx.select({ t: auditEvent.tenantId }).from(auditEvent);
    });
    expect(new Set(seen.map((r) => r.t))).toEqual(new Set([A.tenantId]));
    const op = await withOperator(t.db, [B.tenantId], async (tx) => {
      await asWorker(tx);
      return tx.select({ t: auditEvent.tenantId }).from(auditEvent);
    });
    expect(new Set(op.map((r) => r.t))).toEqual(new Set([B.tenantId, null]));
  });

  it("rows never change and are never deleted, for the runtime or the owner", async () => {
    for (const statement of [
      sql`update audit_event set action = 'x'`,
      sql`delete from audit_event`,
    ]) {
      const asRuntime = await errorCode(
        withOperator(t.db, [A.tenantId], async (tx) => {
          await asWorker(tx);
          await tx.execute(statement);
        }),
      );
      expect(asRuntime).toBe("42501");
      // The admin connection bypasses grants and RLS; the trigger still refuses.
      expect(await errorCode(t.db.execute(statement))).toBe("23001");
    }
  });

  describe("rows with no client in operator sessions", () => {
    // A's person (A.userId, client_admin of A), B's person, Dan (a client user of A and C), Olga
    // (operator of A only), Oscar (operator of C only), Nora (in no client yet), and a row with no
    // actor: one no-client row each, named by its action.
    let C = "";

    beforeAll(async () => {
      const [c] = await t.db.insert(tenant).values({ name: "C" }).returning({ id: tenant.id });
      C = c?.id ?? "";
      const users = await t.db
        .insert(appUser)
        .values(["dan", "olga", "oscar", "nora"].map((n) => ({ email: `${n}@example.com` })))
        .returning({ id: appUser.id });
      const [dan, olga, oscar, nora] = users.map((u) => u.id);
      await t.db.execute(sql`insert into ${membership} (tenant_id, user_id, role) values
        (${A.tenantId}, ${dan}, 'client_user'), (${C}, ${dan}, 'client_user'),
        (${A.tenantId}, ${olga}, 'operator'), (${C}, ${oscar}, 'operator')`);
      const actors: [string, string | null | undefined][] = [
        ["a", A.userId],
        ["b", B.userId],
        ["dan", dan],
        ["olga", olga],
        ["oscar", oscar],
        ["nora", nora],
        ["none", null],
      ];
      await t.db.insert(auditEvent).values(
        actors.map(([name, userId]) => ({
          tenantId: null,
          actorKind: userId ? ("user" as const) : ("anonymous" as const),
          actorUserId: userId ?? null,
          actorEmail: userId ? `${name}@example.com` : null,
          action: `sec6.${name}`,
          outcome: "refused" as const,
          ip: "203.0.113.9",
        })),
      );
    });

    /** The `sec6.*` rows an operator session over `tenantIds` reads, by actor name. */
    async function seenBy(tenantIds: string[], userId?: string): Promise<string[]> {
      const rows = await withOperator(t.db, tenantIds, async (tx) => {
        await asWorker(tx);
        if (userId) await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
        return tx
          .select({ action: auditEvent.action })
          .from(auditEvent)
          .where(like(auditEvent.action, "sec6.%"));
      });
      return rows.map((r) => r.action.slice("sec6.".length)).sort();
    }

    it("(PLATFORM_QA SEC-6) hides a client person's no-client row from an operator who doesn't serve that client", async () => {
      const seen = await seenBy([C]);
      expect(seen).not.toContain("a");
      expect(seen).not.toContain("b");
      expect(seen).toEqual(["dan", "none", "nora", "olga", "oscar"]);
    });

    it("(PLATFORM_QA SEC-6) shows that row to an operator who serves the person's client", async () => {
      const all = ["a", "dan", "none", "nora", "olga", "oscar"];
      expect(await seenBy([A.tenantId])).toEqual(all);
      expect(await seenBy([A.tenantId, C])).toEqual(all);
    });

    it("(PLATFORM_QA SEC-6) shows the operator's own rows, other operators' and rows with no actor", async () => {
      // Oscar's own row (an operator of C), Olga's (an operator, in no client), the row with no
      // actor, and the session's own user's row through app.user_id.
      expect(await seenBy([C])).toEqual(expect.arrayContaining(["oscar", "olga", "none"]));
      expect(await seenBy([C], B.userId)).toContain("b");
    });

    it("(PLATFORM_QA SEC-6) leaves a client session reading no row with no client", async () => {
      const seen = await withTenant(t.db, A.tenantId, async (tx) => {
        await asWorker(tx);
        return tx
          .select({ id: auditEvent.id })
          .from(auditEvent)
          .where(like(auditEvent.action, "sec6.%"));
      });
      expect(seen).toEqual([]);
    });

    it("(PLATFORM_QA SEC-6) still shows every no-client row to an operator scope over no clients (the second-factor rate limits)", async () => {
      expect(await seenBy([])).toEqual(["a", "b", "dan", "none", "nora", "olga", "oscar"]);
    });

    it("(PLATFORM_QA SEC-6) still writes no-client rows from a person's, a public and an operator scope", async () => {
      const values = (action: string) => ({
        tenantId: null,
        actorKind: "user" as const,
        actorUserId: A.userId,
        action,
        outcome: "ok" as const,
      });
      await withUser(t.db, A.userId, async (tx) => {
        await asWorker(tx);
        await tx.insert(auditEvent).values(values("sec6-write.person"));
      });
      // auditAlone's public scope: no client, no operator, no user.
      await t.db.transaction(async (tx) => {
        await asWorker(tx);
        await tx.insert(auditEvent).values(values("sec6-write.public"));
      });
      await withOperator(t.db, [C], async (tx) => {
        await asWorker(tx);
        await tx.insert(auditEvent).values(values("sec6-write.operator"));
      });
      const written = await t.db
        .select({ action: auditEvent.action })
        .from(auditEvent)
        .where(like(auditEvent.action, "sec6-write.%"));
      expect(written.map((r) => r.action).sort()).toEqual([
        "sec6-write.operator",
        "sec6-write.person",
        "sec6-write.public",
      ]);
    });
  });
});
