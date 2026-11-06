// Immutable history (CLAUDE.md invariant 3): version rows and raw records never change except their
// status column, and are never deleted, whoever tries (the owner included); the change logs are
// append-only.

import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withOperator, withTenant } from "./client";
import {
  BUNDLE,
  type ClientFixture,
  insertClient,
  insertOperatorRows,
} from "./fixtures.test-helper";
import {
  agentChange,
  agentVersion,
  automationVersion,
  billingAgentDay,
  billingEvent,
  billingStatement,
  billingStatementLine,
  billingUsageReport,
  connectionChange,
  contactChange,
  docExtraction,
  docLine,
  document,
  knowledgeEntryVersion,
  modelCall,
  notification,
  organizationChange,
  oversightDecision,
  rawRecord,
  skillVersion,
  testCaseResult,
} from "./schema";
import { asWorker, createTestDatabase, databaseAvailable, type TestDatabase } from "./testing";

const online = await databaseAvailable();

const RESTRICT_VIOLATION = "23001";

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.code ?? e.cause?.code ?? "unknown";
  }
  return undefined;
}

describe.skipIf(!online)("immutability", () => {
  let t: TestDatabase;
  let A: ClientFixture;
  let templateVersionId: string;
  let shared: Awaited<ReturnType<typeof insertOperatorRows>>;

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    A = await insertClient(t.db, "A");
    shared = await insertOperatorRows(t.db);
    templateVersionId = shared.agentVersionId;
  });
  afterAll(async () => {
    await t?.drop();
  });

  // As the migrating owner too: the triggers hold for every role, not only the Worker's.
  it("agent_version: the bundle can't change, the status can, nothing is deleted", async () => {
    const changed = {
      ...BUNDLE,
      workflows: [] as typeof BUNDLE.workflows,
      definition: { ...BUNDLE.definition, instructions: "Changed." },
    };
    expect(
      await errorCode(
        t.db
          .update(agentVersion)
          .set({ bundle: changed })
          .where(eq(agentVersion.id, A.agentVersionId)),
      ),
    ).toBe(RESTRICT_VIOLATION);
    expect(
      await errorCode(
        t.db
          .update(agentVersion)
          .set({ bundleHash: "other" })
          .where(eq(agentVersion.id, A.agentVersionId)),
      ),
    ).toBe(RESTRICT_VIOLATION);
    await t.db
      .update(agentVersion)
      .set({ status: "retired" })
      .where(eq(agentVersion.id, A.agentVersionId));
    const [row] = await t.db
      .select({ status: agentVersion.status })
      .from(agentVersion)
      .where(eq(agentVersion.id, A.agentVersionId));
    expect(row?.status).toBe("retired");
    expect(
      await errorCode(t.db.delete(agentVersion).where(eq(agentVersion.id, A.agentVersionId))),
    ).toBe(RESTRICT_VIOLATION);
  });

  it("agent_version: the same holds for a template as the operator in the Worker's role", async () => {
    await withOperator(t.db, [], async (tx) => {
      await asWorker(tx);
      await tx
        .update(agentVersion)
        .set({ status: "live" })
        .where(eq(agentVersion.id, templateVersionId));
    });
    expect(
      await errorCode(
        withOperator(t.db, [], async (tx) => {
          await asWorker(tx);
          await tx
            .update(agentVersion)
            .set({ changeNote: "rewritten" })
            .where(eq(agentVersion.id, templateVersionId));
        }),
      ),
    ).toBe(RESTRICT_VIOLATION);
  });

  it("skill_version: the definition can't change, the status can, nothing is deleted", async () => {
    expect(
      await errorCode(
        t.db
          .update(skillVersion)
          .set({ definitionHash: "x" })
          .where(eq(skillVersion.id, A.skillVersionId)),
      ),
    ).toBe(RESTRICT_VIOLATION);
    await t.db
      .update(skillVersion)
      .set({ status: "retired" })
      .where(eq(skillVersion.id, A.skillVersionId));
    expect(
      await errorCode(t.db.delete(skillVersion).where(eq(skillVersion.id, A.skillVersionId))),
    ).toBe(RESTRICT_VIOLATION);
  });

  it("raw_record: the payload can't change, is_deleted can, nothing is deleted", async () => {
    expect(
      await errorCode(
        t.db
          .update(rawRecord)
          .set({ payload: { a: 2 } })
          .where(eq(rawRecord.id, A.rawRecordId)),
      ),
    ).toBe(RESTRICT_VIOLATION);
    await t.db.update(rawRecord).set({ isDeleted: true }).where(eq(rawRecord.id, A.rawRecordId));
    expect(await errorCode(t.db.delete(rawRecord).where(eq(rawRecord.id, A.rawRecordId)))).toBe(
      RESTRICT_VIOLATION,
    );
  });

  it("connection_change, agent_change, contact_change and organization_change are append-only", async () => {
    for (const table of [connectionChange, agentChange, contactChange, organizationChange]) {
      expect(await errorCode(t.db.update(table).set({ change: { edited: true } }))).toBe(
        RESTRICT_VIOLATION,
      );
      expect(await errorCode(t.db.delete(table))).toBe(RESTRICT_VIOLATION);
    }
  });

  it("knowledge_entry_version is append-only: an edit is a new version", async () => {
    expect(await errorCode(t.db.update(knowledgeEntryVersion).set({ body: "edited" }))).toBe(
      RESTRICT_VIOLATION,
    );
    expect(await errorCode(t.db.delete(knowledgeEntryVersion))).toBe(RESTRICT_VIOLATION);
  });

  it("billing_usage_report: only status, error and sent_at change; billing_event never does", async () => {
    expect(await errorCode(t.db.update(billingUsageReport).set({ quantity: 99 }))).toBe(
      RESTRICT_VIOLATION,
    );
    await t.db.update(billingUsageReport).set({ status: "sent", sentAt: new Date(), error: null });
    expect(await errorCode(t.db.delete(billingUsageReport))).toBe(RESTRICT_VIOLATION);
    expect(await errorCode(t.db.update(billingEvent).set({ type: "x" }))).toBe(RESTRICT_VIOLATION);
    expect(await errorCode(t.db.delete(billingEvent))).toBe(RESTRICT_VIOLATION);
  });

  it("billing_agent_day never changes; a statement's lines freeze once its send starts", async () => {
    expect(await errorCode(t.db.update(billingAgentDay).set({ monthlyPrice: "1.0000" }))).toBe(
      RESTRICT_VIOLATION,
    );
    expect(await errorCode(t.db.delete(billingAgentDay))).toBe(RESTRICT_VIOLATION);
    const [st] = await t.db
      .select()
      .from(billingStatement)
      .where(eq(billingStatement.tenantId, A.tenantId));
    if (!st) throw new Error("no statement");
    const line = (over: Partial<typeof billingStatementLine.$inferInsert> = {}) =>
      t.db.insert(billingStatementLine).values({
        tenantId: A.tenantId,
        statementId: st.id,
        position: 9,
        kind: "adjustment",
        description: "Credit for a slow week",
        amount: "-1.0000",
        ...over,
      });
    // A draft takes adjustments and gives them back; its other lines stay.
    await line();
    await t.db
      .delete(billingStatementLine)
      .where(
        and(
          eq(billingStatementLine.statementId, st.id),
          eq(billingStatementLine.kind, "adjustment"),
        ),
      );
    expect(
      await errorCode(
        t.db.delete(billingStatementLine).where(eq(billingStatementLine.kind, "agent")),
      ),
    ).toBe(RESTRICT_VIOLATION);
    expect(await errorCode(t.db.update(billingStatementLine).set({ amount: "9.0000" }))).toBe(
      RESTRICT_VIOLATION,
    );
    await t.db
      .update(billingStatement)
      .set({ total: "2.2300" })
      .where(eq(billingStatement.id, st.id));
    // Once Stripe has the invoice: no new lines, no total change; an item id is set once.
    await t.db
      .update(billingStatement)
      .set({ stripeInvoiceId: "in_1" })
      .where(eq(billingStatement.id, st.id));
    expect(await errorCode(line())).toBe(RESTRICT_VIOLATION);
    expect(
      await errorCode(
        t.db
          .update(billingStatement)
          .set({ total: "0.0000" })
          .where(eq(billingStatement.id, st.id)),
      ),
    ).toBe(RESTRICT_VIOLATION);
    await t.db.update(billingStatementLine).set({ stripeInvoiceItemId: "ii_1" });
    expect(
      await errorCode(t.db.update(billingStatementLine).set({ stripeInvoiceItemId: "ii_2" })),
    ).toBe(RESTRICT_VIOLATION);
    // Sent, then void for good; never back to draft, never deleted, its month never moves.
    await t.db
      .update(billingStatement)
      .set({ status: "sent" })
      .where(eq(billingStatement.id, st.id));
    expect(
      await errorCode(
        t.db
          .update(billingStatement)
          .set({ status: "draft" })
          .where(eq(billingStatement.id, st.id)),
      ),
    ).toBe(RESTRICT_VIOLATION);
    expect(
      await errorCode(
        t.db.update(billingStatement).set({ creditsUsed: 5 }).where(eq(billingStatement.id, st.id)),
      ),
    ).toBe(RESTRICT_VIOLATION);
    await t.db
      .update(billingStatement)
      .set({ status: "void" })
      .where(eq(billingStatement.id, st.id));
    expect(
      await errorCode(
        t.db.update(billingStatement).set({ status: "paid" }).where(eq(billingStatement.id, st.id)),
      ),
    ).toBe(RESTRICT_VIOLATION);
    expect(await errorCode(t.db.delete(billingStatement))).toBe(RESTRICT_VIOLATION);
  });

  it("doc_extraction and doc_line never change and are never deleted; the document's status can", async () => {
    expect(
      await errorCode(
        t.db
          .update(docExtraction)
          .set({ totalsMatch: false })
          .where(eq(docExtraction.id, A.extractionId)),
      ),
    ).toBe(RESTRICT_VIOLATION);
    expect(
      await errorCode(t.db.delete(docExtraction).where(eq(docExtraction.id, A.extractionId))),
    ).toBe(RESTRICT_VIOLATION);
    expect(
      await errorCode(t.db.update(docLine).set({ qty: "2" }).where(eq(docLine.id, A.docLineId))),
    ).toBe(RESTRICT_VIOLATION);
    expect(await errorCode(t.db.delete(docLine).where(eq(docLine.id, A.docLineId)))).toBe(
      RESTRICT_VIOLATION,
    );
    await t.db
      .update(document)
      .set({ status: "needs_review" })
      .where(eq(document.id, A.documentId));
  });

  it("doc_extraction's cost is written at insert and never changes (0018)", async () => {
    const [row] = await t.db
      .select({ cost: docExtraction.costUsd, tin: docExtraction.tokensIn })
      .from(docExtraction)
      .where(eq(docExtraction.id, A.extractionId));
    expect(row).toEqual({ cost: "0.0000", tin: 0 });
    expect(
      await errorCode(
        t.db
          .update(docExtraction)
          .set({ costUsd: "0.0100", tokensIn: 10 })
          .where(eq(docExtraction.id, A.extractionId)),
      ),
    ).toBe(RESTRICT_VIOLATION);
  });

  it("model_call is insert only, for the owner and the Worker's role (0023)", async () => {
    expect(
      await errorCode(
        t.db.update(modelCall).set({ costUsd: "0.0000" }).where(eq(modelCall.id, A.modelCallId)),
      ),
    ).toBe(RESTRICT_VIOLATION);
    expect(await errorCode(t.db.delete(modelCall).where(eq(modelCall.id, A.modelCallId)))).toBe(
      RESTRICT_VIOLATION,
    );
    for (const statement of [
      sql`update model_call set tokens_out = 0 where id = ${A.modelCallId}`,
      sql`delete from model_call where id = ${A.modelCallId}`,
    ]) {
      const code = await errorCode(
        withTenant(t.db, A.tenantId, async (tx) => {
          await asWorker(tx);
          await tx.execute(statement);
        }),
      );
      expect(code).toBe("42501");
    }
  });

  it("notification: only status, reason, provider_id and sent_at change; never deleted (0020)", async () => {
    await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      await tx
        .update(notification)
        .set({ status: "sent", providerId: "re_123", sentAt: new Date(), reason: null })
        .where(eq(notification.id, A.notificationId));
    });
    for (const change of [
      { link: "/elsewhere" },
      { counts: { items: 9 } },
      { dedupeKey: "other" },
      { userId: null },
    ]) {
      expect(
        await errorCode(
          t.db.update(notification).set(change).where(eq(notification.id, A.notificationId)),
        ),
        JSON.stringify(change),
      ).toBe(RESTRICT_VIOLATION);
    }
    expect(
      await errorCode(t.db.delete(notification).where(eq(notification.id, A.notificationId))),
    ).toBe(RESTRICT_VIOLATION);
    const [row] = await t.db
      .select({ status: notification.status, providerId: notification.providerId })
      .from(notification)
      .where(eq(notification.id, A.notificationId));
    expect(row).toEqual({ status: "sent", providerId: "re_123" });
  });

  it("automation_version: the definition can't change, the status can, nothing is deleted (0027)", async () => {
    for (const change of [
      { definitionHash: "x" },
      { definition: { changed: true } },
      { version: 2 },
      { changeNote: "rewritten" },
    ]) {
      expect(
        await errorCode(
          t.db
            .update(automationVersion)
            .set(change)
            .where(eq(automationVersion.id, A.automationVersionId)),
        ),
        JSON.stringify(change),
      ).toBe(RESTRICT_VIOLATION);
    }
    await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      await tx
        .update(automationVersion)
        .set({ status: "retired" })
        .where(eq(automationVersion.id, A.automationVersionId));
    });
    // A shared version, as the operator in the Worker's role.
    await withOperator(t.db, [], async (tx) => {
      await asWorker(tx);
      await tx
        .update(automationVersion)
        .set({ status: "live" })
        .where(eq(automationVersion.id, shared.automationVersionId));
    });
    expect(
      await errorCode(
        withOperator(t.db, [], async (tx) => {
          await asWorker(tx);
          await tx
            .update(automationVersion)
            .set({ definitionHash: "y" })
            .where(eq(automationVersion.id, shared.automationVersionId));
        }),
      ),
    ).toBe(RESTRICT_VIOLATION);
    expect(
      await errorCode(
        t.db.delete(automationVersion).where(eq(automationVersion.id, A.automationVersionId)),
      ),
    ).toBe(RESTRICT_VIOLATION);
    const [row] = await t.db
      .select({ status: automationVersion.status })
      .from(automationVersion)
      .where(eq(automationVersion.id, A.automationVersionId));
    expect(row?.status).toBe("retired");
  });

  it("test_case_result and oversight_decision are insert only, for the owner and the Worker (0028, 0029)", async () => {
    expect(
      await errorCode(
        t.db
          .update(testCaseResult)
          .set({ status: "fail" })
          .where(eq(testCaseResult.id, A.testCaseResultId)),
      ),
    ).toBe(RESTRICT_VIOLATION);
    expect(
      await errorCode(t.db.delete(testCaseResult).where(eq(testCaseResult.id, A.testCaseResultId))),
    ).toBe(RESTRICT_VIOLATION);
    expect(
      await errorCode(
        t.db
          .update(testCaseResult)
          .set({ status: "pass" })
          .where(eq(testCaseResult.id, shared.testCaseResultId)),
      ),
    ).toBe(RESTRICT_VIOLATION);
    expect(
      await errorCode(
        t.db
          .update(oversightDecision)
          .set({ note: "Rewritten." })
          .where(eq(oversightDecision.id, A.oversightDecisionId)),
      ),
    ).toBe(RESTRICT_VIOLATION);
    expect(
      await errorCode(
        t.db.delete(oversightDecision).where(eq(oversightDecision.id, A.oversightDecisionId)),
      ),
    ).toBe(RESTRICT_VIOLATION);
    for (const statement of [
      sql`update test_case_result set status = 'error' where id = ${A.testCaseResultId}`,
      sql`delete from test_case_result where id = ${A.testCaseResultId}`,
      sql`update oversight_decision set action = 'stop' where id = ${A.oversightDecisionId}`,
      sql`delete from oversight_decision where id = ${A.oversightDecisionId}`,
    ]) {
      const code = await errorCode(
        withOperator(t.db, [A.tenantId], async (tx) => {
          await asWorker(tx);
          await tx.execute(statement);
        }),
      );
      expect(code).toBe("42501");
    }
  });

  it("the Worker's role cannot update an extraction or delete a document", async () => {
    for (const statement of [
      sql`update doc_extraction set model = 'x' where id = ${A.extractionId}`,
      sql`delete from document where id = ${A.documentId}`,
    ]) {
      const code = await errorCode(
        withOperator(t.db, [A.tenantId], async (tx) => {
          await asWorker(tx);
          await tx.execute(statement);
        }),
      );
      expect(code).toBe("42501");
    }
  });

  it("the Worker's role has no DELETE on history at all", async () => {
    const code = await errorCode(
      withOperator(t.db, [A.tenantId], async (tx) => {
        await asWorker(tx);
        await tx.execute(sql`delete from agent_version where id = ${A.agentVersionId}`);
      }),
    );
    expect(code).toBe("42501");
  });
});
