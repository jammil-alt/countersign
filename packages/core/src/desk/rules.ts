// The Desk's pure rules (ARCHITECTURE §11.1, docs/plan.md §1.39): the undo window's setting, snooze
// limits, which parts of a drafted change a person may edit, quick answers, and batch keys. The API
// applies them; the portal may use them to show the same limits before a request.

import { z } from "zod";
import { deepEqual, isPlainObject } from "../json";
import { EDITABLE_KINDS, type ToolDisplay } from "../schemas/tool-display";
import { type PersonChoice, PersonField } from "../schemas/workflow";

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
    // A path through an object's prototype is never an input field.
    if (path.length === 0 || !safePath(path) || fixed.has(path[0] as string)) continue;
    out.push(path);
  }
  return out;
}

/** Keys that reach an object's prototype: never part of a path read or written here. */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function safePath(path: readonly string[]): boolean {
  return path.every((key) => !UNSAFE_KEYS.has(key));
}

function getAt(value: unknown, path: readonly string[]): { found: boolean; value: unknown } {
  if (!safePath(path)) return { found: false, value: undefined };
  let node: unknown = value;
  for (const key of path) {
    if (UNSAFE_KEYS.has(key) || !isPlainObject(node) || !Object.hasOwn(node, key)) {
      return { found: false, value: undefined };
    }
    node = node[key];
  }
  return { found: true, value: node };
}

/** Sets (or, when not found, removes) the value at `path`, copying each object on the way down. */
function setAt(
  target: Record<string, unknown>,
  path: readonly string[],
  hit: { found: boolean; value: unknown },
) {
  if (path.length === 0 || !safePath(path)) return;
  let node: Record<string, unknown> = target;
  for (const key of path.slice(0, -1)) {
    if (UNSAFE_KEYS.has(key)) return;
    const next = Object.hasOwn(node, key) ? node[key] : undefined;
    if (!isPlainObject(next) && !hit.found) return;
    const copy: Record<string, unknown> = isPlainObject(next) ? { ...next } : {};
    Object.defineProperty(node, key, {
      value: copy,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    node = copy;
  }
  const last = path[path.length - 1] as string;
  if (UNSAFE_KEYS.has(last)) return;
  if (hit.found) {
    Object.defineProperty(node, last, {
      value: hit.value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  } else if (Object.hasOwn(node, last)) {
    delete node[last];
  }
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

/** Reads the fields a person is asked for (an inbox item's `payload.fields`); unreadable is none. */
export function readAnswerFields(value: unknown): PersonField[] | null {
  const r = z.array(PersonField).min(1).safeParse(value);
  return r.success ? r.data : null;
}

/**
 * A person's answer as the fields they were asked for, each by its name (null where not given).
 * A form answers with an object; a single value (a choice pressed, a reply typed on a screen that
 * shows no form) fills the first field.
 */
export function answerFields(
  fields: readonly Pick<PersonField, "name">[],
  answer: unknown,
): Record<string, unknown> {
  const given: Record<string, unknown> = isPlainObject(answer)
    ? answer
    : fields[0] && answer !== undefined && answer !== null
      ? { [fields[0].name]: answer }
      : {};
  return Object.fromEntries(fields.map((f) => [f.name, given[f.name] ?? null]));
}

const DECIMAL = /^-?\d+(\.\d{1,4})?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Why a value can't fill a field of this type (null: it can). */
function fieldValueProblem(field: PersonField, value: unknown): string | null {
  const what = field.about ?? field.name;
  switch (field.type) {
    case "text":
      return typeof value === "string" ? null : `${what}: write it as text`;
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? null : `${what}: give a number`;
    case "money":
      return typeof value === "string" && DECIMAL.test(value)
        ? null
        : `${what}: give an amount, like 125.00`;
    case "date":
      return typeof value === "string" && ISO_DATE.test(value)
        ? null
        : `${what}: give a date, like 2026-01-15`;
    case "yes_no":
      return typeof value === "boolean" ? null : `${what}: answer yes or no`;
  }
}

/**
 * What is wrong with an answer to a person's question (null: nothing): one of its choices when it
 * has them, and, when it asks for fields, each required one given and each given one of its type.
 * A single value answers the first field (a screen that shows no form); the rest stay empty.
 */
export function answerProblem(payload: unknown, answer: unknown): string | null {
  const p = isPlainObject(payload) ? payload : {};
  const choices = readChoices(p.choices);
  const fields = readAnswerFields(p.fields);
  if (!fields || !isPlainObject(answer)) return choices ? choiceProblem(choices, answer) : null;
  const values = answerFields(fields, answer);
  const first = fields[0];
  if (choices && first) {
    const problem = choiceProblem(choices, values[first.name]);
    if (problem) return problem;
  }
  for (const f of fields) {
    const v = values[f.name];
    const empty = v === null || (typeof v === "string" && v.trim() === "");
    if (empty) {
      if (f.required) return `${f.about ?? f.name}: this is needed`;
      continue;
    }
    if (choices && f === first) continue;
    const problem = fieldValueProblem(f, v);
    if (problem) return problem;
  }
  return null;
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
