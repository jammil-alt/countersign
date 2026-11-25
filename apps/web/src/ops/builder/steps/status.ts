// What the bar and the chart say about a step-model workflow: counts, and the issues on each step as
// the chart and side panel read them (`../../flow/types`).
import type { StatusMap, StepStatus } from "../../flow/types";
import type { BuilderIssue } from "./issues";
import { walk } from "./model";
import { actionKindOf, type UsesContext } from "./options";
import type { Workflow } from "./types";

export interface StepCounts {
  steps: number;
  /** Forks: "decisions" in the bar. */
  ifs: number;
  /** Steps that change a client's tool. */
  writes: number;
  /** Of those, the ones that will wait for a person: every one, until a client allows otherwise. */
  needApproval: number;
}

export function stepCounts(workflow: Pick<Workflow, "steps">, ctx: UsesContext): StepCounts {
  const out: StepCounts = { steps: 0, ifs: 0, writes: 0, needApproval: 0 };
  for (const { step } of walk(workflow)) {
    if (step.kind === "end") continue;
    out.steps += 1;
    if (step.kind === "fork") out.ifs += 1;
    if (step.kind === "do") {
      const kind = actionKindOf(step, ctx);
      if (kind === "change" || kind === "save" || kind === "send") out.writes += 1;
      if (kind === "change" || kind === "send") {
        if (step.checks?.approval?.required !== "not_required") out.needApproval += 1;
      }
    }
  }
  return out;
}

/** Each step's issues as the chart and the side panel show them (red, in plain words). */
export function statusesFor(issues: readonly BuilderIssue[]): StatusMap {
  const out = new Map<string, StepStatus>();
  for (const [i, issue] of issues.entries()) {
    if (!issue.at) continue;
    const item = {
      key: `problem:${issue.code}:${issue.at}:${i}`,
      stepId: issue.at,
      level: "issue" as const,
      title: issue.message,
      source: "problem" as const,
    };
    const known = out.get(issue.at);
    out.set(issue.at, {
      stepId: issue.at,
      level: "issue",
      items: [...(known?.items ?? []), item],
      decided: [],
    });
  }
  return out;
}
