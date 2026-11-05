// Immutable history (CLAUDE.md invariant 3): version rows and raw records never change except their
// status column, and are never deleted, whoever tries (the owner included); the change logs are
// append-only.

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withOperator } from "./client";
import {
  BUNDLE,
  type ClientFixture,
  insertClient,
  insertOperatorRows,
} from "./fixtures.test-helper";
import {
  agentChange,
  agentVersion,
  billingEvent,
  billingUsageReport,
  connectionChange,
  contactChange,
  docExtraction,
  docLine,
  document,
  knowledgeEntryVersion,
  organizationChange,
  rawRecord,
  skillVersion,
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

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    A = await insertClient(t.db, "A");
    templateVersionId = (await insertOperatorRows(t.db)).agentVersionId;
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
