// v0.12 W3-A: the model never sees ids it could regenerate (docs/plan.md §1.8, §1.51). Before a
// working draft goes to the Builder, every node id (triggers, steps, fork paths, otherwise
// branches) is replaced by a short alias (`t1`, `s1`, `p1`, `o1`) and `{{steps.<id>…}}` references
// follow; the answer's aliases are mapped back to the real ids. An id the model makes up maps to
// nothing, so the guards give it a new id made by the server, once (`assignIds`).

import type { AgentBundle, Step } from "@countersign/core";
import { rewriteRefs } from "./guards";

export type NodeKind = "trigger" | "step" | "path" | "otherwise";

export interface IdAliases {
  /** alias → real id */
  toReal: Map<string, string>;
  /** real id → alias */
  toAlias: Map<string, string>;
}

const PREFIX: Record<NodeKind, string> = { trigger: "t", step: "s", path: "p", otherwise: "o" };

/** Every node id of the bundle mapped by `fn`, and `{{steps.<id>}}` references with them. */
export function mapNodeIds(
  bundle: AgentBundle,
  fn: (id: string, kind: NodeKind) => string,
): AgentBundle {
  const map = new Map<string, string>();
  const to = (id: string, kind: NodeKind) => {
    const next = fn(id, kind);
    if (!map.has(id)) map.set(id, next);
    return next;
  };
  const mapSteps = (steps: Step[]): Step[] =>
    steps.map((s): Step => {
      const id = to(s.id, "step");
      if (s.kind === "fork") {
        return {
          ...s,
          id,
          paths: s.paths.map((p) => ({ ...p, id: to(p.id, "path"), steps: mapSteps(p.steps) })),
          otherwise: {
            ...s.otherwise,
            id: to(s.otherwise.id, "otherwise"),
            steps: mapSteps(s.otherwise.steps),
          },
        };
      }
      if (s.kind === "for_each") return { ...s, id, steps: mapSteps(s.steps) };
      return { ...s, id };
    });
  const workflows = bundle.workflows.map((bw) => {
    const trigger = { ...bw.workflow.trigger, id: to(bw.workflow.trigger.id, "trigger") };
    const more = bw.workflow.moreTriggers?.map((t) => ({ ...t, id: to(t.id, "trigger") }));
    const steps = mapSteps(bw.workflow.steps);
    return { ...bw, workflow: { ...bw.workflow, trigger, ...(more ? { moreTriggers: more } : {}), steps } };
  });
  // References are rewritten after every id is known (a reference may point forward in a bad draft).
  return {
    ...bundle,
    workflows: workflows.map((bw) => ({
      ...bw,
      workflow: rewriteRefs(bw.workflow, map) as typeof bw.workflow,
    })),
  };
}

/** The draft as the model sees it: aliases in place of ids, and the map back. */
export function aliasBundle(bundle: AgentBundle): { bundle: AgentBundle; aliases: IdAliases } {
  const toReal = new Map<string, string>();
  const toAlias = new Map<string, string>();
  const counts: Record<NodeKind, number> = { trigger: 0, step: 0, path: 0, otherwise: 0 };
  const aliased = mapNodeIds(bundle, (id, kind) => {
    const known = toAlias.get(id);
    if (known) return known;
    counts[kind] += 1;
    const alias = `${PREFIX[kind]}${counts[kind]}`;
    toAlias.set(id, alias);
    toReal.set(alias, id);
    return alias;
  });
  return { bundle: aliased, aliases: { toReal, toAlias } };
}

/** The model's answer with its aliases mapped back to the real ids; other ids stay as written. */
export function unaliasBundle(bundle: AgentBundle, aliases: IdAliases): AgentBundle {
  return mapNodeIds(bundle, (id) => aliases.toReal.get(id) ?? id);
}

/** Replaces real ids in plain text (labels, notes) with their aliases, for the model. */
export function aliasText(text: string, aliases: IdAliases): string {
  let out = text;
  for (const [real, alias] of aliases.toAlias) out = out.split(real).join(alias);
  return out;
}
