import { describe, expect, it } from "vitest";
import {
  type AutomationDefinition,
  AutomationDefinition as AutomationSchema,
} from "../schemas/automation";
import type { SkillDefinition } from "../schemas/skill";
import { type ToolSpec, ToolSpec as ToolSpecSchema } from "../schemas/tool";
import {
  type ActionStep,
  type ForkStep,
  type ForEachStep as V3ForEachStep,
  type SkillStep as V3SkillStep,
  type Workflow,
  Workflow as WorkflowSchema,
} from "../schemas/workflow";
import { bundleInput, ctx, edit, workflowInput } from "../testing/fixtures";
import { type ValidationContext, validateWorkflow } from "../workflow/validate";
import { type ConvertLookup, fromWorkflowV3 } from "./convert";
import type { Process, Step } from "./schema";
import {
  approvalLoosenings,
  type ProcessValidationCode,
  type ProcessValidationContext,
  SPLIT_MAX_STEPS,
  validateProcess,
} from "./validate";

// ── Fixture: the v3 fixture's intake, written as a v4 process ──────────────────────────────────

type Raw = {
  schemaVersion: 4;
  triggers: { id: string; on: Record<string, unknown> }[];
  steps: Record<string, unknown>[];
  handoff?: unknown;
};

function processInput(): Raw {
  return {
    schemaVersion: 4,
    triggers: [{ id: "t1", on: { type: "event", event: "document.received" } }],
    steps: [
      {
        id: "s0",
        name: "Find bills",
        kind: "read",
        tool: "qbo.bill.query",
        input: { vendor: "{{trigger.vendor}}" },
      },
      {
        id: "s1",
        name: "Extract",
        kind: "skill",
        skill: "docs.extract",
        input: { documentId: "{{trigger.documentId}}" },
      },
      {
        id: "s2",
        name: "Big?",
        kind: "if",
        paths: [
          {
            id: "p1",
            name: "Big",
            when: { match: "all", rules: [{ field: "{{trigger.total}}", op: ">", value: 500 }] },
            steps: [
              {
                id: "s3",
                name: "Approve",
                kind: "person",
                mode: "approve",
                assignee: "client_admin",
                title: "Approve {{trigger.vendor}}",
                payload: { total: "{{trigger.total}}" },
                deadline: { after: "5 days" },
              },
            ],
          },
        ],
        otherwise: {
          id: "o1",
          steps: [
            {
              id: "s4",
              name: "Note",
              kind: "notify",
              notify: { to: ["client_admin"], message: "Small one" },
            },
          ],
        },
      },
      {
        id: "s5",
        name: "Each line",
        kind: "for_each",
        over: "{{steps.s1.output.lines}}",
        steps: [
          {
            id: "s6",
            name: "Summarize",
            kind: "skill",
            skill: "test.summarize",
            input: { text: "{{item.description}}" },
          },
        ],
      },
      {
        id: "s7",
        name: "Attach",
        kind: "write",
        tool: "qbo.attachable.upload",
        input: { documentId: "{{steps.s1.output.documentId}}" },
        checks: {
          confer: {
            with: [
              { ai: { focus: "Is {{steps.s1.output.documentId}} the right document?" } },
              {
                person: "accountant",
                when: { rules: [{ field: "{{confer.0.verdict}}", op: "!=", value: "agree" }] },
                deadline: { after: "4 hours", hours: "business" },
              },
            ],
          },
          approval: {
            mode: "in_turn",
            approvers: [{ who: "client_admin", deadline: { after: "30 minutes" } }],
          },
          notify: [
            {
              to: ["client_admin"],
              message: "Attached {{steps.s7.output.attachableId}}",
              when: { rules: [{ field: "{{confer.1.verdict}}", op: "=", value: "disagree" }] },
            },
          ],
        },
      },
    ],
  };
}

const agent = bundleInput().definition as never;
const full: ProcessValidationContext = { ...ctx, agent };

type Where = { code: ProcessValidationCode; stepId: string | null; field: string };

function codes(input: unknown, c: ProcessValidationContext = ctx): Where[] {
  return validateProcess(input, c).errors.map((e) => ({
    code: e.code,
    stepId: e.stepId,
    field: e.field,
  }));
}

/** The step with this id, anywhere in a raw process. */
function stepIn(p: Raw, id: string): Record<string, unknown> {
  let found: Record<string, unknown> | undefined;
  const visit = (steps: Record<string, unknown>[]) => {
    for (const s of steps) {
      if (s.id === id) found = s;
      for (const pth of (s.paths as { steps: Record<string, unknown>[] }[] | undefined) ?? []) {
        visit(pth.steps);
      }
      const other = s.otherwise as { steps: Record<string, unknown>[] } | undefined;
      if (other) visit(other.steps);
      if (Array.isArray(s.steps)) visit(s.steps as Record<string, unknown>[]);
    }
  };
  visit(p.steps);
  if (!found) throw new Error(`no step ${id}`);
  return found;
}

const write = (p: Raw) => stepIn(p, "s7") as { checks: Record<string, unknown>; input: unknown };
const approvalOf = (p: Raw) => write(p).checks.approval as Record<string, unknown>;

// ── Valid processes ────────────────────────────────────────────────────────────────────────────

describe("valid processes", () => {
  it("accepts the fixture with every context check on", () => {
    const r = validateProcess(processInput(), full);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.valid).toBe(true);
    expect(r.value?.schemaVersion).toBe(4);
  });

  it("is usable without registries (the builder before they load)", () => {
    expect(validateProcess(processInput()).errors).toEqual([]);
  });

  it("accepts the other kinds of step", () => {
    const p = edit(processInput(), (d) => {
      d.steps.push(
        {
          id: "c1",
          name: "Ask the vendor",
          kind: "conversation",
          with: "{{trigger.vendor}}",
          channel: "email",
          goal: "Confirm the total of {{trigger.documentId}}",
          deadline: { after: "2 days", hours: "business" },
        },
        { id: "w1", name: "Wait", kind: "wait", for: "2 hours" },
        { id: "x1", name: "Stop", kind: "stop", status: "succeeded" },
      );
    });
    expect(codes(p, full)).toEqual([]);
  });

  it("reads every trigger: a field some triggers lack is optional, not an error", () => {
    const p = edit(processInput(), (d) => {
      d.triggers.push({
        id: "t2",
        on: {
          type: "manual",
          input: { type: "object", properties: { documentId: { type: "string" } } },
        },
      });
    });
    expect(codes(p, full)).toEqual([]);
  });
});

// ── One failing fixture per rule ───────────────────────────────────────────────────────────────

describe("one failing fixture per rule", () => {
  const cases: [string, ProcessValidationCode, (p: Raw) => void, Omit<Where, "code">][] = [
    [
      "schema: a step without a name",
      "schema",
      (p) => {
        delete stepIn(p, "s6").name;
      },
      { stepId: "s6", field: "name" },
    ],
    [
      "schema: a deadline that is not a duration",
      "schema",
      (p) => {
        stepIn(p, "s3").deadline = { after: "soon" };
      },
      { stepId: "s3", field: "deadline.after" },
    ],
    [
      "schema: an unknown kind",
      "schema",
      (p) => {
        stepIn(p, "s4").kind = "email";
      },
      { stepId: "s4", field: "kind" },
    ],
    [
      "schema: a bad ifNoAnswer",
      "schema",
      (p) => {
        approvalOf(p).ifNoAnswer = "go";
      },
      { stepId: "s7", field: "checks.approval.ifNoAnswer" },
    ],
    [
      "schema: a path's bad field is on the path",
      "schema",
      (p) => {
        (stepIn(p, "s2").paths as { name?: unknown }[])[0] = {
          ...((stepIn(p, "s2").paths as object[])[0] as object),
          name: 3,
        };
      },
      { stepId: "p1", field: "name" },
    ],
    [
      "schema: a trigger's bad field is on the trigger",
      "schema",
      (p) => {
        (p.triggers[0] as { on: unknown }).on = { type: "event" };
      },
      { stepId: "t1", field: "on.event" },
    ],
    [
      "every if has a path",
      "if_no_paths",
      (p) => {
        stepIn(p, "s2").paths = [];
      },
      { stepId: "s2", field: "paths" },
    ],
    [
      "every for_each has a step",
      "for_each_empty",
      (p) => {
        stepIn(p, "s5").steps = [];
      },
      { stepId: "s5", field: "steps" },
    ],
    [
      "a person step needs a deadline",
      "deadline_missing",
      (p) => {
        delete stepIn(p, "s3").deadline;
      },
      { stepId: "s3", field: "deadline" },
    ],
    [
      "a person reviewer needs a deadline",
      "deadline_missing",
      (p) => {
        const confer = write(p).checks.confer as { with: Record<string, unknown>[] };
        delete confer.with[1]?.deadline;
      },
      { stepId: "s7", field: "checks.confer.with.1.deadline" },
    ],
    [
      "an urgent notice needs the time to be seen in",
      "urgent_needs_ack",
      (p) => {
        (write(p).checks.notify as Record<string, unknown>[])[0] = {
          to: ["client_admin"],
          message: "Now",
          urgent: {},
        };
      },
      { stepId: "s7", field: "checks.notify.0.urgent.ackWithin" },
    ],
    [
      "step ids unique",
      "duplicate_id",
      (p) => {
        stepIn(p, "s6").id = "s1";
      },
      { stepId: "s1", field: "id" },
    ],
    [
      "path ids unique too",
      "duplicate_id",
      (p) => {
        (stepIn(p, "s2").paths as { id: string }[])[0] = {
          ...((stepIn(p, "s2").paths as object[])[0] as { id: string }),
          id: "s4",
        };
      },
      { stepId: "s4", field: "id" },
    ],
    [
      "otherwise ids unique too",
      "duplicate_id",
      (p) => {
        (stepIn(p, "s2").otherwise as { id: string }).id = "s0";
      },
      { stepId: "s0", field: "otherwise.id" },
    ],
    [
      "trigger ids unique too",
      "duplicate_id",
      (p) => {
        p.triggers.push({ id: "t1", on: { type: "manual", input: {} } });
      },
      { stepId: "t1", field: "id" },
    ],
    [
      "a trigger and a step can't share an id",
      "duplicate_id",
      (p) => {
        stepIn(p, "s0").id = "t1";
      },
      { stepId: "t1", field: "id" },
    ],
    [
      "for_each goes over a list",
      "for_each_not_array",
      (p) => {
        stepIn(p, "s5").over = "{{steps.s1.output.total}}";
      },
      { stepId: "s5", field: "over" },
    ],
    [
      "template syntax",
      "template_syntax",
      (p) => {
        stepIn(p, "s1").input = { documentId: "{{trigger.documentId" };
      },
      { stepId: "s1", field: "input.documentId" },
    ],
    [
      "no reference to a later step",
      "template_scope",
      (p) => {
        stepIn(p, "s1").input = { documentId: "{{steps.s7.output.attachableId}}" };
      },
      { stepId: "s1", field: "input.documentId" },
    ],
    [
      "no reference to the step itself in its own input",
      "template_scope",
      (p) => {
        stepIn(p, "s1").input = { documentId: "{{steps.s1.output.documentId}}" };
      },
      { stepId: "s1", field: "input.documentId" },
    ],
    [
      "no reference into an if path after it",
      "template_scope",
      (p) => {
        write(p).input = { documentId: "{{steps.s3.output.answer}}" };
      },
      { stepId: "s7", field: "input.documentId" },
    ],
    [
      "no reference into a for_each after it",
      "template_scope",
      (p) => {
        write(p).input = { documentId: "{{steps.s6.output.summary}}" };
      },
      { stepId: "s7", field: "input.documentId" },
    ],
    [
      "no reference across if paths",
      "template_scope",
      (p) => {
        (stepIn(p, "s4").notify as { message: string }).message = "{{steps.s3.output.by}}";
      },
      { stepId: "s4", field: "notify.message" },
    ],
    [
      "item only inside a for_each",
      "template_scope",
      (p) => {
        write(p).input = { documentId: "{{item.description}}" };
      },
      { stepId: "s7", field: "input.documentId" },
    ],
    [
      "only trigger, settings, steps, item and index",
      "template_scope",
      (p) => {
        write(p).input = { documentId: "{{run.id}}" };
      },
      { stepId: "s7", field: "input.documentId" },
    ],
    [
      "a field the output doesn't have",
      "template_path",
      (p) => {
        write(p).input = { documentId: "{{steps.s1.output.docId}}" };
      },
      { stepId: "s7", field: "input.documentId" },
    ],
    [
      "a field the trigger doesn't have",
      "template_path",
      (p) => {
        stepIn(p, "s1").input = { documentId: "{{trigger.docId}}" };
      },
      { stepId: "s1", field: "input.documentId" },
    ],
    [
      "a notice's sources reference what is in scope",
      "template_scope",
      (p) => {
        (stepIn(p, "s4").notify as { sources?: string[] }).sources = [
          "{{steps.s1.output.documentId}}",
          "{{steps.s7.output.attachableId}}",
        ];
      },
      { stepId: "s4", field: "notify.sources.1" },
    ],
    [
      "if path rules compile",
      "rule_invalid",
      (p) => {
        (stepIn(p, "s2").paths as { when: unknown }[])[0] = {
          ...((stepIn(p, "s2").paths as object[])[0] as object),
          when: { match: "all", rules: [{ field: "total", op: ">", value: 1 }] },
        };
      },
      { stepId: "p1", field: "when.rules.0.field" },
    ],
    [
      "an if path needs a condition",
      "rules_empty",
      (p) => {
        (stepIn(p, "s2").paths as { when: unknown }[])[0] = {
          ...((stepIn(p, "s2").paths as object[])[0] as object),
          when: { match: "all", rules: [] },
        };
      },
      { stepId: "p1", field: "when.rules" },
    ],
    [
      "if rules see only what the if sees",
      "template_scope",
      (p) => {
        (stepIn(p, "s2").paths as { when: unknown }[])[0] = {
          ...((stepIn(p, "s2").paths as object[])[0] as object),
          when: { rules: [{ field: "{{steps.s3.output.approved}}", op: "is", value: true }] },
        };
      },
      { stepId: "p1", field: "when.rules.0.field" },
    ],
    [
      "a trigger's filter reads that trigger only",
      "template_scope",
      (p) => {
        (p.triggers[0] as { on: Record<string, unknown> }).on.filter = {
          rules: [{ field: "{{steps.s1.output.total}}", op: ">", value: 1 }],
        };
      },
      { stepId: "t1", field: "on.filter.rules.0.field" },
    ],
    [
      "event exists",
      "unknown_event",
      (p) => {
        (p.triggers[0] as { on: Record<string, unknown> }).on.event = "nothing.happened";
      },
      { stepId: "t1", field: "on.event" },
    ],
    [
      "cron has five fields",
      "invalid_cron",
      (p) => {
        p.triggers = [{ id: "t1", on: { type: "schedule", cron: "every day" } }];
        p.steps = [];
      },
      { stepId: "t1", field: "on.cron" },
    ],
    [
      "skill exists",
      "unknown_skill",
      (p) => {
        stepIn(p, "s1").skill = "docs.nothing";
      },
      { stepId: "s1", field: "skill" },
    ],
    [
      "tool exists",
      "unknown_tool",
      (p) => {
        stepIn(p, "s7").tool = "qbo.bill.delete";
      },
      { stepId: "s7", field: "tool" },
    ],
    [
      "a read step's tool only reads",
      "read_not_read",
      (p) => {
        stepIn(p, "s0").tool = "qbo.bill.update_lines";
        stepIn(p, "s0").input = { billId: "b1" };
      },
      { stepId: "s0", field: "tool" },
    ],
    [
      "a write step's tool changes something",
      "write_not_write",
      (p) => {
        stepIn(p, "s7").tool = "qbo.bill.query";
        stepIn(p, "s7").input = {};
      },
      { stepId: "s7", field: "tool" },
    ],
    [
      "a skill step's required input is present",
      "input_missing",
      (p) => {
        stepIn(p, "s1").input = {};
      },
      { stepId: "s1", field: "input.documentId" },
    ],
    [
      "a skill step's input types match",
      "input_type",
      (p) => {
        stepIn(p, "s1").input = { documentId: 42 };
      },
      { stepId: "s1", field: "input.documentId" },
    ],
    [
      "typed references match",
      "input_type",
      (p) => {
        stepIn(p, "s1").input = { documentId: "{{trigger.total}}" };
      },
      { stepId: "s1", field: "input.documentId" },
    ],
    [
      "no unknown inputs",
      "input_unknown",
      (p) => {
        stepIn(p, "s1").input = { documentId: "x", extra: 1 };
      },
      { stepId: "s1", field: "input.extra" },
    ],
    [
      "a write step's input against its tool",
      "input_missing",
      (p) => {
        write(p).input = {};
      },
      { stepId: "s7", field: "input.documentId" },
    ],
    [
      "not_required only on steps that write",
      "approval_not_write",
      (p) => {
        stepIn(p, "s6").checks = { approval: { required: "not_required" } };
      },
      { stepId: "s6", field: "checks.approval.required" },
    ],
    [
      "quick answers only on questions",
      "choices_not_ask",
      (p) => {
        stepIn(p, "s3").choices = [{ label: "Yes", value: "yes" }];
      },
      { stepId: "s3", field: "choices" },
    ],
  ];

  it.each(cases)("%s", (_name, code, mutate, where) => {
    expect(codes(edit(processInput(), mutate), full)).toContainEqual({ code, ...where });
  });

  it("skills and tools must be allowed by the owning agent", () => {
    const narrow = {
      ...bundleInput().definition,
      skills: [{ skill: "docs.extract" }],
      extraTools: [],
      canCommand: [],
    } as never;
    const errs = codes(processInput(), { ...ctx, agent: narrow });
    expect(errs).toContainEqual({ code: "skill_not_allowed", stepId: "s6", field: "skill" });
    expect(errs).toContainEqual({ code: "tool_not_allowed", stepId: "s7", field: "tool" });
    expect(errs).toContainEqual({ code: "tool_not_allowed", stepId: "s0", field: "tool" });
    const viaAgent = edit(processInput(), (p) => {
      stepIn(p, "s1").agent = "other-agent";
    });
    expect(codes(viaAgent, full)).toContainEqual({
      code: "agent_not_commandable",
      stepId: "s1",
      field: "agent",
    });
  });

  it("reads settings, typed when the context gives their schema", () => {
    const p = edit(processInput(), (d) => {
      stepIn(d, "s4").notify = { to: ["client_admin"], message: "Over {{settings.threshold}}" };
    });
    expect(codes(p, full)).toEqual([]);
    const typed = {
      ...full,
      settings: {
        type: "object",
        properties: { limit: { type: "number" } },
        additionalProperties: false,
      },
    };
    expect(codes(p, typed)).toEqual([
      { code: "template_path", stepId: "s4", field: "notify.message" },
    ]);
  });

  it("checks a handoff against the top-level steps", () => {
    const ok = edit(processInput(), (d) => {
      d.handoff = { output: { doc: "{{steps.s1.output.documentId}}" } };
    });
    expect(codes(ok, full)).toEqual([]);
    const inside = edit(processInput(), (d) => {
      d.handoff = { output: { doc: "{{steps.s6.output.summary}}" } };
    });
    expect(codes(inside, full)).toEqual([
      { code: "template_scope", stepId: "t1", field: "handoff.output.doc" },
    ]);
  });
});

// ── Checks ─────────────────────────────────────────────────────────────────────────────────────

describe("checks", () => {
  const conferOf = (p: Raw) => write(p).checks.confer as { with: Record<string, unknown>[] };

  it("lets a reviewer's condition read only the reviewers before it", () => {
    const first = edit(processInput(), (p) => {
      (conferOf(p).with[0] as Record<string, unknown>).when = {
        rules: [{ field: "{{confer.0.verdict}}", op: "=", value: "agree" }],
      };
    });
    expect(codes(first, full)).toEqual([
      { code: "template_scope", stepId: "s7", field: "checks.confer.with.0.when.rules.0.field" },
    ]);
    const itself = edit(processInput(), (p) => {
      (conferOf(p).with[1] as Record<string, unknown>).when = {
        rules: [{ field: "{{confer.1.verdict}}", op: "=", value: "agree" }],
      };
    });
    expect(codes(itself, full)).toEqual([
      { code: "template_scope", stepId: "s7", field: "checks.confer.with.1.when.rules.0.field" },
    ]);
    const badField = edit(processInput(), (p) => {
      (conferOf(p).with[1] as Record<string, unknown>).when = {
        rules: [{ field: "{{confer.0.mood}}", op: "=", value: "agree" }],
      };
    });
    expect(codes(badField, full)).toEqual([
      { code: "template_path", stepId: "s7", field: "checks.confer.with.1.when.rules.0.field" },
    ]);
  });

  it("lets approval and notify conditions read every verdict, and nothing else reads them", () => {
    const approval = edit(processInput(), (p) => {
      approvalOf(p).when = {
        rules: [{ field: "{{confer.1.verdict}}", op: "=", value: "disagree" }],
      };
    });
    expect(codes(approval, full)).toEqual([]);
    const tooFar = edit(processInput(), (p) => {
      approvalOf(p).when = {
        rules: [{ field: "{{confer.2.verdict}}", op: "=", value: "disagree" }],
      };
    });
    expect(codes(tooFar, full)).toEqual([
      { code: "template_scope", stepId: "s7", field: "checks.approval.when.rules.0.field" },
    ]);
    const noConfer = edit(processInput(), (p) => {
      stepIn(p, "s6").checks = {
        notify: [{ to: ["lead"], message: "{{confer.0.verdict}}" }],
      };
    });
    expect(codes(noConfer, full)).toEqual([
      { code: "template_scope", stepId: "s6", field: "checks.notify.0.message" },
    ]);
    const inInput = edit(processInput(), (p) => {
      write(p).input = { documentId: "{{confer.0.verdict}}" };
    });
    expect(codes(inInput, full)).toContainEqual({
      code: "template_scope",
      stepId: "s7",
      field: "input.documentId",
    });
  });

  it("shows a write's own output to its notices, not to its approval (it hasn't written yet)", () => {
    const own = edit(processInput(), (p) => {
      approvalOf(p).when = {
        rules: [{ field: "{{steps.s7.output.attachableId}}", op: "exists" }],
      };
    });
    expect(codes(own, full)).toEqual([
      { code: "template_scope", stepId: "s7", field: "checks.approval.when.rules.0.field" },
    ]);
  });

  it("shows a skill's own output to its confer and approval (they review its result)", () => {
    const p = edit(processInput(), (d) => {
      stepIn(d, "s1").checks = {
        confer: {
          when: { rules: [{ field: "{{steps.s1.output.total}}", op: "exists" }] },
          with: [{ ai: { focus: "Does {{steps.s1.output.total}} match the lines?" } }],
        },
        approval: {
          when: { rules: [{ field: "{{confer.0.verdict}}", op: "!=", value: "agree" }] },
        },
      };
    });
    expect(codes(p, full)).toEqual([]);
  });

  it("checks a reviewer's model against the platform's", () => {
    const p = edit(processInput(), (d) => {
      (conferOf(d).with[0] as { ai: Record<string, unknown> }).ai.model = { id: "claude-nonesuch" };
    });
    expect(codes(p, { ...full, models: ["claude-haiku-5-5"] })).toEqual([
      { code: "unknown_model", stepId: "s7", field: "checks.confer.with.0.ai.model.id" },
    ]);
    expect(codes(p, full)).toEqual([]);
  });

  it("checks a notice's conditions and its urgent conditions", () => {
    const p = edit(processInput(), (d) => {
      stepIn(d, "s4").notify = {
        to: ["client_admin"],
        message: "Small",
        when: { rules: [{ field: "total", op: ">", value: 1 }] },
        urgent: {
          ackWithin: "15 minutes",
          when: { rules: [{ field: "{{steps.s7.output.attachableId}}", op: "exists" }] },
        },
      };
    });
    expect(codes(p, full)).toEqual([
      { code: "rule_invalid", stepId: "s4", field: "notify.when.rules.0.field" },
      { code: "template_scope", stepId: "s4", field: "notify.urgent.when.rules.0.field" },
    ]);
  });
});

// ── Invariant 8 ────────────────────────────────────────────────────────────────────────────────

describe("invariant 8: loosening a write's approval", () => {
  const publish = (
    matrix: Record<string, unknown> | undefined,
    mutate: (p: Raw) => void = () => {},
    extra: Partial<ProcessValidationContext> = {},
  ) =>
    codes(edit(processInput(), mutate), {
      ...ctx,
      publish: { matrices: { qbo: matrix as never } },
      ...extra,
    });
  const notRequired = (p: Raw) => {
    approvalOf(p).required = "not_required";
  };
  const conditional = (p: Raw) => {
    approvalOf(p).when = { rules: [{ field: "{{trigger.total}}", op: ">", value: 100 }] };
  };
  const proceeds = (p: Raw) => {
    approvalOf(p).ifNoAnswer = "proceed";
  };
  const approverProceeds = (p: Raw) => {
    approvalOf(p).approvers = [
      { who: "client_admin", deadline: { after: "30 minutes", ifNoAnswer: "proceed" } },
    ];
  };
  const escalationProceeds = (p: Raw) => {
    approvalOf(p).approvers = [
      {
        who: "client_admin",
        deadline: {
          after: "30 minutes",
          ifNoAnswer: {
            escalate: { to: "lead", deadline: { after: "1 hour", ifNoAnswer: "proceed" } },
          },
        },
      },
    ];
  };
  const loosenings: [string, (p: Raw) => void, string][] = [
    ["not_required", notRequired, "checks.approval.required"],
    ["a condition", conditional, "checks.approval.when"],
    ["proceed when nobody answers", proceeds, "checks.approval.ifNoAnswer"],
    [
      "an approver's deadline that proceeds",
      approverProceeds,
      "checks.approval.approvers.0.deadline.ifNoAnswer",
    ],
    [
      "an escalation that proceeds",
      escalationProceeds,
      "checks.approval.approvers.0.deadline.ifNoAnswer.escalate.deadline.ifNoAnswer",
    ],
  ];

  it("passes with the default matrix and approval on", () => {
    expect(publish({})).toEqual([]);
  });

  it.each(loosenings)("refuses %s where the connection requires approval", (_n, mutate, f) => {
    expect(publish({ create: "approval" }, mutate)).toEqual([
      { code: "approval_required_by_connection", stepId: "s7", field: f },
    ]);
  });

  it.each(loosenings)("allows %s where the connection allows auto", (_n, mutate) => {
    expect(publish({ create: "auto" }, mutate)).toEqual([]);
  });

  it.each(loosenings)("allows %s only for an agent that acts", (_n, mutate, f) => {
    const mode = (m: string) => ({
      agent: { ...bundleInput().definition, permissions: { mode: m } } as never,
    });
    expect(publish({ create: "auto" }, mutate, mode("suggest_only"))).toEqual([
      { code: "approval_needs_act", stepId: "s7", field: f },
    ]);
    expect(publish({ create: "auto" }, mutate, mode("act"))).toEqual([]);
  });

  it.each(loosenings)(
    "is not checked without a publish context (templates, drafts): %s",
    (_n, mutate) => {
      expect(codes(edit(processInput(), mutate), full)).toEqual([]);
    },
  );

  it.each(loosenings)("never loosens a verb a person always signs: %s", (_n, mutate, f) => {
    const spec = ctx.tools?.["qbo.attachable.upload"] as ToolSpec;
    const always: ProcessValidationContext = {
      ...ctx,
      tools: { ...ctx.tools, [spec.id]: { ...spec, approval: "always" } },
    };
    expect(codes(edit(processInput(), mutate), always)).toEqual([
      { code: "approval_always", stepId: "s7", field: f },
    ]);
    expect(codes(processInput(), always)).toEqual([]);
  });

  it("names the message by the loosening", () => {
    const r = validateProcess(edit(processInput(), conditional), {
      ...ctx,
      publish: { matrices: { qbo: { create: "approval" } } },
    });
    expect(r.errors[0]?.message).toBe(
      "this connection requires approval for creates: on every run, not only when conditions hold",
    );
  });

  it("doesn't count stop or skip as loosening", () => {
    const safe = (p: Raw) => {
      approvalOf(p).ifNoAnswer = "skip";
      approvalOf(p).approvers = [{ who: "a", deadline: { after: "1 hour", ifNoAnswer: "stop" } }];
    };
    expect(publish({ create: "approval" }, safe)).toEqual([]);
  });

  it("doesn't hold a step that writes nothing to it", () => {
    const p = (d: Raw) => {
      stepIn(d, "s6").checks = { approval: { ifNoAnswer: "proceed", when: { rules: [] } } };
    };
    expect(publish({ create: "approval" }, p)).toEqual([]);
  });

  it("checks a skill whose tools write (v3 skills), too", () => {
    const itemize = (d: Raw) => {
      Object.assign(stepIn(d, "s6"), {
        skill: "test.itemize",
        input: {},
        checks: { approval: { required: "not_required" } },
      });
    };
    expect(publish({ update: "approval" }, itemize)).toContainEqual({
      code: "approval_required_by_connection",
      stepId: "s6",
      field: "checks.approval.required",
    });
    expect(publish({ update: "off" }, itemize)).toContainEqual({
      code: "verb_off",
      stepId: "s6",
      field: "skill",
    });
    expect(publish({ update: "auto" }, itemize)).toEqual([]);
  });

  it("needs a bound connection for every write, and the verb on", () => {
    expect(codes(processInput(), { ...ctx, publish: { matrices: {} } })).toEqual([
      { code: "connection_missing", stepId: "s7", field: "" },
    ]);
    expect(publish({ create: "off" })).toEqual([{ code: "verb_off", stepId: "s7", field: "tool" }]);
  });

  it("refuses an entity the connection turned off", () => {
    const spec = ctx.tools?.["qbo.attachable.upload"] as ToolSpec;
    const withEntity: ProcessValidationContext = {
      ...ctx,
      tools: { ...ctx.tools, [spec.id]: { ...spec, entity: "attachment" } },
      publish: { matrices: { qbo: { entities: { attachment: { create: "off" } } } } },
    };
    expect(codes(processInput(), withEntity)).toEqual([
      { code: "entity_off", stepId: "s7", field: "tool" },
    ]);
  });

  it("lists the loosenings of an approval", () => {
    expect(approvalLoosenings(undefined, "x")).toEqual([]);
    expect(
      approvalLoosenings(
        {
          required: "not_required",
          when: { match: "all", rules: [] },
          mode: "any",
          ifNoAnswer: "proceed",
          onReject: "stop",
        },
        "a",
      ).map((l) => l.what),
    ).toEqual(["not_required", "when", "proceed"]);
  });
});

// ── Fixed inputs ───────────────────────────────────────────────────────────────────────────────

describe("fixed inputs (text that becomes instructions)", () => {
  const CALL = ToolSpecSchema.parse({
    id: "test.call.place",
    description: "Call someone",
    input: {
      type: "object",
      properties: { to: { type: "string" }, purpose: { type: "string" } },
      required: ["to", "purpose"],
      additionalProperties: false,
    },
    output: { type: "object", properties: {} },
    sideEffect: "external",
    verb: "create",
    source: "test",
    connector: "test",
    fixedInputs: ["purpose"],
  });
  const caller = {
    ...(ctx.skills?.["test.itemize"] as SkillDefinition),
    id: "test.caller",
    tools: [CALL.id],
  };
  const callCtx: ProcessValidationContext = {
    ...ctx,
    tools: { ...ctx.tools, [CALL.id]: CALL },
    skills: { ...ctx.skills, [caller.id]: caller as SkillDefinition },
  };
  const fixed = (p: unknown) => codes(p, callCtx).filter((e) => e.code === "input_not_fixed");

  it("accepts a purpose written in a write step, flags a templated one", () => {
    const calling = (purpose: string) =>
      edit(processInput(), (d) => {
        Object.assign(write(d), { tool: CALL.id, input: { to: "{{trigger.vendor}}", purpose } });
      });
    expect(fixed(calling("Confirm Friday's delivery"))).toEqual([]);
    expect(fixed(calling("Ask about {{trigger.vendor}}"))).toEqual([
      { code: "input_not_fixed", stepId: "s7", field: "input.purpose" },
    ]);
  });

  it("flags a skill step whose model could call the tool", () => {
    const p = edit(processInput(), (d) => {
      Object.assign(stepIn(d, "s1"), { skill: caller.id, input: {} });
    });
    expect(fixed(p)).toEqual([{ code: "input_not_fixed", stepId: "s1", field: "skill" }]);
  });
});

// ── Sub-processes ──────────────────────────────────────────────────────────────────────────────

describe("a process step", () => {
  const followUp = (): AutomationDefinition =>
    AutomationSchema.parse({
      schemaVersion: 1,
      slug: "follow-up",
      name: "Follow up",
      input: { type: "object", properties: { billId: { type: "string" } }, required: ["billId"] },
      output: { done: "{{steps.fix.output.updated}}" },
      steps: [
        { id: "fix", name: "Fix", kind: "skill", skill: "test.itemize", input: {} },
        { id: "say", name: "Say", kind: "notify", channel: "thread", message: "Done" },
      ],
      requires: { connectors: ["qbo"] },
    });
  const sub = (approvals?: Record<string, unknown>) => (d: Raw) => {
    d.steps.push({
      id: "u1",
      name: "Follow up",
      kind: "process",
      process: "follow-up@1",
      input: { billId: "{{steps.s1.output.documentId}}" },
      ...(approvals ? { approvals } : {}),
    });
  };
  const subCtx: ProcessValidationContext = { ...full, automations: { "follow-up@1": followUp() } };

  it("is valid when its process exists and its input fits", () => {
    expect(codes(edit(processInput(), sub()), subCtx)).toEqual([]);
  });

  it("reads the process's output after it", () => {
    const p = edit(processInput(), (d) => {
      sub()(d);
      d.steps.push({
        id: "n9",
        name: "Note",
        kind: "notify",
        notify: { to: ["lead"], message: "{{steps.u1.output.done}} {{steps.u1.output.nope}}" },
      });
    });
    expect(codes(p, subCtx)).toEqual([
      { code: "template_path", stepId: "n9", field: "notify.message" },
    ]);
  });

  it("refuses an unknown process, a missing input and approvals off a client agent", () => {
    expect(codes(edit(processInput(), sub()), { ...full, automations: {} })).toEqual([
      { code: "unknown_automation", stepId: "u1", field: "process" },
    ]);
    const noInput = edit(processInput(), (d) => {
      sub()(d);
      (d.steps.at(-1) as Record<string, unknown>).input = {};
    });
    expect(codes(noInput, subCtx)).toEqual([
      { code: "input_missing", stepId: "u1", field: "input.billId" },
    ]);
    const approvals = edit(processInput(), sub({ fix: { required: "required" } }));
    expect(codes(approvals, { ...subCtx, clientAgent: false })).toEqual([
      { code: "approvals_not_client", stepId: "u1", field: "approvals" },
    ]);
  });

  it("holds an inner step's approval to the same rules", () => {
    expect(codes(edit(processInput(), sub({ nope: {} })), subCtx)).toEqual([
      { code: "approval_unknown_step", stepId: "u1", field: "approvals.nope" },
    ]);
    expect(codes(edit(processInput(), sub({ say: { required: "not_required" } })), subCtx)).toEqual(
      [{ code: "approval_not_write", stepId: "u1", field: "approvals.say.required" }],
    );
    const when = sub({ fix: { when: { rules: [{ field: "{{input.billId}}", op: "exists" }] } } });
    const pub = (level: string) => ({
      ...subCtx,
      publish: { matrices: { qbo: { update: level } as never } },
    });
    // The fixture's agent only suggests: both the connection and the mode keep approval on.
    expect(codes(edit(processInput(), when), pub("approval"))).toEqual([
      { code: "approval_required_by_connection", stepId: "u1", field: "approvals.fix.when" },
      { code: "approval_needs_act", stepId: "u1", field: "approvals.fix.when" },
    ]);
    expect(codes(edit(processInput(), when), pub("auto"))).toEqual([
      { code: "approval_needs_act", stepId: "u1", field: "approvals.fix.when" },
    ]);
    expect(codes(edit(processInput(), sub()), { ...subCtx, publish: { matrices: {} } })).toEqual([
      { code: "connection_missing", stepId: "s7", field: "" },
      { code: "connection_missing", stepId: "u1", field: "process" },
    ]);
  });
});

// ── Advice: split signals ──────────────────────────────────────────────────────────────────────

describe("split signals (advice, never errors)", () => {
  const note = (id: string) => ({
    id,
    name: id,
    kind: "notify",
    notify: { to: ["lead"], message: id },
  });
  const nest = (depth: number, inner: Record<string, unknown>): Record<string, unknown> =>
    depth === 0
      ? inner
      : {
          id: `l${depth}`,
          name: "Loop",
          kind: "for_each",
          over: "{{trigger.lines}}",
          steps: [nest(depth - 1, inner)],
        };
  const base = (steps: Record<string, unknown>[]) => ({
    schemaVersion: 4,
    triggers: [{ id: "t", on: { type: "manual", input: {} } }],
    steps,
  });

  it("flags more than 20 steps, nested ones counted", () => {
    const at = (n: number) => base(Array.from({ length: n }, (_, i) => note(`n${i}`)));
    expect(validateProcess(at(SPLIT_MAX_STEPS)).warnings).toEqual([]);
    const r = validateProcess(at(SPLIT_MAX_STEPS + 1));
    expect(r.valid).toBe(true);
    expect(r.warnings.map((w) => [w.code, w.stepId, w.field])).toEqual([
      ["split_long", null, "steps"],
    ]);
  });

  it("flags logic nested more than 3 deep, once, at the first level past it", () => {
    expect(validateProcess(base([nest(3, note("x"))])).warnings).toEqual([]);
    const r = validateProcess(base([nest(5, note("x"))]));
    expect(r.valid).toBe(true);
    expect(r.warnings.map((w) => [w.code, w.stepId])).toEqual([["split_deep", "l2"]]);
  });
});

// ── v3 workflows read as v4 validate the same way ──────────────────────────────────────────────

describe("a v3 workflow read as v4 validates as it did", () => {
  const fork = (w: Workflow) => w.steps[1] as ForkStep;
  const loop = (w: Workflow) => w.steps[2] as V3ForEachStep;
  const action = (w: Workflow) => w.steps[3] as ActionStep;
  const extract = (w: Workflow) => w.steps[0] as V3SkillStep;

  /** The registries as the converter reads them: a tool-mode skill wraps its handler. */
  const lookupFor = (c: ValidationContext): ConvertLookup => ({
    wrappedTool: (id) => {
      const s = c.skills?.[id];
      return s?.mode === "tool" && s.handler ? s.handler : null;
    },
    sideEffect: (id) => c.tools?.[id]?.sideEffect ?? null,
  });

  /** v4's names for v3's: codes renamed with the step kinds, and fields moved under checks. */
  const CODE: Partial<Record<string, ProcessValidationCode>> = {
    fork_no_paths: "if_no_paths",
    action_not_external: "write_not_write",
  };
  function asV4(e: { code: string; stepId: string | null; field: string }, p: Process): Where {
    let f = e.field;
    const step = findIn(p.steps, e.stepId);
    if (f.startsWith("approval.")) f = `checks.${f}`;
    if (step?.kind === "notify" && /^(message|to|sources)/.test(f)) f = `notify.${f}`;
    if ((step?.kind === "write" || step?.kind === "read") && f === "skill") f = "tool";
    return { code: (CODE[e.code] ?? e.code) as ProcessValidationCode, stepId: e.stepId, field: f };
  }
  function findIn(steps: Step[], id: string | null): Step | undefined {
    for (const s of steps) {
      if (s.id === id) return s;
      const inner =
        s.kind === "if"
          ? [...s.paths.flatMap((x) => x.steps), ...s.otherwise.steps]
          : s.kind === "for_each"
            ? s.steps
            : [];
      const hit = findIn(inner, id);
      if (hit) return hit;
    }
    return undefined;
  }
  const sorted = (xs: Where[]) =>
    [...xs].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

  function same(mutate: (w: Workflow) => void, c: ValidationContext = ctx) {
    const raw = edit(workflowInput(), mutate);
    const v3 = validateWorkflow(raw, c).errors;
    const p = fromWorkflowV3(WorkflowSchema.parse(raw), lookupFor(c));
    const v4 = codes(p, c as ProcessValidationContext);
    expect(sorted(v4)).toEqual(sorted(v3.map((e) => asV4(e, p))));
    return v4;
  }

  const cases: [string, (w: Workflow) => void, ValidationContext?][] = [
    ["the fixture as it is", () => {}],
    ["with its agent", () => {}, { ...ctx, agent: bundleInput().definition as never }],
    [
      "ids unique",
      (w) => {
        (loop(w).steps[0] as { id: string }).id = "s1";
      },
    ],
    [
      "path ids unique",
      (w) => {
        (fork(w).paths[0] as { id: string }).id = "s4";
      },
    ],
    [
      "every fork has a path",
      (w) => {
        fork(w).paths = [];
      },
    ],
    [
      "a for_each has a step",
      (w) => {
        loop(w).steps = [];
      },
    ],
    [
      "for_each over a list",
      (w) => {
        loop(w).over = "{{steps.s1.output.total}}";
      },
    ],
    [
      "template syntax",
      (w) => {
        extract(w).input = { documentId: "{{trigger.documentId" };
      },
    ],
    [
      "no reference to a later step",
      (w) => {
        extract(w).input = { documentId: "{{steps.s7.output.attachableId}}" };
      },
    ],
    [
      "sources in scope",
      (w) => {
        (fork(w).otherwise.steps[0] as { sources?: string[] }).sources = [
          "{{steps.s7.output.attachableId}}",
        ];
      },
    ],
    [
      "no reference into a fork path after it",
      (w) => {
        action(w).input = { documentId: "{{steps.s3.output.answer}}" };
      },
    ],
    [
      "no reference into a loop after it",
      (w) => {
        action(w).input = { documentId: "{{steps.s6.output.summary}}" };
      },
    ],
    [
      "item only in a loop",
      (w) => {
        action(w).input = { documentId: "{{item.description}}" };
      },
    ],
    [
      "a field the output lacks",
      (w) => {
        action(w).input = { documentId: "{{steps.s1.output.docId}}" };
      },
    ],
    [
      "a field the trigger lacks",
      (w) => {
        extract(w).input = { documentId: "{{trigger.docId}}" };
      },
    ],
    [
      "path rules compile",
      (w) => {
        (fork(w).paths[0] as { when: unknown }).when = {
          match: "all",
          rules: [{ field: "total", op: ">", value: 1 }],
        };
      },
    ],
    [
      "a path needs a condition",
      (w) => {
        (fork(w).paths[0] as { when: unknown }).when = { match: "all", rules: [] };
      },
    ],
    [
      "trigger filter scope",
      (w) => {
        (w.trigger.on as { filter?: unknown }).filter = {
          match: "all",
          rules: [{ field: "{{steps.s1.output.total}}", op: ">", value: 1 }],
        };
      },
    ],
    [
      "event exists",
      (w) => {
        (w.trigger.on as { event: string }).event = "nothing.happened";
      },
    ],
    [
      "cron",
      (w) => {
        w.trigger.on = { type: "schedule", cron: "every day" };
        w.steps = [];
      },
    ],
    [
      "skill exists",
      (w) => {
        extract(w).skill = "docs.nothing";
      },
    ],
    [
      "tool exists",
      (w) => {
        action(w).tool = "qbo.bill.delete";
      },
    ],
    [
      "an action changes a client tool",
      (w) => {
        action(w).tool = "qbo.bill.query";
        action(w).input = {};
      },
    ],
    [
      "required input (a wrapped tool)",
      (w) => {
        extract(w).input = {};
      },
    ],
    [
      "input types",
      (w) => {
        extract(w).input = { documentId: 42 };
      },
    ],
    [
      "typed references",
      (w) => {
        extract(w).input = { documentId: "{{trigger.total}}" };
      },
    ],
    [
      "unknown inputs",
      (w) => {
        extract(w).input = { documentId: "x", extra: 1 };
      },
    ],
    [
      "not_required only on writes",
      (w) => {
        loop(w).steps[0] = {
          ...(loop(w).steps[0] as V3SkillStep),
          approval: { required: "not_required", onReject: "stop" },
        };
      },
    ],
    [
      "a model on a tool-mode skill",
      (w) => {
        extract(w).model = { id: "claude-haiku-5-5" };
      },
    ],
    [
      "skills and tools the agent lacks",
      (w) => {
        loop(w).steps[0] = {
          ...(loop(w).steps[0] as V3SkillStep),
          skill: "test.itemize",
          input: {},
        };
      },
      {
        ...ctx,
        agent: {
          ...bundleInput().definition,
          skills: [{ skill: "docs.extract" }],
          extraTools: [],
          canCommand: [],
        } as never,
      },
    ],
    ["at publish, approval on", () => {}, { ...ctx, publish: { matrices: { qbo: {} } } }],
    ["at publish, no connection", () => {}, { ...ctx, publish: { matrices: {} } }],
    [
      "at publish, the verb off",
      () => {},
      { ...ctx, publish: { matrices: { qbo: { create: "off" } } } },
    ],
    [
      "at publish, approval skipped where the connection requires it",
      (w) => {
        action(w).approval = { required: "not_required", onReject: "stop" };
      },
      { ...ctx, publish: { matrices: { qbo: { create: "approval" } } } },
    ],
    [
      "at publish, approval skipped where the connection allows auto",
      (w) => {
        action(w).approval = { required: "not_required", onReject: "stop" };
      },
      { ...ctx, publish: { matrices: { qbo: { create: "auto" } } } },
    ],
    [
      "at publish, a skill whose tools write",
      (w) => {
        loop(w).steps[0] = {
          ...(loop(w).steps[0] as V3SkillStep),
          skill: "test.itemize",
          input: {},
          approval: { required: "not_required", onReject: "stop" },
        };
      },
      { ...ctx, publish: { matrices: { qbo: { update: "approval" } } } },
    ],
  ];

  it.each(cases)("%s", (_name, mutate, c) => {
    same(mutate, c);
  });

  it("finds something in the cases that fail (the comparison isn't empty)", () => {
    expect(
      same((w) => {
        action(w).tool = "qbo.bill.delete";
      }),
    ).toEqual([{ code: "unknown_tool", stepId: "s7", field: "tool" }]);
  });
});
