import { describe, expect, it } from "vitest";
import { Process } from "../process/schema";
import { validateProcess } from "../process/validate";
import { SkillDefinition, type SkillRule } from "../schemas/skill";
import { parameterValueProblem } from "../schemas/skill-model";
import type { ToolSpec } from "../schemas/tool";
import { definitionModelErrors, definitionSkillErrors } from "../workflow/validate";
import {
  newSkillVersionProblems,
  retiredSkillReason,
  SKILL_KIND_LABEL,
  skillKind,
  toolLookup,
} from "./kind";
import { effectiveModel, recommendedModel } from "./model";
import { parameterValueProblems, resolveSkillParameters } from "./parameters";
import {
  bucketLabel,
  evaluateSkillCompute,
  evaluateSkillCondition,
  evaluateSkillRules,
  isoToday,
  type SkillRuleContext,
  skillRuleProblems,
} from "./rules";
import { skillMoveImpact, skillStepReferences, skillVersionChange } from "./versions";
import { defaultWriteApproval, writeStepLabel } from "./writes";

const base = {
  schemaVersion: 1 as const,
  description: "",
  category: "test",
  tools: [],
  settings: [],
  requiresConnectors: [],
  requiresPacks: [],
  producesAlerts: false,
};

const spec = (id: string, extra: Partial<ToolSpec> = {}): ToolSpec => ({
  id,
  description: id,
  input: { type: "object" },
  output: { type: "object" },
  sideEffect: "none",
  verb: "read",
  source: "platform",
  ...extra,
});

const TOOLS = toolLookup([
  spec("docs.get"),
  spec("docs.extract", {
    sideEffect: "internal",
    verb: "create",
    usesModel: "reads the document with a model",
  }),
  spec("qbo.bill.create", { sideEffect: "external", verb: "create", connector: "qbo" }),
]);

// ── The aging example: 0–15 Current, 16–30 Due, 31+ Past due, as of an injected today ─────────

const AGING = [
  { from: 0, to: 15, label: "Current" },
  { from: 16, to: 30, label: "Due" },
  { from: 31, label: "Past due" },
];

const agingRows: SkillRule[] = [
  {
    id: "not_due",
    when: { match: "all", rules: [] },
    name: "Not due yet",
    conditions: [{ left: { input: "dueDate" }, op: ">", right: { today: true } }],
    set: { bucket: "Not due" },
    compute: { daysOverdue: { value: 0 }, amount: { input: "amount" } },
  },
  {
    id: "aged",
    when: { match: "all", rules: [] },
    name: "Aged by the agent's buckets",
    compute: {
      daysOverdue: { daysBetween: { from: { input: "dueDate" }, to: { today: true } } },
      bucket: {
        bucket: {
          value: { daysBetween: { from: { input: "dueDate" }, to: { today: true } } },
          by: "aging",
        },
      },
      amount: { input: "amount" },
    },
  },
];

const ageReceivables = SkillDefinition.parse({
  ...base,
  id: "custom:age-receivables",
  name: "Age receivables",
  mode: "tool",
  method: "rules",
  input: {
    type: "object",
    properties: { dueDate: { type: "string" }, amount: { type: "string" } },
    required: ["dueDate", "amount"],
  },
  output: {
    type: "object",
    properties: {
      daysOverdue: { type: "integer" },
      bucket: { type: "string" },
      amount: { type: "string" },
    },
    required: ["daysOverdue", "bucket", "amount"],
  },
  parameters: [{ name: "aging", label: "Aging buckets", type: "buckets", default: AGING }],
  rules: agingRows,
});

describe("rule rows: the aging example", () => {
  const age = (
    dueDate: string,
    today: string,
    parameters = resolveSkillParameters(ageReceivables),
  ) =>
    evaluateSkillRules(ageReceivables.rules ?? [], {
      input: { dueDate, amount: "1250.00" },
      parameters,
      today,
    });

  it("buckets days overdue by the agent's buckets, as of the day it runs", () => {
    expect(age("2026-11-01", "2026-11-10")).toEqual({
      ruleId: "aged",
      output: { daysOverdue: 9, bucket: "Current", amount: "1250.00" },
    });
    expect(age("2026-10-26", "2026-11-10")?.output).toMatchObject({
      daysOverdue: 15,
      bucket: "Current",
    });
    expect(age("2026-10-25", "2026-11-10")?.output).toMatchObject({
      daysOverdue: 16,
      bucket: "Due",
    });
    expect(age("2026-10-11", "2026-11-10")?.output).toMatchObject({
      daysOverdue: 30,
      bucket: "Due",
    });
    expect(age("2026-10-10", "2026-11-10")?.output).toMatchObject({
      daysOverdue: 31,
      bucket: "Past due",
    });
    expect(age("2025-11-10", "2026-11-10")?.output).toMatchObject({
      daysOverdue: 365,
      bucket: "Past due",
    });
    // Due today is current; due later is not due yet (the first row wins).
    expect(age("2026-11-10", "2026-11-10")?.output).toMatchObject({
      daysOverdue: 0,
      bucket: "Current",
    });
    expect(age("2026-11-20", "2026-11-10")).toEqual({
      ruleId: "not_due",
      output: { bucket: "Not due", daysOverdue: 0, amount: "1250.00" },
    });
  });

  it("reads a timestamp by the date written in it, and takes another agent's buckets", () => {
    expect(age("2026-11-01T23:30:00-05:00", "2026-11-10")?.output).toMatchObject({
      daysOverdue: 9,
    });
    const weekly = resolveSkillParameters(ageReceivables, {
      agent: {
        aging: [
          { from: 0, to: 7, label: "This week" },
          { from: 8, label: "Older" },
        ],
      },
    });
    expect(age("2026-11-01", "2026-11-10", weekly)?.output).toMatchObject({ bucket: "Older" });
  });

  it("is the same every time, and checks clean against its own schemas", () => {
    expect(age("2026-10-01", "2026-11-10")).toEqual(age("2026-10-01", "2026-11-10"));
    expect(skillRuleProblems(ageReceivables)).toEqual([]);
    expect(skillKind(ageReceivables, TOOLS)).toBe("deterministic");
  });

  it("injects today from the run's clock in the client's zone", () => {
    const now = new Date("2026-11-11T03:00:00Z");
    expect(isoToday(now)).toBe("2026-11-11");
    expect(isoToday(now, "America/Chicago")).toBe("2026-11-10");
    expect(isoToday(now, "Not/AZone")).toBe("2026-11-11");
  });
});

describe("rule rows: conditions and calculations", () => {
  const ctx: SkillRuleContext = {
    input: {
      vendor: "Home Depot",
      total: "512.40",
      count: 3,
      before: 80,
      after: 100,
      price: { amount: "19.99", currency: "USD" },
      lines: [{ amount: "10.10" }, { amount: "5.05" }],
      date: "2026-11-05",
    },
    parameters: {
      threshold: 500,
      limit: { amount: "20.00", currency: "USD" },
      vendors: "Home Depot",
      cutoff: "2026-11-01",
    },
    today: "2026-11-10",
  };

  it("compares numbers, decimal strings, amounts and dates as such", () => {
    expect(
      evaluateSkillCondition(
        { left: { input: "total" }, op: ">", right: { parameter: "threshold" } },
        ctx,
      ),
    ).toBe(true);
    expect(
      evaluateSkillCondition(
        { left: { input: "price" }, op: "<", right: { parameter: "limit" } },
        ctx,
      ),
    ).toBe(true);
    expect(
      evaluateSkillCondition(
        { left: { input: "date" }, op: ">=", right: { parameter: "cutoff" } },
        ctx,
      ),
    ).toBe(true);
    expect(
      evaluateSkillCondition({ left: { input: "count" }, op: "=", right: { value: "3" } }, ctx),
    ).toBe(true);
    expect(
      evaluateSkillCondition({ left: { input: "vendor" }, op: "<", right: { value: "Z" } }, ctx),
    ).toBe(false);
  });

  it("between includes both ends; in reads a list; days between counts whole days", () => {
    expect(
      evaluateSkillCondition(
        { left: { input: "total" }, op: "between", from: { value: 500 }, to: { value: "512.40" } },
        ctx,
      ),
    ).toBe(true);
    expect(
      evaluateSkillCondition(
        { left: { input: "vendor" }, op: "in", list: { value: ["Lowe's", "Home Depot"] } },
        ctx,
      ),
    ).toBe(true);
    expect(
      evaluateSkillCondition(
        {
          left: { daysBetween: { from: { input: "date" }, to: { today: true } } },
          op: "between",
          from: { value: 1 },
          to: { value: 5 },
        },
        ctx,
      ),
    ).toBe(true);
  });

  it("never matches on what the input doesn't say, not even with !=", () => {
    expect(
      evaluateSkillCondition({ left: { input: "missing" }, op: "!=", right: { value: "x" } }, ctx),
    ).toBe(false);
    expect(
      evaluateSkillCondition(
        { left: { input: "total" }, op: "=", right: { parameter: "nope" } },
        ctx,
      ),
    ).toBe(false);
  });

  it("adds, subtracts and takes percent changes in decimals, never floats", () => {
    expect(
      evaluateSkillCompute(
        { sum: [{ input: "lines.0.amount" }, { input: "lines.1.amount" }] },
        ctx,
      ),
    ).toBe("15.15");
    expect(evaluateSkillCompute({ sum: [{ value: 0.1 }, { value: 0.2 }] }, ctx)).toBe(0.3);
    expect(
      evaluateSkillCompute({ difference: [{ input: "price" }, { parameter: "limit" }] }, ctx),
    ).toEqual({
      amount: "-0.0100",
      currency: "USD",
    });
    expect(
      evaluateSkillCompute(
        { percentChange: { from: { input: "before" }, to: { input: "after" } } },
        ctx,
      ),
    ).toBe(25);
    expect(
      evaluateSkillCompute({ percentChange: { from: { value: 0 }, to: { value: 5 } } }, ctx),
    ).toBeNull();
    expect(evaluateSkillCompute({ sum: [{ input: "vendor" }] }, ctx)).toBeNull();
    expect(evaluateSkillCompute({ input: "vendor" }, ctx)).toBe("Home Depot");
    expect(evaluateSkillCompute({ input: "missing" }, ctx)).toBeNull();
  });

  it("names the first bucket a value falls in, or none", () => {
    expect(bucketLabel(-1, AGING)).toBeNull();
    expect(bucketLabel("15.5", AGING)).toBeNull();
    expect(bucketLabel(16, AGING)).toBe("Due");
    expect(bucketLabel(16, "not buckets")).toBeNull();
  });

  it("reads plain `when` rules over input, parameters and today, and gives null when no row matches", () => {
    const rows: SkillRule[] = [
      {
        id: "big",
        when: {
          match: "all",
          rules: [{ field: "{{input.count}}", op: ">", value: "{{parameters.threshold}}" }],
        },
        set: { size: "big" },
      },
      {
        id: "home_depot",
        when: {
          match: "all",
          rules: [{ field: "{{input.vendor}}", op: "=", value: "{{parameters.vendors}}" }],
        },
        set: { account: "Materials" },
      },
    ];
    expect(evaluateSkillRules(rows, ctx)).toEqual({
      ruleId: "home_depot",
      output: { account: "Materials" },
    });
    expect(evaluateSkillRules(rows.slice(0, 1), ctx)).toBeNull();
  });
});

describe("the skill definition: parameters and rule rows", () => {
  const rulesSkill = (extra: Record<string, unknown>) =>
    SkillDefinition.safeParse({
      ...base,
      id: "custom:x",
      name: "X",
      mode: "tool",
      input: { type: "object" },
      output: { type: "object" },
      ...extra,
    });

  it("a deterministic skill without code needs rule rows", () => {
    expect(rulesSkill({}).success).toBe(false);
    expect(
      rulesSkill({ rules: [{ id: "a", when: { match: "all", rules: [] }, set: { x: 1 } }] })
        .success,
    ).toBe(true);
  });

  it("refuses a row that sets nothing, or sets a field twice", () => {
    expect(rulesSkill({ rules: [{ id: "a", when: { match: "all", rules: [] } }] }).success).toBe(
      false,
    );
    expect(
      rulesSkill({
        rules: [
          {
            id: "a",
            when: { match: "all", rules: [] },
            set: { x: 1 },
            compute: { x: { value: 2 } },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("refuses a row naming a parameter the skill lacks, or bucketing by a number", () => {
    const row = {
      id: "a",
      when: { match: "all", rules: [] },
      compute: { b: { bucket: { value: { input: "days" }, by: "aging" } } },
    };
    expect(rulesSkill({ rules: [row] }).success).toBe(false);
    expect(
      rulesSkill({ rules: [row], parameters: [{ name: "aging", label: "A", type: "number" }] })
        .success,
    ).toBe(false);
    expect(
      rulesSkill({ rules: [row], parameters: [{ name: "aging", label: "A", type: "buckets" }] })
        .success,
    ).toBe(true);
  });

  it("checks a parameter's default against its type, and buckets for order and overlap", () => {
    expect(
      rulesSkill({
        rules: [{ id: "a", when: { match: "all", rules: [] }, set: { x: 1 } }],
        parameters: [{ name: "n", label: "N", type: "number", default: "5" }],
      }).success,
    ).toBe(false);
    const p = { name: "aging", type: "buckets" as const };
    expect(parameterValueProblem(p, AGING)).toBeNull();
    expect(
      parameterValueProblem(p, [
        { from: 0, to: 30, label: "A" },
        { from: 30, label: "B" },
      ]),
    ).toMatch(/overlaps/);
    expect(
      parameterValueProblem(p, [
        { from: 0, label: "A" },
        { from: 31, label: "B" },
      ]),
    ).toMatch(/overlaps|open-ended/);
    expect(parameterValueProblem(p, [{ from: 10, to: 5, label: "A" }])).toMatch(/ends before/);
    expect(parameterValueProblem({ name: "d", type: "date" }, "2026-02-28")).toBeNull();
    expect(parameterValueProblem({ name: "d", type: "date" }, "2026-02-30")).toMatch(/date/);
    expect(parameterValueProblem({ name: "d", type: "date" }, "next week")).toMatch(/date/);
    expect(
      parameterValueProblem({ name: "m", type: "money" }, { amount: "5.00", currency: "USD" }),
    ).toBeNull();
    expect(parameterValueProblem({ name: "m", type: "money" }, 5)).toMatch(/amount/);
  });

  it("parses every stored shape unchanged: when and set alone still read", () => {
    const parsed = rulesSkill({
      rules: [{ id: "a", when: { match: "all", rules: [] }, set: { x: 1 } }],
    });
    expect(parsed.success && parsed.data.rules).toEqual([
      { id: "a", when: { match: "all", rules: [] }, set: { x: 1 } },
    ]);
  });
});

describe("kinds: deterministic or AI", () => {
  const code = (handler: string) =>
    SkillDefinition.parse({
      ...base,
      id: handler,
      name: handler,
      mode: "tool",
      handler,
      input: {},
      output: {},
    });
  const task = SkillDefinition.parse({
    ...base,
    id: "custom:read",
    name: "Read",
    mode: "task",
    model: { id: "claude-haiku-4-5" },
    instructions: "Read it.",
    input: {},
    output: {},
  });

  it("labels code that calls a model AI, never deterministic", () => {
    expect(skillKind(code("docs.get"), TOOLS)).toBe("deterministic");
    expect(skillKind(code("docs.extract"), TOOLS)).toBe("ai");
    expect(skillKind(task)).toBe("ai");
    expect(skillKind({ ...task, mode: "agent" })).toBe("ai");
    expect(SKILL_KIND_LABEL[skillKind(code("docs.get"), TOOLS)]).toBe("Deterministic");
  });

  it("retires rules_then_ai and agent mode for new versions, in plain words", () => {
    expect(retiredSkillReason(task)).toBeNull();
    expect(retiredSkillReason({ mode: "task", method: "rules_then_ai" })).toMatch(/two skills/);
    expect(retiredSkillReason({ mode: "agent" })).toMatch(/write step/);
    expect(newSkillVersionProblems({ ...task, tools: ["qbo.bill.create"] }, TOOLS)).toEqual([
      'A skill never writes: "qbo.bill.create" changes something. Put a write step after the skill instead.',
    ]);
    expect(newSkillVersionProblems(task, TOOLS)).toEqual([]);
    expect(
      newSkillVersionProblems(
        {
          ...code("docs.get"),
          rules: [{ id: "a", when: { match: "all", rules: [] }, set: { x: 1 } }],
        },
        TOOLS,
      ),
    ).toEqual(["A deterministic skill runs its rule rows or its built-in code, not both."]);
  });
});

describe("parameters per agent and per step", () => {
  it("layers the skill's defaults under the agent's under the step's", () => {
    const def = {
      parameters: [
        { name: "a", label: "A", type: "number" as const, default: 1 },
        { name: "b", label: "B", type: "number" as const },
        { name: "c", label: "C", type: "text" as const },
      ],
    };
    expect(
      resolveSkillParameters(def, { agent: { b: 2, c: "x" }, step: { c: "y", z: 9 } }),
    ).toEqual({
      a: 1,
      b: 2,
      c: "y",
    });
    expect(parameterValueProblems(def, { a: "1", z: 1 })).toEqual([
      { name: "a", message: "a is a number" },
      { name: "z", message: "the skill has no parameter z" },
    ]);
    expect(parameterValueProblems(def, { b: 2 }, { complete: true }).map((p) => p.name)).toEqual([
      "c",
    ]);
  });

  it("holds an agent's values and models to the skill at publish", () => {
    const skills = { [ageReceivables.id]: ageReceivables };
    const definition = {
      skills: [
        {
          skill: ageReceivables.id,
          settings: {},
          parameters: { aging: [{ from: 5, to: 1, label: "x" }] },
        },
        { skill: ageReceivables.id, settings: {}, model: { id: "claude-sonnet-5-5" } },
      ],
    };
    const errors = definitionSkillErrors(definition, { skills, models: ["claude-sonnet-5-5"] });
    expect(errors.map((e) => [e.field, e.code])).toEqual([
      ["definition.skills.0.parameters.aging", "parameter_invalid"],
      ["definition.skills.1.model", "model_not_allowed"],
    ]);
    expect(
      definitionModelErrors(
        {
          model: { id: "claude-sonnet-5-5", maxTokens: 4096 },
          skills: [{ model: { id: "openai:nope" } }],
        },
        ["claude-sonnet-5-5"],
      ).map((e) => e.field),
    ).toEqual(["definition.skills.0.model.id"]);
  });
});

describe("the model that runs", () => {
  const task = { mode: "task" as const, model: { id: "claude-haiku-4-5", maxTokens: 1000 } };
  const agentModel = { id: "claude-sonnet-5-5", maxTokens: 4096 };

  it("most specific wins: step, then agent × skill, then the skill's, then the agent's", () => {
    expect(
      effectiveModel({ skill: task, agentModel, step: { id: "s" }, agentSkill: { id: "a" } }),
    ).toEqual({
      model: { id: "s", maxTokens: 1000 },
      from: "step",
    });
    expect(
      effectiveModel({ skill: task, agentModel, agentSkill: { id: "a", maxTokens: 50 } }),
    ).toEqual({
      model: { id: "a", maxTokens: 50 },
      from: "agent",
    });
    expect(effectiveModel({ skill: task, agentModel })).toEqual({
      model: { id: "claude-haiku-4-5", maxTokens: 1000 },
      from: "skill",
    });
    expect(effectiveModel({ skill: { mode: "agent" }, agentModel })).toEqual({
      model: agentModel,
      from: "default",
    });
    expect(effectiveModel({ skill: { mode: "tool" }, agentModel, step: { id: "s" } })).toBeNull();
    expect(recommendedModel(task)).toEqual(task.model);
    expect(recommendedModel({ mode: "agent" })).toBeNull();
  });
});

describe("moving a step to another version", () => {
  const v1 = SkillDefinition.parse({
    ...base,
    id: "custom:match",
    name: "Match",
    mode: "task",
    model: { id: "claude-haiku-4-5" },
    instructions: "Match.",
    input: { type: "object", properties: { line: { type: "string" } }, required: ["line"] },
    output: {
      type: "object",
      properties: {
        itemId: { type: "string" },
        confidence: { type: "number" },
        lines: {
          type: "array",
          items: { type: "object", properties: { qty: { type: "number" } } },
        },
      },
      required: ["itemId", "confidence"],
    },
    parameters: [{ name: "floor", label: "Floor", type: "number", default: 0.8 }],
  });

  it("only optional additions are compatible", () => {
    const v2 = {
      ...v1,
      input: { ...v1.input, properties: { line: { type: "string" }, hint: { type: "string" } } },
      output: {
        ...v1.output,
        properties: { ...(v1.output.properties as object), note: { type: "string" } },
      },
      parameters: [
        ...(v1.parameters ?? []),
        { name: "extra", label: "E", type: "text" as const, default: "" },
      ],
    };
    expect(skillVersionChange(v1, v2)).toEqual({ compatible: true, breaks: [] });
  });

  it("names every break: removed (a likely rename), type changed, newly required, parameters", () => {
    const props = v1.output.properties as Record<string, unknown>;
    const v2 = {
      ...v1,
      input: {
        type: "object",
        properties: { line: { type: "string" }, vendor: { type: "string" } },
        required: ["line", "vendor"],
      },
      output: {
        type: "object",
        properties: {
          catalogItemId: { type: "string" },
          confidence: { type: "string" },
          lines: {
            type: "array",
            items: { type: "object", properties: { qty: { type: "string" } } },
          },
        },
        required: ["catalogItemId"],
      },
      parameters: [{ name: "mode", label: "Mode", type: "text" as const }],
    };
    expect(props).toBeDefined();
    const change = skillVersionChange(v1, v2);
    expect(change.compatible).toBe(false);
    expect(change.breaks.map((b) => [b.side, b.kind, b.field, b.renamedTo])).toEqual([
      ["output", "removed", "itemId", "catalogItemId"],
      ["output", "now_optional", "confidence", undefined],
      ["output", "type_changed", "confidence", undefined],
      ["output", "type_changed", "lines.*.qty", undefined],
      ["input", "required_added", "vendor", undefined],
      ["parameter", "parameter_removed", "floor", undefined],
      ["parameter", "parameter_required_added", "mode", undefined],
    ]);
  });

  const process = Process.parse({
    schemaVersion: 4,
    triggers: [
      {
        id: "t1",
        on: { type: "manual", input: { type: "object", properties: { line: { type: "string" } } } },
      },
    ],
    steps: [
      {
        id: "m",
        name: "Match",
        kind: "skill",
        skill: "custom:match@1",
        input: { line: "{{trigger.line}}" },
      },
      {
        id: "sure",
        name: "Sure?",
        kind: "if",
        paths: [
          {
            id: "p1",
            name: "Sure",
            when: {
              match: "all",
              rules: [{ field: "{{steps.m.output.confidence}}", op: ">", value: 0.9 }],
            },
            steps: [
              {
                id: "n",
                name: "Tell",
                kind: "notify",
                notify: {
                  to: ["lead"],
                  message: "Matched {{steps.m.output.itemId}}, {{steps.m.output.lines.0.qty}} each",
                },
              },
            ],
          },
        ],
        otherwise: { id: "o", steps: [] },
      },
      {
        id: "n2",
        name: "All",
        kind: "notify",
        notify: { to: ["lead"], message: "{{steps.m.output}}" },
      },
    ],
  });

  it("lists every reference downstream a break hits, the step's own input included", () => {
    const v2 = {
      ...v1,
      output: {
        type: "object",
        properties: { confidence: { type: "number" } },
        required: ["confidence"],
      },
      input: {
        ...v1.input,
        properties: { line: { type: "string" }, vendor: { type: "string" } },
        required: ["line", "vendor"],
      },
    };
    const { breaks } = skillVersionChange(v1, v2);
    expect(skillStepReferences(process, "m", breaks)).toEqual([
      { stepId: "n", at: "notify.message", expr: "steps.m.output.itemId", field: "itemId" },
      { stepId: "n", at: "notify.message", expr: "steps.m.output.lines.0.qty", field: "lines" },
      { stepId: "n2", at: "notify.message", expr: "steps.m.output", field: "*" },
      { stepId: "m", at: "input.vendor", expr: "input.vendor", field: "vendor" },
    ]);
  });

  it("types the moved process with the same validator: what the move adds", () => {
    const ctx = { skills: { "custom:match@1": v1 } };
    const v2 = {
      ...v1,
      output: {
        type: "object",
        properties: { confidence: { type: "number" } },
        required: ["confidence"],
      },
    };
    const impact = skillMoveImpact(process, "m", "custom:match@2", v2, ctx);
    expect(impact?.compatible).toBe(false);
    expect(impact?.errors.map((e) => [e.stepId, e.code])).toEqual([
      ["n", "template_path"],
      ["n", "template_path"],
    ]);
    const same = skillMoveImpact(process, "m", "custom:match@2", v1, ctx);
    expect(same).toMatchObject({ compatible: true, breaks: [], references: [], errors: [] });
    expect(skillMoveImpact(process, "n", "custom:match@2", v1, ctx)).toBeNull();
  });

  it("refuses a retired kind of skill in a new step, never in one already there", () => {
    const agentMode = { ...v1, mode: "agent" as const, model: undefined };
    const ctx = { skills: { "custom:match@1": agentMode } };
    const codes = (existing?: Set<string>) =>
      validateProcess(process, {
        ...ctx,
        ...(existing ? { existingStepIds: existing } : {}),
      }).errors.map((e) => e.code);
    expect(codes(new Set())).toContain("skill_retired");
    expect(codes(new Set(["m"]))).not.toContain("skill_retired");
    expect(codes()).not.toContain("skill_retired");
  });
});

describe("write steps: Save to records or Change in a client's tool", () => {
  it("labels and defaults by the tool's side effect", () => {
    const step = { kind: "write" };
    expect(writeStepLabel(step, { sideEffect: "internal", source: "platform" })).toEqual({
      kind: "save_to_records",
      text: "Save to records",
    });
    expect(
      writeStepLabel(
        step,
        { sideEffect: "external", source: "qbo", connector: "qbo" },
        "QuickBooks Online",
      ),
    ).toEqual({
      kind: "change_in",
      text: "Change in QuickBooks Online",
    });
    expect(writeStepLabel(step, undefined).kind).toBe("change_in");
    expect(defaultWriteApproval({ sideEffect: "internal" })).toBeUndefined();
    expect(defaultWriteApproval({ sideEffect: "external" })?.required).toBe("required");
    expect(defaultWriteApproval(undefined)?.required).toBe("required");
  });
});
