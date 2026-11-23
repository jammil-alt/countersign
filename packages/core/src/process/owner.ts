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
import { type AgentDefinition, type AnyAgentBundle, holdsProcess } from "../schemas/agent";
import type { AgentMode } from "../schemas/permissions";
import { collectRefs } from "../template/template";
import { lookupSkill, type TypingContext } from "../template/typer";
import { fromWorkflowV3 } from "./convert";
import type { Process, Step } from "./schema";
import { type ProcessWarning, stepWrites, validateProcess } from "./validate";
import { walkSteps } from "./walk";

// ── The owner's settings ─────────────────────────────────────────────────────────────────────

/** Where the owner's review comes from. */
export type OwnerReviewSource =
  /** The definition's `oversight`, as saved. */
  | "set"
  /** None saved, and the agent holds a v4 process: a new-model agent, so failures are reviewed. */
  | "new_default"
  /** None saved on a v3-only agent: off, exactly as it ran before (v0.13). */
  | "stored_off";

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
  /**
   * What the executor is handed as `oversight.settings`: the saved settings, the new-agent
   * default, or absent for a stored agent with none (off, as today).
   */
  settings: OversightSettings | undefined;
  /** The cheap watch on every step's result (v4 processes only; `anomalySignals`). */
  watch: boolean;
}

type OwnerDefinition = Pick<
  AgentDefinition,
  "identity" | "instructions" | "model" | "permissions" | "oversight"
>;

/**
 * The owner of an agent, with defaults. `process` says whether the agent holds a v4 process
 * (`ownerOfBundle` reads it from the bundle).
 */
// DECISION: "new agent" is read from the stored bundle itself, never from a new column or a
// rewritten row: a bundle that holds a v4 process was saved under the process model (R1 onwards),
// so an absent `oversight` there means the new default (`failures`). A v3-only bundle without
// `oversight` keeps v0.13's meaning, off, so every stored agent runs exactly as before. New v3
// drafts already start with `NEW_AGENT_OVERSIGHT` where they are made (Builder, definition form).
export function ownerOf(definition: OwnerDefinition, options: { process: boolean }): Owner {
  const saved = definition.oversight;
  const settings = saved
    ? saved
    : options.process
      ? OversightSettings.parse(NEW_AGENT_OVERSIGHT)
      : undefined;
  const source: OwnerReviewSource = saved ? "set" : options.process ? "new_default" : "stored_off";
  const review: OversightReview = settings?.review ?? "off";
  const fallback = OversightSettings.parse({ review: "off" });
  return {
    identity: definition.identity,
    instructions: definition.instructions,
    model: {
      id: settings?.model?.id ?? definition.model.id,
      maxTokens: settings?.model?.maxTokens ?? definition.model.maxTokens,
    },
    mode: definition.permissions.mode,
    review,
    source,
    maxPerStep: OVERSIGHT_MAX_PER_STEP,
    maxPerRun: settings?.maxPerRun ?? fallback.maxPerRun,
    maxCostUsd: settings?.maxCostUsd ?? fallback.maxCostUsd,
    settings,
    // DECISION: the cheap watch runs for v4 processes only; v3 workflows keep v0.13's triggers for
    // a review (failures, checkpoints, `all`), so a stored agent never gets a review it didn't.
    watch: options.process && review !== "off",
  };
}

/** The owner of the agent a bundle stores. */
export function ownerOfBundle(bundle: Pick<AnyAgentBundle, "definition" | "workflows">): Owner {
  return ownerOf(bundle.definition, { process: holdsProcess(bundle) });
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
  if (step.kind === "conversation") return true;
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

// ── One agent, one process ───────────────────────────────────────────────────────────────────

export interface OneProcessError {
  stepId: null;
  /** `workflows`, or `workflows.<i>` for the second and later enabled entries. */
  field: string;
  code: "one_process";
  message: string;
}

/** A split advisory, with the workflow it is about (advice only, never an error). */
export interface SplitAdvisory extends ProcessWarning {
  workflow: string;
}

/** A v3 workflow read only for its shape: every skill stays a skill (counts and nesting hold). */
const SHAPE_ONLY = { wrappedTool: () => null, sideEffect: () => null };

/**
 * The one-process rule (ARCHITECTURE §10.14): an agent owns exactly one process, so a version
 * with more than one enabled workflow is an error, one per extra workflow. Disabled entries don't
 * count. With it, each enabled workflow's split advisories (`validateProcess` warnings: more than
 * 20 steps, logic nested more than 3 deep); v3 workflows are read as v4 for this.
 *
 * Stored versions keep parsing and running as stored (invariant 3): the caller applies this to a
 * NEW version only (publish, and the builder's save of a v4 bundle), never on load.
 */
// DECISION: the rule is reported for the bundle it is given; whether a version is new is the
// caller's (validateBundle should call this from publish for a version that holds a v4 process,
// docs/plan.md §9 R6). Disabled workflows are kept in the bundle as they are, uncounted.
export function oneProcessProblems(bundle: Pick<AnyAgentBundle, "workflows">): {
  errors: OneProcessError[];
  advisories: SplitAdvisory[];
} {
  const errors: OneProcessError[] = [];
  const advisories: SplitAdvisory[] = [];
  const enabled = bundle.workflows.map((w, i) => ({ w, i })).filter(({ w }) => w.enabled !== false);
  if (enabled.length > 1) {
    const first = enabled[0]?.w.slug ?? "";
    for (const { w, i } of enabled.slice(1)) {
      errors.push({
        stepId: null,
        field: `workflows.${i}`,
        code: "one_process",
        message: `an agent owns one workflow: "${w.slug}" runs beside "${first}", so make it its own agent (a handoff trigger can join them), or turn it off`,
      });
    }
  }
  for (const { w } of enabled) {
    const process =
      w.workflow.schemaVersion === 4 ? w.workflow : fromWorkflowV3(w.workflow, SHAPE_ONLY);
    for (const warning of validateProcess(process).warnings) {
      advisories.push({ ...warning, workflow: w.slug });
    }
  }
  return { errors, advisories };
}
