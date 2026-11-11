// Reshape data (2026-11-11) end to end in the executor: Read document's output, reshaped into
// Create bill's input, runs as one process. The executor hands the Reshape step's mapping to the
// agent port with its resolved input; the port here runs it as the runtime's pure handler does
// (core's `evaluateReshape`), and the bill action gets the reshaped fields, mapped to QuickBooks'.
import {
  InvoiceExtraction,
  type JsonSchema,
  processes,
  type SkillDefinition,
} from "@countersign/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { executeWorkflow } from "./executor";
import { FakeStepRunner } from "./fake-runner";
import { Harness } from "./fakes.test-helper";
import type { SkillStepRequest } from "./ports";

const READ: SkillDefinition = {
  schemaVersion: 1,
  id: "docs.read-document",
  name: "Read document",
  description: "Reads an invoice.",
  category: "documents",
  mode: "task",
  model: { id: "claude-haiku-5-5" },
  instructions: "Read it.",
  tools: [],
  input: { type: "object", properties: { documentId: { type: "string" } } },
  output: z.toJSONSchema(InvoiceExtraction, { io: "output" }) as JsonSchema,
  settings: [],
  requiresConnectors: [],
  requiresPacks: [],
  producesAlerts: false,
};

const RESHAPE: SkillDefinition = {
  ...READ,
  id: processes.RESHAPE_SKILL,
  name: "Reshape data",
  mode: "tool",
  model: undefined,
  instructions: undefined,
  handler: processes.RESHAPE_TOOL,
  tools: [processes.RESHAPE_TOOL],
  input: { type: "object", additionalProperties: true },
  output: { type: "object", additionalProperties: true },
};

const typing = { skills: { [READ.id]: READ, [RESHAPE.id]: RESHAPE } };

/** What Read document read (the golden invoice's shape). */
const READING = {
  header: {
    vendorName: "Cascade Lumber",
    vendorAddress: null,
    invoiceNumber: "INV-1042",
    invoiceDate: "2026-10-28",
    dueDate: null,
    poNumber: "JOB-77",
    currency: "USD",
    pageCount: 1,
    confidence: { vendorName: 1, invoiceNumber: 1, invoiceDate: 1, total: 1 },
  },
  lines: [
    {
      lineNo: 1,
      vendorSku: null,
      description: "2x4 stud 8ft",
      qty: "100",
      uom: "EA",
      unitPrice: "5.125",
      extPrice: "512.50",
      discount: null,
      page: 1,
    },
    {
      lineNo: 2,
      vendorSku: null,
      description: "Plywood 3/4",
      qty: "20",
      uom: "SHT",
      unitPrice: "55.205",
      extPrice: "1104.10",
      discount: null,
      page: 1,
    },
  ],
  subtotal: "1616.60",
  freight: "0",
  surcharges: [],
  tax: "0",
  total: "1616.60",
  confidence: 0.98,
};

/** The process as the builder leaves it: Read, then a proposed Reshape, then Create bill wired to it. */
function billProcess(): processes.Process {
  const base = processes.Process.parse({
    schemaVersion: 4,
    triggers: [
      {
        id: "t",
        on: {
          type: "manual",
          input: { type: "object", properties: { documentId: { type: "string" } } },
        },
      },
    ],
    steps: [
      {
        id: "read",
        kind: "skill",
        name: "Read document",
        skill: READ.id,
        input: { documentId: "{{trigger.documentId}}" },
      },
      {
        id: "shape",
        kind: "skill",
        name: "Reshape data",
        skill: RESHAPE.id,
        input: {},
        reshape: { fields: [] },
      },
      { id: "bill", kind: "write", name: "Create bill", action: "create_bill", input: {} },
    ],
  });
  const context = processes.reshapeContext(base, "shape", typing);
  if (!context) throw new Error("no context");
  const p = processes.proposeReshape({ context });
  // The operator adds a memo by hand, in the review.
  const mapping: processes.ReshapeMapping = {
    fields: p.mapping.fields.map((f) =>
      f.name === "memo"
        ? {
            ...f,
            from: {
              join: { values: [{ value: "PO" }, { input: "readDocument.header.poNumber" }] },
            },
          }
        : f,
    ),
  };
  return processes.Process.parse({
    ...base,
    steps: base.steps.map((s) => {
      if (s.id === "shape") return { ...s, input: p.input, reshape: mapping };
      if (s.id === "bill" && s.kind === "write") {
        return {
          ...s,
          input: processes.wireToReshape(
            s.input,
            "shape",
            mapping,
            processes.actionInputSchema("create_bill"),
          ),
        };
      }
      return s;
    }),
  });
}

describe("Reshape data between Read document and Create bill", () => {
  it("validates, then runs: the bill gets the reshaped fields in QuickBooks' shape", async () => {
    const process = billProcess();
    expect(processes.validateProcess(process, typing).errors).toEqual([]);

    const h = new Harness();
    h.agent.resolveAction = async () => ({ tool: "qbo.bill.create", connector: "qbo" });
    h.handlers.read = () => ({ kind: "done", output: READING });
    h.handlers.shape = (req) => {
      const { reshape, input } = req as SkillStepRequest;
      if (!reshape) return { kind: "failed", error: "no mapping" };
      const r = processes.evaluateReshape(reshape, input, { today: "2026-11-11" });
      return r.problems.length > 0
        ? { kind: "failed", error: r.problems.map((x) => x.message).join("; ") }
        : { kind: "done", output: r.output };
    };
    h.handlers.bill = (req) => ({ kind: "done", output: { billId: "9", input: req.input } });

    const result = await executeWorkflow(new FakeStepRunner(), h.context(), process, {
      documentId: "doc-1",
    });
    // The run stops at Create bill: QuickBooks takes a vendor by id, which nothing maps yet.
    expect(result.status).toBe("failed");

    const shape = h.agentCalls.find((c) => c.step.id === "shape") as SkillStepRequest;
    expect(shape.input).toEqual({ readDocument: READING });
    expect(shape.reshape?.fields.map((f) => f.name)).toEqual([
      "vendorId",
      "vendorName",
      "invoiceNumber",
      "date",
      "dueDate",
      "lines",
      "total",
      "currency",
      "memo",
    ]);
    expect(h.row("shape")?.output).toEqual({
      vendorName: "Cascade Lumber",
      invoiceNumber: "INV-1042",
      date: "2026-10-28",
      lines: [
        { description: "2x4 stud 8ft", amount: "512.50" },
        { description: "Plywood 3/4", amount: "1104.10" },
      ],
      total: "1616.60",
      currency: "USD",
      memo: "PO JOB-77",
    });
    // Create bill's input, mapped to QuickBooks' (the vendor by name is QuickBooks' to refuse:
    // a bill names its vendor by id, so the operator maps vendorId before going live).
    // Refused before anything is sent: the port never sees the bill.
    expect(h.agentCalls.some((c) => c.step.id === "bill")).toBe(false);
    expect(h.row("bill")).toMatchObject({ status: "failed" });
    expect(h.row("bill")?.error).toMatch(/refused: .*vendor/i);
  });

  it("with the vendor's id mapped, the bill is proposed with every field", async () => {
    const process = billProcess();
    const steps = process.steps.map((s) =>
      s.id === "shape" && s.kind === "skill" && s.reshape
        ? {
            ...s,
            reshape: {
              fields: s.reshape.fields.map((f) =>
                f.name === "vendorId" ? { ...f, from: { value: "56" } } : f,
              ),
            },
          }
        : s,
    );
    const h = new Harness();
    h.agent.resolveAction = async () => ({ tool: "qbo.bill.create", connector: "qbo" });
    h.handlers.read = () => ({ kind: "done", output: READING });
    h.handlers.shape = (req) => {
      const { reshape, input } = req as SkillStepRequest;
      const r = processes.evaluateReshape(reshape as processes.ReshapeMapping, input, {
        today: "2026-11-11",
      });
      return { kind: "done", output: r.output };
    };
    h.handlers.bill = (req) => ({ kind: "done", output: { billId: "9", input: req.input } });
    const result = await executeWorkflow(
      new FakeStepRunner(),
      h.context(),
      { ...process, steps } as processes.Process,
      { documentId: "doc-1" },
    );
    expect(result.status).toBe("succeeded");
    expect(h.agentCalls.find((c) => c.step.id === "bill")?.input).toEqual({
      vendorId: "56",
      docNumber: "INV-1042",
      txnDate: "2026-10-28",
      currency: "USD",
      expectedTotal: "1616.60",
      privateNote: "PO JOB-77",
      lines: [
        { description: "2x4 stud 8ft", amount: "512.50" },
        { description: "Plywood 3/4", amount: "1104.10" },
      ],
    });
    expect(h.row("bill")).toMatchObject({ nodeType: "write", status: "succeeded" });
  });
});
