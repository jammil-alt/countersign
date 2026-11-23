// How it ends (owner, 2026-11-23: "a forced defined output, similar to the trigger… what does it
// report out and where… we don't define that so we lead it to a dead end potentially. This can be
// a write or a trigger of a different agent"). A process says how it starts (its triggers); this
// says how it ends: the steps a run can finish on, and whether each one reports out, by changing
// a tool or saving a record, by handing off to another agent, or by reaching a person.
//
// DECISION: worked out from the steps, not stored. The ways out are step kinds the process
// already has (write, handoff, notify, person, conversation), so a second field saying where the
// result goes could disagree with the steps that send it. A process that passes its output on
// (`handoff`, read by other agents' handoff triggers) reports out whatever its last step is.
// DECISION: a Stop is an end the operator chose ("ends here"), so it is never a dead end; what is
// flagged is a run that falls off the end of the list on a step that only reads or thinks.

import { skillTools } from "../schemas/skill";
import { lookupSkill, type TypingContext } from "../template/typer";
import { type Process, SELF_AGENT, type Step } from "./schema";

/** Where a run's result goes: a tool or a record, another agent, or a person. */
export const ENDING_KINDS = ["tool", "agent", "people"] as const;
export type EndingKind = (typeof ENDING_KINDS)[number];

/** What a step reports out: a way out, `none` (it only reads or thinks), or `unknown`. */
export type ReportsOut = EndingKind | "none" | "unknown";

/**
 * The steps a run can finish on when it reaches the end of the list: the last step, or, when that
 * is a decision or a loop, the last step of each path that has steps. A path that ends with a Stop
 * finishes there by choice and adds nothing; a Stop that only closes the whole list is looked past.
 */
// DECISION: an empty path adds no end. "If some need asking, ask; otherwise nothing" is how a
// process says there is nothing to do (the Bookkeeper's Monday questions end that way), and
// calling it a dead end would be advice nobody can act on.
export function runEnds(process: Pick<Process, "steps">): Step[] {
  // A Stop closing the whole list says nothing a list's end doesn't: the run ends on what is before.
  const last = process.steps.at(-1);
  const steps =
    last?.kind === "stop" && last.status === "succeeded"
      ? process.steps.slice(0, -1)
      : process.steps;
  const seen = new Set<string>();
  return endsOf(steps, []).filter((s) => !seen.has(s.id) && seen.add(s.id));
}

function endsOf(steps: readonly Step[], before: readonly Step[]): Step[] {
  const last = steps.at(-1);
  if (!last) return [...before];
  const prior = () => endsOf(steps.slice(0, -1), before);
  switch (last.kind) {
    case "stop":
      return [];
    case "if": {
      // An empty path is "nothing to do in this case", not an end of its own. When every path is
      // empty the decision does nothing, and the run ends on what came before it.
      const paths = [...last.paths, last.otherwise].filter((p) => p.steps.length > 0);
      if (paths.length === 0) return prior();
      return paths.flatMap((p) => endsOf(p.steps, []));
    }
    case "for_each":
    case "repeat":
      return endsOf(last.steps, prior());
    default:
      return [last];
  }
}

/**
 * What a step reports out. A skill is known only with the registries: one whose tools change
 * something or that reaches people reports out; one that only reads doesn't. An automation and a
 * missing step are unknown here (their own definitions say).
 */
export function reportsOut(step: Step, ctx: TypingContext = {}): ReportsOut {
  switch (step.kind) {
    case "write":
      return "tool";
    case "handoff":
      return "agent";
    case "notify":
    case "person":
    case "conversation":
      return "people";
    case "read":
    case "wait":
      return "none";
    case "skill": {
      const skill = lookupSkill(step.skill, ctx);
      if (!skill || !ctx.tools) return "unknown";
      if (skill.reachesPeople === true) return "people";
      const tools = skillTools(skill).map((id) => ctx.tools?.[id]);
      if (tools.some((t) => t === undefined)) return "unknown";
      return tools.some((t) => t?.sideEffect !== "none") ? "tool" : "none";
    }
    default:
      return "unknown";
  }
}

/** The steps a run can finish on with nothing reported out. None when the process passes its output on. */
export function deadEnds(
  process: Pick<Process, "steps" | "handoff">,
  ctx: TypingContext = {},
): Step[] {
  if (process.handoff) return [];
  return runEnds(process).filter((s) => reportsOut(s, ctx) === "none");
}

/** The advice for a dead end, as the validator and the builder word it. */
export function deadEndMessage(step: Pick<Step, "name">): string {
  return `a run can end on "${step.name}" with nothing reported out: end with a step that changes a tool, saves a record, tells someone or hands off to another agent`;
}

// ── Ways out ─────────────────────────────────────────────────────────────────────────────────────
// Owner, 2026-11-23: "triggers and report-out forks: multiple ways in if needed, multiple ways out
// if needed. A fork out inside the workflow can be a handoff; one that leaves and comes back is an
// automation or a loop." A way out is where a run's work leaves this process: every hand-off,
// wherever it is, and every step a run can finish on.

/** Where a way out goes: a way out of `ReportsOut`, or `workflow` for another workflow of this agent. */
export type WayOutKind = ReportsOut | "workflow";

export interface WayOut {
  step: Step;
  kind: WayOutKind;
  /**
   * `fork`: the run goes on after it (a hand-off before the end; the run it starts is its own).
   * `end`: a run can finish on it.
   */
  how: "fork" | "end";
  /** Inside a for-each or a repeat: it happens once a time round. */
  repeats: boolean;
  /** A hand-off's target: the agent (`"@self"` for this one), its workflow when said, the step. */
  to?: { agent: string; workflow?: string; step: string };
}

// DECISION (owner, 2026-11-23): only a hand-off forks out mid-process. A write or a note in the
// middle changes something on the way, but the run's work doesn't leave by it; an automation
// (`process`) leaves and comes back, so it is part of the run, not a way out.
/**
 * Every way out of a process, in the order the steps are listed: each hand-off (mid-process, in
 * a path or a loop: a fork out, unless a run can finish on it) and each run end from `runEnds`.
 */
export function waysOut(process: Pick<Process, "steps">, ctx: TypingContext = {}): WayOut[] {
  const ends = new Set(runEnds(process).map((s) => s.id));
  const out: WayOut[] = [];
  const seen = new Set<string>();
  const visit = (steps: readonly Step[], repeats: boolean) => {
    for (const s of steps) {
      const end = ends.has(s.id);
      if ((end || s.kind === "handoff") && !seen.has(s.id)) {
        seen.add(s.id);
        const to = s.kind === "handoff" ? handoffTarget(s) : undefined;
        out.push({
          step: s,
          kind: to?.agent === SELF_AGENT ? "workflow" : reportsOut(s, ctx),
          how: end ? "end" : "fork",
          repeats,
          ...(to ? { to } : {}),
        });
      }
      if (s.kind === "if") {
        for (const p of s.paths) visit(p.steps, repeats);
        visit(s.otherwise.steps, repeats);
      } else if (s.kind === "for_each" || s.kind === "repeat") {
        visit(s.steps, true);
      }
    }
  };
  visit(process.steps, false);
  return out;
}

function handoffTarget(s: Extract<Step, { kind: "handoff" }>): NonNullable<WayOut["to"]> {
  const { agent, step, workflow } = s.to;
  return { agent, step, ...(workflow ? { workflow } : {}) };
}
