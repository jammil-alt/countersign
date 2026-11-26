// R6 (docs/plan.md §1.86, §9; ARCHITECTURE §10.14 "Agents and their owner"): an agent is one
// process plus its owner, the AI that watches every step and fixes within limits. The owner is not
// a new engine: it is the agent definition's identity, model and instructions plus v0.13's
// oversight (§10.11), read here under its proper name. Its decisions are oversight's decisions,
// its review is oversight's review (packages/agents `overseeStep`), and nothing stored changes
// (invariant 3): a stored agent keeps the oversight it was saved with.

import {
  NEW_AGENT_OVERSIGHT,
  OVERSIGHT_ACTIONS,
  OVERSIGHT_MAX_PER_STEP,
  type OversightActionName,
  type OversightReview,
  OversightSettings,
  ownerWatches,
} from "../oversight/decision";
import type { AgentBundle, AgentDefinition } from "../schemas/agent";
import type { AgentMode } from "../schemas/permissions";
import { collectRefs } from "../template/template";
import { lookupSkill, type TypingContext } from "../template/typer";
import type { Process, Step } from "./schema";
import { stepWrites } from "./validate";
import { walkSteps } from "./walk";

// ── The owner's settings ─────────────────────────────────────────────────────────────────────

/** Where the owner's review comes from. */
export type OwnerReviewSource =
  /** The definition's `oversight`, as saved. */
  | "set"
  /** None saved: failures are reviewed. */
  | "new_default";

/** The owner of one agent: who it is, what it reasons on and how closely it watches. */
export interface Owner {
  identity: AgentDefinition["identity"];
  instructions: string;
  /** What the owner reasons on: the oversight model, else the agent's own. */
  model: { id: string; maxTokens: number };
  /** The agent's mode: the owner never changes it (invariant 9). */
  mode: AgentMode;
  review: OversightReview;
  source: OwnerReviewSource;
  /** Interventions per step (fixed) and per run, and the reviews' cost per run. */
  maxPerStep: number;
  maxPerRun: number;
  maxCostUsd: string;
  /** What the executor is handed as `oversight.settings`: the saved settings or the new-agent default. */
  settings: OversightSettings;
  /** The cheap watch on every step's result (`anomalySignals`). */
  watch: boolean;
}

type OwnerDefinition = Pick<
  AgentDefinition,
  "identity" | "instructions" | "model" | "permissions" | "oversight"
>;

/** The owner of an agent, with defaults. */
// DECISION: an absent `oversight` means the new default (`failures`), read from the stored bundle
// itself, never from a new column or a rewritten row.
export function ownerOf(definition: OwnerDefinition): Owner {
  const saved = definition.oversight;
  const settings = saved ?? OversightSettings.parse(NEW_AGENT_OVERSIGHT);
  const source: OwnerReviewSource = saved ? "set" : "new_default";
  const review: OversightReview = settings.review;
  const fallback = OversightSettings.parse({ review: "off" });
  return {
    identity: definition.identity,
    instructions: definition.instructions,
    model: {
      id: settings.model?.id ?? definition.model.id,
      maxTokens: settings.model?.maxTokens ?? definition.model.maxTokens,
    },
    mode: definition.permissions.mode,
    review,
    source,
    maxPerStep: OVERSIGHT_MAX_PER_STEP,
    maxPerRun: settings.maxPerRun ?? fallback.maxPerRun,
    maxCostUsd: settings.maxCostUsd ?? fallback.maxCostUsd,
    settings,
    watch: review !== "off",
  };
}

/** The owner of the agent a bundle stores. */
export function ownerOfBundle(bundle: Pick<AgentBundle, "definition">): Owner {
  return ownerOf(bundle.definition);
}

// ── What the owner may and may never do ──────────────────────────────────────────────────────

/** Each thing the owner may do, as the oversight decision that does it (§10.14's table). */
export const OWNER_MAY = {
  /** Review a step and let a good one go on. */
  watch: "continue",
  /** The same input, later. */
  retry: "retry",
  /** A corrected input; the gate decides a write again, under its own idempotency keys. */
  correct: "retry_with",
  /** Ask the lead (or the step's approver). */
  ask_lead: "ask",
  stop: "stop",
} as const satisfies Record<string, OversightActionName>;
export type OwnerMay = keyof typeof OWNER_MAY;

/**
 * What the owner may never do (invariant 9): there is no decision for any of these, and the
 * decision schema is strict, so an answer carrying one is refused. A fix that should last is a
 * `proposal` the operator applies in the builder.
 */
export const OWNER_NEVER = ["change_plan", "change_approvals", "change_permissions"] as const;
export type OwnerNever = (typeof OWNER_NEVER)[number];

/** Whether a decision is one the owner may make (every oversight decision, nothing else). */
export function ownerMay(action: string): action is OversightActionName {
  return (OVERSIGHT_ACTIONS as readonly string[]).includes(action);
}

// ── Checkpoints of a v4 process ──────────────────────────────────────────────────────────────

/** What checkpoint computation reads: skills and tools, and the processes sub-process steps pin. */
export interface ProcessCheckpointContext extends Pick<TypingContext, "skills" | "tools"> {
  /** Process versions by pinned reference (`slug@version`): their steps are enough. */
  processes?: Readonly<Record<string, Pick<Process, "steps">>>;
}

/** The templates a step hands to what it writes or sends. */
function inputsOf(step: Step): unknown {
  if (step.kind === "conversation") return { with: step.with, goal: step.goal };
  if ("input" in step) return step.input;
  return undefined;
}

function writesForCheckpoints(step: Step, ctx: ProcessCheckpointContext, depth = 0): boolean {
  // Collect reports: its links reach people outside, as a conversation does.
  if (step.kind === "conversation" || step.kind === "collect") return true;
  if (step.kind === "process") {
    const def = Object.hasOwn(ctx.processes ?? {}, step.process)
      ? ctx.processes?.[step.process]
      : undefined;
    if (!def || depth > 5) return false;
    let found = false;
    walkSteps(def, ({ step: inner }) => {
      found ||= writesForCheckpoints(inner, ctx, depth + 1);
    });
    return found;
  }
  const typing: TypingContext = {
    ...(ctx.skills ? { skills: ctx.skills } : {}),
    ...(ctx.tools ? { tools: ctx.tools } : {}),
  };
  if (step.kind === "skill" && lookupSkill(step.skill, typing)?.reachesPeople === true) return true;
  // DECISION: as v3's checkpoints (workflowCheckpoints): a step whose tool the context doesn't
  // know counts as not writing, so it makes no checkpoint (never less safe than without the owner).
  return (stepWrites(step, typing)?.length ?? 0) > 0;
}

/**
 * The checkpoints of a v4 process (the counterpart of v3's `workflowCheckpoints`): every watched
 * step (read, skill, write, conversation) whose output feeds a step that writes or reaches people,
 * and every watched step with `review: 'always'`. A sub-process's inner checkpoints are listed as
 * `${processStepId}/${innerId}`. Computed from the definition, never guessed by a model.
 */
export function processCheckpoints(
  process: Pick<Process, "steps">,
  ctx: ProcessCheckpointContext = {},
): string[] {
  const own = (p: Pick<Process, "steps">): Set<string> => {
    const fed = new Set<string>();
    walkSteps(p, ({ step }) => {
      if (!writesForCheckpoints(step, ctx)) return;
      for (const r of collectRefs(inputsOf(step)).refs) {
        const [root, id] = r.path;
        if (root === "steps" && id !== undefined) fed.add(id);
      }
    });
    const out = new Set<string>();
    walkSteps(p, ({ step }) => {
      if (!ownerWatches(step)) return;
      if (step.review === "always" || fed.has(step.id)) out.add(step.id);
    });
    return out;
  };
  const out = [...own(process)];
  walkSteps(process, ({ step }) => {
    if (step.kind !== "process") return;
    const def = Object.hasOwn(ctx.processes ?? {}, step.process)
      ? ctx.processes?.[step.process]
      : undefined;
    if (!def) return;
    for (const id of own(def)) out.push(`${step.id}/${id}`);
  });
  return out;
}
