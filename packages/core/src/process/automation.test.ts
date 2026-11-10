// Wave 3b (docs/plan.md §1.86): automations whose steps are v4 process steps, "Save as automation"
// on a process, and process steps that pin a v3 or a v4 automation.
import { describe, expect, it } from "vitest";
import {
  AnyAutomationDefinition,
  type AutomationDefinition,
  type ProcessAutomationDefinition,
} from "../schemas/automation";
import { ctx as baseCtx } from "../testing/fixtures";
import { type ValidationContext, validateWorkflow } from "../workflow/validate";
import {
  anyAutomationRequires,
  stepsToProcessAutomation,
  validateAnyAutomation,
} from "./automation";
import { Process, type Step } from "./schema";
import { approvalLoosenings, tightenedApproval, validateProcess } from "./validate";

/** Summarize a note, then attach the document (a write). */
function followUp(): ProcessAutomationDefinition {
  return AnyAutomationDefinition.parse({
    schemaVersion: 2,
    slug: "follow-up",
    name: "Follow up",
    input: {
      type: "object",
      properties: { customer: { type: "string" }, documentId: { type: "string" } },
      required: ["customer", "documentId"],
    },
    output: { summary: "{{steps.d1.output.summary}}", note: "Sent to {{input.customer}}" },
    steps: [
      {
        id: "d1",
        name: "Draft the note",
        kind: "skill",
        skill: "test.summarize",
        input: { text: "Follow up with {{input.customer}}" },
      },
      {
        id: "a1",
        name: "Attach",
        kind: "write",
        tool: "qbo.attachable.upload",
        input: { documentId: "{{input.documentId}}" },
        checks: { approval: { required: "required" } },
      },
    ],
  }) as ProcessAutomationDefinition;
}

const v3FollowUp: AutomationDefinition = {
  schemaVersion: 1,
  slug: "follow-up",
  name: "Follow up",
  description: "",
  input: { type: "object", properties: { customer: { type: "string" } } },
  output: { summary: "{{steps.d1.output.summary}}" },
  steps: [
    {
      id: "d1",
      name: "Draft the note",
      kind: "skill",
      skill: "test.summarize",
      input: { text: "{{input.customer}}" },
    },
  ],
  requires: { skills: [], tools: [], connectors: [] },
};

const codes = (r: { errors: { code: string; stepId: string | null; field: string }[] }) =>
  r.errors.map((e) => `${e.code}@${e.stepId ?? ""}:${e.field}`);

describe("a v4 automation", () => {
  it("validates with {{input}} in place of the trigger, and refuses nesting", () => {
    expect(validateAnyAutomation(followUp(), baseCtx).errors).toEqual([]);
    const bad = followUp();
    bad.steps.push(
      {
        id: "t",
        name: "Trigger",
        kind: "notify",
        notify: { to: ["lead"], channel: "inbox", message: "{{trigger.vendor}}" },
      },
      { id: "n", name: "Nested", kind: "process", process: "other@1", input: {} },
    );
    bad.output = { gone: "{{steps.zz.output}}" };
    expect(codes(validateAnyAutomation(bad, baseCtx))).toEqual([
      "automation_nested@n:",
      "template_scope@t:notify.message",
      "template_scope@:output.gone",
    ]);
  });

  it("validates a v1 automation exactly as before", () => {
    expect(validateAnyAutomation(v3FollowUp, baseCtx).errors).toEqual([]);
  });

  it("requires its skills, its read and write tools, and their connectors", () => {
    expect(anyAutomationRequires(followUp(), baseCtx)).toEqual({
      skills: ["test.summarize"],
      tools: ["qbo.attachable.upload"],
      connectors: ["qbo"],
    });
  });
});

/** A process: extract, then the selection (summarize, attach), then a step reading the summary. */
function process(attach: Partial<Step> = {}): Process {
  return Process.parse({
    schemaVersion: 4,
    triggers: [{ id: "t1", on: { type: "event", event: "document.received" } }],
    steps: [
      {
        id: "s1",
        name: "Summarize",
        kind: "skill",
        skill: "test.summarize",
        input: { text: "{{trigger.vendor}}" },
      },
      {
        id: "s2",
        name: "Attach",
        kind: "write",
        tool: "qbo.attachable.upload",
        input: { documentId: "{{trigger.documentId}}" },
        ...attach,
      },
      {
        id: "s3",
        name: "Tell",
        kind: "notify",
        notify: { to: ["lead"], message: "Done: {{steps.s1.output.summary}}" },
      },
    ],
  });
}

describe("save as automation, from a process", () => {
  let n = 0;
  const newId = () => `n${++n}`;

  it("copies the steps with new ids, infers input and output, and puts a process step there", () => {
    n = 0;
    const r = stepsToProcessAutomation({
      process: process(),
      stepIds: ["s1", "s2"],
      slug: "summarize-attach",
      name: "Summarize and attach",
      newId,
      ctx: baseCtx,
    });
    if (!r.ok) throw new Error(r.message);
    expect(r.automation.schemaVersion).toBe(2);
    expect(r.automation.steps.map((s) => s.id)).toEqual(["n1", "n2"]);
    expect(r.automation.input).toMatchObject({
      properties: { vendor: { type: "string" }, documentid: { type: "string" } },
    });
    expect(r.automation.steps[0]).toMatchObject({ input: { text: "{{input.vendor}}" } });
    expect(r.automation.output).toEqual({ summarize: "{{steps.n1.output}}" });
    expect(r.step).toMatchObject({
      id: "n3",
      kind: "process",
      process: "summarize-attach@1",
      input: { vendor: "{{trigger.vendor}}", documentid: "{{trigger.documentId}}" },
    });
    expect(r.process.steps.map((s) => s.id)).toEqual(["n3", "s3"]);
    expect(r.process.steps[1]).toMatchObject({
      notify: { message: "Done: {{steps.n3.output.summarize.summary}}" },
    });
    // The automation validates, and the process validates with it pinned.
    expect(validateAnyAutomation(r.automation, baseCtx).errors).toEqual([]);
    const pinned = { ...baseCtx, automations: { "summarize-attach@1": r.automation } };
    expect(validateProcess(r.process, pinned).errors).toEqual([]);
  });

  it("starts the copy with approval on; a client agent keeps its loosening on the step", () => {
    const loose = {
      checks: {
        approval: {
          required: "not_required" as const,
          mode: "in_turn" as const,
          ifNoAnswer: "proceed" as const,
          onReject: "stop" as const,
        },
      },
    };
    for (const clientAgent of [false, true]) {
      n = 0;
      const r = stepsToProcessAutomation({
        process: process(loose as Partial<Step>),
        stepIds: ["s2"],
        slug: "attach",
        name: "Attach",
        newId,
        ctx: baseCtx,
        clientAgent,
      });
      if (!r.ok) throw new Error(r.message);
      const inner = r.automation.steps[0];
      expect(approvalLoosenings(inner?.checks?.approval, "a")).toEqual([]);
      expect(r.step.approvals).toEqual(clientAgent ? { n1: loose.checks.approval } : undefined);
    }
  });

  it("refuses a step that isn't at the top, a gap, and a process step", () => {
    const p = process();
    const base = { slug: "x", name: "X", newId, ctx: baseCtx };
    expect(stepsToProcessAutomation({ ...base, process: p, stepIds: ["zz"] })).toMatchObject({
      ok: false,
      code: "not_top_level",
    });
    expect(stepsToProcessAutomation({ ...base, process: p, stepIds: ["s1", "s3"] })).toMatchObject({
      ok: false,
      code: "not_contiguous",
    });
    const nested = Process.parse({
      ...p,
      steps: [{ id: "u", name: "Use", kind: "process", process: "x@1", input: {} }],
    });
    expect(stepsToProcessAutomation({ ...base, process: nested, stepIds: ["u"] })).toMatchObject({
      ok: false,
      code: "nested",
    });
  });
});

describe("tightenedApproval", () => {
  it("takes out every loosening and keeps the rest", () => {
    const a = tightenedApproval({
      required: "not_required",
      when: { match: "all", rules: [] },
      mode: "any",
      ifNoAnswer: {
        escalate: {
          to: "lead",
          deadline: { after: "1 day", hours: "clock", ifNoAnswer: "proceed" },
        },
      },
      onReject: "continue",
      approvers: [
        {
          who: "client_admin",
          deadline: { after: "2 hours", hours: "clock", ifNoAnswer: "proceed" },
        },
      ],
    });
    expect(approvalLoosenings(a, "a")).toEqual([]);
    expect(a).toMatchObject({ required: "required", mode: "any", onReject: "continue" });
    expect(a.when).toBeUndefined();
  });
});

describe("a process step pins a v3 or a v4 automation; a v3 use step only a v3 one", () => {
  const ctx: ValidationContext = {
    ...baseCtx,
    automations: { "follow-up@1": v3FollowUp, "follow-up@2": followUp() },
  };

  it("types each one's output and checks its input", () => {
    const p = Process.parse({
      schemaVersion: 4,
      triggers: [{ id: "t1", on: { type: "event", event: "document.received" } }],
      steps: [
        {
          id: "old",
          name: "Old",
          kind: "process",
          process: "follow-up@1",
          input: { customer: "{{trigger.vendor}}" },
        },
        {
          id: "new",
          name: "New",
          kind: "process",
          process: "follow-up@2",
          input: { customer: "{{trigger.vendor}}", documentId: "{{trigger.documentId}}" },
        },
        {
          id: "tell",
          name: "Tell",
          kind: "notify",
          notify: {
            to: ["lead"],
            message:
              "{{steps.old.output.summary}} {{steps.new.output.note}} {{steps.new.output.nope}}",
          },
        },
      ],
    });
    expect(codes(validateProcess(p, ctx))).toEqual(["template_path@tell:notify.message"]);
  });

  it("checks an override on a v4 automation's inner write", () => {
    const p = Process.parse({
      schemaVersion: 4,
      triggers: [{ id: "t1", on: { type: "event", event: "document.received" } }],
      steps: [
        {
          id: "new",
          name: "New",
          kind: "process",
          process: "follow-up@2",
          input: { customer: "x", documentId: "y" },
          approvals: { d1: { required: "not_required" }, a1: { required: "not_required" } },
        },
      ],
    });
    expect(codes(validateProcess(p, { ...ctx, clientAgent: true }))).toEqual([
      "approval_not_write@new:approvals.d1.required",
    ]);
  });

  it("refuses a v4 automation on a v3 use step", () => {
    const r = validateWorkflow(
      {
        schemaVersion: 3,
        trigger: { id: "t1", on: { type: "event", event: "document.received" } },
        steps: [
          {
            id: "u",
            name: "Use",
            kind: "use_automation",
            automation: "follow-up@2",
            input: {},
          },
        ],
      },
      ctx,
    );
    expect(codes(r)).toEqual(["unknown_automation@u:automation"]);
  });
});
