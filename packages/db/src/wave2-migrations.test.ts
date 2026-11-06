// The Wave 2 migrations (0026–0029, ARCHITECTURE v0.12 §5.5 and v0.13 §5.6) beyond what the RLS,
// immutability and migration tests walk for every table: `skill.require_tests` on a database the
// previous Worker used, the keys and checks the new tables rely on, same-client foreign keys, and
// who sees the shared rows (tenant_id null): operator sessions only.

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Tx, withOperator, withTenant } from "./client";
import {
  AUTOMATION_DEFINITION,
  type ClientFixture,
  insertClient,
  insertOperatorRows,
} from "./fixtures.test-helper";
import {
  automation,
  automationVersion,
  connectorSetting,
  inboxItem,
  oversightDecision,
  skill,
  testCase,
  testCaseResult,
  testSuiteRun,
} from "./schema";
import {
  asWorker,
  createTestDatabase,
  databaseAvailable,
  migrateAsOwner,
  type TestDatabase,
} from "./testing";

const online = await databaseAvailable();

const UNIQUE = "23505";
const CHECK = "23514";
const FOREIGN_KEY = "23503";
const INSUFFICIENT_PRIVILEGE = "42501";

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.code ?? e.cause?.code ?? "unknown";
  }
  return undefined;
}

/** The tenant ids a session sees in a table. */
async function scopeOf(tx: Tx, table: string): Promise<Set<string | null>> {
  const rows = await tx.execute<{ t: string | null }>(
    sql.raw(`select tenant_id::text as t from ${table}`),
  );
  return new Set([...rows].map((r) => r.t));
}

describe.skipIf(!online)("0028 on a database the previous Worker used", () => {
  let t: TestDatabase;

  beforeAll(async () => {
    const created = await createTestDatabase({ migrate: false });
    if (!created) throw new Error("database vanished");
    t = created;
    await migrateAsOwner(t.url, { upTo: "0027_automations" });
    const [tn] = await t.db.$client<{ id: string }[]>`
      insert into tenant (name) values ('Earlier') returning id`;
    // The previous Worker's inserts: no require_tests column yet.
    await t.db.$client`insert into skill (slug, name) values ('shared', 'Shared')`;
    await t.db.$client`
      insert into skill (tenant_id, slug, name) values (${tn?.id ?? ""}, 'own', 'Own')`;
    await migrateAsOwner(t.url);
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("leaves every existing skill without the test requirement", async () => {
    const rows = await t.db.select({ slug: skill.slug, require: skill.requireTests }).from(skill);
    expect(rows.map((r) => [r.slug, r.require]).sort()).toEqual([
      ["own", false],
      ["shared", false],
    ]);
  });

  it("applies the rest of the journal once, after the data went in", async () => {
    const [row] = await t.db.$client<{ n: number }[]>`
      select count(*)::int as n from drizzle.__drizzle_migrations`;
    const [cols] = await t.db.$client<{ n: number }[]>`
      select count(*)::int as n from information_schema.columns
      where table_name = 'oversight_decision'`;
    expect(row?.n).toBeGreaterThanOrEqual(30);
    expect(cols?.n).toBeGreaterThan(0);
  });
});

describe.skipIf(!online)("Wave 2 tables and columns", () => {
  let t: TestDatabase;
  let A: ClientFixture;
  let B: ClientFixture;

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    A = await insertClient(t.db, "A");
    B = await insertClient(t.db, "B");
    await insertOperatorRows(t.db);
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("connector_setting: operator sessions only; updated in place, never deleted (0026)", async () => {
    const client = await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      return tx.select().from(connectorSetting);
    });
    expect(client).toEqual([]);
    expect(
      await errorCode(
        withTenant(t.db, A.tenantId, async (tx) => {
          await asWorker(tx);
          await tx.insert(connectorSetting).values({ connector: "qbo", status: "live" });
        }),
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    const matrix = {
      verbs: { read: "auto", create: "approval", update: "approval", delete: "off" },
      entities: { bill: { create: "off" } },
    };
    const saved = await withOperator(t.db, [], async (tx) => {
      await asWorker(tx);
      await tx.insert(connectorSetting).values({
        connector: "qbo",
        status: "beta",
        defaultPermissions: matrix as never,
        note: "Bills and purchases first",
      });
      await tx
        .update(connectorSetting)
        .set({ status: "live" })
        .where(eq(connectorSetting.connector, "qbo"));
      return tx
        .select({ status: connectorSetting.status, perms: connectorSetting.defaultPermissions })
        .from(connectorSetting)
        .where(eq(connectorSetting.connector, "qbo"));
    });
    expect(saved).toEqual([{ status: "live", perms: matrix }]);
    expect(
      await errorCode(
        withOperator(t.db, [], async (tx) => {
          await asWorker(tx);
          await tx.delete(connectorSetting).where(eq(connectorSetting.connector, "qbo"));
        }),
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    expect(
      await errorCode(
        t.db.insert(connectorSetting).values({ connector: "zoho", status: "retired" as never }),
      ),
    ).toBe(CHECK);
    expect(
      await errorCode(t.db.insert(connectorSetting).values({ connector: "", status: "building" })),
    ).toBe(CHECK);
    expect(
      await errorCode(t.db.insert(connectorSetting).values({ connector: "qbo", status: "beta" })),
    ).toBe(UNIQUE);
  });

  it("automation: one slug among the shared ones and within each client (0027)", async () => {
    // The fixtures already hold `lookup` shared, in A and in B.
    expect(await errorCode(t.db.insert(automation).values({ slug: "lookup", name: "Again" }))).toBe(
      UNIQUE,
    );
    expect(
      await errorCode(
        t.db.insert(automation).values({ tenantId: A.tenantId, slug: "lookup", name: "Again" }),
      ),
    ).toBe(UNIQUE);
    // A shared automation copied into a client.
    await t.db
      .insert(automation)
      .values({ tenantId: A.tenantId, slug: "shared:lookup", name: "Lookup" });
    expect(
      await errorCode(
        t.db.insert(automation).values({ slug: "x", name: "X", status: "draft" as never }),
      ),
    ).toBe(CHECK);
  });

  it("automation_version: one per number, same client as its automation (0027)", async () => {
    const version = {
      tenantId: A.tenantId,
      automationId: A.automationId,
      definition: AUTOMATION_DEFINITION,
      definitionHash: "h2",
    };
    expect(await errorCode(t.db.insert(automationVersion).values({ ...version, version: 1 }))).toBe(
      UNIQUE,
    );
    expect(await errorCode(t.db.insert(automationVersion).values({ ...version, version: 0 }))).toBe(
      CHECK,
    );
    expect(
      await errorCode(
        t.db.insert(automationVersion).values({ ...version, version: 3, status: "x" as never }),
      ),
    ).toBe(CHECK);
    // A version of A's automation filed under B is refused.
    expect(
      await errorCode(
        t.db.insert(automationVersion).values({ ...version, tenantId: B.tenantId, version: 2 }),
      ),
    ).toBe(FOREIGN_KEY);
    // Publishing in A's scope: a new version, then the live pointer.
    await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      const [v2] = await tx
        .insert(automationVersion)
        .values({ ...version, version: 2, status: "live", parentVersionId: A.automationVersionId })
        .returning({ id: automationVersion.id });
      await tx
        .update(automation)
        .set({ liveVersionId: v2?.id ?? null })
        .where(eq(automation.id, A.automationId));
    });
  });

  it("shared automations and test bench rows show only in operator sessions (0027, 0028)", async () => {
    const tables = [
      "automation",
      "automation_version",
      "test_case",
      "test_suite_run",
      "test_case_result",
    ];
    await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      for (const table of tables)
        expect(await scopeOf(tx, table), table).toEqual(new Set([A.tenantId]));
    });
    await withOperator(t.db, [], async (tx) => {
      await asWorker(tx);
      for (const table of tables) expect(await scopeOf(tx, table), table).toEqual(new Set([null]));
    });
    await withOperator(t.db, [B.tenantId], async (tx) => {
      await asWorker(tx);
      for (const table of tables) {
        expect(await scopeOf(tx, table), table).toEqual(new Set([null, B.tenantId]));
      }
    });
    // A client session can't write a shared row, nor a row of another client.
    for (const insert of [
      (tx: Tx) => tx.insert(automation).values({ slug: "sneaky", name: "Sneaky" }),
      (tx: Tx) =>
        tx.insert(testCase).values({
          targetKind: "skill",
          targetId: A.automationId,
          name: "Sneaky",
          input: {},
          expected: {},
          matcher: { kind: "exact" },
        }),
      (tx: Tx) =>
        tx.insert(testCase).values({
          tenantId: B.tenantId,
          targetKind: "skill",
          targetId: A.automationId,
          name: "Sneaky",
          input: {},
          expected: {},
          matcher: { kind: "exact" },
        }),
    ]) {
      expect(
        await errorCode(
          withTenant(t.db, A.tenantId, async (tx) => {
            await asWorker(tx);
            await insert(tx);
          }),
        ),
      ).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });

  it("test_case: kinds and sources checked; required and no fixtures by default (0028)", async () => {
    const values = {
      tenantId: A.tenantId,
      targetKind: "template" as const,
      targetId: A.agentId,
      name: "A delivery note",
      input: { event: "document.extracted" },
      expected: { total: "10.0000" },
      matcher: { kind: "subset" },
    };
    const [row] = await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      return tx.insert(testCase).values(values).returning({
        required: testCase.required,
        fixtures: testCase.fixtures,
        source: testCase.source,
      });
    });
    expect(row).toEqual({ required: true, fixtures: [], source: "manual" });
    for (const bad of [
      { targetKind: "workflow" as never },
      { source: "import" as never },
      { name: "  " },
    ]) {
      expect(
        await errorCode(t.db.insert(testCase).values({ ...values, ...bad })),
        JSON.stringify(bad),
      ).toBe(CHECK);
    }
    // Archived in place, in the client's scope.
    await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      await tx
        .update(testCase)
        .set({ archivedAt: new Date() })
        .where(eq(testCase.id, A.testCaseId));
    });
  });

  it("test_suite_run: counts add up; finished exactly when no longer running (0028)", async () => {
    const run = {
      tenantId: A.tenantId,
      targetKind: "skill" as const,
      targetId: A.automationId,
      versionId: A.skillVersionId,
    };
    const [started] = await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      return tx.insert(testSuiteRun).values(run).returning();
    });
    if (!started) throw new Error("no suite run");
    expect([started.status, started.total, started.costUsd, started.finishedAt]).toEqual([
      "running",
      0,
      "0.0000",
      null,
    ]);
    expect(
      await errorCode(t.db.insert(testSuiteRun).values({ ...run, total: 1, passed: 1, failed: 1 })),
    ).toBe(CHECK);
    expect(await errorCode(t.db.insert(testSuiteRun).values({ ...run, costUsd: "-1" }))).toBe(
      CHECK,
    );
    expect(
      await errorCode(
        t.db.update(testSuiteRun).set({ status: "done" }).where(eq(testSuiteRun.id, started.id)),
      ),
    ).toBe(CHECK);
    await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      await tx
        .update(testSuiteRun)
        .set({ status: "done", total: 2, passed: 1, failed: 1, finishedAt: new Date() })
        .where(eq(testSuiteRun.id, started.id));
    });
  });

  it("test_case_result: once per case and suite run, all of one client (0028)", async () => {
    const result = {
      tenantId: A.tenantId,
      suiteRunId: A.suiteRunId,
      testCaseId: A.testCaseId,
      status: "pass" as const,
    };
    expect(await errorCode(t.db.insert(testCaseResult).values(result))).toBe(UNIQUE);
    expect(
      await errorCode(t.db.insert(testCaseResult).values({ ...result, testCaseId: B.testCaseId })),
    ).toBe(FOREIGN_KEY);
    expect(
      await errorCode(t.db.insert(testCaseResult).values({ ...result, suiteRunId: B.suiteRunId })),
    ).toBe(FOREIGN_KEY);
    const [another] = await t.db
      .insert(testCase)
      .values({
        tenantId: A.tenantId,
        targetKind: "template",
        targetId: A.agentId,
        name: "Second",
        input: {},
        expected: {},
        matcher: { kind: "exact" },
      })
      .returning({ id: testCase.id });
    const second = { ...result, testCaseId: another?.id ?? "" };
    // A template case's run is of the same client.
    expect(await errorCode(t.db.insert(testCaseResult).values({ ...second, runId: B.runId }))).toBe(
      FOREIGN_KEY,
    );
    expect(
      await errorCode(
        t.db.insert(testCaseResult).values({ ...second, status: "skipped" as never }),
      ),
    ).toBe(CHECK);
    await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      await tx.insert(testCaseResult).values({ ...second, runId: A.runId, status: "error" });
    });
  });

  it("skill.require_tests: off by default, switched by the operator (0028)", async () => {
    const [own] = await t.db
      .insert(skill)
      .values({ tenantId: A.tenantId, slug: "gated", name: "Gated" })
      .returning({ id: skill.id, require: skill.requireTests });
    expect(own?.require).toBe(false);
    await withOperator(t.db, [A.tenantId], async (tx) => {
      await asWorker(tx);
      await tx
        .update(skill)
        .set({ requireTests: true })
        .where(eq(skill.id, own?.id ?? ""));
    });
  });

  it("oversight_decision: one per step node and seq, of the run's client, checked (0029)", async () => {
    const decision = {
      tenantId: A.tenantId,
      runId: A.runId,
      stepRunId: A.stepRunId,
      nodeId: "s1",
      seq: 2,
      cause: "failed" as const,
      action: "retry" as const,
      note: "Timed out again.",
      model: "claude-opus-5-5",
      agentVersionId: A.agentVersionId,
    };
    expect(await errorCode(t.db.insert(oversightDecision).values({ ...decision, seq: 1 }))).toBe(
      UNIQUE,
    );
    for (const bad of [
      { seq: 0 },
      { cause: "timeout" as never },
      { action: "skip" as never },
      { note: "" },
      { note: "x".repeat(2001) },
      { sources: { id: "x" } as never },
      { costUsd: "-0.0001" },
      { tokensIn: -1 },
      // A corrected input goes with retry_with, and only with it.
      { action: "retry_with" as const },
      { inputAfter: { vendor: "Acme" } },
      { inputBefore: { vendor: "acme" } },
    ]) {
      expect(
        await errorCode(t.db.insert(oversightDecision).values({ ...decision, ...bad })),
        JSON.stringify(bad),
      ).toBe(CHECK);
    }
    for (const bad of [{ runId: B.runId }, { stepRunId: B.stepRunId }]) {
      expect(
        await errorCode(t.db.insert(oversightDecision).values({ ...decision, ...bad })),
        JSON.stringify(bad),
      ).toBe(FOREIGN_KEY);
    }
    const [bItem] = await t.db
      .insert(inboxItem)
      .values({ tenantId: B.tenantId, kind: "external_action", title: "B's" })
      .returning({ id: inboxItem.id });
    expect(
      await errorCode(
        t.db
          .insert(oversightDecision)
          .values({ ...decision, action: "ask", inboxItemId: bItem?.id ?? "" }),
      ),
    ).toBe(FOREIGN_KEY);

    // In the run's client: a corrected retry, then an ask with its inbox item made first.
    const rows = await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      await tx.insert(oversightDecision).values({
        ...decision,
        action: "retry_with",
        inputBefore: { vendor: "acme lumbr" },
        inputAfter: { vendor: "Acme Lumber" },
        sources: [A.rawRecordId],
        proposal: { summary: "Add a vendor alias", change: { alias: "acme lumbr" } },
      });
      const [item] = await tx
        .insert(inboxItem)
        .values({ tenantId: A.tenantId, kind: "external_action", title: "Which vendor?" })
        .returning({ id: inboxItem.id });
      await tx
        .insert(oversightDecision)
        .values({ ...decision, seq: 3, action: "ask", inboxItemId: item?.id ?? null });
      return tx
        .select({ seq: oversightDecision.seq, action: oversightDecision.action })
        .from(oversightDecision)
        .orderBy(oversightDecision.seq);
    });
    expect(rows.map((r) => [r.seq, r.action])).toEqual([
      [1, "retry"],
      [2, "retry_with"],
      [3, "ask"],
    ]);
    // Another client's session neither sees nor writes A's decisions.
    const seenByB = await withTenant(t.db, B.tenantId, async (tx) => {
      await asWorker(tx);
      return tx
        .select({ id: oversightDecision.id })
        .from(oversightDecision)
        .where(eq(oversightDecision.tenantId, A.tenantId));
    });
    expect(seenByB).toEqual([]);
    expect(
      await errorCode(
        withTenant(t.db, B.tenantId, async (tx) => {
          await asWorker(tx);
          await tx.insert(oversightDecision).values({ ...decision, seq: 4 });
        }),
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);
  });
});
