// Migration 0046 (docs/plan.md §1.86 "Run audit (wave 6)"): `owner_check`, `run_audit` and
// `run_audit_mark`. It applies on a database the previous Worker used (new tables only), that
// Worker's runs still finish, all three tables have forced row-level security, the Worker's role
// reads and writes only its own client's rows, and every row is insert only.

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withOperator, withTenant } from "./client";
import { type ClientFixture, insertClient } from "./fixtures.test-helper";
import { ownerCheck, run, runAudit, runAuditMark } from "./schema";
import {
  asWorker,
  createTestDatabase,
  databaseAvailable,
  migrateAsOwner,
  type TestDatabase,
} from "./testing";

const online = await databaseAvailable();

type AnyTx = Parameters<Parameters<typeof withTenant>[2]>[0];

describe.skipIf(!online)("0046 on a database the previous Worker used", () => {
  let t: TestDatabase;
  let tenantId = "";

  beforeAll(async () => {
    const created = await createTestDatabase({ migrate: false });
    if (!created) throw new Error("database vanished");
    t = created;
    await migrateAsOwner(t.url, { upTo: "0045_browser_scripts" });
    const [tn] = await t.db.$client<{ id: string }[]>`
      insert into tenant (name) values ('Earlier') returning id`;
    tenantId = tn?.id ?? "";
    await migrateAsOwner(t.url);
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("adds the three tables, empty, with forced row-level security", async () => {
    const rows = await t.db.$client<{ relname: string; rls: boolean; forced: boolean }[]>`
      select relname, relrowsecurity as rls, relforcerowsecurity as forced
      from pg_class where relname in ('owner_check', 'run_audit', 'run_audit_mark')
      order by relname`;
    expect(rows).toEqual([
      { relname: "owner_check", rls: true, forced: true },
      { relname: "run_audit", rls: true, forced: true },
      { relname: "run_audit_mark", rls: true, forced: true },
    ]);
    const [count] = await t.db.$client<{ n: number }[]>`
      select (select count(*) from owner_check) + (select count(*) from run_audit)
        + (select count(*) from run_audit_mark) as n`;
    expect(Number(count?.n)).toBe(0);
  });

  it("leaves the previous Worker's tenants as they were", async () => {
    const [row] = await t.db.$client<{ name: string }[]>`
      select name from tenant where id = ${tenantId}`;
    expect(row?.name).toBe("Earlier");
  });
});

describe.skipIf(!online)("the run audit under the Worker's role (0046)", () => {
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

  it("a client sees only its own checks, queue rows and marks", async () => {
    const seen = await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      return {
        checks: await tx.select({ tenantId: ownerCheck.tenantId }).from(ownerCheck),
        queued: await tx.select({ tenantId: runAudit.tenantId }).from(runAudit),
        marks: await tx.select({ tenantId: runAuditMark.tenantId }).from(runAuditMark),
      };
    });
    for (const rows of [seen.checks, seen.queued, seen.marks]) {
      expect(rows).toEqual([{ tenantId: A.tenantId }]);
    }
  });

  it("an operator serving A sees A's rows and none of B's", async () => {
    const seen = await withOperator(t.db, [A.tenantId], async (tx) => {
      await asWorker(tx);
      return tx.select({ tenantId: runAuditMark.tenantId }).from(runAuditMark);
    });
    expect(new Set(seen.map((r) => r.tenantId))).toEqual(new Set([A.tenantId]));
  });

  it("never writes a mark into another client", async () => {
    await expect(
      withTenant(t.db, A.tenantId, async (tx) => {
        await asWorker(tx);
        await tx.insert(runAuditMark).values({
          tenantId: B.tenantId,
          runId: B.runId,
          verdict: "looks_right",
          markedBy: A.userId,
        });
      }),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
  });

  it("queues a run once and checks an attempt once", async () => {
    await expect(
      withTenant(t.db, A.tenantId, async (tx) => {
        await asWorker(tx);
        await tx
          .insert(runAudit)
          .values({ tenantId: A.tenantId, runId: A.runId, agentId: A.agentId, reason: "sampled" });
      }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
    const again = await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      return tx
        .insert(ownerCheck)
        .values({
          tenantId: A.tenantId,
          runId: A.runId,
          nodeId: "s1",
          attempt: 1,
          result: "clean",
          attemptOutcome: "succeeded",
          agentVersionId: A.agentVersionId,
        })
        .onConflictDoNothing()
        .returning();
    });
    expect(again).toEqual([]);
  });

  it("refuses a problem without a note and a reviewed check without its verdict", async () => {
    await expect(
      withTenant(t.db, A.tenantId, async (tx) => {
        await asWorker(tx);
        await tx
          .insert(runAuditMark)
          .values({ tenantId: A.tenantId, runId: A.runId, verdict: "problem", markedBy: A.userId });
      }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(
      withTenant(t.db, A.tenantId, async (tx) => {
        await asWorker(tx);
        await tx.insert(ownerCheck).values({
          tenantId: A.tenantId,
          runId: A.runId,
          nodeId: "s2",
          attempt: 1,
          result: "reviewed",
          attemptOutcome: "succeeded",
          agentVersionId: A.agentVersionId,
        });
      }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  it("takes how an attempt ended, why the owner never looked, and why a review was due", async () => {
    const rows = await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      return tx
        .insert(ownerCheck)
        .values([
          {
            tenantId: A.tenantId,
            runId: A.runId,
            nodeId: "s3",
            attempt: 1,
            result: "flagged",
            attemptOutcome: "escalated",
            agentVersionId: A.agentVersionId,
          },
          {
            tenantId: A.tenantId,
            runId: A.runId,
            nodeId: "s4",
            attempt: 1,
            result: "clean",
            attemptOutcome: "unanswered",
            reason: "ended_by_person",
            agentVersionId: A.agentVersionId,
          },
          {
            tenantId: A.tenantId,
            runId: A.runId,
            nodeId: "s5",
            attempt: 1,
            result: "clean",
            attemptOutcome: "succeeded",
            reason: "no_decision",
            cause: "checkpoint",
            reviewDue: "all",
            agentVersionId: A.agentVersionId,
          },
        ])
        .returning({ reviewDue: ownerCheck.reviewDue });
    });
    expect(rows.map((r) => r.reviewDue)).toEqual([null, null, "all"]);
    await expect(
      withTenant(t.db, A.tenantId, async (tx) => {
        await asWorker(tx);
        await tx.insert(ownerCheck).values({
          tenantId: A.tenantId,
          runId: A.runId,
          nodeId: "s6",
          attempt: 1,
          result: "clean",
          attemptOutcome: "succeeded",
          reviewDue: "sometimes" as never,
          agentVersionId: A.agentVersionId,
        });
      }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  it("keeps every row as it was: never updated, never deleted", async () => {
    const changes: ((tx: AnyTx) => Promise<unknown>)[] = [
      (tx) => tx.update(ownerCheck).set({ result: "clean" }),
      (tx) => tx.delete(ownerCheck),
      (tx) => tx.update(runAudit).set({ reason: "by_hand" }),
      (tx) => tx.delete(runAudit),
      (tx) => tx.update(runAuditMark).set({ verdict: "looks_right" }),
      (tx) => tx.delete(runAuditMark),
    ];
    // The Worker's role has no grant to do either.
    for (const change of changes) {
      await expect(
        withTenant(t.db, A.tenantId, async (tx) => {
          await asWorker(tx);
          await change(tx);
        }),
      ).rejects.toMatchObject({ cause: { code: "42501" } });
    }
    // And the trigger stops whoever has one (the owner included).
    for (const change of changes) {
      await expect(change(t.db as unknown as AnyTx)).rejects.toMatchObject({
        cause: { code: "23001" },
      });
    }
  });

  it("leaves the run itself free to change (the Worker finishes it as before)", async () => {
    await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      await tx.update(run).set({ status: "succeeded" }).where(eq(run.id, A.runId));
    });
    const [r] = await t.db.select({ status: run.status }).from(run).where(eq(run.id, A.runId));
    expect(r?.status).toBe("succeeded");
  });
});
