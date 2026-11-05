import { describe, expect, it } from "vitest";
import type { AgentBundleInput } from "../schemas/agent";
import type { SkillDefinition } from "../schemas/skill";
import { ToolSpec as ToolSpecSchema } from "../schemas/tool";
import type { ActionStep, ForEachStep, ForkStep, SkillStep, Workflow } from "../schemas/workflow";
import { bundleInput, ctx, edit, workflowInput } from "../testing/fixtures";
import {
  type ValidationCode,
  type ValidationContext,
  validateBundle,
  validateWorkflow,
} from "./validate";

const fork = (w: Workflow) => w.steps[1] as ForkStep;
const loop = (w: Workflow) => w.steps[2] as ForEachStep;
const action = (w: Workflow) => w.steps[3] as ActionStep;
const extract = (w: Workflow) => w.steps[0] as SkillStep;

function codes(input: unknown, c: ValidationContext = ctx) {
  return validateWorkflow(input, c).errors.map((e) => ({
    code: e.code,
    stepId: e.stepId,
    field: e.field,
  }));
}

describe("valid workflows", () => {
  it("accepts the fixture with every context check on", () => {
    const r = validateWorkflow(workflowInput(), {
      ...ctx,
      agent: bundleInput().definition as never,
    });
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
  });

  it("accepts every step kind and trigger type", () => {
    const wf = edit(workflowInput(), (w) => {
      w.steps.push(
        { id: "w1", name: "Wait", kind: "wait", for: "2 hours" },
        { id: "x1", name: "Stop", kind: "stop", status: "succeeded" },
      );
    });
    expect(validateWorkflow(wf, ctx).errors).toEqual([]);
    for (const on of [
      { type: "schedule", cron: "0 7 * * 1-5", tz: "America/Chicago" },
      {
        type: "manual",
        input: {
          type: "object",
          properties: {
            documentId: { type: "string" },
            vendor: { type: "string" },
            total: { type: "number" },
          },
        },
      },
      { type: "command", command: "intake" },
    ]) {
      const w = edit(workflowInput(), (d) => {
        (d.trigger as { on: unknown }).on = on;
        d.steps = [{ id: "n1", name: "Note", kind: "notify", channel: "thread", message: "hi" }];
      });
      expect(validateWorkflow(w, ctx).errors).toEqual([]);
    }
  });

  it("is usable without registries (the builder before they load)", () => {
    expect(validateWorkflow(workflowInput()).errors).toEqual([]);
  });
});

describe("one failing fixture per rule", () => {
  const cases: [
    string,
    ValidationCode,
    (w: Workflow) => void,
    { stepId: string | null; field: string },
    ValidationContext?,
  ][] = [
    [
      "schema: a step without a name",
      "schema",
      (w) => {
        delete (loop(w).steps[0] as { name?: string }).name;
      },
      { stepId: "s6", field: "name" },
    ],
    [
      "schema: a bad duration",
      "schema",
      (w) => {
        (fork(w).paths[0]?.steps[0] as { timeout: string }).timeout = "soon";
      },
      { stepId: "s3", field: "timeout" },
    ],
    [
      "ids unique",
      "duplicate_id",
      (w) => {
        (loop(w).steps[0] as { id: string }).id = "s1";
      },
      { stepId: "s1", field: "id" },
    ],
    [
      "path ids unique too",
      "duplicate_id",
      (w) => {
        (fork(w).paths[0] as { id: string }).id = "s4";
      },
      { stepId: "s4", field: "id" },
    ],
    [
      "every fork has a path",
      "fork_no_paths",
      (w) => {
        fork(w).paths = [];
      },
      { stepId: "s2", field: "paths" },
    ],
    [
      "a for_each has a step",
      "for_each_empty",
      (w) => {
        loop(w).steps = [];
      },
      { stepId: "s5", field: "steps" },
    ],
    [
      "for_each goes over a list",
      "for_each_not_array",
      (w) => {
        loop(w).over = "{{steps.s1.output.total}}";
      },
      { stepId: "s5", field: "over" },
    ],
    [
      "template syntax",
      "template_syntax",
      (w) => {
        extract(w).input = { documentId: "{{trigger.documentId" };
      },
      { stepId: "s1", field: "input.documentId" },
    ],
    [
      "no reference to a later step",
      "template_scope",
      (w) => {
        extract(w).input = { documentId: "{{steps.s7.output.attachableId}}" };
      },
      { stepId: "s1", field: "input.documentId" },
    ],
    [
      "a notice's sources reference what is in scope",
      "template_scope",
      (w) => {
        (fork(w).otherwise.steps[0] as { sources?: string[] }).sources = [
          "{{steps.s1.output.documentId}}",
          "{{steps.s7.output.attachableId}}",
        ];
      },
      { stepId: "s4", field: "sources.1" },
    ],
    [
      "no reference into a fork path after the join",
      "template_scope",
      (w) => {
        action(w).input = { documentId: "{{steps.s3.output.answer}}" };
      },
      { stepId: "s7", field: "input.documentId" },
    ],
    [
      "no reference into a for_each after it",
      "template_scope",
      (w) => {
        action(w).input = { documentId: "{{steps.s6.output.summary}}" };
      },
      { stepId: "s7", field: "input.documentId" },
    ],
    [
      "item only inside a for_each",
      "template_scope",
      (w) => {
        action(w).input = { documentId: "{{item.description}}" };
      },
      { stepId: "s7", field: "input.documentId" },
    ],
    [
      "a field the output doesn't have",
      "template_path",
      (w) => {
        action(w).input = { documentId: "{{steps.s1.output.docId}}" };
      },
      { stepId: "s7", field: "input.documentId" },
    ],
    [
      "a field the trigger doesn't have",
      "template_path",
      (w) => {
        extract(w).input = { documentId: "{{trigger.docId}}" };
      },
      { stepId: "s1", field: "input.documentId" },
    ],
    [
      "fork path rules compile",
      "rule_invalid",
      (w) => {
        (fork(w).paths[0] as { when: unknown }).when = {
          match: "all",
          rules: [{ field: "total", op: ">", value: 1 }],
        };
      },
      { stepId: "p1", field: "when.rules.0.field" },
    ],
    [
      "a rule needs a value",
      "rule_invalid",
      (w) => {
        (fork(w).paths[0] as { when: unknown }).when = {
          match: "all",
          rules: [{ field: "{{trigger.total}}", op: ">" }],
        };
      },
      { stepId: "p1", field: "when.rules.0.value" },
    ],
    [
      "a fork path needs a condition",
      "rules_empty",
      (w) => {
        (fork(w).paths[0] as { when: unknown }).when = { match: "all", rules: [] };
      },
      { stepId: "p1", field: "when.rules" },
    ],
    [
      "fork rules see only what the fork sees",
      "template_scope",
      (w) => {
        (fork(w).paths[0] as { when: unknown }).when = {
          match: "all",
          rules: [{ field: "{{steps.s3.output.approved}}", op: "is", value: true }],
        };
      },
      { stepId: "p1", field: "when.rules.0.field" },
    ],
    [
      "trigger filter references the trigger only",
      "template_scope",
      (w) => {
        (w.trigger.on as { filter?: unknown }).filter = {
          match: "all",
          rules: [{ field: "{{steps.s1.output.total}}", op: ">", value: 1 }],
        };
      },
      { stepId: "t1", field: "on.filter.rules.0.field" },
    ],
    [
      "event exists",
      "unknown_event",
      (w) => {
        (w.trigger.on as { event: string }).event = "nothing.happened";
      },
      { stepId: "t1", field: "on.event" },
    ],
    [
      "cron has five fields",
      "invalid_cron",
      (w) => {
        w.trigger.on = { type: "schedule", cron: "every day" };
        w.steps = [];
      },
      { stepId: "t1", field: "on.cron" },
    ],
    [
      "timezone exists",
      "invalid_timezone",
      (w) => {
        w.trigger.on = { type: "schedule", cron: "0 7 * * *", tz: "Mars/Olympus" };
        w.steps = [];
      },
      { stepId: "t1", field: "on.tz" },
    ],
    [
      "skill exists",
      "unknown_skill",
      (w) => {
        extract(w).skill = "docs.nothing";
      },
      { stepId: "s1", field: "skill" },
    ],
    [
      "tool exists",
      "unknown_tool",
      (w) => {
        action(w).tool = "qbo.bill.delete";
      },
      { stepId: "s7", field: "tool" },
    ],
    [
      "an action changes a client tool",
      "action_not_external",
      (w) => {
        action(w).tool = "qbo.bill.query";
        action(w).input = {};
      },
      { stepId: "s7", field: "tool" },
    ],
    [
      "required input present",
      "input_missing",
      (w) => {
        extract(w).input = {};
      },
      { stepId: "s1", field: "input.documentId" },
    ],
    [
      "input types match",
      "input_type",
      (w) => {
        extract(w).input = { documentId: 42 };
      },
      { stepId: "s1", field: "input.documentId" },
    ],
    [
      "typed references match",
      "input_type",
      (w) => {
        extract(w).input = { documentId: "{{trigger.total}}" };
      },
      { stepId: "s1", field: "input.documentId" },
    ],
    [
      "no unknown inputs",
      "input_unknown",
      (w) => {
        extract(w).input = { documentId: "x", extra: 1 };
      },
      { stepId: "s1", field: "input.extra" },
    ],
    [
      "not_required only on write steps",
      "approval_not_write",
      (w) => {
        loop(w).steps[0] = {
          ...(loop(w).steps[0] as SkillStep),
          approval: { required: "not_required", onReject: "stop" },
        };
      },
      { stepId: "s6", field: "approval.required" },
    ],
  ];

  it.each(cases)("%s", (_name, code, mutate, where, c) => {
    const errors = codes(edit(workflowInput(), mutate), c ?? ctx);
    expect(errors).toContainEqual({ code, ...where });
  });

  it("skills and tools must be allowed by the owning agent", () => {
    const agent = { ...bundleInput().definition, extraTools: [] } as never;
    const wf = edit(workflowInput(), (w) => {
      loop(w).steps[0] = { ...(loop(w).steps[0] as SkillStep), skill: "test.itemize", input: {} };
    });
    const narrow = {
      ...(agent as object),
      skills: [{ skill: "docs.extract" }],
      canCommand: [],
    } as never;
    const errs = codes(wf, { ...ctx, agent: narrow });
    expect(errs).toContainEqual({ code: "skill_not_allowed", stepId: "s6", field: "skill" });
    expect(errs).toContainEqual({ code: "tool_not_allowed", stepId: "s7", field: "tool" });
    const viaAgent = edit(workflowInput(), (w) => {
      extract(w).agent = "other-agent";
    });
    expect(codes(viaAgent, { ...ctx, agent })).toContainEqual({
      code: "agent_not_commandable",
      stepId: "s1",
      field: "agent",
    });
  });
});

describe("publish-time connection checks", () => {
  const publish = (
    matrix: Record<string, unknown> | undefined,
    mutate: (w: Workflow) => void = () => {},
  ) =>
    codes(edit(workflowInput(), mutate), {
      ...ctx,
      publish: { matrices: { qbo: matrix as never } },
    });

  it("passes with the default matrix and approval on", () => {
    expect(publish({})).toEqual([]);
  });

  it("needs a bound connection for every write", () => {
    expect(codes(workflowInput(), { ...ctx, publish: { matrices: {} } })).toContainEqual({
      code: "connection_missing",
      stepId: "s7",
      field: "",
    });
  });

  it("refuses an action whose verb is off on the connection", () => {
    expect(publish({ create: "off" })).toContainEqual({
      code: "verb_off",
      stepId: "s7",
      field: "tool",
    });
  });

  it("refuses skipping approval where the connection requires it", () => {
    const skip = (w: Workflow) => {
      action(w).approval = { required: "not_required", onReject: "stop" };
    };
    const errs = validateWorkflow(edit(workflowInput(), skip), {
      ...ctx,
      publish: { matrices: { qbo: { create: "approval" } } },
    }).errors;
    expect(errs).toEqual([
      expect.objectContaining({
        code: "approval_required_by_connection",
        stepId: "s7",
        field: "approval.required",
        message: "this connection requires approval for creates",
      }),
    ]);
    expect(publish({ create: "auto" }, skip)).toEqual([]);
  });

  it("checks skill steps whose tools write, too", () => {
    const wf = (w: Workflow) => {
      loop(w).steps[0] = {
        ...(loop(w).steps[0] as SkillStep),
        skill: "test.itemize",
        input: {},
        approval: { required: "not_required", onReject: "stop" },
      };
    };
    expect(publish({ update: "approval" }, wf)).toContainEqual({
      code: "approval_required_by_connection",
      stepId: "s6",
      field: "approval.required",
    });
    expect(publish({ update: "off" }, wf)).toContainEqual({
      code: "verb_off",
      stepId: "s6",
      field: "skill",
    });
    expect(publish({ update: "auto" }, wf)).toEqual([]);
  });
});

describe("validateBundle", () => {
  it("accepts the fixture bundle", () => {
    const r = validateBundle(bundleInput(), ctx);
    expect(r.errors).toEqual([]);
    expect(r.value?.definition.budgets).toEqual({ maxSteps: 12, maxCostUsd: "0.50" });
  });

  it("requires ids unique across workflows, and unique slugs and skills", () => {
    const b = edit(bundleInput(), (d: AgentBundleInput) => {
      d.workflows.push({ ...(d.workflows[0] as AgentBundleInput["workflows"][number]) });
      d.definition.skills.push({ skill: "docs.extract@2" });
    });
    const errs = validateBundle(b, ctx).errors.map((e) => e.code);
    expect(errs).toContain("duplicate_slug");
    expect(errs).toContain("duplicate_skill");
    expect(errs).toContain("duplicate_id");
  });

  it("locates schema errors inside a workflow by step and slug", () => {
    const b = edit(bundleInput(), (d: AgentBundleInput) => {
      const wf = d.workflows[0]?.workflow as Workflow;
      (action(wf) as { tool: string }).tool = "Not A Tool";
    });
    expect(validateBundle(b, ctx).errors).toEqual([
      expect.objectContaining({ code: "schema", stepId: "s7", field: "tool", workflow: "intake" }),
    ]);
  });

  it("checks steps against the bundle's own agent", () => {
    const b = edit(bundleInput(), (d: AgentBundleInput) => {
      d.definition.skills = d.definition.skills.filter((s) => s.skill !== "test.summarize");
    });
    expect(validateBundle(b, ctx).errors).toEqual([
      expect.objectContaining({ code: "skill_not_allowed", stepId: "s6", workflow: "intake" }),
    ]);
  });
});

describe("fixed inputs (text that becomes instructions)", () => {
  const CALL = ToolSpecSchema.parse({
    id: "test.call.place",
    description: "Call someone",
    input: {
      type: "object",
      properties: {
        to: { type: "string" },
        purpose: { type: "string" },
        firstMessage: { type: "string" },
      },
      required: ["to", "purpose"],
      additionalProperties: false,
    },
    output: { type: "object", properties: {} },
    sideEffect: "external",
    verb: "create",
    source: "test",
    connector: "test",
    fixedInputs: ["purpose", "firstMessage"],
  });
  const caller = { ...(ctx.skills?.["test.itemize"] as SkillDefinition), id: "test.caller" };
  const callCtx: ValidationContext = {
    ...ctx,
    tools: { ...ctx.tools, [CALL.id]: CALL },
    skills: { ...ctx.skills, [caller.id]: { ...caller, tools: [CALL.id] } as SkillDefinition },
  };
  const calling = (input: Record<string, unknown>) =>
    edit(workflowInput(), (w) => {
      Object.assign(action(w), { tool: CALL.id, input: { to: "{{trigger.vendor}}", ...input } });
    });
  const fixedErrors = (wf: unknown) =>
    codes(wf, callCtx).filter((e) => e.code === "input_not_fixed");

  it("accepts a purpose and opening written in the step (the number may still be a template)", () => {
    const wf = calling({ purpose: "Confirm Friday's delivery", firstMessage: "About your order." });
    expect(fixedErrors(wf)).toEqual([]);
  });

  it("flags a purpose from the trigger and an opening from a step's output", () => {
    const wf = calling({
      purpose: "Ask about {{trigger.vendor}}",
      firstMessage: "{{steps.s1.output.total}}",
    });
    expect(fixedErrors(wf)).toEqual([
      { code: "input_not_fixed", stepId: "s7", field: "input.purpose" },
      { code: "input_not_fixed", stepId: "s7", field: "input.firstMessage" },
    ]);
  });

  it("flags a skill step whose model could call the tool", () => {
    const wf = edit(workflowInput(), (w) => {
      extract(w).skill = caller.id;
      extract(w).input = {};
    });
    expect(fixedErrors(wf)).toEqual([{ code: "input_not_fixed", stepId: "s1", field: "skill" }]);
  });
});
