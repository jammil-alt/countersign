// v0.13 W2-I: run oversight (ARCHITECTURE §10.11; docs/plan.md §1.54).
//
// The client agent that owns a workflow looks at a step that went wrong and decides what happens
// next, inside the plan: try again, try again with a corrected input, ask a person, or stop. Its
// answer is one of the decisions below, given through `finish`. Nothing here can add, skip or edit a
// step, or change an approval, a matrix, a grant, a mode or a stage: the schema has no field for
// any of them (CLAUDE.md invariants 3, 4, 8).

import { z } from "zod";
import { Duration, parseDuration } from "../duration";
import { DecimalString } from "../money";
import type {
  ConversationStep,
  SkillStep as ProcessSkillStep,
  ReadStep,
  WriteStep,
} from "../process/schema";
import { type Approval, DEFAULT_APPROVAL } from "../schemas/approval";
import { ModelChoice } from "../schemas/skill";
import type { ActionStep, SkillStep } from "../schemas/workflow";
import type { AnomalySignal } from "./watch";

// R6: the owner's cheap watch (its anomaly signals), exported with the decisions.
export * from "./watch";

// ── Settings ────────────────────────────────────────────────────────────────────────────────────

/** What the agent reviews: nothing, failed steps, also checkpoints, or every skill and action step. */
export const OVERSIGHT_REVIEWS = ["off", "failures", "checkpoints", "all"] as const;
export const OversightReview = z.enum(OVERSIGHT_REVIEWS);
export type OversightReview = z.infer<typeof OversightReview>;

/** A step's own setting: follow the agent (`auto`, the default), never, or always. */
export const STEP_REVIEWS = ["auto", "off", "always"] as const;
export const StepReview = z.enum(STEP_REVIEWS);
export type StepReview = z.infer<typeof StepReview>;

/** Interventions per step: past two, the step fails as it would without oversight. */
export const OVERSIGHT_MAX_PER_STEP = 2;
export const OVERSIGHT_DEFAULT_MAX_PER_RUN = 3;
export const OVERSIGHT_DEFAULT_MAX_COST_USD = "0.25";
/** A `retry` without `after` waits this long; `after` is at most an hour. */
export const OVERSIGHT_RETRY_AFTER: Duration = "30 seconds";
export const OVERSIGHT_RETRY_AFTER_MAX_MS = 3_600_000;

/** `definition.oversight` (ARCHITECTURE §9.1, §10.11). Absent on a definition means `off`. */
export const OversightSettings = z
  .strictObject({
    review: OversightReview,
    /** What oversight reasons on; default the agent's own model. */
    model: ModelChoice.optional(),
    maxPerRun: z.number().int().min(0).max(10).default(OVERSIGHT_DEFAULT_MAX_PER_RUN),
    /** On top of the agent's budget: the decisions' cost in one run. */
    maxCostUsd: DecimalString.default(OVERSIGHT_DEFAULT_MAX_COST_USD),
  })
  .meta({ id: "OversightSettings" });
export type OversightSettings = z.infer<typeof OversightSettings>;
export type OversightSettingsInput = z.input<typeof OversightSettings>;

/**
 * What a new agent, a Builder draft or a new template starts with (ARCHITECTURE §10.11).
 */
// DECISION: agents made before v0.13 have no `oversight` and keep running as they did; only new
// drafts start with failures reviewed (docs/plan.md §1.54).
export const NEW_AGENT_OVERSIGHT: OversightSettingsInput = { review: "failures" };

/** Whether a failure of this step is reviewed: the step's own setting, else the agent's. */
export function reviewsFailures(
  settings: Pick<OversightSettings, "review"> | undefined,
  step: { review?: StepReview | undefined },
): boolean {
  if (step.review === "off") return false;
  if (step.review === "always") return true;
  return settings !== undefined && settings.review !== "off";
}

/**
 * v0.13 M32: whether the step is reviewed after it succeeds: `always` on the step, `all` on the
 * agent, or `checkpoints` when the step is one (computed, `workflowCheckpoints`). `off` on the step
 * wins, and `failures` never reviews a step that succeeded.
 */
export function reviewsAfterSuccess(
  settings: Pick<OversightSettings, "review"> | undefined,
  step: { review?: StepReview | undefined },
  checkpoint: boolean,
): boolean {
  return successReviewDue(settings, step, checkpoint) !== null;
}

/**
 * Wave 6: why a step that succeeded is reviewed whatever its result (`reviewsAfterSuccess`'s
 * rule, by its reason): `always` on the step, `all` on the agent, or a `checkpoint` under
 * `checkpoints`. Null when it isn't (a signal may still send it, `ownerReviewsSuccess`).
 */
export const OWNER_REVIEW_DUES = ["checkpoint", "all", "always"] as const;
export type OwnerReviewDue = (typeof OWNER_REVIEW_DUES)[number];

export function successReviewDue(
  settings: Pick<OversightSettings, "review"> | undefined,
  step: { review?: StepReview | undefined },
  checkpoint: boolean,
): OwnerReviewDue | null {
  if (step.review === "off") return null;
  if (step.review === "always") return "always";
  if (settings?.review === "all") return "all";
  return settings?.review === "checkpoints" && checkpoint ? "checkpoint" : null;
}

// ── Decisions ───────────────────────────────────────────────────────────────────────────────────

export const OVERSIGHT_CAUSES = ["failed", "checkpoint"] as const;
export type OversightCause = (typeof OVERSIGHT_CAUSES)[number];
export const OVERSIGHT_ACTIONS = ["continue", "retry", "retry_with", "ask", "stop"] as const;
export type OversightActionName = (typeof OVERSIGHT_ACTIONS)[number];

/** Which decisions each cause allows (ARCHITECTURE §10.11's table). */
export const OVERSIGHT_ALLOWED: Record<OversightCause, readonly OversightActionName[]> = {
  failed: ["retry", "retry_with", "ask", "stop"],
  checkpoint: ["continue", "retry_with", "ask", "stop"],
};

export const OVERSIGHT_NOTE_MAX = 2000;

/** A lasting fix in plain words, for the operator to apply in the builder (never applied here). */
// DECISION: `change` is plain words (what to change and where), not a bundle patch: nothing applies
// a proposal on its own, the operator does it in the builder (docs/plan.md §1.54).
export const OversightProposal = z.strictObject({
  summary: z.string().trim().min(1).max(300),
  change: z.string().trim().min(1).max(2000),
});
export type OversightProposal = z.infer<typeof OversightProposal>;

const common = {
  /** The agent's diagnosis: operator only, never shown to the client. */
  note: z.string().trim().min(1).max(OVERSIGHT_NOTE_MAX),
  /** Record ids the decision relied on (invariant 10). */
  sources: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
  proposal: OversightProposal.optional(),
};

export const OversightDecision = z
  .discriminatedUnion("action", [
    z.strictObject({ action: z.literal("continue"), ...common }),
    z.strictObject({ action: z.literal("retry"), after: Duration.optional(), ...common }),
    z.strictObject({
      action: z.literal("retry_with"),
      /** The whole corrected input: checked against the step's own input schema before it runs. */
      input: z.record(z.string(), z.unknown()),
      ...common,
    }),
    z.strictObject({
      action: z.literal("ask"),
      question: z.string().trim().min(1).max(500),
      ...common,
    }),
    z.strictObject({ action: z.literal("stop"), ...common }),
  ])
  .meta({ id: "OversightDecision" });
export type OversightDecision = z.infer<typeof OversightDecision>;

export type ParsedDecision =
  | { ok: true; decision: OversightDecision }
  | { ok: false; reason: string };

/**
 * The agent's answer, checked: the schema, the decisions its cause allows and `after`'s bounds.
 * A refusal means no intervention: the step fails (or goes on) as it would without oversight.
 */
export function parseOversightDecision(
  raw: unknown,
  cause: OversightCause,
  // v0.13 M32: narrower, for a step that can't run again (its write reached the client's tool).
  allowed: readonly OversightActionName[] = OVERSIGHT_ALLOWED[cause],
): ParsedDecision {
  const r = OversightDecision.safeParse(raw);
  if (!r.success) return { ok: false, reason: `invalid decision: ${z.prettifyError(r.error)}` };
  const decision = r.data;
  if (!OVERSIGHT_ALLOWED[cause].includes(decision.action)) {
    return { ok: false, reason: `${decision.action} is not allowed after a ${cause} step` };
  }
  if (!allowed.includes(decision.action)) {
    return { ok: false, reason: `${decision.action} is not allowed for this step` };
  }
  if (decision.action === "retry" && decision.after !== undefined) {
    if (parseDuration(decision.after) > OVERSIGHT_RETRY_AFTER_MAX_MS) {
      return { ok: false, reason: "a retry waits at most an hour" };
    }
  }
  return { ok: true, decision };
}

/**
 * The `finish` tool's input schema: one flat object, so every provider takes it. The answer is
 * then checked with OversightDecision (one validator, invariant 5).
 */
export function oversightFinishSchema(
  cause: OversightCause,
  // v0.13 M32
  allowed: readonly OversightActionName[] = OVERSIGHT_ALLOWED[cause],
): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      action: { type: "string", enum: [...allowed] },
      note: {
        type: "string",
        description: "Your diagnosis for the operator: what went wrong and why you decided this.",
        maxLength: OVERSIGHT_NOTE_MAX,
      },
      sources: {
        type: "array",
        items: { type: "string" },
        description: "Record ids your decision relied on.",
      },
      after: {
        type: "string",
        description: 'retry only: how long to wait first, e.g. "30 seconds" (at most "1 hour").',
      },
      input: {
        type: "object",
        description: "retry_with only: the whole corrected input for the step.",
      },
      question: {
        type: "string",
        description: "ask only: the question for the person, in plain words.",
      },
      proposal: {
        type: "object",
        description:
          "Optional: a lasting fix the operator could make so this doesn't happen again.",
        properties: { summary: { type: "string" }, change: { type: "string" } },
        required: ["summary", "change"],
      },
    },
    required: ["action", "note", "sources"],
  };
}

// ── R6: the owner (ARCHITECTURE §10.14 "Agents and their owner"; docs/plan.md §1.86, §9) ──────
//
// The owner is v0.13's oversight under its proper name: the same settings, the same decisions and
// the same review. R6 adds which v4 steps it watches and the cheap watch's signals (watch.ts).

/**
 * The steps the owner watches: v3's skill and action steps, and v4's read, skill, write and
 * conversation steps (a v4 step's checks run inside it, so they are watched with it). Person,
 * notify and logic steps are a person's or the plan's, never the owner's.
 */
export const OWNER_WATCHED_KINDS = ["skill", "action", "read", "write", "conversation"] as const;
export type OwnerWatchedKind = (typeof OWNER_WATCHED_KINDS)[number];

/** A step the owner watches, v3 or v4. */
export type OwnerWatchedStep =
  | SkillStep
  | ActionStep
  | ReadStep
  | ProcessSkillStep
  | WriteStep
  | ConversationStep;

export function ownerWatches(step: { kind: string }): boolean {
  return (OWNER_WATCHED_KINDS as readonly string[]).includes(step.kind);
}

/** Whether a failure of the step goes to the owner: a watched step whose failures are reviewed. */
export function ownerReviewsFailure(
  settings: Pick<OversightSettings, "review"> | undefined,
  step: { kind: string; review?: StepReview | undefined },
): boolean {
  return ownerWatches(step) && reviewsFailures(settings, step);
}

/**
 * Whether a step that succeeded goes to the owner: v0.13's rule (`reviewsAfterSuccess`), or a
 * signal from the cheap watch while the owner reviews anything at all. `off` on the step wins.
 * With no signals this is exactly `reviewsAfterSuccess` for a watched step.
 */
// DECISION: a signal is reviewed under `failures` too (the cheap watch is there so that an owner
// set to review failures still notices a result that is plainly off); never under `off`.
export function ownerReviewsSuccess(
  settings: Pick<OversightSettings, "review"> | undefined,
  step: { kind: string; review?: StepReview | undefined },
  checkpoint: boolean,
  signals: readonly AnomalySignal[] = [],
): boolean {
  if (!ownerWatches(step)) return false;
  if (reviewsAfterSuccess(settings, step, checkpoint)) return true;
  if (signals.length === 0 || step.review === "off") return false;
  return settings !== undefined && settings.review !== "off";
}

/**
 * A conversation never runs again with a new input: that would start over with the person
 * (docs/plan.md §1.66). Its failed turn may be retried: each message it sent is keyed.
 */
export const OWNER_CONVERSATION_ALLOWED: Record<OversightCause, readonly OversightActionName[]> = {
  failed: ["retry", "ask", "stop"],
  checkpoint: ["continue", "ask", "stop"],
};

/** The decisions the owner may make about this step for this cause. */
export function ownerAllowedActions(
  step: { kind: string },
  cause: OversightCause,
): readonly OversightActionName[] {
  return step.kind === "conversation"
    ? OWNER_CONVERSATION_ALLOWED[cause]
    : OVERSIGHT_ALLOWED[cause];
}

/**
 * The approval an owner's `ask` follows: who is asked, how long they have, what a "no" does. A
 * v3 step's own `approval`; a v4 step's `checks.approval`, by its first approver.
 */
// DECISION: an ask is one question, so it goes to the first approver and waits on that approver's
// deadline (clock time); `in_turn`, `any` and `all` belong to the step's own approval.
export function ownerStepApproval(step: OwnerWatchedStep): Approval {
  if (step.kind === "action") return step.approval;
  if ("approval" in step && step.approval) return step.approval;
  const check = "checks" in step ? step.checks?.approval : undefined;
  const first = check?.approvers?.[0];
  return {
    required: check?.required ?? DEFAULT_APPROVAL.required,
    ...(first?.who ? { approver: first.who } : {}),
    ...(first?.deadline ? { timeout: first.deadline.after } : {}),
    onReject: check?.onReject ?? DEFAULT_APPROVAL.onReject,
  };
}

/** The step's words for people: its client label, else its name (`clientLabel`'s rule, any step). */
export function ownerStepLabel(step: Pick<OwnerWatchedStep, "name" | "client">): string {
  return step.client?.label ?? step.name;
}

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────────

/** Top-level fields whose value differs between two inputs, in the corrected input's order. */
export function changedFields(before: unknown, after: unknown): string[] {
  const a = isRecord(before) ? before : {};
  const b = isRecord(after) ? after : {};
  const keys: string[] = [];
  for (const k of [...Object.keys(b), ...Object.keys(a)]) {
    if (keys.includes(k)) continue;
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) keys.push(k);
  }
  return keys;
}

/**
 * A field's words for people: its schema `title` when it has one, else its name in words
 * (`vendorName` → "vendor name").
 */
export function fieldLabel(schema: unknown, key: string): string {
  const props = isRecord(schema) && isRecord(schema.properties) ? schema.properties : null;
  const prop = props && Object.hasOwn(props, key) ? props[key] : null;
  const title = isRecord(prop) && typeof prop.title === "string" ? prop.title.trim() : "";
  if (title) return title;
  let out = "";
  for (let i = 0; i < key.length; i++) {
    const c = key.charAt(i);
    if (c === "_" || c === "-" || c === ".") {
      if (!out.endsWith(" ")) out += " ";
    } else if (c >= "A" && c <= "Z") {
      if (out && !out.endsWith(" ")) out += " ";
      out += c.toLowerCase();
    } else {
      out += c;
    }
  }
  return out.trim();
}

/**
 * The step a durable name stands for, without loop indexes: `each:3:check` → `each:check`, so every
 * iteration of a loop shares one proposal.
 */
export function stepPathOf(nodeId: string): string {
  return nodeId
    .split(":")
    .filter((part) => part !== "" && !isDigits(part))
    .join(":");
}

/** Lower case, single spaces: two wordings of the same summary give the same fingerprint. */
function normalise(text: string): string {
  let out = "";
  let space = false;
  for (const c of text.toLowerCase()) {
    if (c === " " || c === "\n" || c === "\t" || c === "\r") {
      space = out.length > 0;
      continue;
    }
    if (space) out += " ";
    space = false;
    out += c;
  }
  return out;
}

/**
 * A proposal's fingerprint (docs/plan.md §1.54): the agent, the workflow, the step and the
 * proposal's normalised summary, so an open proposal is not made twice.
 */
export function oversightFingerprint(input: {
  agentId: string;
  workflowSlug: string;
  nodeId: string;
  summary: string;
}): string {
  return [
    "oversight",
    input.agentId,
    input.workflowSlug,
    stepPathOf(input.nodeId),
    normalise(input.summary),
  ].join("|");
}

function isDigits(s: string): boolean {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return true;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
