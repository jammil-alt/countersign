// What the workflow builder tells the one-screen view (docs/builder-plan.md §12, F6; docs/plan.md
// §1.170): what the frame starts and ends with (an agent's triggers; a loop's "For each …" and what
// it gives back), each step's words on the chart, the statuses the builder adds to the validator's
// (a client's missing setup, a Dev queue request on a step that requires code), and where a place
// in a loop's own view sits in the whole workflow. Pure: no React, so it holds in tests.
import {
  processes,
  type StepCodeRequest,
  stepCodeStatus,
  type TypingContext,
} from "@countersign/core";
import type { LeftItem } from "../builder/data-use";
import {
  type ApprovalEnv,
  approvalOption,
  type ContainerId,
  getContainer,
  ifOfBranch,
  locate,
  type Process,
  ROOT,
  type Step,
} from "../builder/model";
import {
  fieldText,
  processKindLabel,
  processStepDetail,
  processStepNames,
  rulesText,
  type StepLabels,
  stepSkillKindLabel,
  triggerTitle,
} from "../workflow/describe";
import type { SettleEntry } from "./status";
import type { ChartProps, FlowEnds, InsertPoint, StatusMap, StepStatus } from "./types";

// ── What the frame starts and ends with ──────────────────────────────────────────────────────────

/** An agent's workflow: "Starts when" its triggers; it gives nothing back. */
export function agentEnds(process: Pick<Process, "triggers">): FlowEnds {
  return {
    start:
      process.triggers.length > 0
        ? { title: "Starts when", lines: process.triggers.map((t) => triggerTitle(t)) }
        : null,
    givesBack: null,
  };
}

type Loop = Extract<Step, { kind: "for_each" | "repeat" }>;

export function isLoop(step: Step | null | undefined): step is Loop {
  return step?.kind === "for_each" || step?.kind === "repeat";
}

/** What a later step can read of a loop, in words, by the field of its output. */
const LOOP_GIVES: Record<string, string> = {
  count: "How many items it ran for",
  passes: "How many passes it took",
  done: "Whether it finished before its limit",
};

/**
 * A loop opened in the frame: it starts "For each item of <list>" or "Repeat until …", and gives
 * back what later steps can use from it, worked out from its steps and never stored: the fields of
 * its output (core's `stepOutputSchema`), a repeat's last pass by step, and what its steps save and
 * change (`dataLines`: the builder's words for `stepDataUse`).
 */
export function loopEnds(
  loop: Loop,
  process: Pick<Process, "steps">,
  ctx: TypingContext,
  dataLines: (step: Step) => readonly string[] = () => [],
): FlowEnds {
  const names = processStepNames(process);
  const start =
    loop.kind === "for_each"
      ? {
          title: "Runs once per item",
          lines: [`For each item of ${fieldText(loop.over, names) || "the list"}`],
        }
      : {
          title: `Up to ${loop.maxTimes} ${loop.maxTimes === 1 ? "time" : "times"}`,
          lines: [
            "rules" in loop.until
              ? loop.until.rules.rules.length > 0
                ? `Repeat until ${rulesText(loop.until.rules, names)}`
                : "Repeat until its rule holds"
              : `Repeat until ${loop.until.agent.goal.trim() || "the agent says it's done"}`,
          ],
        };

  const lines: string[] = [];
  const output = processes.stepOutputSchema(loop, ctx);
  const fields = (output?.properties ?? {}) as Record<string, { properties?: object } | undefined>;
  for (const key of Object.keys(fields)) {
    if (key === "last") {
      for (const id of Object.keys(fields.last?.properties ?? {})) {
        lines.push(`The last pass of “${names.get(id) || "a step"}”`);
      }
    } else {
      lines.push(LOOP_GIVES[key] ?? key);
    }
  }
  // What its steps keep outlasts the loop: later steps read it from where it was saved.
  processes.walkSteps({ steps: loop.steps }, ({ step }) => {
    for (const line of dataLines(step)) {
      if (!/^(Saves|Changes) /.test(line) || line.startsWith("Saves nothing")) continue;
      if (!lines.includes(line)) lines.push(line);
    }
  });
  return { start, givesBack: lines.length > 0 ? { title: "Gives back", lines } : null };
}

/** The loop's own steps as the chart draws them, or null when `loopId` names no loop. */
export function loopProcess(
  process: Process,
  loopId: string,
): { loop: Loop; view: Process } | null {
  const step = locate(process, loopId)?.step;
  if (!isLoop(step)) return null;
  // No triggers in its view: the loop starts it (the List has no "Starts when" row there).
  return { loop: step, view: { ...process, triggers: [], steps: step.steps } };
}

/** A place in the frame as the whole workflow names it: a loop's own list is `loop:<id>` there. */
export function hostPoint(openLoop: string | null, at: InsertPoint): InsertPoint {
  return openLoop && at.container === ROOT ? { ...at, container: `loop:${openLoop}` } : at;
}

/** Where a new step would go, in words: "at the end", "before “Check vendor”", "to “Big change”". */
export function placeWords(process: Pick<Process, "steps">, at: InsertPoint): string {
  const list = getContainer(process, at.container);
  const next = list?.[at.index];
  const where = (c: ContainerId): string | null => {
    if (c === ROOT) return null;
    if (c.startsWith("otherwise:")) {
      const branch = ifOfBranch(process, c.slice("otherwise:".length));
      return branch ? `“Otherwise” in ${branch.name || "the if"}` : null;
    }
    if (c.startsWith("path:")) {
      const id = c.slice("path:".length);
      const branch = ifOfBranch(process, id);
      const path = branch?.kind === "if" ? branch.paths.find((p) => p.id === id) : undefined;
      return path ? `“${path.name}”` : null;
    }
    const loop = locate(process, c.slice("loop:".length))?.step;
    return loop ? `“${loop.name || "For each"}”` : null;
  };
  const inside = where(at.container);
  if (next) return `before “${next.name || "the next step"}”`;
  if (!inside) return "at the end";
  return at.container.startsWith("loop:") ? `inside ${inside}` : `to ${inside}`;
}

// ── A step's words on the chart ──────────────────────────────────────────────────────────────────

/** What a step's checks add, in words: a second check, notices (approval has its own). */
export function checkWords(step: Step): { confer: string | null; notify: string | null } {
  const confer = step.checks?.confer?.with ?? [];
  const notify = step.checks?.notify ?? [];
  return {
    confer:
      confer.length > 0
        ? confer.some((c) => "person" in c)
          ? "Checked with a person"
          : "Second check"
        : null,
    notify:
      notify.length > 0 ? (notify.some((n) => n.urgent) ? "Urgent notice" : "Tells people") : null,
  };
}

/**
 * A step's title, kind and second line for the chart and the List, in the builder's words: a write
 * by where it writes, a skill with its kind (Deterministic or AI), and whether a step that changes
 * a client's tool waits for approval here (the connection, the agent's mode and the step decide,
 * `approvalOption`), then what its checks add.
 */
export function chartLabel(labels: StepLabels, env: ApprovalEnv): NonNullable<ChartProps["label"]> {
  return (step) => {
    const kind = processKindLabel(step, labels);
    const skillKind = stepSkillKindLabel(step, labels);
    const approval = approvalOption(step, env);
    const own = processStepDetail(step, labels);
    // The step's own words say what its approval check asks; here, what will happen for this agent.
    const said = approval ? (own ?? "").replace(/(^| · )(needs approval|on its own)$/, "") : own;
    const checks = checkWords(step);
    const detail = [
      said,
      approval ? (approval.automatic ? "on its own" : "needs approval") : null,
      checks.confer,
      checks.notify,
    ]
      .filter(Boolean)
      .join(" · ");
    // The chart's details say these on a line of their own (owner, 2026-11-21).
    const model = labels.stepModel?.(step);
    // The connector a read or a write is on, for the box's mark (its logo).
    const connector = labels.connectorOf?.(step);
    return {
      title: step.name.trim() || kind,
      kind: skillKind ? `${kind} · ${skillKind}` : kind,
      detail: detail || null,
      ...(skillKind ? { skillKind } : {}),
      ...(model ? { model } : {}),
      ...(connector ? { connector } : {}),
    };
  };
}

// ── Statuses the builder adds ────────────────────────────────────────────────────────────────────

/**
 * What the client still lacks for a step (a connection, a pack that is off): a question on the
 * first step that needs it, as "What's left" lists it.
 */
export function setupItems(left: readonly LeftItem[], workflow: string): SettleEntry[] {
  return left.flatMap((item): SettleEntry[] =>
    (item.kind === "connection" || item.kind === "pack") && item.workflow === workflow
      ? [
          {
            key: `setup:${item.key}`,
            stepId: item.stepId,
            level: "question",
            title: item.text,
            source: "problem",
          },
        ]
      : [],
  );
}

/** A request on the Feedback page's Dev queue tab. */
export function devQueuePath(ref: string): string {
  return `/ops/utilities/feedback?tab=dev-queue&request=${encodeURIComponent(ref)}`;
}

/**
 * docs/plan.md §1.125: a step that requires code says so in place of "missing", with its request's
 * status pulled from the Dev queue ("Requires code · DQ-012 · In review") and the request's title;
 * once shipped it asks for the swap. A closed request, or another workflow's, changes nothing.
 * The item keeps its key and carries the request's ref (`refId`) for the link.
 */
// DECISION (F6): the request's status takes the missing step's own item rather than adding one, as
// the Steps list showed it in place of "Missing"; the step stays an issue until the part is in it.
export function withCodeRequests(
  statuses: StatusMap,
  requests: readonly StepCodeRequest[],
  workflow?: string,
): StatusMap {
  const waiting = new Map<string, StepCodeRequest["request"]>();
  for (const r of requests) {
    if (!r.stepId || r.request.status === "closed") continue;
    if (r.workflowId && workflow && r.workflowId !== workflow) continue;
    waiting.set(r.stepId, r.request);
  }
  if (waiting.size === 0) return statuses;
  const out = new Map<string, StepStatus>(statuses);
  for (const [stepId, request] of waiting) {
    const status = out.get(stepId);
    if (!status) continue;
    const key = `missing:${stepId}`;
    if (!status.items.some((i) => i.key === key)) continue;
    const shipped = request.status === "shipped";
    out.set(stepId, {
      ...status,
      items: status.items.map((i) =>
        i.key === key
          ? {
              ...i,
              title: stepCodeStatus(request),
              detail: shipped
                ? `${request.title}. It's in the catalog now: put it in this step.`
                : request.title,
              refId: request.ref,
            }
          : i,
      ),
    });
  }
  return out;
}
