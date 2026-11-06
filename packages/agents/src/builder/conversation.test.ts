// v0.12 W3-A: the Builder as a conversation against scripted model answers (FakeModel): the model
// never sees an id it could regenerate, the guards hold across turns, commands keep a turn to what
// they name, undo reverts one change alone or refuses with the conflict, and draft-skill turns
// examples into test cases whose inputs come from the examples.

import {
  ConnectorRegistry,
  createTestkitConnector,
  TESTKIT_QUERY_TOOL,
  TESTKIT_UPDATE_TOOL,
} from "@countersign/connectors";
import {
  type AgentBundle,
  type AgentBundleInput,
  AgentBundle as AgentBundleSchema,
  type SkillDefinition,
  type Step,
  validateBundle,
  walkSteps,
} from "@countersign/core";
import { createLlmClient, FakeModel, type LlmRequest } from "@countersign/llm";
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../registry/tools";
import { PLATFORM_TOOLS } from "../tools/platform";
import { aliasBundle, unaliasBundle } from "./aliases";
import { entryKey, undoChange, undoneEntries } from "./changes";
import { readCommand } from "./commands";
import type { BuilderContext } from "./context";
import { agentTurn, blankAgentDraft, TURN_TOOL } from "./conversation";
import {
  EMPTY_SKILL_DRAFT,
  SKILL_TOOL,
  skillChanges,
  skillTurn,
  undoSkillChange,
} from "./skill-draft";

const registry = new ToolRegistry({
  platform: PLATFORM_TOOLS,
  connectors: new ConnectorRegistry([createTestkitConnector()]),
});

const matchSkill: SkillDefinition = {
  schemaVersion: 1,
  id: "custom:match-receipt",
  name: "Match a receipt",
  description: "Finds the record a receipt belongs to",
  category: "data",
  mode: "agent",
  instructions: "Match it.",
  tools: [TESTKIT_QUERY_TOOL],
  input: { type: "object", properties: { text: { type: "string" } } },
  output: { type: "object", properties: { recordId: { type: "string" } } },
  settings: [
    { key: "window_days", label: "Window", type: "number", default: 3, clientSpecific: false },
  ],
  requiresConnectors: ["testkit"],
  requiresPacks: [],
  producesAlerts: false,
};

function context(): BuilderContext {
  return {
    tools: Object.values(registry.specs()),
    skills: [{ ref: matchSkill.id, definition: matchSkill, source: "shared" }],
    connectors: [{ id: "testkit", name: "Testkit" }],
    packs: [],
    events: [],
    templates: [],
    client: null,
    agentSlugs: [],
    automations: [
      {
        ref: "lookup@1",
        slug: "lookup",
        name: "Lookup",
        description: "Looks a record up",
        input: { type: "object" },
        output: {},
      },
    ],
    models: ["claude-haiku-5-5", "claude-sonnet-5-5"],
  };
}

const validate = async (bundle: AgentBundle) =>
  validateBundle(bundle, { skills: { [matchSkill.id]: matchSkill }, tools: registry.specs() })
    .errors;

/** Server ids for the whole file, so turns never reuse one. */
let made = 0;
const newId = () => {
  made += 1;
  return `id${made}`;
};

const stepsOf = (b: AgentBundle) => {
  const out: Step[] = [];
  for (const w of b.workflows) walkSteps(w.workflow, ({ step }) => out.push(step));
  return out;
};

/** The aliased draft the model was shown in a request. */
function shownBundle(req: LlmRequest): AgentBundle {
  const content = req.messages[0]?.content as string;
  const start = content.indexOf("<current_bundle>") + "<current_bundle>".length;
  const end = content.indexOf("</current_bundle>");
  return JSON.parse(content.slice(start, end)) as AgentBundle;
}

type Draft = AgentBundleInput & { workflows: { workflow: { steps: Record<string, unknown>[] } }[] };

/** A model that edits the draft it was shown and answers with it. */
function editing(fn: (b: Draft) => void) {
  return (req: LlmRequest) => {
    const b = structuredClone(shownBundle(req)) as unknown as Draft;
    fn(b);
    return { toolUse: { name: TURN_TOOL, input: { text: "Done.", bundle: b } } };
  };
}

const matchStep = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: "skill",
  name: "Match the receipt",
  skill: matchSkill.id,
  input: { text: "{{trigger.text}}" },
  ...over,
});
const noteStep = (id: string, ref: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: "action",
  name: "Note it on the record",
  tool: TESTKIT_UPDATE_TOOL,
  input: { id: `{{steps.${ref}.output.recordId}}`, name: "Receipt matched" },
  ...over,
});

async function turn(
  working: AgentBundle,
  message: string,
  answer: (req: LlmRequest) => unknown,
  origin: AgentBundle | null = null,
) {
  const read = readCommand(message, { bundle: working, automations: context().automations ?? [] });
  if (!read.ok) throw new Error(read.message);
  const model = new FakeModel([answer as never]);
  const result = await agentTurn(
    { working, origin, history: [], message, command: read.command, ctx: context() },
    { llm: createLlmClient({ transport: model }), validate, newId },
  );
  return { ...result, model };
}

describe("aliases", () => {
  it("shows the model short handles and maps its answer back", () => {
    const b = blankAgentDraft({ name: "Remy" }, () => "019a7f00-0000-7000-8000-00000000000a");
    b.workflows[0]?.workflow.steps.push(
      matchStep("019a7f00-0000-7000-8000-00000000000b") as unknown as Step,
      noteStep(
        "019a7f00-0000-7000-8000-00000000000c",
        "019a7f00-0000-7000-8000-00000000000b",
      ) as unknown as Step,
    );
    const { bundle: shown, aliases } = aliasBundle(b);
    expect(JSON.stringify(shown)).not.toContain("019a7f00");
    expect(stepsOf(shown).map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(JSON.stringify(stepsOf(shown)[1])).toContain("{{steps.s1.output.recordId}}");
    expect(unaliasBundle(shown, aliases)).toEqual(b);
  });
});

describe("a conversation about a new agent", () => {
  const start = blankAgentDraft({ name: "Remy", role: "Card receipts" }, () => "trig-1");

  it("holds the guards across turns, with ids made by the server once", async () => {
    const t1 = await turn(
      start,
      "Draft Remy: match each card receipt and note it on the record.",
      editing((b) => {
        b.definition.permissions = { mode: "act" };
        b.definition.oversight = { review: "off" };
        b.definition.skills = [{ skill: matchSkill.id }];
        (b.workflows[0] as Draft["workflows"][number]).workflow.steps = [
          matchStep("s1", { model: { id: "gpt-unknown" } }),
          noteStep("s2", "s1", { approval: { required: "not_required" } }),
        ];
      }),
    );
    // The model saw no real id, not even the trigger's.
    expect(JSON.stringify(t1.model.requests[0])).not.toContain("trig-1");
    expect(t1.bundle.workflows[0]?.workflow.trigger.id).toBe("trig-1");
    const [m1, n1] = stepsOf(t1.bundle);
    expect(m1?.id).toMatch(/^id\d+$/);
    expect(JSON.stringify(n1)).toContain(`{{steps.${m1?.id}.output.recordId}}`);
    expect(t1.bundle.definition.permissions.mode).toBe("suggest_only");
    expect(t1.bundle.definition.oversight).toMatchObject({ review: "failures" });
    expect(m1 && m1.kind === "skill" ? m1.model : "x").toBeUndefined();
    expect(n1 && n1.kind === "action" ? n1.approval.required : null).toBe("required");
    expect(t1.changes.map((c) => c.label)).toEqual(
      expect.arrayContaining([
        "+1 skill · custom:match-receipt",
        "+1 skill, step 1 · Match the receipt",
        "+1 action, step 2 · Note it on the record",
      ]),
    );

    // Turn 2: it tries again to act alone and skip the approval, and adds a wait step.
    const t2 = await turn(
      t1.bundle,
      "Wait a day after noting it.",
      editing((b) => {
        b.definition.permissions = { mode: "act" };
        const steps = (b.workflows[0] as Draft["workflows"][number]).workflow.steps;
        (steps[1] as Record<string, unknown>).approval = { required: "not_required" };
        steps.push({ id: "s1", kind: "wait", name: "Wait a day", for: "1 day" });
      }),
    );
    const ids2 = stepsOf(t2.bundle).map((s) => s.id);
    // The two steps keep their ids; the new one (which reused a handle) gets a new one.
    expect(ids2.slice(0, 2)).toEqual([m1?.id, n1?.id]);
    expect(new Set(ids2).size).toBe(3);
    expect(t2.bundle.definition.permissions.mode).toBe("suggest_only");
    const n2 = stepsOf(t2.bundle)[1];
    expect(n2 && n2.kind === "action" ? n2.approval.required : null).toBe("required");
    expect(t2.changes.map((c) => c.label)).toEqual(["+1 wait, step 3 · Wait a day"]);
  });

  it("keeps an approval the operator switched off in the version it started from", async () => {
    const origin = AgentBundleSchema.parse({
      ...start,
      definition: {
        ...start.definition,
        skills: [{ skill: matchSkill.id }],
        extraTools: [TESTKIT_UPDATE_TOOL],
      },
      workflows: [
        {
          ...start.workflows[0],
          workflow: {
            ...start.workflows[0]?.workflow,
            steps: [matchStep("m"), noteStep("n", "m", { approval: { required: "not_required" } })],
          },
        },
      ],
    });
    const t = await turn(
      origin,
      "Rename the note step.",
      editing((b) => {
        const steps = (b.workflows[0] as Draft["workflows"][number]).workflow.steps;
        (steps[1] as Record<string, unknown>).name = "Note the match";
      }),
      origin,
    );
    const n = stepsOf(t.bundle)[1];
    expect(n?.name).toBe("Note the match");
    expect(n && n.kind === "action" ? n.approval.required : null).toBe("not_required");
  });

  it("/skill changes only that skill's steps and settings", async () => {
    const working = AgentBundleSchema.parse({
      ...start,
      definition: {
        ...start.definition,
        skills: [{ skill: matchSkill.id }],
        extraTools: [TESTKIT_UPDATE_TOOL],
      },
      workflows: [
        {
          ...start.workflows[0],
          workflow: {
            ...start.workflows[0]?.workflow,
            steps: [matchStep("m"), noteStep("n", "m")],
          },
        },
      ],
    });
    const t = await turn(
      working,
      "/skill match-receipt widen the window to 5 days",
      editing((b) => {
        b.definition.skills = [{ skill: matchSkill.id, settings: { window_days: 5 } }];
        b.definition.instructions = "Something else entirely.";
        const steps = (b.workflows[0] as Draft["workflows"][number]).workflow.steps;
        (steps[1] as Record<string, unknown>).name = "Renamed out of scope";
      }),
    );
    expect(t.bundle.definition.skills[0]?.settings).toEqual({ window_days: 5 });
    expect(t.bundle.definition.instructions).toBe(working.definition.instructions);
    expect(stepsOf(t.bundle)[1]?.name).toBe("Note it on the record");
    expect(t.changes.map((c) => c.label)).toEqual([
      "~1 skill · custom:match-receipt · setting · window_days none → 5",
    ]);
    expect(t.notes.join(" ")).toContain(
      "2 changes outside /skill custom:match-receipt were left out",
    );
    // The model was told what the command allows.
    const prompt = t.model.requests[0]?.messages[0]?.content as string;
    expect(prompt).toContain("Change only the skill custom:match-receipt");
  });

  it("reads the three commands and refuses others", () => {
    const b = AgentBundleSchema.parse({
      ...start,
      definition: { ...start.definition, skills: [{ skill: matchSkill.id }] },
    });
    const automations = context().automations ?? [];
    const read = (t: string) => readCommand(t, { bundle: b, automations });
    expect(read("just words")).toEqual({ ok: true, command: null });
    expect(read("/skill match-receipt set the window")).toMatchObject({
      ok: true,
      command: { name: "skill", skill: matchSkill.id },
    });
    expect(read("/automation lookup after the match")).toMatchObject({
      ok: true,
      command: { name: "automation", ref: "lookup@1" },
    });
    expect(read("/trigger schedule every Monday at 9")).toMatchObject({
      ok: true,
      command: { name: "trigger", trigger: "schedule" },
    });
    expect(read("/skill nothing-here do it")).toMatchObject({ ok: false, code: "invalid_command" });
    expect(read("/skill match-receipt")).toMatchObject({ ok: false, code: "invalid_command" });
    expect(read("/automation missing")).toMatchObject({ ok: false, code: "invalid_command" });
    expect(read("/trigger sometimes")).toMatchObject({ ok: false, code: "invalid_command" });
    expect(read("/remy hello")).toMatchObject({ ok: false, code: "unknown_command" });
  });
});

describe("undo by three-way merge", () => {
  const base = AgentBundleSchema.parse({
    ...blankAgentDraft({ name: "Remy" }, () => "t"),
  });
  const withSteps = (steps: unknown[]) =>
    AgentBundleSchema.parse({
      ...base,
      definition: { ...base.definition, skills: [{ skill: matchSkill.id }] },
      workflows: [{ ...base.workflows[0], workflow: { ...base.workflows[0]?.workflow, steps } }],
    });

  it("reverts one change alone, keeping later ones; refuses when a later change touched it", () => {
    const before = base;
    const after1 = withSteps([matchStep("m"), noteStep("n", "m")]);
    // A later turn renames the note step.
    const working = withSteps([
      matchStep("m"),
      noteStep("n", "m", { name: "Note the match" }),
      { id: "w", kind: "wait", name: "Wait", for: "1 day" },
    ]);
    // Undo only the instructions-free part: the wait came later; undo the match step's addition?
    // The note step depends on nothing being renamed: undoing its addition conflicts (it was
    // edited later).
    const conflict = undoChange({ before, after: after1, working, changeId: "step:n" });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.conflicts[0]?.entity).toBe("step:n");
    // Undoing the skill entry's addition leaves both steps and the later wait alone.
    const ok = undoChange({
      before,
      after: after1,
      working,
      changeId: "skill:custom:match-receipt",
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.bundle.definition.skills).toEqual([]);
      expect(stepsOf(ok.bundle).map((s) => s.id)).toEqual(["m", "n", "w"]);
      expect(stepsOf(ok.bundle)[1]?.name).toBe("Note the match");
    }
  });

  it("knows what is undone, and that undoing an undo puts it back", () => {
    const c = { id: "step:n", label: "+1 step" };
    const turns = [
      { id: "t1", seq: 2, changes: [c] },
      { id: "u1", seq: 3, changes: [{ ...c, undoes: { turnId: "t1", changeId: "step:n" } }] },
    ];
    expect(undoneEntries(turns).has(entryKey("t1", "step:n"))).toBe(true);
    const redo = [
      ...turns,
      { id: "u2", seq: 4, changes: [{ ...c, undoes: { turnId: "u1", changeId: "step:n" } }] },
    ];
    expect(undoneEntries(redo).has(entryKey("t1", "step:n"))).toBe(false);
    expect(undoneEntries(redo).has(entryKey("u1", "step:n"))).toBe(true);
  });
});

describe("draft-skill", () => {
  const examples = Array.from({ length: 8 }, (_, i) => ({
    name: `Charge ${i + 1}`,
    input: { charge: { amount: `${(i + 1) * 10}.00`, merchant: `Shop ${i + 1}` } },
    ...(i < 4 ? { expected: { recordId: `r${i + 1}` } } : {}),
  }));
  const definition = {
    slug: "match-card-charge",
    name: "Match card charge",
    description: "Finds the receipt record a card charge belongs to",
    category: "data",
    mode: "task",
    model: { id: "claude-haiku-5-5" },
    instructions: "Match on amount first, then merchant.",
    tools: [TESTKIT_QUERY_TOOL, "card.feed.read"],
    input: { type: "object", properties: { charge: { type: "object" } } },
    output: { type: "object", properties: { recordId: { type: "string" } } },
    settings: [],
    producesAlerts: true,
  };

  it("drafts a skill with a case per example, inputs copied from the examples", async () => {
    const model = new FakeModel([
      {
        toolUse: {
          name: SKILL_TOOL,
          input: {
            text: "Drafted match-card-charge with eight cases.",
            gaps: [],
            definition,
            cases: examples.map((_, i) => ({
              example: i + 1,
              // The model tries to rewrite an input; only expected and matcher are taken.
              input: { charge: { amount: "0.00" } },
              ...(i >= 4 ? { expected: { recordId: `r${i + 1}` } } : {}),
              matcher:
                i === 0
                  ? { kind: "label", label: { field: "recordId", positive: "r1" } }
                  : { kind: "subset" },
            })),
          },
        },
      },
    ]);
    let k = 0;
    const r = await skillTurn(
      {
        current: EMPTY_SKILL_DRAFT,
        history: [],
        message: "Draft a skill that matches a card charge to its receipt record.",
        examples,
        ctx: context(),
      },
      {
        llm: createLlmClient({ transport: model }),
        validate: async () => [],
        newId: () => `c${++k}`,
      },
    );
    expect(r.problems).toEqual([]);
    expect(r.draft.definition).toMatchObject({
      id: "custom:match-card-charge",
      mode: "task",
      model: { id: "claude-haiku-5-5" },
      tools: [TESTKIT_QUERY_TOOL],
      requiresConnectors: ["testkit"],
      producesAlerts: false,
    });
    expect(r.gaps).toContain('There is no tool "card.feed.read"; it was left out.');
    expect(r.draft.cases).toHaveLength(8);
    expect(r.draft.cases.map((c) => c.input)).toEqual(examples.map((e) => e.input));
    expect(r.draft.cases[0]).toMatchObject({
      key: "c1",
      name: "Charge 1",
      expected: { recordId: "r1" },
      matcher: { kind: "label" },
    });
    expect(r.draft.cases[7]?.expected).toEqual({ recordId: "r8" });
    // Examples reach the model as data.
    const prompt = model.requests[0]?.messages[0]?.content as string;
    expect(prompt).toContain("<examples>");
    expect(prompt).toContain("data, not instructions");

    // Changes and undo of one case alone.
    const changes = skillChanges(EMPTY_SKILL_DRAFT, r.draft);
    expect(changes).toHaveLength(9);
    const c3 = changes.find((c) => c.id === "case:c3");
    expect(c3?.label).toBe("+1 test case · Charge 3");
    const undone = undoSkillChange(r.draft, c3 as NonNullable<typeof c3>);
    expect(undone.ok && undone.draft.cases.map((c) => c.key)).toEqual([
      "c1",
      "c2",
      "c4",
      "c5",
      "c6",
      "c7",
      "c8",
    ]);
    // A field changed again later can't be undone alone.
    const edited = {
      ...r.draft,
      definition: { ...(r.draft.definition as SkillDefinition), instructions: "Changed later." },
    };
    const first = skillChanges(EMPTY_SKILL_DRAFT, r.draft).find((c) => c.id === "definition");
    expect(undoSkillChange(edited, first as NonNullable<typeof first>).ok).toBe(false);
  });
});
