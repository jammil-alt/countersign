// v0.13 W2-I, M32: checkpoints are computed from the steps, never guessed (ARCHITECTURE §10.11;
// docs/plan.md §1.54): a skill or action step whose output a later write step's input references,
// or one with `review: 'always'`, in forks, loops and automations' expanded steps.

import { describe, expect, it } from "vitest";
import { OversightSettings, reviewsAfterSuccess } from "../oversight/decision";
import type { SkillDefinition } from "../schemas/skill";
import type { ToolSpec } from "../schemas/tool";
import { Step, Workflow } from "../schemas/workflow";
import { checkpointSteps, workflowCheckpoints } from "./validate";

const READ: SkillDefinition = {
  schemaVersion: 1,
  id: "test.read",
  name: "Read",
  description: "",
  category: "test",
  mode: "task",
  model: { id: "claude-haiku-5-5" },
  tools: [],
  input: {},
  output: {},
  settings: [],
  requiresConnectors: [],
  requiresPacks: [],
  producesAlerts: false,
};
const WRITE: ToolSpec = {
  id: "testkit.bill.create",
  description: "",
  input: {},
  output: {},
  sideEffect: "external",
  verb: "create",
  source: "testkit",
  connector: "testkit",
};
const LOOKUP: ToolSpec = { ...WRITE, id: "testkit.bill.query", sideEffect: "none", verb: "read" };
/** An agent skill whose tools write: a write step too. */
const POSTER: SkillDefinition = {
  ...READ,
  id: "test.post",
  mode: "agent",
  model: undefined,
  tools: [WRITE.id],
} as SkillDefinition;
const ctx = {
  skills: { [READ.id]: READ, [POSTER.id]: POSTER },
  tools: { [WRITE.id]: WRITE, [LOOKUP.id]: LOOKUP },
};

const read = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: "skill",
  name: id,
  skill: READ.id,
  input: {},
  ...over,
});
const write = (id: string, from: string) => ({
  id,
  kind: "action",
  name: id,
  tool: WRITE.id,
  input: { total: `{{steps.${from}.output.total}}` },
});
const lookup = (id: string, from: string) => ({
  id,
  kind: "action",
  name: id,
  tool: LOOKUP.id,
  input: { q: `{{steps.${from}.output.total}}` },
});
const wf = (steps: unknown[]) =>
  Workflow.parse({
    schemaVersion: 3,
    trigger: { id: "t", on: { type: "manual", input: {} } },
    steps,
  });

describe("checkpoints", () => {
  it("marks a step whose output a write's input references, not one only a read uses", () => {
    const w = wf([
      read("extract"),
      read("other"),
      lookup("find", "other"),
      write("bill", "extract"),
    ]);
    expect([...checkpointSteps(w.steps, ctx)]).toEqual(["extract"]);
  });

  it("counts a skill whose tools write as a write, and `review: 'always'` on any step", () => {
    const w = wf([
      read("extract"),
      read("loud", { review: "always" }),
      {
        id: "post",
        kind: "skill",
        name: "Post",
        skill: POSTER.id,
        input: { x: "{{steps.extract.output.total}}" },
      },
    ]);
    expect([...checkpointSteps(w.steps, ctx)].sort()).toEqual(["extract", "loud"]);
  });

  it("finds them across forks and loops", () => {
    const w = wf([
      read("extract"),
      {
        id: "split",
        kind: "fork",
        name: "Split",
        paths: [
          {
            id: "p1",
            name: "One",
            when: { match: "all", rules: [{ field: "{{trigger.x}}", op: "is", value: 1 }] },
            steps: [read("inner"), write("w1", "inner")],
          },
        ],
        otherwise: { id: "p2", steps: [write("w2", "extract")] },
      },
      {
        id: "each",
        kind: "for_each",
        name: "Each",
        over: "{{trigger.items}}",
        steps: [read("item-read"), write("item-write", "item-read")],
      },
    ]);
    expect([...checkpointSteps(w.steps, ctx)].sort()).toEqual(["extract", "inner", "item-read"]);
  });

  it("finds them in an automation's expanded steps, and before a use step whose automation writes", () => {
    const automation = {
      steps: [read("a-read"), write("a-write", "a-read")].map((s) => Step.parse(s)),
    };
    const w = wf([
      read("extract"),
      {
        id: "use",
        kind: "use_automation",
        name: "Bill it",
        automation: "bill-it@1",
        input: { total: "{{steps.extract.output.total}}" },
      },
    ]);
    expect(workflowCheckpoints(w, { ...ctx, automations: { "bill-it@1": automation } })).toEqual([
      "extract",
      "use/a-read",
    ]);
    // An automation the context doesn't hold adds nothing.
    expect(workflowCheckpoints(w, ctx)).toEqual([]);
  });

  it("is reviewed after success under checkpoints (checkpoints only) and all; never under failures", () => {
    const s = (review: string) => OversightSettings.parse({ review });
    expect(reviewsAfterSuccess(s("failures"), {}, true)).toBe(false);
    expect(reviewsAfterSuccess(s("checkpoints"), {}, true)).toBe(true);
    expect(reviewsAfterSuccess(s("checkpoints"), {}, false)).toBe(false);
    expect(reviewsAfterSuccess(s("all"), {}, false)).toBe(true);
    expect(reviewsAfterSuccess(s("all"), { review: "off" }, true)).toBe(false);
    expect(reviewsAfterSuccess(undefined, { review: "always" }, false)).toBe(true);
    expect(reviewsAfterSuccess(undefined, {}, true)).toBe(false);
  });
});
