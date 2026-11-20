// Rules a client may adjust (docs/builder-plan.md §7, B5). The operator marks a setting of an
// agent as client-adjustable, with bounds: a number between a low and a high, one of a list of
// options, a schedule from the ones we allow. They travel in the agent's version
// (`definition.adjustable`, beside `setup` and `manual`), so a template's bounds reach its copies
// and a copy keeps them unless we change them for that client (§10, point 2).
//
// The client admin changes one on the agent's Settings in the portal. Code decides what happens:
// - within the bounds, or tighter than it is now: applied at once, as a new version made by code
//   (the "client settings" class, ARCHITECTURE §10.15);
// - beyond the bounds: a request to us;
// - never: approvals, permissions, new writes or new steps. A setting can only name a skill's
//   parameter or a schedule trigger's time, and the new bundle may differ from the old one only
//   there (and in the manual's record of the change), checked by code (`onlyAdjusted`).
//
// Every change is written into the manual's decisions with who made it and when
// (`recordAdjustment`). Pure: the API reads the rows and writes the version.

import { z } from "zod";
import { DECISIONS_MAX, type Decision } from "../build/build";
import { cloneJson, deepEqual, isPlainObject } from "../json";
import { type AgentManual, readManual } from "../manual/manual";
import { DECIMAL_RE, Decimal } from "../money";
import { allTriggers, type TriggerHolder } from "../triggers/kinds";
import {
  type AdjustableSetting,
  type AdjustSchedule,
  type AdjustTarget,
  AdjustTighter,
  readAdjustable,
} from "./adjustable";
import { applySetupSetting, settingValue } from "./checklist";

/** The id a setting gets from what it changes: `param-tolerance`, `schedule-main-<trigger>`. */
export function adjustableId(target: AdjustTarget): string {
  const raw =
    target.kind === "parameter"
      ? `param-${target.stepId ? `${target.stepId}-` : ""}${target.parameter}`
      : `schedule-${target.workflow}-${target.triggerId}`;
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 80);
}

/** Two targets name the same setting. */
export function sameTarget(a: AdjustTarget, b: AdjustTarget): boolean {
  if (a.kind === "parameter" && b.kind === "parameter") {
    return (
      a.skill === b.skill &&
      a.parameter === b.parameter &&
      (a.stepId ?? null) === (b.stepId ?? null)
    );
  }
  if (a.kind === "schedule" && b.kind === "schedule") {
    return a.workflow === b.workflow && a.triggerId === b.triggerId;
  }
  return false;
}

// ── Reading and writing a setting's value ──────────────────────────────────────────────────────

interface BundleLike {
  definition: { skills: readonly unknown[]; manual?: unknown; adjustable?: unknown };
  workflows: readonly { slug: string; workflow: unknown }[];
}

/** The schedule trigger a target names, in a bundle (or a copy of it), if it is still there. */
function scheduleTrigger(bundle: BundleLike, target: AdjustSchedule) {
  const w = bundle.workflows.find((x) => x.slug === target.workflow);
  if (!w) return null;
  const t = allTriggers(w.workflow as TriggerHolder).find((x) => x.id === target.triggerId);
  return t?.on.type === "schedule"
    ? (t as typeof t & { on: { type: "schedule"; cron: string } })
    : null;
}

/** The setting's value in the bundle now: the parameter's set value, or the trigger's cron. */
export function adjustValue(bundle: BundleLike, target: AdjustTarget): unknown {
  if (target.kind === "schedule") return scheduleTrigger(bundle, target)?.on.cron;
  return settingValue(bundle as never, target);
}

/** A value as the client reads it: "2", "5000.00 USD", a cron, a date, words. */
export function adjustValueText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") return value;
  if (isPlainObject(value) && typeof value.amount === "string") {
    return typeof value.currency === "string" ? `${value.amount} ${value.currency}` : value.amount;
  }
  return null;
}

/** The bundle with the setting's value written in, and nothing else changed. */
export function applyAdjustValue<B extends BundleLike>(
  bundle: B,
  target: AdjustTarget,
  value: unknown,
): { ok: true; bundle: B } | { ok: false; reason: string } {
  if (target.kind === "parameter") {
    const out = applySetupSetting(bundle as never, target, value);
    return out.ok ? { ok: true, bundle: out.bundle as unknown as B } : out;
  }
  const next = cloneJson(bundle);
  const t = scheduleTrigger(next, target);
  if (!t) {
    return { ok: false, reason: "The schedule this setting changes is no longer in the agent." };
  }
  if (typeof value !== "string") return { ok: false, reason: "A schedule is a time to run." };
  t.on.cron = value;
  return { ok: true, bundle: next };
}

// ── Judging a change ────────────────────────────────────────────────────────────────────────────

export type AdjustOutcome =
  /** Within the bounds, or tighter than now: applied at once. */
  | { outcome: "apply"; value: unknown; text: string; tightens: boolean }
  /** Beyond the bounds: a request to us, with the value asked for in words. */
  | { outcome: "request"; text: string; reason: string }
  /** Not a value of the setting's kind at all. */
  | { outcome: "invalid"; reason: string };

function numberText(raw: string): string | null {
  const t = raw.replace(/[\s,$%]/g, "");
  return DECIMAL_RE.test(t) ? t : null;
}

function decimalOf(v: unknown): Decimal | null {
  const t = adjustValueText(v);
  if (t === null) return null;
  const n = numberText(t.replace(/\b[A-Z]{3}\b/, ""));
  return n === null ? null : new Decimal(n);
}

/** "between 0 and 5", "at least 0", "at most 5". */
function boundsWords(b: AdjustableSetting["bounds"]): string {
  if (b?.min !== undefined && b.max !== undefined) return `between ${b.min} and ${b.max}`;
  if (b?.min !== undefined) return `at least ${b.min}`;
  if (b?.max !== undefined) return `at most ${b.max}`;
  return "within its limits";
}

/**
 * What a client's new value for a setting does, by code: applied (within the bounds, or a number
 * moved to its tighter side from where it is now), a request to us (beyond the bounds), or
 * invalid (not a value of its kind). `current` is the value in the agent now (`adjustValue`, or
 * the skill's default when it has none).
 */
// DECISION: a tightening is applied even past the bounds ("tightening, or a change within the
// bounds", §7): a number moved to its `tighter` side from the value it has now. A setting with no
// `tighter` has no tightening; past its bounds it is a request. Options and schedules have no
// order, so any value not on their list is a request.
// DECISION: dates and text with no options take any value of their kind: they have no bounds to
// keep. A date's min and max are not read (bounds are decimals).
export function judgeAdjustment(
  setting: Pick<AdjustableSetting, "target" | "bounds" | "tighter">,
  raw: string,
  current?: unknown,
): AdjustOutcome {
  const text = raw.trim();
  if (text.length === 0) return { outcome: "invalid", reason: "Write a value first." };
  if (text.length > 2000) return { outcome: "invalid", reason: "Keep it under 2,000 characters." };
  const options = setting.bounds?.options;
  if (setting.target.kind === "schedule") {
    const match = options?.find((o) => o.trim() === text);
    if (match) return { outcome: "apply", value: match, text: match, tightens: false };
    return { outcome: "request", text, reason: "That schedule isn't one of the ones we set up." };
  }
  if (options) {
    const match = options.find((o) => o.toLowerCase() === text.toLowerCase());
    if (match) return { outcome: "apply", value: match, text: match, tightens: false };
    return { outcome: "request", text, reason: `It isn't one of: ${options.join(", ")}.` };
  }
  const type = setting.target.type;
  if (type === "text") return { outcome: "apply", value: text, text, tightens: false };
  if (type === "date") {
    const ok = /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00Z`));
    return ok
      ? { outcome: "apply", value: text, text, tightens: false }
      : { outcome: "invalid", reason: "Write a date such as 2026-12-24." };
  }
  const code = type === "money" ? /\b([A-Z]{3})\b/.exec(text)?.[1] : undefined;
  const n = numberText(type === "money" ? text.replace(/\b[A-Z]{3}\b/, "") : text);
  if (n === null) {
    return {
      outcome: "invalid",
      reason: type === "money" ? "Write an amount, such as 5000.00." : "Write a number.",
    };
  }
  const d = new Decimal(n);
  let value: unknown = Number(n);
  let shown = n;
  if (type === "money") {
    const was =
      isPlainObject(current) && typeof current.currency === "string" ? current.currency : "USD";
    const currency = code ?? was;
    if (isPlainObject(current) && typeof current.currency === "string" && currency !== was) {
      return { outcome: "invalid", reason: `Keep it in ${was}.` };
    }
    value = { amount: d.toFixed(2), currency };
    shown = `${d.toFixed(2)} ${currency}`;
  }
  const b = setting.bounds;
  const below = b?.min !== undefined && d.lessThan(b.min);
  const above = b?.max !== undefined && d.greaterThan(b.max);
  const now = decimalOf(current);
  const tightens =
    now !== null &&
    ((setting.tighter === "lower" && d.lessThan(now)) ||
      (setting.tighter === "higher" && d.greaterThan(now)));
  if (!below && !above) return { outcome: "apply", value, text: shown, tightens };
  // Past a bound only on the tighter side, and tighter than it is now.
  const pastTightSide =
    (below && setting.tighter === "lower") || (above && setting.tighter === "higher");
  if (pastTightSide && tightens) return { outcome: "apply", value, text: shown, tightens: true };
  return {
    outcome: "request",
    text: shown,
    reason: `It is outside what we set up: ${boundsWords(b)}.`,
  };
}

// ── The never class, by code ────────────────────────────────────────────────────────────────────

/** A JSON copy with the setting's value and the manual taken out, to compare the rest. */
function withoutAdjusted(bundle: BundleLike, target: AdjustTarget): unknown {
  const copy = cloneJson(bundle) as BundleLike & { definition: Record<string, unknown> };
  delete copy.definition.manual;
  const cleared = applyAdjustValue(copy, target, target.kind === "schedule" ? "" : null);
  return cleared.ok ? cleared.bundle : copy;
}

/**
 * Whether `after` differs from `before` only in the setting's value and the manual's record of it.
 * The last guard before an adjustment is saved: anything else (an approval, a permission, a write,
 * a step) would be the never class, and is refused.
 */
export function onlyAdjusted(before: BundleLike, after: BundleLike, target: AdjustTarget): boolean {
  return deepEqual(withoutAdjusted(before, target), withoutAdjusted(after, target));
}

// ── The manual's record ─────────────────────────────────────────────────────────────────────────

/** Who made a change, as the manual keeps it. */
export interface AdjustActor {
  name: string | null;
  side: "client" | "operator";
}

/**
 * The manual with a change written into its decisions: the decision the setting is about (its
 * value now, status changed, by whom and when), else a decision of its own for the setting.
 */
// DECISION: a setting with no decision of its own gets one, id `set-<setting id>`, kind
// `client_setup`, so the manual lists every client change beside the build's decisions; a second
// change updates the same row. When the list is full, the oldest decision of that kind is dropped
// before a build's own.
export function recordAdjustment(
  manualRaw: unknown,
  setting: Pick<AdjustableSetting, "id" | "label" | "decisionId">,
  text: string,
  actor: AdjustActor,
  at: string,
): AgentManual {
  const manual: AgentManual = readManual(manualRaw) ?? {
    whatItDoes: "",
    decisions: [],
    decisionPoints: [],
    knownRisks: [],
  };
  const who = actor.name ?? (actor.side === "client" ? "your team" : "Mezonas");
  const changed = {
    value: text.slice(0, 300),
    status: "changed" as const,
    by: actor.name,
    at,
    side: actor.side,
  };
  const own = setting.decisionId
    ? manual.decisions.find((d) => d.id === setting.decisionId)
    : undefined;
  const ownId = `set-${setting.id}`.slice(0, 40);
  const target = own ?? manual.decisions.find((d) => d.id === ownId);
  if (target) {
    return {
      ...manual,
      decisions: manual.decisions.map((d) => (d.id === target.id ? { ...d, ...changed } : d)),
    };
  }
  const row: Decision = {
    id: ownId,
    what: `${setting.label}: ${text}`.slice(0, 300),
    why: `Set by ${who} on the agent's settings.`.slice(0, 500),
    kind: "client_setup",
    risk: "normal",
    ...changed,
  };
  let decisions = [...manual.decisions, row];
  while (decisions.length > DECISIONS_MAX) {
    const i = decisions.findIndex((d) => d.id.startsWith("set-") && d.id !== ownId);
    decisions = i >= 0 ? decisions.filter((_, j) => j !== i) : decisions.slice(1);
  }
  return { ...manual, decisions };
}

// ── The view ────────────────────────────────────────────────────────────────────────────────────

export const ADJUST_KINDS = ["number", "money", "text", "date", "schedule"] as const;

export const AdjustRowView = z.object({
  id: z.string(),
  label: z.string(),
  hint: z.string(),
  kind: z.enum(ADJUST_KINDS),
  /** The value now, in words (a schedule's cron, which the portal reads in words). */
  current: z.string().nullable(),
  min: z.string().nullable(),
  max: z.string().nullable(),
  options: z.array(z.string()).nullable(),
  tighter: AdjustTighter.nullable(),
  /** Who changed it last and when, from the manual; null when nobody has. */
  changedBy: z.string().nullable(),
  changedSide: z.enum(["client", "operator"]).nullable(),
  changedAt: z.string().nullable(),
});
export type AdjustRowView = z.infer<typeof AdjustRowView>;

/**
 * The adjustable settings as the portal shows them: their words, bounds and value now, never which
 * skill, parameter or step they set (invariant 11). `defaultOf` gives a parameter's default when
 * the agent sets none. Who changed one on our side is shown as "us", never our name.
 */
export function adjustView(
  bundle: BundleLike,
  defaultOf: (target: AdjustTarget) => unknown = () => undefined,
  audience: "client" | "operator" = "client",
): AdjustRowView[] {
  const manual = readManual(bundle.definition.manual);
  return readAdjustable(bundle.definition.adjustable).map((s) => {
    const value = adjustValue(bundle, s.target) ?? defaultOf(s.target);
    const ownId = `set-${s.id}`.slice(0, 40);
    const d =
      manual?.decisions.find((x) => x.id === s.decisionId && x.status === "changed") ??
      manual?.decisions.find((x) => x.id === ownId);
    const side = d?.side ?? null;
    return {
      id: s.id,
      label: s.label,
      hint: s.hint,
      kind: s.target.kind === "schedule" ? "schedule" : s.target.type,
      current: adjustValueText(value),
      min: s.bounds?.min ?? null,
      max: s.bounds?.max ?? null,
      options: s.bounds?.options ?? null,
      tighter: s.tighter ?? null,
      changedBy: d && (audience === "operator" || side === "client") ? (d.by ?? null) : null,
      changedSide: d ? side : null,
      changedAt: d?.at ?? null,
    };
  });
}
