// Which checks a Do step can carry, and the defaults a check starts with (docs/step-model-plan.md
// §4's table, §5, invariant 8). Pure.

import type { processes } from "@countersign/core";
import type { UsesContext } from "./options";
import type { Step } from "./types";

export type Checks = processes.Checks;
export type ApprovalCheck = processes.ApprovalCheck;

export interface CheckSet {
  confer: boolean;
  approval: boolean;
  review: boolean;
  tellAfter: boolean;
}

const NONE: CheckSet = { confer: false, approval: false, review: false, tellAfter: false };

/** Whether an action's kind makes its step a Change or a Send to a client's tool (an approver). */
export function needsApprover(step: Step, ctx: UsesContext): boolean {
  if (step.kind !== "do" || step.uses?.type !== "action") return false;
  // An action the catalog doesn't know is taken as a Change, the safe side.
  const kind = ctx.actions.get(step.uses.action)?.kind ?? "change";
  return kind === "change" || kind === "send";
}

/** The checks a step can carry: §4's table, by Done by and Uses. */
export function checksFor(step: Step, ctx: UsesContext): CheckSet {
  if (step.kind !== "do") return { confer: true, approval: false, review: true, tellAfter: true };
  const uses = step.uses;
  if (uses?.type === "missing" || uses?.type === "automation") return NONE;
  if (uses?.type === "tell") return { ...NONE, tellAfter: true };
  if (step.doneBy === "person" || step.doneBy === "contact") return { ...NONE, tellAfter: true };
  if (uses?.type === "action") {
    const kind = ctx.actions.get(uses.action)?.kind ?? "change";
    return {
      confer: true,
      approval: kind === "change" || kind === "send",
      review: true,
      tellAfter: true,
    };
  }
  return { confer: true, approval: false, review: true, tellAfter: true };
}

/** An approval as it starts: required, in turn, nobody answering stops it (invariant 8). */
export function defaultApproval(): ApprovalCheck {
  return { required: "required", mode: "in_turn", ifNoAnswer: "stop", onReject: "stop" };
}

export function withChecks(step: Step, edit: (c: Checks) => Checks): Step {
  const next = edit(step.checks ?? {});
  const { checks: _drop, ...rest } = step;
  return (Object.keys(next).length > 0 ? { ...rest, checks: next } : rest) as Step;
}

export function without<K extends keyof Checks>(c: Checks, key: K): Checks {
  const { [key]: _drop, ...rest } = c;
  return rest;
}

export const REVIEW_CHOICES = [
  { value: "auto", label: "The owner decides" },
  { value: "always", label: "Always" },
  { value: "off", label: "Off" },
] as const;
