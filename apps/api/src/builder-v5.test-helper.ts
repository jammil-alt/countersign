// ONE-OFF (step model, docs/step-model-plan.md §13b, stream I): the Builder drafts v5 workflows
// (build item 9), so the tests that script its answers give them in the step model. A test's v4
// answer is turned into one by core's one-off converter (`steps.toStepModel`), with the real
// registries, so each test keeps the agent it was written about. Wave 4 deletes it with the
// converter; the answers it converts are written out in the step model then.

import { isToolWrapper, processes, skillMethod, steps } from "@countersign/core";
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

type Json = Record<string, unknown>;

/** A bundle whose v4 (or v3) workflows are rewritten in the step model; v5 ones stay. */
export function stepModelBundle<T>(bundle: T): T {
  const b = bundle as Json & { workflows?: Json[] };
  if (!Array.isArray(b.workflows)) return bundle;
  return {
    ...b,
    workflows: b.workflows.map((w) => {
      const wf = w.workflow as Json | undefined;
      if (!wf || wf.schemaVersion === 5) return w;
      const source =
        wf.schemaVersion === 4 ? processes.Process.parse(wf) : (wf as unknown as never);
      return { ...w, workflow: steps.toStepModel(source, lookup).workflow };
    }),
  } as T;
}

/** A scripted `submit_draft`, `submit_revision` or `submit_turn` answer, its bundle in v5. */
export function stepModelAnswer<T>(answer: T): T {
  const a = answer as Json;
  if (a.toolUse && typeof a.toolUse === "object") {
    const tu = a.toolUse as Json;
    return { ...a, toolUse: { ...tu, input: stepModelAnswer(tu.input) } } as T;
  }
  if (a.bundle === undefined) return answer;
  return { ...a, bundle: stepModelBundle(a.bundle) } as T;
}
