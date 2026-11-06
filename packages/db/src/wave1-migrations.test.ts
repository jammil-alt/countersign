// The Wave 1 migrations (0018–0025, ARCHITECTURE v0.12 §5.5) beyond what the RLS, immutability and
// migration tests walk for every table: the 0019 backfill on a database that already holds agents,
// the stage a new agent starts at, and the keys and checks the new tables rely on.

import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withOperator, withTenant } from "./client";
import { type ClientFixture, insertClient, insertOperatorRows } from "./fixtures.test-helper";
import {
  agent,
  contact,
  externalAction,
  knowledgeEntry,
  knowledgeEntryVersion,
  membership,
  modelCall,
  notification,
  receivable,
  run,
  savedView,
  thread,
  threadRead,
  usagePlatformDaily,
  weeklyTable,
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

describe.skipIf(!online)("0019 backfill on a database the previous Worker used", () => {
  let t: TestDatabase;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const created = await createTestDatabase({ migrate: false });
    if (!created) throw new Error("database vanished");
    t = created;
    await migrateAsOwner(t.url, { upTo: "0018_extraction_cost" });
    // The rows as the previous Worker wrote them: no stage columns yet.
    const [tn] = await t.db.$client<{ id: string }[]>`
      insert into tenant (name) values ('Backfill') returning id`;
    const tenantId = tn?.id ?? "";
    const [tpl] = await t.db.$client<{ id: string }[]>`
      insert into agent (kind, slug, name, run_status) values ('template', 'tpl', 'Template', null)
      returning id`;
    ids.template = tpl?.id ?? "";
    for (const status of ["draft", "testing", "active", "paused", "retired", null]) {
      const [a] = await t.db.$client<{ id: string }[]>`
        insert into agent (tenant_id, kind, slug, name, run_status)
        values (${tenantId}, 'client', ${`a-${status ?? "none"}`}, 'Agent', ${status})
        returning id`;
      ids[status ?? "none"] = a?.id ?? "";
    }
    const [copy] = await t.db.$client<{ id: string }[]>`
      insert into agent (tenant_id, kind, slug, name, run_status, template_id, test_copy)
      values (${tenantId}, 'client', 'copy', 'Copy', 'active', ${ids.template ?? ""}, true)
      returning id`;
    ids.copy = copy?.id ?? "";
    await migrateAsOwner(t.url);
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("sets client agents that ran live to live, the rest to bench, templates to none", async () => {
    const rows = await t.db
      .select({ id: agent.id, stage: agent.stage, state: agent.stageState, pause: agent.pause })
      .from(agent);
    const stage = new Map(rows.map((r) => [r.id, r.stage]));
    expect(stage.get(ids.active ?? "")).toBe("live");
    expect(stage.get(ids.paused ?? "")).toBe("live");
    expect(stage.get(ids.retired ?? "")).toBe("live");
    expect(stage.get(ids.draft ?? "")).toBe("bench");
    expect(stage.get(ids.testing ?? "")).toBe("bench");
    expect(stage.get(ids.none ?? "")).toBe("bench");
    // A template's test copy never goes live, even when marked active.
    expect(stage.get(ids.copy ?? "")).toBe("bench");
    expect(stage.get(ids.template ?? "")).toBeNull();
    for (const r of rows) {
      expect(r.state).toEqual({});
      expect(r.pause).toBeNull();
    }
  });

  it("applies every migration once: the rest of the journal ran after the data went in", async () => {
    const [row] = await t.db.$client<{ n: number }[]>`
      select count(*)::int as n from drizzle.__drizzle_migrations`;
    const [cols] = await t.db.$client<{ n: number }[]>`
      select count(*)::int as n from information_schema.columns
      where table_name = 'receivable'`;
    expect(row?.n).toBeGreaterThanOrEqual(26);
    expect(cols?.n).toBeGreaterThan(0);
  });
});

describe.skipIf(!online)("Wave 1 tables and columns", () => {
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

  it("starts a client agent at bench, whoever inserts it; templates have no stage", async () => {
    // The previous Worker's insert: no stage given.
    const [a] = await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      return tx
        .insert(agent)
        .values({ tenantId: A.tenantId, kind: "client", slug: "new-one", name: "New" })
        .returning({ stage: agent.stage });
    });
    expect(a?.stage).toBe("bench");
    const [tpl] = await t.db
      .insert(agent)
      .values({ kind: "template", slug: "no-stage", name: "Template" })
      .returning({ stage: agent.stage });
    expect(tpl?.stage).toBeNull();
    expect(
      await errorCode(
        t.db
          .insert(agent)
          .values({ kind: "template", slug: "staged", name: "Template", stage: "live" }),
      ),
    ).toBe(CHECK);
    expect(
      await errorCode(
        t.db
          .update(agent)
          .set({ stage: "nowhere" as never })
          .where(eq(agent.id, A.agentId)),
      ),
    ).toBe(CHECK);
    expect(
      await errorCode(t.db.update(agent).set({ stage: null }).where(eq(agent.id, A.agentId))),
    ).toBe(CHECK);
    await t.db
      .update(agent)
      .set({
        stage: "trial",
        stageState: {
          trial: { startedAt: "2026-11-06T00:00:00Z", minDays: 14, minRuns: 25, setBy: null },
        },
        pause: { side: "client", by: A.userId, reason: "Holiday", at: "2026-11-06T00:00:00Z" },
      })
      .where(eq(agent.id, A.agentId));
  });

  it("usage_platform_daily: one row per client and day, written in the client's scope", async () => {
    await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      await tx
        .insert(usagePlatformDaily)
        .values({ tenantId: A.tenantId, day: "2026-11-03", documents: 2, costUsd: "0.0200" })
        .onConflictDoUpdate({
          target: [usagePlatformDaily.tenantId, usagePlatformDaily.day],
          set: { documents: 2, costUsd: "0.0200" },
        });
      const rows = await tx.select().from(usagePlatformDaily);
      expect(rows.map((r) => [r.tenantId, r.documents, r.costUsd])).toEqual([
        [A.tenantId, 2, "0.0200"],
      ]);
    });
    expect(
      await errorCode(
        withTenant(t.db, A.tenantId, async (tx) => {
          await asWorker(tx);
          await tx.insert(usagePlatformDaily).values({ tenantId: B.tenantId, day: "2026-11-04" });
        }),
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it("notification: sent once per client, channel and dedupe key", async () => {
    const values = {
      tenantId: A.tenantId,
      userId: A.userId,
      kind: "reconnect" as const,
      dedupeKey: "reconnect:qbo:2026-11-06",
      link: "/connections",
    };
    await t.db.insert(notification).values({ ...values, channel: "email" });
    await t.db.insert(notification).values({ ...values, channel: "sms" });
    expect(await errorCode(t.db.insert(notification).values({ ...values, channel: "email" }))).toBe(
      UNIQUE,
    );
    // Another client may use the same key.
    await t.db
      .insert(notification)
      .values({ ...values, tenantId: B.tenantId, userId: B.userId, channel: "email" });
    expect(
      await errorCode(
        t.db.insert(notification).values({ ...values, dedupeKey: "x", channel: "fax" as never }),
      ),
    ).toBe(CHECK);
  });

  it("weekly_table: one per client and week; sent_at goes with status sent", async () => {
    expect(
      await errorCode(
        t.db.insert(weeklyTable).values({ tenantId: A.tenantId, weekStart: "2026-11-02" }),
      ),
    ).toBe(UNIQUE);
    expect(
      await errorCode(
        t.db
          .update(weeklyTable)
          .set({ status: "sent" })
          .where(eq(weeklyTable.tenantId, A.tenantId)),
      ),
    ).toBe(CHECK);
    await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      await tx
        .update(weeklyTable)
        .set({ status: "sent", sentAt: new Date(), note: "A good week." })
        .where(eq(weeklyTable.tenantId, A.tenantId));
    });
  });

  it("thread: one lead thread per client; read marks move forward in the client's scope", async () => {
    const lead = (tenantId: string) => ({
      tenantId,
      subjectType: "lead",
      subjectId: tenantId,
      title: "Your lead",
    });
    await t.db.insert(thread).values(lead(A.tenantId));
    await t.db.insert(thread).values(lead(B.tenantId));
    expect(await errorCode(t.db.insert(thread).values(lead(A.tenantId)))).toBe(UNIQUE);
    // Other subject types may repeat.
    await t.db.insert(thread).values({
      tenantId: A.tenantId,
      subjectType: "account",
      title: "Question",
      createdBy: A.userId,
    });
    await t.db.insert(thread).values({
      tenantId: A.tenantId,
      subjectType: "account",
      title: "Another",
      createdBy: A.userId,
    });

    const later = new Date("2030-01-01T00:00:00Z");
    const seen = await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      await tx
        .update(threadRead)
        .set({ lastReadAt: later })
        .where(and(eq(threadRead.threadId, A.threadId), eq(threadRead.userId, A.userId)));
      return tx.select().from(threadRead);
    });
    expect(seen.map((r) => [r.tenantId, r.lastReadAt.toISOString()])).toEqual([
      [A.tenantId, later.toISOString()],
    ]);
    // A read mark can't point at another client's thread.
    expect(
      await errorCode(
        t.db.insert(threadRead).values({
          tenantId: A.tenantId,
          threadId: B.threadId,
          userId: A.userId,
        }),
      ),
    ).toBe(FOREIGN_KEY);
  });

  it("inbox_item, external_action and membership take the Desk's columns", async () => {
    const [m] = await t.db
      .select({ canSign: membership.canSign })
      .from(membership)
      .where(eq(membership.userId, A.userId));
    expect(m?.canSign).toBe(true);
    expect(
      await errorCode(
        t.db
          .update(externalAction)
          .set({ editedInput: { amount: "10.0000" } })
          .where(eq(externalAction.tenantId, A.tenantId)),
      ),
    ).toBe(CHECK);
    await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      await tx
        .update(externalAction)
        .set({ editedInput: { amount: "10.0000" }, editedBy: A.userId, editedAt: new Date() })
        .where(eq(externalAction.tenantId, A.tenantId));
      await tx.update(membership).set({ canSign: false }).where(eq(membership.userId, A.userId));
    });
  });

  it("run: a retry points at a failed run of the same client only", async () => {
    const [retry] = await t.db
      .insert(run)
      .values({
        tenantId: A.tenantId,
        agentId: A.agentId,
        agentVersionId: A.agentVersionId,
        workflowSlug: "wf",
        retryOf: A.runId,
        resumeFrom: "s1",
      })
      .returning({ id: run.id });
    expect(retry?.id).toBeTruthy();
    expect(
      await errorCode(
        t.db.insert(run).values({
          tenantId: A.tenantId,
          agentId: A.agentId,
          agentVersionId: A.agentVersionId,
          workflowSlug: "wf",
          retryOf: B.runId,
        }),
      ),
    ).toBe(FOREIGN_KEY);
    expect(
      await errorCode(
        t.db.insert(run).values({
          tenantId: A.tenantId,
          agentId: A.agentId,
          agentVersionId: A.agentVersionId,
          workflowSlug: "wf",
          resumeFrom: "s1",
        }),
      ),
    ).toBe(CHECK);
  });

  it("model_call: the body is stored under its own client's prefix", async () => {
    const call = {
      tenantId: A.tenantId,
      runId: A.runId,
      stepRunId: A.stepRunId,
      provider: "anthropic",
      model: "claude-opus-5-5",
      tokensIn: 1,
      tokensOut: 1,
      costUsd: "0.0001",
      durationMs: 10,
      stopReason: "end_turn",
    };
    expect(
      await errorCode(
        t.db
          .insert(modelCall)
          .values({ ...call, bodyKey: `tenants/${B.tenantId}/model-calls/x.json` }),
      ),
    ).toBe(CHECK);
    expect(
      await errorCode(
        t.db
          .insert(modelCall)
          .values({ ...call, tokensIn: -1, bodyKey: `tenants/${A.tenantId}/model-calls/y.json` }),
      ),
    ).toBe(CHECK);
    // A model call of another client's run is refused.
    expect(
      await errorCode(
        t.db.insert(modelCall).values({
          ...call,
          runId: B.runId,
          bodyKey: `tenants/${A.tenantId}/model-calls/z.json`,
        }),
      ),
    ).toBe(FOREIGN_KEY);
  });

  // RLS can't hold a view to its own operator: operator sessions carry no user id (app.user_id is
  // set only while signing in), so the routes filter by user_id. RLS keeps clients out entirely.
  it("saved_view: operator sessions only, never a client's, delete included", async () => {
    const client = await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      return tx.select().from(savedView);
    });
    expect(client).toEqual([]);
    const operator = await withOperator(t.db, [], async (tx) => {
      await asWorker(tx);
      return tx.select({ name: savedView.name }).from(savedView);
    });
    expect(operator.map((r) => r.name)).toEqual(["Failed this week"]);
    expect(
      await errorCode(
        withTenant(t.db, A.tenantId, async (tx) => {
          await asWorker(tx);
          await tx
            .insert(savedView)
            .values({ userId: A.userId, surface: "portal_runs", name: "Mine" });
        }),
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    // A client session's delete sees no view to delete.
    const clientDeleted = await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      return (await tx.execute(sql`delete from saved_view returning id`)).length;
    });
    expect(clientDeleted).toBe(0);
    const operatorDeleted = await withOperator(t.db, [], async (tx) => {
      await asWorker(tx);
      return tx.delete(savedView).where(eq(savedView.name, "Failed this week")).returning();
    });
    expect(operatorDeleted).toHaveLength(1);
  });

  it("receivable: one per connection and QuickBooks id, linked within its client", async () => {
    const [existing] = await t.db
      .select()
      .from(receivable)
      .where(eq(receivable.id, A.receivableId));
    if (!existing) throw new Error("no receivable");
    const { id: _id, createdAt: _c, updatedAt: _u, ...copy } = existing;
    expect(await errorCode(t.db.insert(receivable).values(copy))).toBe(UNIQUE);
    expect(
      await errorCode(
        t.db.insert(receivable).values({ ...copy, externalId: "inv-2", status: "late" as never }),
      ),
    ).toBe(CHECK);
    expect(
      await errorCode(
        t.db
          .insert(receivable)
          .values({ ...copy, externalId: "inv-3", connectionId: B.connectionId }),
      ),
    ).toBe(FOREIGN_KEY);
    // QuickBooks' DocNumber is optional: an invoice without one is stored with none.
    const [noNumber] = await t.db
      .insert(receivable)
      .values({ ...copy, externalId: "inv-4", docNumber: null })
      .returning({ docNumber: receivable.docNumber });
    expect(noNumber?.docNumber).toBeNull();
    await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      await tx
        .update(receivable)
        .set({ balance: "0.0000", status: "paid" })
        .where(eq(receivable.id, A.receivableId));
    });
  });

  it("contacts take autonomy; the knowledge base takes voice samples with their meta", async () => {
    const [c] = await t.db
      .select({ autonomy: contact.autonomy })
      .from(contact)
      .where(eq(contact.tenantId, A.tenantId));
    expect(c?.autonomy).toEqual({});
    await t.db
      .update(contact)
      .set({ autonomy: { email: "auto", voice: "off" } })
      .where(eq(contact.tenantId, A.tenantId));
    const [ke] = await t.db
      .insert(knowledgeEntry)
      .values({ tenantId: A.tenantId, kind: "voice_sample", createdBy: A.userId })
      .returning();
    if (!ke) throw new Error("no entry");
    const [kv] = await t.db
      .insert(knowledgeEntryVersion)
      .values({
        tenantId: A.tenantId,
        entryId: ke.id,
        version: 1,
        title: "Reply to Lakeside",
        body: "Thanks, we'll have it Friday.",
        status: "active",
        authorRole: "client_admin",
        meta: { personUserId: A.userId, channel: "email" },
      })
      .returning({ meta: knowledgeEntryVersion.meta });
    expect(kv?.meta).toEqual({ personUserId: A.userId, channel: "email" });
    expect(
      await errorCode(
        t.db
          .insert(knowledgeEntry)
          .values({ tenantId: A.tenantId, kind: "memo" as never, createdBy: A.userId }),
      ),
    ).toBe(CHECK);
    // Older versions read as no meta.
    const [old] = await t.db
      .select({ meta: knowledgeEntryVersion.meta })
      .from(knowledgeEntryVersion)
      .where(eq(knowledgeEntryVersion.tenantId, B.tenantId));
    expect(old?.meta).toEqual({});
  });
});
