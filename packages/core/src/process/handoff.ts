// Hand off (owner, 2026-11-11; docs/plan.md §1.95): what a hand-off step needs to know about the
// agent it hands off to. The server builds it from the client's other client agents' live
// versions; the builder gets the same list from the server, so both validate with the same facts.

import type { JsonSchema } from "../schemas/common";
import { collectRefs } from "../template/template";
import type { TypingContext } from "../template/typer";
import { stepInputSchema } from "./reshape";
import type { HandoffStep, Process, Step } from "./schema";

/** A top-level step of the target's live version, as a hand-off can start at it. */
export interface HandoffTargetStep {
  id: string;
  name: string;
  kind: Step["kind"];
  /** The step's input schema (its skill's or tool's); absent when it takes none or is unknown. */
  input?: JsonSchema | undefined;
  /** The step ids it, or a step inside it, reads (`{{steps.<id>…}}`). */
  reads: string[];
  /** Its own id and the ids of the steps inside it (an if's paths, a loop's steps). */
  ids: string[];
}

/** One of the client's other client agents, as a hand-off step sees it. */
export interface HandoffAgent {
  slug: string;
  /** What people call it (its service name, else its name). */
  name: string;
  /** The live version's process that a hand-off starts; null when it has no live version. */
  workflow: string | null;
  /** That process's top-level steps, in order; empty without a live version. */
  steps: HandoffTargetStep[];
}

/** The kinds a hand-off can start at: work steps, which take an input. */
export const HANDOFF_ENTRY_KINDS: ReadonlySet<Step["kind"]> = new Set(["read", "skill", "write"]);

function idsIn(step: Step): string[] {
  const out = [step.id];
  if (step.kind === "if") {
    for (const p of step.paths) for (const s of p.steps) out.push(...idsIn(s));
    for (const s of step.otherwise.steps) out.push(...idsIn(s));
  } else if (step.kind === "for_each") {
    for (const s of step.steps) out.push(...idsIn(s));
  }
  return out;
}

/** A process's top-level steps as hand-off targets: names, kinds, input schemas, what each reads. */
export function handoffTargetSteps(
  process: Pick<Process, "steps">,
  ctx: TypingContext,
): HandoffTargetStep[] {
  return process.steps.map((step) => {
    const reads = new Set<string>();
    for (const ref of collectRefs(step).refs) {
      if (ref.path[0] === "steps" && typeof ref.path[1] === "string") reads.add(ref.path[1]);
    }
    const input = HANDOFF_ENTRY_KINDS.has(step.kind) ? stepInputSchema(step, ctx) : undefined;
    return {
      id: step.id,
      name: step.name,
      kind: step.kind,
      ...(input ? { input } : {}),
      reads: [...reads],
      ids: idsIn(step),
    };
  });
}

/**
 * The later steps of a hand-off's target that read a step it skips: each later step with the
 * skipped steps it reads (the warning's facts). Steps before `at` are skipped; `at` itself and
 * what follows run.
 */
export function skippedReads(
  steps: readonly HandoffTargetStep[],
  at: string,
): { step: HandoffTargetStep; skipped: HandoffTargetStep[] }[] {
  const i = steps.findIndex((s) => s.id === at);
  if (i < 0) return [];
  const before = steps.slice(0, i);
  const out: { step: HandoffTargetStep; skipped: HandoffTargetStep[] }[] = [];
  for (const step of steps.slice(i)) {
    const skipped = before.filter((b) => b.ids.some((id) => step.reads.includes(id)));
    if (skipped.length > 0) out.push({ step, skipped });
  }
  return out;
}

/** "5 · Itemize the invoice": a top-level step's number (from 1) and name. */
export function handoffStepLabel(
  steps: readonly Pick<HandoffTargetStep, "id" | "name">[],
  id: string,
): string {
  const i = steps.findIndex((s) => s.id === id);
  const step = steps[i];
  return step ? `${i + 1} · ${step.name}` : id;
}

/** The target of a hand-off step, when the list knows it. */
export function handoffTargetOf(
  agents: readonly HandoffAgent[] | undefined,
  step: Pick<HandoffStep, "to">,
): { agent: HandoffAgent; step: HandoffTargetStep | undefined } | undefined {
  const agent = agents?.find((a) => a.slug === step.to.agent);
  if (!agent) return undefined;
  return { agent, step: agent.steps.find((s) => s.id === step.to.step) };
}
