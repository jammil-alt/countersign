// The audit log (migration 0017, docs/plan.md §1.35) as the Worker's role sees it: append-only,
// written into the scope's own client or into no client, and read back only within scope.

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withOperator, withTenant } from "./client";
import { type ClientFixture, insertClient } from "./fixtures.test-helper";
import { auditEvent } from "./schema";
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
});
