// v0.12 W2-B: automations expanded into runs (ARCHITECTURE §10.7; docs/plan.md §1.45, M22).
import { type AutomationDefinition, AutomationDefinition as Schema } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { executeWorkflow, resumePoint } from "./executor";
import { expandAutomations } from "./expand";
import { FakeStepRunner } from "./fake-runner";
import { Harness, WRITE_TOOL, wf } from "./fakes.test-helper";

/** "Polite follow-up": draft a note, then write it (approval on by default). */
const FOLLOW_UP: AutomationDefinition = Schema.parse({
  schemaVersion: 1,
  slug: "polite-follow-up",
  name: "Polite follow-up",
  input: { type: "object", properties: { customer: { type: "string" } } },
  output: { note: "{{steps.draft.output.text}}", to: "{{input.customer}}" },
  steps: [
    {
      id: "draft",
      kind: "skill",
      name: "Draft",
      skill: "test.summarize",
      input: { who: "{{input.customer}}", outside: "{{trigger.what}}" },
    },
    {
      id: "send",
      kind: "action",
      name: "Send",
      tool: WRITE_TOOL.id,
      input: { name: "{{steps.draft.output.text}}" },
    },
  ],
});
const AUTOMATIONS = { "polite-follow-up@1": FOLLOW_UP };

const use = (over: Record<string, unknown> = {}) => ({
  id: "follow",
  kind: "use_automation",
  name: "Follow up",
  automation: "polite-follow-up@1",
  input: { customer: "{{trigger.who}}" },
  ...over,
});

const after = (message: string) => ({
  id: "tell",
  kind: "notify",
  name: "Tell",
  channel: "thread",
  message,
});

function harness(): Harness {
  const h = new Harness();
  h.handlers.draft = (req) => ({
    kind: "done",
    output: { text: `Hello ${(req.input as { who: string }).who}` },
  });
  h.handlers.send = (req) => ({
    kind: "done",
    output: { sent: true, name: (req.input as { name: string }).name },
  });
  return h;
}

describe("expanding use steps", () => {
  it("runs the automation's steps under the use step, with its own scope and output", async () => {
    const h = harness();
    const runner = new FakeStepRunner();
    const result = await executeWorkflow(
      runner,
      h.context({ automations: AUTOMATIONS }),
      wf([use(), after("{{steps.follow.output.note}} / {{steps.draft.output.text}}")]),
      { who: "Acme", what: "x" },
    );
    expect(result).toEqual({ status: "succeeded" });
    expect(h.agentCalls.map((c) => [c.nodeId, c.input, c.automation])).toEqual([
      ["follow/draft", { who: "Acme", outside: undefined }, "polite-follow-up@1"],
      ["follow/send", { name: "Hello Acme" }, "polite-follow-up@1"],
    ]);
    expect(h.row("follow")).toMatchObject({
      nodeType: "use_automation",
      skillRef: "automation:polite-follow-up@1",
      input: { customer: "Acme" },
      status: "succeeded",
      output: { note: "Hello Acme", to: "Acme" },
      summary: "Follow up: done",
    });
    // Inner outputs are invisible after the use step: only its output is.
    expect(h.sent[0]?.text).toBe("Hello Acme / ");
    expect(runner.names()).toEqual([
      "follow",
      "follow/draft",
      "follow/send",
      "follow:done",
      "tell",
    ]);
  });

  it("keeps approval on for inner write steps unless a client agent's use step overrides it", async () => {
    const h = harness();
    await executeWorkflow(
      new FakeStepRunner(),
      h.context({ automations: AUTOMATIONS }),
      wf([use()]),
      {
        who: "A",
      },
    );
    expect(h.agentCalls[1]?.approval.required).toBe("required");

    const loosened = harness();
    await executeWorkflow(
      new FakeStepRunner(),
      loosened.context({ automations: AUTOMATIONS }),
      wf([use({ approvals: { send: { required: "not_required" } } })]),
      { who: "A" },
    );
    expect(loosened.agentCalls[1]?.approval.required).toBe("not_required");
    // The version itself is never changed by an override.
    expect(FOLLOW_UP.steps[1]).toMatchObject({ approval: { required: "required" } });
  });

  it("names inner steps under a loop's iteration", async () => {
    const h = harness();
    const runner = new FakeStepRunner();
    await executeWorkflow(
      runner,
      h.context({ automations: AUTOMATIONS }),
      wf([
        {
          id: "each",
          kind: "for_each",
          name: "Each",
          over: "{{trigger.people}}",
          concurrency: 1,
          steps: [use({ input: { customer: "{{item}}" } })],
        },
      ]),
      { people: ["A", "B"] },
    );
    expect(h.agentCalls.map((c) => c.nodeId)).toEqual([
      "each:0:follow/draft",
      "each:0:follow/send",
      "each:1:follow/draft",
      "each:1:follow/send",
    ]);
  });

  it("gives the same node ids when a failed run is retried, and resumes at the use step", async () => {
    const workflow = wf([use(), after("{{steps.follow.output.note}}")]);
    const first = harness();
    first.handlers.send = () => ({ kind: "failed", error: "503 from the tool" });
    const failed = await executeWorkflow(
      new FakeStepRunner(),
      first.context({ automations: AUTOMATIONS }),
      workflow,
      { who: "Acme" },
    );
    expect(failed).toMatchObject({ status: "failed", nodeId: "follow/send" });
    expect(first.row("follow")?.status).toBe("failed");
    expect(resumePoint(workflow, failed.nodeId ?? null)).toBe("follow");
    expect(resumePoint(workflow, "follow/send:approval:1:wait")).toBe("follow");

    const retry = harness();
    const result = await executeWorkflow(
      new FakeStepRunner(),
      retry.context({
        automations: AUTOMATIONS,
        resume: { from: "follow", of: "R-000001", reused: {} },
      }),
      workflow,
      { who: "Acme" },
    );
    expect(result).toEqual({ status: "succeeded" });
    expect(retry.agentCalls.map((c) => c.nodeId)).toEqual(first.agentCalls.map((c) => c.nodeId));
  });

  it("replays without repeating the inner steps", async () => {
    const h = harness();
    const runner = new FakeStepRunner();
    const ctx = h.context({ automations: AUTOMATIONS });
    const workflow = wf([use()]);
    await executeWorkflow(runner, ctx, workflow, { who: "A" });
    runner.replay();
    await executeWorkflow(runner, ctx, workflow, { who: "A" });
    expect(h.agentCalls).toHaveLength(2);
  });

  it("fails the run at the use step when its version isn't loaded", async () => {
    const h = harness();
    const result = await executeWorkflow(new FakeStepRunner(), h.context(), wf([use()]), {});
    expect(result).toMatchObject({ status: "failed", nodeId: "follow" });
    expect(h.agentCalls).toEqual([]);
  });

  it("refuses an automation that uses another automation", () => {
    const nested = Schema.parse({ ...FOLLOW_UP, steps: [use({ id: "inner" })] });
    expect(() => expandAutomations(wf([use()]), { "polite-follow-up@1": nested })).toThrow(
      /uses another automation/,
    );
  });
});
