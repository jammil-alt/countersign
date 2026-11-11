// Reshape data (owner, 2026-11-11; docs/plan.md §1.86 "Reshape data"). The builder's two routes
// for a Reshape step between Read document and Create bill: the proposal (by name and type, then
// the Builder AI once for what is left, on a HAND-WRITTEN replay in fixtures/llm: no API key here)
// and the sample values (a client run's stored step output, else samples from the schemas). Both
// are operator only and audited. Rebuild the hand-written answer after changing the prompt with
//   WRITE_RESHAPE_FIXTURES=1 COUNTERSIGN_REQUIRE_DB=1 pnpm --filter @countersign/api exec vitest run src/reshape.test.ts
// then delete the file whose hash no longer appears.

import { processes } from "@countersign/core";
import { auditEvent, run, stepRun } from "@countersign/db";
import { fakeMessage, type LlmTransport, withRecording } from "@countersign/llm";
import { fileFixtureStore } from "@countersign/llm/node";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ApiHarness, admin, createApiHarness, OPERATOR, testBundle } from "./api.test-helper";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const WRITING = process.env.WRITE_RESHAPE_FIXTURES === "1";

/** The Builder AI's answer, written by hand: the memo from the PO number, and a bad vendor id. */
function writtenAnswer(): LlmTransport {
  return {
    async create(request) {
      const msg = fakeMessage(
        request.model,
        [
          {
            type: "tool_use",
            id: "toolu_handwritten_reshape_1",
            name: "suggest_mapping",
            input: {
              fields: [
                {
                  name: "memo",
                  expression: {
                    join: {
                      values: [{ value: "PO" }, { input: "readDocument.header.poNumber" }],
                      separator: " ",
                    },
                  },
                  why: "The PO number names the job the bill is for.",
                },
                // Not an expression from the allowed set: dropped, left for the operator.
                { name: "vendorId", expression: { lookup: "readDocument.header.vendorName" } },
              ],
            },
            caller: { type: "direct" },
          } as never,
        ],
        "tool_use",
        { input: 1800, output: 120 },
      );
      return { ...msg, id: "msg_handwritten_reshape_1" };
    },
  };
}

const store = fileFixtureStore();
const llm = WRITING
  ? withRecording(writtenAnswer(), {
      mode: "record",
      now: () => new Date("2026-11-11T12:00:00.000Z"),
      store: {
        read: store.read,
        // Marked so nobody mistakes it for a recorded answer.
        write: (call) => store.write({ ...call, handWritten: true } as typeof call),
      },
    })
  : withRecording(null, { mode: "replay", store });

const h = await createApiHarness({ llm });
afterAll(() => h?.close());

/** Read document, a new Reshape step, then Create bill: the builder's draft, unsaved. */
const draft = {
  schemaVersion: 4,
  triggers: [
    {
      id: "t1",
      on: {
        type: "manual",
        input: { type: "object", properties: { documentId: { type: "string" } } },
      },
    },
  ],
  steps: [
    {
      id: "read",
      name: "Read document",
      kind: "skill",
      skill: "docs.read-document",
      input: { documentId: "{{trigger.documentId}}" },
    },
    {
      id: "shape",
      name: "Reshape data",
      kind: "skill",
      skill: processes.RESHAPE_SKILL,
      input: {},
      reshape: { fields: [] },
    },
    { id: "bill", name: "Create bill", kind: "write", action: "create_bill", input: {} },
  ],
};

describe.skipIf(!h)("Reshape data in the back office", () => {
  const H = h as ApiHarness;
  let templateId = "";
  let clientAgentId = "";
  let clientVersionId = "";

  beforeAll(async () => {
    const template = await H.call(OPERATOR, "POST", "/api/ops/templates", {
      slug: "bill-shaper",
      bundle: testBundle("Bill shaper"),
      releaseNote: "First",
    });
    expect(template.status, JSON.stringify(template.json)).toBe(200);
    templateId = j(template.json).agent.id;
    await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${templateId}/versions/${j(template.json).version.id}/publish`,
    );
    const fork = await H.call(OPERATOR, "POST", `/api/ops/templates/${templateId}/fork`, {
      clientId: H.A.tenantId,
    });
    expect(fork.status, JSON.stringify(fork.json)).toBe(200);
    clientAgentId = j(fork.json).agent.id;
    clientVersionId = j(fork.json).version.id;
  });

  it("proposes by name and type, then keeps the Builder AI's checked suggestion", async () => {
    const res = await H.call(OPERATOR, "POST", `/api/ops/agents/${templateId}/reshape/propose`, {
      process: draft,
      stepId: "shape",
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const body = j(res.json);
    if (WRITING) return;
    expect(body.next).toEqual({ stepId: "bill", name: "Create bill" });
    expect(body.input).toEqual({ readDocument: "{{steps.read.output}}" });
    const from = Object.fromEntries(
      body.mapping.fields.map((f: { name: string; from?: unknown }) => [f.name, f.from]),
    );
    expect(from).toMatchObject({
      vendorName: { input: "readDocument.header.vendorName" },
      date: { input: "readDocument.header.invoiceDate" },
      total: { input: "readDocument.total" },
      memo: {
        join: {
          values: [{ value: "PO" }, { input: "readDocument.header.poNumber" }],
          separator: " ",
        },
      },
    });
    expect(from.vendorId).toBeUndefined();
    expect(body.how).toMatchObject({ vendorName: "exact", date: "synonym", memo: "ai" });
    expect(body.ai).toMatchObject({
      asked: true,
      fields: ["memo"],
      dropped: [{ field: "vendorId", reason: "not an expression from the allowed set" }],
      why: { memo: "The PO number names the job the bill is for." },
    });
    expect(body.ai.costUsd).toEqual(expect.any(String));
    expect(body.unmapped).toEqual(["vendorId", "lines.account", "lines.item"]);

    // The proposal, saved into the step, validates with the bill wired to it.
    const mapping = body.mapping as processes.ReshapeMapping;
    const steps = draft.steps.map((s) =>
      s.id === "shape"
        ? { ...s, input: body.input, reshape: mapping }
        : s.id === "bill"
          ? {
              ...s,
              input: processes.wireToReshape(
                s.input,
                "shape",
                mapping,
                processes.actionInputSchema("create_bill"),
              ),
            }
          : s,
    );
    const result = processes.validateProcess(
      { ...draft, steps },
      {
        skills: Object.fromEntries(H.platform.catalog.list().map((d) => [d.id, d])),
        tools: H.platform.tools.specs(),
      },
    );
    expect(result.errors).toEqual([]);

    // Audited like the builder's other routes.
    const audits = await H.t.db
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.action, "POST /api/ops/agents/:id/reshape/propose"));
    expect(audits.length).toBeGreaterThan(0);
  });

  it("asks no model when told not to, and keeps what still fits on an update", async () => {
    if (WRITING) return;
    const shaped = draft.steps.map((s) =>
      s.id === "shape"
        ? {
            ...s,
            input: { readDocument: "{{steps.read.output}}" },
            reshape: {
              fields: [
                {
                  name: "invoiceNumber",
                  schema: { type: "string" },
                  from: { input: "readDocument.header.invoiceNumber" },
                },
                {
                  name: "total",
                  schema: { type: "string" },
                  from: { input: "readDocument.header.nope" },
                },
              ],
            },
          }
        : s,
    );
    const res = await H.call(OPERATOR, "POST", `/api/ops/agents/${templateId}/reshape/propose`, {
      process: { ...draft, steps: shaped },
      stepId: "shape",
      update: true,
      ai: false,
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const body = j(res.json);
    expect(body.ai.asked).toBe(false);
    expect(body.how).toMatchObject({ invoiceNumber: "kept", total: "exact" });
  });

  it("samples from the schemas, then from the latest run's stored output", async () => {
    if (WRITING) return;
    const process = {
      ...draft,
      steps: draft.steps.map((s) =>
        s.id === "shape"
          ? {
              ...s,
              input: { readDocument: "{{steps.read.output}}" },
              reshape: {
                fields: [
                  {
                    name: "vendorName",
                    schema: { type: "string" },
                    from: { input: "readDocument.header.vendorName" },
                  },
                  {
                    name: "total",
                    schema: { type: "string" },
                    from: { formatMoney: { value: { input: "readDocument.total" } } },
                  },
                ],
              },
            }
          : s,
      ),
    };
    const sample = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${clientAgentId}/reshape/sample`,
      {
        process,
        stepId: "shape",
      },
    );
    expect(sample.status, JSON.stringify(sample.json)).toBe(200);
    expect(j(sample.json)).toMatchObject({
      source: "schema",
      run: null,
      fields: [
        { name: "vendorName", value: "Sample vendorName", problem: null },
        { name: "total", value: "125.00", problem: null },
      ],
    });

    // A test run of the client's agent read a real invoice: its stored output is the sample.
    const [r] = await H.t.db
      .insert(run)
      .values({
        tenantId: H.A.tenantId,
        agentId: clientAgentId,
        agentVersionId: clientVersionId,
        workflowSlug: "fix-record",
        mode: "test",
        status: "succeeded",
        trigger: { documentId: "doc-1" },
      })
      .returning();
    if (!r) throw new Error("no run");
    await H.t.db.insert(stepRun).values({
      tenantId: H.A.tenantId,
      runId: r.id,
      nodeId: "read",
      nodeType: "skill",
      status: "succeeded",
      output: { header: { vendorName: "Cascade Lumber" }, total: "1691.6" },
    });
    const real = await H.call(OPERATOR, "POST", `/api/ops/agents/${clientAgentId}/reshape/sample`, {
      process,
      stepId: "shape",
    });
    expect(j(real.json)).toMatchObject({
      source: "run",
      run: { id: r.id, mode: "test" },
      fields: [
        { name: "vendorName", value: "Cascade Lumber", problem: null },
        { name: "total", value: "1691.60", problem: null },
      ],
    });
    await H.t.db.delete(stepRun).where(and(eq(stepRun.runId, r.id)));
  });

  it("refuses a step that isn't a Reshape step, and anyone but the operator", async () => {
    if (WRITING) return;
    const notReshape = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${templateId}/reshape/propose`,
      { process: draft, stepId: "read" },
    );
    expect(notReshape.status).toBe(422);
    const client = await H.call(
      admin("a"),
      "POST",
      `/api/ops/agents/${templateId}/reshape/sample`,
      { process: draft, stepId: "shape" },
    );
    expect(client.status).toBe(403);
  });
});
