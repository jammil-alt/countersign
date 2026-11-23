// Overnight S3.5 (WR7): Prepare bill is given the document it reads, and its sources are set in
// code from what it was given (the document and the reading), never left to the model, which
// wrote "no document id was provided" when it had none to cite (invariant 10).

import { agent } from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTemplate, fork, publish } from "../registry/agents";
import { SkillCatalog } from "../registry/skills";
import { runAgent } from "../runtime/run-agent";
import { PREPARE_BILL_SKILL, PREPARE_BILL_SKILL_DEFINITION } from "../tools/docs-split";
import { createHarness, type Harness, makeBundle } from "./harness.test-helper";
import { createRun } from "./run-log";

const harness = await createHarness();
afterAll(() => harness?.close());

const DOCUMENT_ID = "0193f000-0000-7000-8000-0000000000d1";
const EXTRACTION_ID = "0193f000-0000-7000-8000-0000000000e1";

const INVOICE = {
  id: EXTRACTION_ID,
  header: { vendorName: "Acme Supply", invoiceNumber: "A-77", currency: "USD" },
  lines: [{ description: "Boards", extPrice: "120.00" }],
  freight: "0",
  surcharges: [],
  tax: "0",
  total: "120.00",
};

/** The model's bill: everything right, and sources it made up. */
const PREPARED = {
  vendorId: "56",
  invoiceNumber: "A-77",
  date: "2026-11-20",
  dueDate: "2026-11-20",
  lines: [{ description: "Boards", amount: "120.00", account: "84" }],
  total: "120.00",
  currency: "USD",
  memo: "Invoice A-77 from Acme Supply",
  sources: ["no document id was provided"],
};

describe.skipIf(!harness)("Prepare bill's sources", () => {
  const h = harness as Harness;
  const catalog = new SkillCatalog([PREPARE_BILL_SKILL_DEFINITION], h.tools);
  let agentId = "";
  let versionId = "";

  beforeAll(async () => {
    const bundle = makeBundle({
      skills: [{ skill: PREPARE_BILL_SKILL, settings: {} }],
      workflows: [],
    });
    const ctx = { tools: h.tools, catalog };
    const a = await h.ops(async (tx) => {
      const { agent: tpl, version } = await createTemplate(tx, { slug: "bill-prep", bundle });
      const tv = await publish(tx, { agentId: tpl.id, versionId: version.id, ctx });
      const forked = await fork(tx, {
        tenantId: h.A.tenantId,
        slug: "bill-prep",
        templateVersionId: tv.id,
      });
      await publish(tx, { agentId: forked.agent.id, versionId: forked.version.id, ctx });
      await tx.update(agent).set({ runStatus: "active" }).where(eq(agent.id, forked.agent.id));
      return { agentId: forked.agent.id, versionId: forked.version.id };
    });
    agentId = a.agentId;
    versionId = a.versionId;
  });

  async function prepare(input: Record<string, unknown>) {
    const r = await h.client(h.A, (tx) =>
      createRun(tx, { tenantId: h.A.tenantId, agentId, workflowSlug: "bills", mode: "live" }),
    );
    const model = new FakeModel([{ toolUse: { name: "finish", input: PREPARED } }]);
    const result = await runAgent(
      { ...h.deps(model), catalog },
      {
        tenantId: h.A.tenantId,
        agentVersionId: versionId,
        skill: PREPARE_BILL_SKILL,
        input,
        runId: r.id,
        stepId: "prepare",
      },
    );
    return { result, model };
  }

  it("cites the document and its reading, whatever the model wrote", async () => {
    const { result, model } = await prepare({
      invoice: INVOICE,
      vendors: [{ id: "56", name: "Acme Supply" }],
      accounts: [{ id: "84", name: "Materials" }],
      documentId: DOCUMENT_ID,
    });
    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") return;
    expect((result.output as { sources: string[] }).sources).toEqual([DOCUMENT_ID, EXTRACTION_ID]);
    expect(result.sources).toEqual([DOCUMENT_ID, EXTRACTION_ID]);
    // The model is told the sources are added for it, and is given the document's id.
    expect(JSON.stringify(model.requests[0]?.system)).toContain("are added for you");
  });

  it("still cites the reading when a step gives no document id (Bill clerk v4)", async () => {
    const { result } = await prepare({
      invoice: INVOICE,
      vendors: [{ id: "56", name: "Acme Supply" }],
      accounts: [{ id: "84", name: "Materials" }],
    });
    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") return;
    expect((result.output as { sources: string[] }).sources).toEqual([EXTRACTION_ID]);
  });
});
