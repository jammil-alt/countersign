// The Desk's pure rules (ARCHITECTURE §11.1, docs/plan.md §1.39): the undo window's setting, snooze
// limits, which parts of a drafted change a person may edit, quick answers, and batch keys. The API
// applies them; the portal may use them to show the same limits before a request.

import { z } from "zod";
import { isPlainObject, deepEqual } from "../json";
import type { PersonChoice } from "../schemas/workflow";
import { EDITABLE_KINDS, type ToolDisplay } from "../schemas/tool-display";

// ── Undo window ──────────────────────────────────────────────────────────────────────────────────

export const UNDO_SECONDS_DEFAULT = 60;
export const UNDO_SECONDS_MAX = 300;
export const UndoSeconds = z.number().int().min(0).max(UNDO_SECONDS_MAX);

/** `tenant.settings.approvals.undoSeconds`: 0 switches the window off; unreadable = the default. */
export function undoSecondsOf(settings: Record<string, unknown> | null | undefined): number {
  const approvals = settings?.approvals;
  const raw = isPlainObject(approvals) ? approvals.undoSeconds : undefined;
  const parsed = UndoSeconds.safeParse(raw);
  return parsed.success ? parsed.data : UNDO_SECONDS_DEFAULT;
}

/** Settings with a new undo window, keeping the other approval settings. */
export function withUndoSeconds(
  settings: Record<string, unknown>,
  seconds: number,
): Record<string, unknown> {
  const approvals = isPlainObject(settings.approvals) ? settings.approvals : {};
  return { ...settings, approvals: { ...approvals, undoSeconds: UndoSeconds.parse(seconds) } };
}

// ── Snooze ───────────────────────────────────────────────────────────────────────────────────────

export const SNOOZE_MAX_MS = 14 * 24 * 60 * 60_000;
/** A snooze past the item's due time is cut to this long before it. */
export const SNOOZE_DUE_MARGIN_MS = 60 * 60_000;

export type SnoozeResult =
  | { ok: true; until: Date; cut: boolean }
  | { ok: false; code: "in_the_past" | "too_far" | "due_soon"; message: string };

/**
 * When a snooze ends: in the future, at most 14 days away, and an hour before the item's due time
 * at the latest. A snooze never moves the step's timeout.
 */
export function snoozeUntil(input: { until: Date; now: Date; dueAt: Date | null }): SnoozeResult {
  const { until, now, dueAt } = input;
  if (until.getTime() <= now.getTime()) {
    return { ok: false, code: "in_the_past", message: "pick a time in the future" };
  }
  if (until.getTime() - now.getTime() > SNOOZE_MAX_MS) {
    return { ok: false, code: "too_far", message: "snooze for at most 14 days" };
  }
  if (dueAt && until.getTime() > dueAt.getTime() - SNOOZE_DUE_MARGIN_MS) {
    const cut = new Date(dueAt.getTime() - SNOOZE_DUE_MARGIN_MS);
    if (cut.getTime() <= now.getTime()) {
      return { ok: false, code: "due_soon", message: "this is due within the hour" };
    }
    return { ok: true, until: cut, cut: true };
  }
  return { ok: true, until, cut: false };
}

// ── Edit before signing ──────────────────────────────────────────────────────────────────────────

/**
 * The input paths a person may change: fields the tool's display marks `editable` whose value
 * after the change is `input.<path>`, minus the tool's fixed inputs (they become instructions).
 */
export function editablePaths(
  display: ToolDisplay | null | undefined,
  fixedInputs: readonly string[] = [],
): string[][] {
  const fixed = new Set(fixedInputs);
  const out: string[][] = [];
  for (const f of display?.fields ?? []) {
    if (f.editable !== true || !f.after?.startsWith("input.")) continue;
    if (!(EDITABLE_KINDS as readonly string[]).includes(f.kind)) continue;
    const path = f.after.split(".").slice(1);
    if (path.length === 0 || fixed.has(path[0] as string)) continue;
    out.push(path);
  }
  return out;
}

function getAt(value: unknown, path: readonly string[]): { found: boolean; value: unknown } {
  let node: unknown = value;
  for (const key of path) {
    if (!isPlainObject(node) || !Object.hasOwn(node, key)) return { found: false, value: undefined };
    node = node[key];
  }
  return { found: true, value: node };
}

function setAt(target: Record<string, unknown>, path: readonly string[], hit: { found: boolean; value: unknown }) {
  let node: Record<string, unknown> = target;
  for (const key of path.slice(0, -1)) {
    const next = node[key];
    if (!isPlainObject(next)) {
      if (!hit.found) return;
      node[key] = {};
    } else {
      node[key] = { ...next };
    }
    node = node[key] as Record<string, unknown>;
  }
  const last = path[path.length - 1] as string;
  if (hit.found) node[last] = hit.value;
  else delete node[last];
}

/**
 * Null when `edited` differs from the agent's `original` only at editable paths; otherwise what
 * else it changes. Everything else (ids, guards, version tokens, fixed inputs) must stay as the
 * agent proposed it.
 */
export function editProblem(input: {
  original: unknown;
  edited: unknown;
  paths: readonly (readonly string[])[];
}): string | null {
  if (!isPlainObject(input.original) || !isPlainObject(input.edited)) {
    return "the change's input is not an object";
  }
  const edited = input.edited;
  if (input.paths.length === 0) return "nothing in this change can be edited";
  // setAt copies each object on the way down, so the agent's input is never changed.
  const merged: Record<string, unknown> = { ...input.original };
  for (const path of input.paths) setAt(merged, path, getAt(edited, path));
  if (deepEqual(merged, edited)) return null;
  const keys = new Set([...Object.keys(merged), ...Object.keys(edited)]);
  const changed = [...keys].filter((k) => !deepEqual(merged[k], edited[k]));
  return `only ${input.paths.map((p) => p.join(".")).join(", ")} can be edited; ${changed.join(", ")} can't`;
}

// ── Quick answers ────────────────────────────────────────────────────────────────────────────────

/** Null when `answer` is one of the choices' values. */
export function choiceProblem(
  choices: readonly Pick<PersonChoice, "value">[],
  answer: unknown,
): string | null {
  if (typeof answer === "string" && choices.some((c) => c.value === answer)) return null;
  return `answer with one of: ${choices.map((c) => c.value).join(", ")}`;
}

/** Reads stored choices (an inbox item's payload); anything unreadable is none. */
export function readChoices(value: unknown): { value: string }[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: { value: string }[] = [];
  for (const c of value) {
    if (!isPlainObject(c) || typeof c.value !== "string") return null;
    out.push({ value: c.value });
  }
  return out;
}

// ── Batches ──────────────────────────────────────────────────────────────────────────────────────

/**
 * `<run id>:<top step id>`: every approval one step proposes, a `for_each`'s children included
 * (their durable names are `<loop>:<index>:<child>`), shares it.
 */
export function batchKeyOf(runId: string, nodeId: string): string {
  return `${runId}:${nodeId.split(":")[0] ?? nodeId}`;
}
