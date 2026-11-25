// The engine boundary (docs/step-model-plan.md §4, "How a Do step runs"): which engine runs a Do
// step, from its done by and its uses. Every engine exists today in the executor; this is the one
// place that picks among them, so the executor, the timeline, the SOP and the builder read a Do
// step the same way. Pure.

import type { ActionKind } from "./catalog";
import type { DoStep, MatchSettings } from "./schema";

/**
 * The engines a Do step can run on, each today's step kind of the same work:
 * - `read`: calls a Get action (today's `read`);
 * - `write`: an external action or a save, once, through the gate: a Save, a Change or a Send
 *   (today's `write`; a Send names its person, so the gate adds their autonomy);
 * - `rules`: rule rows, or a rules skill, in code (today's `skill`, deterministic);
 * - `ai`: one model call against the output fields, written in the step or an AI skill (today's
 *   `skill`, task);
 * - `match`: a Match on a profile (§7);
 * - `person`, `collect`, `contact`: today's `person`, `collect` and `conversation`;
 * - `automation`: its steps run in place (today's `process`);
 * - `missing`: never runs.
 */
export type DoEngine =
  | { engine: "read"; action: string }
  | { engine: "write"; action: string; kind: Exclude<ActionKind, "get"> }
  | { engine: "rules"; skill?: string | undefined }
  | { engine: "ai"; skill?: string | undefined }
  | { engine: "match"; match: MatchSettings }
  | { engine: "person" }
  | { engine: "collect" }
  | { engine: "contact" }
  | { engine: "automation"; automation: string }
  | { engine: "missing"; need: string };

export type DoEngineName = DoEngine["engine"];

/** Today's step kind whose outcomes (what a Fork routes on) an engine records. */
export const ENGINE_OUTCOMES: Record<DoEngineName, string> = {
  read: "read",
  write: "write",
  rules: "skill",
  ai: "skill",
  match: "skill",
  person: "person",
  collect: "collect",
  contact: "conversation",
  automation: "process",
  missing: "missing",
};

export class DoEngineError extends Error {
  override name = "DoEngineError";
}

/**
 * The engine a Do step runs on. `kindOf` says an action's kind (from the catalog); an action it
 * doesn't know is taken as a Change, the safe side (approval stays on, invariant 8). A combination
 * the validator refuses throws: a published workflow never has one.
 */
export function doEngine(
  step: Pick<DoStep, "id" | "doneBy" | "uses">,
  kindOf: (action: string) => ActionKind | undefined,
): DoEngine {
  const uses = step.uses;
  if (uses?.type === "missing") return { engine: "missing", need: uses.need };
  if (uses?.type === "automation") return { engine: "automation", automation: uses.automation };
  switch (step.doneBy) {
    case "rules":
      if (uses?.type === "action") {
        const kind = kindOf(uses.action) ?? "change";
        return kind === "get"
          ? { engine: "read", action: uses.action }
          : { engine: "write", action: uses.action, kind };
      }
      if (uses?.type === "match") return { engine: "match", match: uses.match };
      if (uses?.type === "skill") return { engine: "rules", skill: uses.skill };
      if (uses === undefined) return { engine: "rules" };
      break;
    case "ai":
      if (uses?.type === "skill") return { engine: "ai", skill: uses.skill };
      if (uses === undefined) return { engine: "ai" };
      break;
    case "person":
      if (uses?.type === "collect") return { engine: "collect" };
      if (uses === undefined) return { engine: "person" };
      break;
    case "contact":
      if (uses === undefined) return { engine: "contact" };
      break;
    case undefined:
      break;
  }
  throw new DoEngineError(
    `step ${step.id}: no engine for done by ${step.doneBy ?? "nobody"} using ${uses?.type ?? "nothing"}`,
  );
}
