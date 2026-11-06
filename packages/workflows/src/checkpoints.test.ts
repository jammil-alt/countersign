// v0.13 W2-I, M32: checkpoint reviews in the executor (ARCHITECTURE §10.11; docs/plan.md §1.54). A
// step whose output feeds a write is reviewed after it succeeds; the executor applies `continue`,
// `retry_with`, `ask` and `stop` there. It never calls a model.

import {
  type AutomationDefinition,
  AutomationDefinition as AutomationSchema,
  OversightSettings,
} from "@countersign/core";
import { describe, expect, it } from "vitest";
import { executeWorkflow } from "./executor";
import { FakeStepRunner } from "./fake-runner";
import { Harness, SKILL, WRITE_TOOL, wf } from "./fakes.test-helper";
import type { OversightPort, OversightRequest, OversightVerdict } from "./ports";
import { inboxEventType } from "./runner";

function port(...verdicts: OversightVerdict[]) {
  const requests: OversightRequest[] = [];
  const p: OversightPort = {
    async review(req) {
      requests.push(req);
      return verdicts.shift() ?? { action: "none", reason: "script ran out" };
    },
  };
  return { port: p, requests };
}

const settings = (review: string, over: Record<string, unknown> = {}) =>
  OversightSettings.parse({ review, ...over });

const CATALOG = { skills: { [SKILL.id]: SKILL }, tools: { [WRITE_TOOL.id]: WRITE_TOOL } };

/** Read an invoice, then write its total: the read is a checkpoint. */
const steps = (readOver: Record<string, unknown> = {}) => [
  {
    id: "read",
    kind: "skill",
    name: "Read the invoice",
    skill: SKILL.id,
    input: { doc: "{{trigger.doc}}" },
    ...readOver,
  },
  {
    id: "bill",
    kind: "action",
    name: "Create the bill",
    tool: WRITE_TOOL.id,
    input: { total: "{{steps.read.output.total}}" },
  },
];

/** The first read takes the subtotal; a read with a hint takes the total. */
function reads(h: Harness) {
  h.handlers.read = (req) => {
    const hint = (req.input as { hint?: string }).hint;
    return { kind: "done", output: { total: hint ? "112.50" : "100.00" } };
  };
  h.handlers.bill = (req) => ({ kind: "done", output: req.input });
}

describe("checkpoint reviews", () => {
  it("makes no oversight call on a clean run under `failures`", async () => {
    const h = new Harness();
    reads(h);
    const o = port();
    const result = await executeWorkflow(
      new FakeStepRunner(),
      h.context({ catalog: CATALOG, oversight: { port: o.port, settings: settings("failures") } }),
      wf(steps()),
      { doc: "d-1" },
    );
    expect(result).toEqual({ status: "succeeded" });
    expect(o.requests).toEqual([]);
  });

  it("reviews a step whose output feeds a write, with its output; continue goes on as it was", async () => {
    const h = new Harness();
    reads(h);
    const o = port({ action: "continue", note: "The total matches the lines." });
    const runner = new FakeStepRunner();
    const result = await executeWorkflow(
      runner,
      h.context({
        catalog: CATALOG,
        oversight: { port: o.port, settings: settings("checkpoints") },
      }),
      wf(steps()),
      { doc: "d-1" },
    );
    expect(result).toEqual({ status: "succeeded" });
    // Only the checkpoint: the write itself feeds nothing.
    expect(o.requests).toEqual([
      expect.objectContaining({
        nodeId: "read",
        seq: 1,
        cause: "checkpoint",
        output: { total: "100.00" },
        input: { doc: "d-1" },
        error: "",
      }),
    ]);
    expect(h.agentCalls.at(-1)?.input).toEqual({ total: "100.00" });
    expect(runner.names()).toEqual(["read", "read:oversee:1", "bill"]);
  });

  it("corrects a wrong total before the write: the read runs again, and the write sees the correction", async () => {
    const h = new Harness();
    reads(h);
    const o = port(
      {
        action: "retry_with",
        input: { doc: "d-1", hint: "The total is 112.50; the first read took the subtotal." },
        note: "The total read is the subtotal.",
      },
      { action: "continue", note: "Now it matches." },
    );
    const result = await executeWorkflow(
      new FakeStepRunner(),
      h.context({
        catalog: CATALOG,
        oversight: { port: o.port, settings: settings("checkpoints") },
      }),
      wf(steps()),
      { doc: "d-1" },
    );
    expect(result).toEqual({ status: "succeeded" });
    expect(h.agentCalls.map((c) => [c.nodeId, c.keyNode, c.input])).toEqual([
      ["read", undefined, { doc: "d-1" }],
      [
        "read",
        "read:o1",
        { doc: "d-1", hint: "The total is 112.50; the first read took the subtotal." },
      ],
      ["bill", undefined, { total: "112.50" }],
    ]);
    expect(o.requests.map((r) => [r.seq, r.cause, r.output])).toEqual([
      [1, "checkpoint", { total: "100.00" }],
      [2, "checkpoint", { total: "112.50" }],
    ]);
  });

  it("asks a person at a checkpoint: the run waits, and resumes on approval", async () => {
    const h = new Harness();
    reads(h);
    const item = h.approvalItem();
    const o = port({ action: "ask", inboxItemId: item, note: "Is 100.00 the total?" });
    const runner = new FakeStepRunner({ onWait: "block" });
    let waited = false;
    runner.onWaitStarted = (_name, type) => {
      if (type !== inboxEventType(item)) return;
      waited = true;
      // Nothing was written while the run waited.
      expect(h.agentCalls.map((c) => c.nodeId)).toEqual(["read"]);
      runner.deliver(type, { approved: true, by: "u-1" });
    };
    const result = await executeWorkflow(
      runner,
      h.context({
        catalog: CATALOG,
        oversight: { port: o.port, settings: settings("checkpoints") },
      }),
      wf(steps()),
      { doc: "d-1" },
    );
    expect(waited).toBe(true);
    expect(result).toEqual({ status: "succeeded" });
    expect(h.agentCalls.map((c) => c.nodeId)).toEqual(["read", "bill"]);
  });

  it("cancels the run when a person declines at a checkpoint (onReject stop)", async () => {
    const h = new Harness();
    reads(h);
    const item = h.approvalItem({ approved: false, by: "u-1" });
    const o = port({ action: "ask", inboxItemId: item, note: "Ask." });
    const result = await executeWorkflow(
      new FakeStepRunner(),
      h.context({
        catalog: CATALOG,
        oversight: { port: o.port, settings: settings("checkpoints") },
      }),
      wf(steps()),
      { doc: "d-1" },
    );
    expect(result).toEqual({
      status: "cancelled",
      reason: "rejected",
      nodeId: "read",
      diagnosis: "Ask.",
    });
    expect(h.agentCalls.map((c) => c.nodeId)).toEqual(["read"]);
  });

  it("cancels the run on a stop at a checkpoint, before the write", async () => {
    const h = new Harness();
    reads(h);
    const o = port({ action: "stop", note: "This isn't an invoice." });
    const result = await executeWorkflow(
      new FakeStepRunner(),
      h.context({
        catalog: CATALOG,
        oversight: { port: o.port, settings: settings("checkpoints") },
      }),
      wf(steps()),
      { doc: "d-1" },
    );
    expect(result).toEqual({
      status: "cancelled",
      reason: "oversight_stop",
      nodeId: "read",
      diagnosis: "This isn't an invoice.",
    });
    expect(h.agentCalls.map((c) => c.nodeId)).toEqual(["read"]);
  });

  it("reviews every skill and action step under `all`; continue counts toward no limit", async () => {
    const h = new Harness();
    reads(h);
    const o = port(
      { action: "continue", note: "a" },
      { action: "continue", note: "b" },
      { action: "continue", note: "c" },
    );
    const result = await executeWorkflow(
      new FakeStepRunner(),
      h.context({
        catalog: CATALOG,
        oversight: { port: o.port, settings: settings("all", { maxPerRun: 1 }) },
      }),
      wf([...steps(), { id: "note", kind: "skill", name: "Note", skill: SKILL.id, input: {} }]),
      { doc: "d-1" },
    );
    expect(result).toEqual({ status: "succeeded" });
    expect(o.requests.map((r) => r.nodeId)).toEqual(["read", "bill", "note"]);
  });

  it("finds checkpoints in a fork, in a loop and inside an automation", async () => {
    const auto: AutomationDefinition = AutomationSchema.parse({
      schemaVersion: 1,
      slug: "bill-it",
      name: "Bill it",
      input: { type: "object", properties: { doc: { type: "string" } } },
      output: { total: "{{steps.read.output.total}}" },
      steps: steps().map((s) => (s.id === "read" ? { ...s, input: { doc: "{{input.doc}}" } } : s)),
    });
    const h = new Harness();
    reads(h);
    const o = port(
      ...Array.from({ length: 6 }, () => ({ action: "continue", note: "ok" }) as const),
    );
    const result = await executeWorkflow(
      new FakeStepRunner(),
      h.context({
        catalog: CATALOG,
        automations: { "bill-it@1": auto },
        oversight: { port: o.port, settings: settings("checkpoints") },
      }),
      wf([
        {
          id: "split",
          kind: "fork",
          name: "Split",
          paths: [
            {
              id: "p-yes",
              name: "Yes",
              when: { match: "all", rules: [{ field: "{{trigger.doc}}", op: "is", value: "d-1" }] },
              steps: steps()
                .map((s) => ({ ...s, id: `f-${s.id}` }))
                .map((s) =>
                  s.id === "f-bill"
                    ? { ...s, input: { total: "{{steps.f-read.output.total}}" } }
                    : s,
                ),
            },
          ],
          otherwise: { id: "p-no", steps: [] },
        },
        {
          id: "each",
          kind: "for_each",
          name: "Each",
          over: "{{trigger.docs}}",
          steps: [
            { ...steps()[0], id: "l-read", input: { doc: "{{item}}" } },
            {
              ...steps()[1],
              id: "l-bill",
              input: { total: "{{steps.l-read.output.total}}" },
            },
          ],
        },
        { id: "use", kind: "use_automation", name: "Bill it", automation: "bill-it@1", input: {} },
      ]),
      { doc: "d-1", docs: ["a", "b"] },
    );
    expect(result).toEqual({ status: "succeeded" });
    expect(o.requests.map((r) => r.nodeId)).toEqual([
      "f-read",
      "each:0:l-read",
      "each:1:l-read",
      "use/read",
    ]);
  });
});
