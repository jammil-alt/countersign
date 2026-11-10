// Wave 3b (docs/plan.md §1.86, readers): core's helpers for readers of a bundle that may hold v3
// workflows and v4 processes alike: every step, a step by id or by a step_run's node id, and the
// message triggers Sloan passes to.

import { describe, expect, it } from "vitest";
import { AnyAgentBundle, type AnyAgentBundleInput } from "../schemas/agent";
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
} satisfies AnyAgentBundleInput["definition"];

const bundle = AnyAgentBundle.parse({
  schemaVersion: 1,
  definition,
  workflows: [
    {
      slug: "old",
      name: "Old",
      workflow: {
        schemaVersion: 3,
        trigger: { id: "t3", on: { type: "manual", input: {} } },
        steps: [{ id: "a3", name: "Act", kind: "action", tool: "testkit.record.update" }],
      },
    },
    {
      slug: "new",
      name: "New",
      enabled: false,
      workflow: {
        schemaVersion: 4,
        triggers: [
          { id: "t4", on: { type: "manual", input: {} } },
          {
            id: "t4-sloan",
            on: { type: "message", channels: ["sloan"], from: {} },
          },
        ],
        steps: [
          {
            id: "loop",
            name: "Each",
            kind: "for_each",
            over: "{{trigger.items}}",
            steps: [{ id: "w4", name: "Write", kind: "write", tool: "testkit.record.update" }],
          },
        ],
      },
    },
  ],
} satisfies AnyAgentBundleInput);

describe("reading v3 and v4 workflows alike", () => {
  it("visits every step of both schemas, nested ones too, and skips disabled workflows on asking", () => {
    const all: string[] = [];
    eachBundleStep(bundle, (s, w) => all.push(`${w.slug}:${s.kind}:${s.id}`));
    expect(all).toEqual(["old:action:a3", "new:for_each:loop", "new:write:w4"]);
    const enabled: string[] = [];
    eachBundleStep(bundle, (s) => enabled.push(s.id), { enabledOnly: true });
    expect(enabled).toEqual(["a3"]);
  });

  it("finds a step by id, and by a loop's node id, in either schema", () => {
    const [v3, v4] = bundle.workflows.map((w) => w.workflow);
    if (!v3 || !v4) throw new Error("fixture");
    expect(findAnyStep(v3, "a3")?.kind).toBe("action");
    expect(findAnyStep(v4, "w4")?.kind).toBe("write");
    expect(findNodeStep(v4, "loop:2:w4")?.id).toBe("w4");
    expect(findNodeStep(v4, "nope")).toBeUndefined();
  });

  it("sees a process's message trigger on Sloan's channel", () => {
    const only = { ...bundle, workflows: bundle.workflows.map((w) => ({ ...w, enabled: true })) };
    expect(acceptsSloan(only)).toBe(true);
    expect(acceptsSloan(bundle)).toBe(false);
  });
});
