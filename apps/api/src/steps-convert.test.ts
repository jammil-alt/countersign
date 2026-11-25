// ONE-OFF (docs/step-model-plan.md §13b, wave 0): every seeded agent's workflows convert to the step
// model and pass its publish checks, with the real registries. Deleted with the converter (wave 4).

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isToolWrapper, skillMethod, steps } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { createPlatform, deploymentConnectors } from "./platform";

const platform = createPlatform({ connectors: deploymentConnectors({} as never, false) });
const skills = new Map(platform.catalog.list().map((s) => [s.id, s]));
const specs = new Map(platform.tools.list().map((t) => [t.spec.id, t.spec]));

const lookup: steps.V5ConvertLookup = {
  wrappedTool: (id) => {
    const s = skills.get(id);
    return s && isToolWrapper(s) ? (s.handler ?? null) : null;
  },
  sideEffect: (id) => specs.get(id)?.sideEffect ?? null,
  skillMethod: (id) => {
    const s = skills.get(id);
    if (!s) return undefined;
    return s.mode === "agent" ? "agent" : skillMethod(s) === "rules" ? "rules" : "ai";
  },
};

const seeds = join(__dirname, "../../../packages/db/seed/agents");

describe("the one-off converter, on every seeded agent", () => {
  for (const file of readdirSync(seeds).filter((f) => f.endsWith(".json"))) {
    const bundle = JSON.parse(readFileSync(join(seeds, file), "utf8"));
    for (const entry of bundle.workflows ?? []) {
      it(`${file} › ${entry.slug}`, () => {
        const { workflow } = steps.toStepModel(entry.workflow, lookup);
        const parsed = steps.Workflow.parse(workflow);
        const issues = steps.validateWorkflow(parsed, {
          sideEffect: (a) => specs.get(a)?.sideEffect,
        });
        expect(issues.filter((i) => i.code !== "not_built_yet")).toEqual([]);
      });
    }
  }
});
