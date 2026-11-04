// The documents capability through the agent runtime (plan M3): a client agent's `docs.extract`
// skill reads a golden invoice in replay mode, writes the extraction with its agent version, and
// logs the model's cost on the step and the run. `docs.find-support` then links it.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ContentStore, ensureUploadConnection, MemoryObjectStore } from "@countersign/connectors";
import { agent, docExtraction, run, stepRun, transaction, vendor } from "@countersign/db";
import { storeDocument } from "@countersign/documents";
import { withRecording } from "@countersign/llm";
import { DEFAULT_FIXTURE_DIR, fileFixtureStore } from "@countersign/llm/node";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTemplate, fork, publish } from "../registry/agents";
import { SkillCatalog } from "../registry/skills";
import { runAgent } from "../runtime/run-agent";
import { DOCS_SKILLS } from "../tools/docs";
import { createHarness, type Harness, makeBundle } from "./harness.test-helper";
import { createDbPorts } from "./ports";
import { createRun } from "./run-log";

const harness = await createHarness();
afterAll(() => harness?.close());

const INVOICE = resolve(DEFAULT_FIXTURE_DIR, "../invoices/northline-20418.pdf");

describe.skipIf(!harness)("docs tools in the runtime", () => {
  const h = harness as Harness;
  const content = new ContentStore(new MemoryObjectStore());
  const catalog = new SkillCatalog(DOCS_SKILLS, h.tools);
  const transport = withRecording(null, { mode: "replay", store: fileFixtureStore() });
  const ports = createDbPorts(h.db, { documents: { content, transport } });
  const deps = () => ({ ports, tools: h.tools, catalog, transport });
  let agentId = "";
  let versionId = "";
  let documentId = "";

  beforeAll(async () => {
    const bundle = makeBundle({
      skills: [
        { skill: "docs.extract", settings: {} },
        { skill: "docs.find-support", settings: {} },
      ],
      workflows: [],
    });
    const ctx = { tools: h.tools, catalog };
    const tv = await h.ops(async (tx) => {
      const t = await createTemplate(tx, { slug: "clerk", bundle });
      return publish(tx, { agentId: t.agent.id, versionId: t.version.id, ctx });
    });
    const forked = await h.ops(async (tx) => {
      const f = await fork(tx, { tenantId: h.A.tenantId, slug: "clerk", templateVersionId: tv.id });
      await publish(tx, { agentId: f.agent.id, versionId: f.version.id, ctx });
      await tx.update(agent).set({ runStatus: "active" }).where(eq(agent.id, f.agent.id));
      return f;
    });
    agentId = forked.agent.id;
    versionId = forked.version.id;
    documentId = await h.client(h.A, async (tx) => {
      const conn = await ensureUploadConnection(tx, h.A.tenantId);
      const stored = await storeDocument(tx, content, {
        tenantId: h.A.tenantId,
        source: "upload",
        connectionId: conn.id,
        bytes: new Uint8Array(readFileSync(INVOICE)),
        filename: "northline-20418.pdf",
        mimeType: "application/pdf",
      });
      return stored.document.id;
    });
  });

  it("docs.extract reads the invoice, records the agent version, and logs cost on the step", async () => {
    const r = await h.client(h.A, (tx) =>
      createRun(tx, { tenantId: h.A.tenantId, agentId, workflowSlug: "manual", mode: "live" }),
    );
    const result = await runAgent(deps(), {
      tenantId: h.A.tenantId,
      agentVersionId: versionId,
      skill: "docs.extract",
      input: { documentId },
      runId: r.id,
      stepId: "step-extract",
    });
    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") return;
    expect(result.output).toMatchObject({
      lineCount: 6,
      vendorName: "Northline Panel Supply",
      status: "extracted",
    });
    expect(result.summary).toBe("Read 6 lines from Northline Panel Supply invoice 20418");
    expect(result.sources).toContain(documentId);
    const [x] = await h.client(h.A, (tx) =>
      tx.select().from(docExtraction).where(eq(docExtraction.documentId, documentId)),
    );
    expect(x?.agentVersionId).toBe(versionId);
    const [sr] = await h.client(h.A, (tx) =>
      tx.select().from(stepRun).where(eq(stepRun.id, result.stepRunId)),
    );
    expect(Number(sr?.costUsd)).toBeGreaterThan(0);
    const [runRow] = await h.client(h.A, (tx) => tx.select().from(run).where(eq(run.id, r.id)));
    expect(runRow?.costUsd).toBe(sr?.costUsd);
  });

  it("docs.find-support links the extracted invoice to its transaction", async () => {
    const txn = await h.client(h.A, async (tx) => {
      const [v] = await tx
        .insert(vendor)
        .values({
          tenantId: h.A.tenantId,
          name: "Northline Panel Supply",
          normalizedName: "northline panel supply",
        })
        .returning();
      const [t] = await tx
        .insert(transaction)
        .values({
          tenantId: h.A.tenantId,
          kind: "purchase",
          connector: "upload",
          vendorId: v?.id ?? null,
          txnDate: "2026-10-29",
          total: "9742.35",
          externalId: "card-1",
        })
        .returning();
      return t;
    });
    const r = await h.client(h.A, (tx) =>
      createRun(tx, { tenantId: h.A.tenantId, agentId, workflowSlug: "manual", mode: "live" }),
    );
    const result = await runAgent(deps(), {
      tenantId: h.A.tenantId,
      agentVersionId: versionId,
      skill: "docs.find-support",
      input: { transactionId: txn?.id },
      runId: r.id,
      stepId: "step-support",
    });
    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") return;
    expect(result.output).toMatchObject({
      status: "found",
      documentIds: [documentId],
      linkedNow: true,
    });
  });

  it("another client can't reach the document through the tool", async () => {
    const r = await h.client(h.B, async (tx) => {
      const [a] = await tx.select().from(agent).limit(1);
      return a;
    });
    expect(r).toBeUndefined();
    const doc = await ports.documents?.get(h.B.tenantId, documentId);
    expect(doc).toBeNull();
  });
});
