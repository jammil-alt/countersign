// B5 (docs/builder-plan.md §7): the settings the operator lets the client adjust, as the definition
// editor edits them. A skill parameter (number, money, text or date) or a schedule is marked with
// a checkbox; its bounds are typed as strings (a low and a high, a list of options, which side is
// stricter) and checked here, then written into `definition.adjustable`. Pure, so the checks are
// tested without rendering. Marks the editor doesn't show (a step's own parameter) are kept as
// they are.

import {
  type AdjustableSetting,
  type AdjustTarget,
  type AnyAgentBundle,
  adjustableId,
  allTriggers,
  DECIMAL_RE,
  Decimal,
  readAdjustable,
  sameTarget,
  type TriggerHolder,
} from "@countersign/core";

/** One mark as the form holds it: its bounds as typed. */
export interface AdjustDraft {
  id: string;
  target: AdjustTarget;
  label: string;
  hint: string;
  min: string;
  max: string;
  /** Options, one per line (a schedule's allowed times as crons). */
  options: string;
  tighter: "" | "lower" | "higher";
  decisionId?: string | undefined;
}

export function draftsFrom(definition: { adjustable?: unknown }): AdjustDraft[] {
  return readAdjustable(definition.adjustable).map((s) => ({
    id: s.id,
    target: s.target,
    label: s.label,
    hint: s.hint,
    min: s.bounds?.min ?? "",
    max: s.bounds?.max ?? "",
    options: (s.bounds?.options ?? []).join("\n"),
    tighter: s.tighter ?? "",
    ...(s.decisionId ? { decisionId: s.decisionId } : {}),
  }));
}

/** The mark on a target, if any. */
export function draftFor(drafts: readonly AdjustDraft[], target: AdjustTarget) {
  return drafts.find((d) => sameTarget(d.target, target));
}

/** The drafts with a target marked (a new mark, starting from `start`) or unmarked. */
export function toggleDraft(
  drafts: readonly AdjustDraft[],
  target: AdjustTarget,
  on: boolean,
  start: Partial<AdjustDraft> & { label: string },
): AdjustDraft[] {
  const rest = drafts.filter((d) => !sameTarget(d.target, target));
  if (!on) return rest;
  return [
    ...rest,
    {
      id: adjustableId(target),
      target,
      hint: "",
      min: "",
      max: "",
      options: "",
      tighter: "",
      ...start,
    },
  ];
}

/** The drafts with one mark changed. */
export function updateDraft(
  drafts: readonly AdjustDraft[],
  target: AdjustTarget,
  patch: Partial<AdjustDraft>,
): AdjustDraft[] {
  return drafts.map((d) => (sameTarget(d.target, target) ? { ...d, ...patch } : d));
}

const optionList = (text: string) =>
  [...new Set(text.split("\n").map((o) => o.trim()))].filter(Boolean);

/** What stops a mark from saving, in plain words; null when it is fine. */
export function draftProblem(d: AdjustDraft): string | null {
  if (!d.label.trim()) return "Give it a name the client reads.";
  const numeric =
    d.target.kind === "parameter" && (d.target.type === "number" || d.target.type === "money");
  if (numeric) {
    for (const v of [d.min, d.max]) {
      if (v.trim() && !DECIMAL_RE.test(v.trim())) return "Limits are numbers, like 0 or 5.5.";
    }
    if (d.min.trim() && d.max.trim() && new Decimal(d.min.trim()).gt(d.max.trim())) {
      return "The low limit is above the high one.";
    }
    if (!d.min.trim() && !d.max.trim() && !d.tighter) {
      return "Give it a low limit, a high one, or a stricter side.";
    }
  }
  if (d.target.kind === "schedule" && optionList(d.options).length === 0) {
    return "List the times the client may choose, one per line.";
  }
  if (optionList(d.options).length > 50) return "At most 50 options.";
  return null;
}

/** Problems by mark id. */
export function draftProblems(drafts: readonly AdjustDraft[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of drafts) {
    const p = draftProblem(d);
    if (p) out[d.id] = p;
  }
  return out;
}

/** The marks as the definition stores them. */
export function settingsFrom(drafts: readonly AdjustDraft[]): AdjustableSetting[] {
  return drafts.map((d) => {
    const options = optionList(d.options);
    const numeric =
      d.target.kind === "parameter" && (d.target.type === "number" || d.target.type === "money");
    const bounds = {
      ...(numeric && d.min.trim() ? { min: d.min.trim() } : {}),
      ...(numeric && d.max.trim() ? { max: d.max.trim() } : {}),
      ...(!numeric && options.length > 0 ? { options } : {}),
    };
    return {
      id: d.id,
      label: d.label.trim(),
      hint: d.hint.trim(),
      target: d.target,
      ...(Object.keys(bounds).length > 0 ? { bounds } : {}),
      ...(numeric && d.tighter ? { tighter: d.tighter } : {}),
      ...(d.decisionId ? { decisionId: d.decisionId } : {}),
    };
  });
}

/** The definition with its marks: none leaves the field out, as a definition without it reads. */
export function withAdjustable<D extends { adjustable?: unknown }>(
  definition: D,
  drafts: readonly AdjustDraft[],
): D {
  const { adjustable: _was, ...rest } = definition;
  return (drafts.length > 0 ? { ...rest, adjustable: settingsFrom(drafts) } : rest) as D;
}

/** The agent's schedule triggers, by workflow, for the schedules card. */
export function scheduleTargets(bundle: Pick<AnyAgentBundle, "workflows">) {
  const out: { target: AdjustTarget; workflow: string; cron: string }[] = [];
  for (const w of bundle.workflows) {
    for (const t of allTriggers(w.workflow as TriggerHolder)) {
      if (t.on.type !== "schedule") continue;
      out.push({
        target: { kind: "schedule", workflow: w.slug, triggerId: t.id },
        workflow: w.name,
        cron: t.on.cron,
      });
    }
  }
  return out;
}
