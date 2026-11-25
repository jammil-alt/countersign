// Core's helpers for readers of a bundle: every step, a step by id or by a step_run's node id, and
// the message triggers Sloan passes to.

import { describe, expect, it } from "vitest";
import { AgentBundle, type AgentBundleInput } from "../schemas/agent";
import { acceptsSloan } from "../triggers/kinds";
import { eachBundleStep, findAnyStep, findNodeStep } from "./normalize";

const definition = {
  schemaVersion: 2,
  identity: { name: "Clerk", role: "keeps records", mission: "keep records right" },
  kind: "functional",
  model: { id: "claude-opus-5-5", maxTokens: 1024 },
  instructions: "Be careful.",
  skills: [],
  extraTools: [],
  canCommand: [],
  permissions: { mode: "suggest_only" },
  budgets: { maxSteps: 4, maxCostUsd: "0.10" },
  memory: { enabled: false },
} satisfies AgentBundleInput["definition"];

const bundle = AgentBundle.parse({
  schemaVersion: 1,
  definition,
  workflows: [
    {
      slug: "old",
      name: "Old",
      workflow: {
        schemaVersion: 5,
        triggers: [{ id: "t3", on: { type: "manual", input: {} } }],
        outputs: [],
        steps: [
          {
            id: "a3",
            name: "Act",
            kind: "do",
            doneBy: "rules",
            uses: { type: "action", action: "testkit.record.update" },
          },
        ],
      },
    },
    {
      slug: "new",
      name: "New",
      enabled: false,
      workflow: {
        schemaVersion: 5,
        triggers: [
          { id: "t4", on: { type: "manual", input: {} } },
          {
            id: "t4-sloan",
            on: { type: "message", channels: ["sloan"], from: {} },
          },
        ],
        outputs: [],
        steps: [
          {
            id: "loop",
            name: "Each",
            kind: "for_each",
            over: "{{trigger.items}}",
            steps: [
              {
                id: "w4",
                name: "Write",
                kind: "do",
                doneBy: "rules",
                uses: { type: "action", action: "testkit.record.update" },
              },
            ],
          },
        ],
      },
    },
  ],
} satisfies AgentBundleInput);

describe("reading a bundle's workflows", () => {
  it("visits every step, nested ones too, and skips disabled workflows on asking", () => {
    const all: string[] = [];
    eachBundleStep(bundle, (s, w) => all.push(`${w.slug}:${s.kind}:${s.id}`));
    expect(all).toEqual(["old:do:a3", "new:for_each:loop", "new:do:w4"]);
    const enabled: string[] = [];
    eachBundleStep(bundle, (s) => enabled.push(s.id), { enabledOnly: true });
    expect(enabled).toEqual(["a3"]);
  });

  it("finds a step by id, and by a loop's node id", () => {
    const [first, second] = bundle.workflows.map((w) => w.workflow);
    if (!first || !second) throw new Error("fixture");
    expect(findAnyStep(first, "a3")?.kind).toBe("do");
    expect(findAnyStep(second, "w4")?.kind).toBe("do");
    expect(findNodeStep(second, "loop:2:w4")?.id).toBe("w4");
    expect(findNodeStep(second, "nope")).toBeUndefined();
  });

  it("sees a workflow's message trigger on Sloan's channel", () => {
    const only = { ...bundle, workflows: bundle.workflows.map((w) => ({ ...w, enabled: true })) };
    expect(acceptsSloan(only)).toBe(true);
    expect(acceptsSloan(bundle)).toBe(false);
  });
});
