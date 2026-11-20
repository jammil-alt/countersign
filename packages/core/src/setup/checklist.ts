// The setup checklist (docs/builder-plan.md §6): built by code from a template build, answered by
// the client per copy, and read by the go-live stages. Pure: the API reads the rows and writes
// `agent.stage_state.setup` and the new version an answer makes.

import type { Decision, SetupField } from "../build/build";
import { cloneJson, isPlainObject } from "../json";
import type { AgentStage, StageState } from "../lifecycle/stage";
import { DECIMAL_RE, Decimal } from "../money";
import { ACTION_CONNECTOR_NAMES, ACTION_SPECS, type WriteAction } from "../process/actions";
import type { SkillStep } from "../process/schema";
import { stepWrites } from "../process/validate";
import { allSteps } from "../process/walk";
import type { AnyAgentBundle, ProcessAgentBundle } from "../schemas/agent";
import { parseSkillRef } from "../schemas/common";
import type { SkillDefinition } from "../schemas/skill";
import type { ToolSpec } from "../schemas/tool";
import type { TypingContext } from "../template/typer";
import {
  SETUP_ITEMS_MAX,
  SETUP_SETTING_TYPES,
  type SetupGuard,
  type SetupItem,
  type SetupProgress,
  type SetupSetting,
  type SetupSettingType,
} from "./item";

// ── Building it from a template build ──────────────────────────────────────────────────────────

/** A connector the draft writes through, and what it writes: one "who signs" question each. */
export interface WriteUse {
  /** A connector id, or `accounting`, `email`, `sms` for an action not resolved yet. */
  connector: string;
  /** Whether `connector` is a real connector (an action not resolved yet isn't). */
  known: boolean;
  /** A short key for the item id: `create-bill`, `update-invoice`. */
  key: string;
  /** "new bills", "emails". */
  what: string;
  /** A message to a person (sent through), rather than a record (written into). */
  send: boolean;
}

const ACTION_WHAT: Record<WriteAction, string> = {
  send_email: "emails",
  send_text: "texts",
  create_bill: "new bills",
  create_vendor: "new vendors",
};

/** "your accounting system" for an accounting action not resolved yet; else the channel. */
const UNRESOLVED_NAMES: Record<string, string> = {
  accounting: "your accounting system",
  email: "your email",
  sms: "your number",
};

function plural(entity: string): string {
  const w = entity.replace(/_/g, " ");
  return w.endsWith("s") ? w : `${w}s`;
}

function toolUse(t: ToolSpec): WriteUse {
  const connector = t.connector ?? t.source;
  const entity = t.entity ? plural(String(t.entity)) : null;
  const send = t.recipient !== undefined;
  const what = send
    ? "messages"
    : t.verb === "update"
      ? `changes to ${entity ?? "records"}`
      : t.verb === "delete"
        ? `deletions of ${entity ?? "records"}`
        : `new ${entity ?? "records"}`;
  const key = `${send ? "send" : t.verb}-${(t.entity ? String(t.entity) : "records").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
  return { connector, known: true, key, what, send };
}

/**
 * Where the draft writes and what: each write step's tool (or action), and each skill whose tools
 * write. A skill that only reaches people through its own channels names no connector here.
 */
// DECISION: a step that contacts people with no write tool of its own (a conversation, a reach-out
// skill) asks no "who signs" here: it signs through the client's channels, whose own approvals
// (and the trial's) already hold it.
export function draftWriteUses(
  bundle: Pick<ProcessAgentBundle, "workflows">,
  typing: TypingContext,
): WriteUse[] {
  const out = new Map<string, WriteUse>();
  const add = (u: WriteUse) => {
    const k = `${u.connector}|${u.key}`;
    if (!out.has(k)) out.set(k, u);
  };
  for (const w of bundle.workflows) {
    for (const { step } of allSteps(w.workflow)) {
      if (step.kind === "write" && step.action !== undefined) {
        const spec = ACTION_SPECS[step.action];
        const channel = "channel" in spec.from ? spec.from.channel : null;
        const connector = step.via ?? channel ?? "accounting";
        add({
          connector,
          known: step.via !== undefined,
          key: step.action.replace(/_/g, "-"),
          what: ACTION_WHAT[step.action],
          send: channel !== null,
        });
        continue;
      }
      if (step.kind !== "write" && step.kind !== "skill") continue;
      for (const t of stepWrites(step, typing) ?? []) {
        if (t.sideEffect === "external") add(toolUse(t));
      }
    }
  }
  return [...out.values()];
}

/** The connector a form's "connect" field names ("QuickBooks Online" → qbo), when one matches. */
export function matchConnector(
  label: string,
  connectors: readonly { id: string; name: string }[],
): string | undefined {
  const text = label.toLowerCase();
  let best: { id: string; len: number } | undefined;
  for (const c of connectors) {
    const name = c.name.toLowerCase();
    const byName = name.length > 0 && text.includes(name);
    const byId = new RegExp(`\\b${c.id.toLowerCase().replace(/[^a-z0-9]/g, "")}\\b`).test(text);
    if (!byName && !byId) continue;
    const len = byName ? name.length : c.id.length;
    if (!best || len > best.len) best = { id: c.id, len };
  }
  return best?.id;
}

const norm = (v: string) =>
  v
    .toLowerCase()
    .replace(/[\s,$%]/g, "")
    .replace(/\.0+$/, "");

function valueText(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "string") return v;
  if (isPlainObject(v) && typeof v.amount === "string") return v.amount;
  return null;
}

/**
 * The skill parameter a `client_setup` decision sets, worked out by code from the draft: the
 * parameter of the decision's step whose starting value is the decision's value, else the one its
 * words name. Null when none (or more than one) fits: the answer is then kept as words.
 */
// DECISION: matched by the value first ("2%" against a tolerance of 2), then by the parameter's
// label in the decision's words; only a single match counts, so an answer never sets a parameter
// the decision wasn't about.
export function settingForDecision(
  d: Pick<Decision, "stepId" | "value" | "what">,
  bundle: Pick<ProcessAgentBundle, "workflows" | "definition">,
  skills: Readonly<Record<string, SkillDefinition>>,
): SetupSetting | null {
  if (!d.stepId) return null;
  let found: SkillStep | undefined;
  for (const w of bundle.workflows) {
    for (const { step } of allSteps(w.workflow)) {
      if (step.id === d.stepId && step.kind === "skill") found = step;
    }
  }
  if (!found) return null;
  const skillId = parseSkillRef(found.skill).id;
  const def = skills[found.skill] ?? skills[skillId];
  const params = (def?.parameters ?? []).filter((p) =>
    (SETUP_SETTING_TYPES as readonly string[]).includes(p.type),
  );
  if (params.length === 0) return null;
  const own = bundle.definition.skills.find((s) => parseSkillRef(s.skill).id === skillId);
  const onStep = found.customize?.parameters ?? {};
  const current = (name: string) => onStep[name] ?? own?.parameters?.[name];
  const setting = (p: (typeof params)[number]): SetupSetting => ({
    skill: skillId,
    parameter: p.name,
    type: p.type as SetupSettingType,
    ...(Object.hasOwn(onStep, p.name) ? { stepId: found.id } : {}),
  });
  if (d.value) {
    const want = norm(d.value);
    const byValue = params.filter((p) => {
      const t = valueText(current(p.name) ?? p.default);
      return t !== null && norm(t) === want;
    });
    if (byValue.length === 1 && byValue[0]) return setting(byValue[0]);
  }
  const words = d.what.toLowerCase();
  const byWords = params.filter(
    (p) => words.includes(p.label.toLowerCase()) || words.includes(p.name.replace(/_/g, " ")),
  );
  return byWords.length === 1 && byWords[0] ? setting(byWords[0]) : null;
}

export interface BuildSetupInput {
  /** The template's client intake form (fields taken out are left out). */
  form: readonly SetupField[];
  decisions: readonly Decision[];
  writes: readonly WriteUse[];
  /** The platform's connectors, to name them and to match a form's "connect" field. */
  connectors?: readonly { id: string; name: string }[];
  /** The parameter a decision sets (`settingForDecision`), when known. */
  settingFor?: (d: Decision) => SetupSetting | null;
}

/**
 * The checklist a template carries (docs/builder-plan.md §6): the client intake form, then each
 * `client_setup` decision, then by code for the draft's writes a connect item per connector not
 * on the form, "When do we start writing into <tool>?" per connector and "Who signs <what> in
 * <tool>?" per kind of write. Ids are stable, so a client's progress survives a new version.
 */
// DECISION: form fields and normal decisions guard setup; a high-risk decision and the writing and
// signing items guard the trial (§6: "the trial: the writing and approval items"). Nothing made
// from a build guards go-live yet: a `live` item is for the client-adjustable settings of B5.
export function buildSetupItems(input: BuildSetupInput): SetupItem[] {
  const connectors = input.connectors ?? [];
  const nameOf = (id: string) =>
    connectors.find((c) => c.id === id)?.name ??
    ACTION_CONNECTOR_NAMES[id] ??
    UNRESOLVED_NAMES[id] ??
    id;
  const out: SetupItem[] = [];
  const formConnectors = new Set<string>();
  for (const f of input.form) {
    if (f.dropped) continue;
    const connector = f.kind === "connect" ? matchConnector(f.label, connectors) : undefined;
    if (connector) formConnectors.add(connector);
    out.push({
      id: `form-${f.id}`,
      label: f.label,
      kind: f.kind,
      hint: f.hint,
      guards: "setup",
      ...(connector ? { connector } : {}),
      source: "form",
    });
  }
  for (const d of input.decisions) {
    if (d.kind !== "client_setup") continue;
    const setting = input.settingFor?.(d) ?? null;
    out.push({
      id: `decision-${d.id}`,
      label: d.what,
      kind: "answer",
      hint: d.why,
      guards: d.risk === "high" ? "trial" : "setup",
      ...(setting ? { setting } : {}),
      ...(d.value ? { suggested: d.value.slice(0, 300) } : {}),
      source: "decision",
    });
  }
  const connectorsWritten = [...new Set(input.writes.map((w) => w.connector))];
  for (const c of connectorsWritten) {
    const known = input.writes.some((w) => w.connector === c && w.known);
    if (!known || formConnectors.has(c)) continue;
    out.push({
      id: `connect-${c}`,
      label: `Connect ${nameOf(c)}`,
      kind: "connect",
      hint: "Sign in to it yourself; we never see your password.",
      guards: "setup",
      connector: c,
      source: "write",
    });
  }
  for (const c of connectorsWritten) {
    const sends = input.writes.filter((w) => w.connector === c).every((w) => w.send);
    out.push({
      id: `write-start-${c}`,
      label: sends
        ? `When do we start sending messages through ${nameOf(c)}?`
        : `When do we start writing into ${nameOf(c)}?`,
      kind: "confirm",
      hint: "During the trial every change waits for a person to approve it.",
      guards: "trial",
      source: "write",
    });
  }
  for (const w of input.writes) {
    out.push({
      id: `write-sign-${w.connector}-${w.key}`.slice(0, 80),
      label: `Who signs ${w.what} ${w.send ? "sent through" : "in"} ${nameOf(w.connector)}?`,
      kind: "confirm",
      hint: "The person who approves each one.",
      guards: "trial",
      source: "write",
    });
  }
  const seen = new Set<string>();
  return out.filter((i) => !seen.has(i.id) && seen.add(i.id)).slice(0, SETUP_ITEMS_MAX);
}

// ── A client copy's progress ────────────────────────────────────────────────────────────────────

/** What the checklist reads about the client: which connectors are connected and bound. */
export interface SetupFacts {
  connected(connector: string): boolean;
  /**
   * Connectors C4 (docs/connectors-plan.md §7): what the agent still needs on a connector that is
   * connected and bound, in words ("Allow create bills"); null or absent when nothing blocks it.
   */
  missing?(connector: string): string | null;
}

/** What a connected, bound connector still lacks for the agent, or null. */
function connectMissing(item: Pick<SetupItem, "kind" | "connector">, facts: SetupFacts) {
  if (item.kind !== "connect" || !item.connector) return null;
  if (!facts.connected(item.connector)) return null;
  return facts.missing?.(item.connector) ?? null;
}

/**
 * Whether an item is done: a connect item with a connector by its connection (connected, bound
 * and with nothing the agent needs missing there), else by a person.
 */
export function setupItemDone(
  item: Pick<SetupItem, "kind" | "connector">,
  progress: SetupProgress | undefined,
  facts: SetupFacts,
): boolean {
  if (item.kind === "connect" && item.connector) {
    return facts.connected(item.connector) && connectMissing(item, facts) === null;
  }
  return progress?.done === true;
}

/** An item's label, with what is still missing on a connected connector ("Connect QuickBooks: allow create bills"). */
export function setupItemLabel(
  item: Pick<SetupItem, "kind" | "connector" | "label">,
  facts: SetupFacts,
): string {
  const missing = connectMissing(item, facts);
  if (!missing) return item.label;
  const base = item.label.replace(/[.?]$/, "");
  return `${base}: ${missing.charAt(0).toLowerCase()}${missing.slice(1)}`;
}

/** The items a stage waits on: the trial on setup and trial items; sign-off and live on all. */
export const STAGE_SETUP_GUARDS: Readonly<Record<AgentStage, readonly SetupGuard[]>> = {
  bench: [],
  trial: ["setup", "trial"],
  signoff: ["setup", "trial", "live"],
  live: ["setup", "trial", "live"],
};

/** The items not done yet that hold a move to `to`. */
export function setupHolds(
  items: readonly SetupItem[],
  progress: Readonly<Record<string, SetupProgress>> | undefined,
  facts: SetupFacts,
  to: AgentStage,
): SetupItem[] {
  const guards = STAGE_SETUP_GUARDS[to];
  return items
    .filter((i) => guards.includes(i.guards) && !setupItemDone(i, progress?.[i.id], facts))
    .map((i) => ({ ...i, label: setupItemLabel(i, facts) }));
}

/** "The setup checklist isn't done: Connect QuickBooks; Who signs new bills in QuickBooks?" */
export function setupHoldText(holds: readonly Pick<SetupItem, "label">[]): string {
  if (holds.length === 0) return "";
  const shown = holds.slice(0, 3).map((h) => h.label.replace(/[.?]$/, ""));
  const more = holds.length - shown.length;
  return `The setup checklist isn't done: ${shown.join("; ")}${more > 0 ? `; and ${more} more` : ""}.`;
}

/** The state with one item's progress recorded. */
export function withSetupProgress(
  state: StageState,
  itemId: string,
  progress: SetupProgress,
): StageState {
  return { ...state, setup: { ...(state.setup ?? {}), [itemId]: progress } };
}

// ── Answers ─────────────────────────────────────────────────────────────────────────────────────

export type SetupAnswer =
  | { ok: true; text: string; value: unknown }
  | { ok: false; reason: string };

function withinBounds(n: string, item: Pick<SetupItem, "bounds">): string | null {
  const b = item.bounds;
  if (!b) return null;
  const d = new Decimal(n);
  if (b.min !== undefined && d.lessThan(b.min)) return `It can't be less than ${b.min}.`;
  if (b.max !== undefined && d.greaterThan(b.max)) return `It can't be more than ${b.max}.`;
  return null;
}

function numberText(raw: string): string | null {
  const t = raw.replace(/[\s,$%]/g, "");
  return DECIMAL_RE.test(t) ? t : null;
}

/**
 * An answer, read for its item: words for an item that sets nothing (one of its options when it
 * has them); a value of the parameter's type, within its bounds, for one that does. Money keeps
 * the currency of the value it replaces (USD when there was none).
 */
export function readSetupAnswer(
  item: Pick<SetupItem, "setting" | "bounds">,
  raw: string,
  current?: unknown,
): SetupAnswer {
  const text = raw.trim();
  if (text.length === 0) return { ok: false, reason: "Write an answer first." };
  if (text.length > 2000) return { ok: false, reason: "Keep it under 2,000 characters." };
  const options = item.bounds?.options;
  if (options) {
    const match = options.find((o) => o.toLowerCase() === text.toLowerCase());
    if (!match) return { ok: false, reason: `Pick one of: ${options.join(", ")}.` };
    return { ok: true, text: match, value: match };
  }
  const type = item.setting?.type ?? ((item.bounds?.min ?? item.bounds?.max) ? "number" : "text");
  switch (type) {
    case "text":
      return { ok: true, text, value: text };
    case "date": {
      const ok = /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00Z`));
      return ok
        ? { ok: true, text, value: text }
        : { ok: false, reason: "Write a date such as 2026-12-24." };
    }
    case "number": {
      const n = numberText(text);
      if (n === null) return { ok: false, reason: "Write a number." };
      const out = withinBounds(n, item);
      if (out) return { ok: false, reason: out };
      return { ok: true, text: n, value: Number(n) };
    }
    case "money": {
      const code = /\b([A-Z]{3})\b/.exec(text)?.[1];
      const n = numberText(text.replace(/\b[A-Z]{3}\b/, ""));
      if (n === null) return { ok: false, reason: "Write an amount, such as 5000.00." };
      const out = withinBounds(n, item);
      if (out) return { ok: false, reason: out };
      const was =
        isPlainObject(current) && typeof current.currency === "string" ? current.currency : "USD";
      const currency = code ?? was;
      return {
        ok: true,
        text: `${new Decimal(n).toFixed(2)} ${currency}`,
        value: { amount: new Decimal(n).toFixed(2), currency },
      };
    }
  }
}

/** The value a setting has in a bundle now (the step's own, else the agent's), if any. */
export function settingValue(bundle: AnyAgentBundle, setting: SetupSetting): unknown {
  if (setting.stepId) {
    for (const w of bundle.workflows) {
      if (w.workflow.schemaVersion !== 4) continue;
      for (const { step } of allSteps(w.workflow)) {
        if (step.id === setting.stepId && step.kind === "skill") {
          return step.customize?.parameters?.[setting.parameter];
        }
      }
    }
    return undefined;
  }
  const own = bundle.definition.skills.find(
    (s) => parseSkillRef(s.skill).id === parseSkillRef(setting.skill).id,
  );
  return own?.parameters?.[setting.parameter];
}

/**
 * The bundle with a setup answer's value written into the parameter it sets: the step's own value
 * when the setting names a step, else the agent's value for the skill. Nothing else changes, so the
 * new version is a client settings change (ARCHITECTURE §10.15), never a loosening.
 */
export function applySetupSetting(
  bundle: AnyAgentBundle,
  setting: SetupSetting,
  value: unknown,
): { ok: true; bundle: AnyAgentBundle } | { ok: false; reason: string } {
  const next = cloneJson(bundle);
  if (setting.stepId) {
    for (const w of next.workflows) {
      if (w.workflow.schemaVersion !== 4) continue;
      for (const { step } of allSteps(w.workflow)) {
        if (step.id !== setting.stepId || step.kind !== "skill") continue;
        const customize = step.customize ?? {};
        step.customize = {
          ...customize,
          parameters: { ...(customize.parameters ?? {}), [setting.parameter]: value },
        };
        return { ok: true, bundle: next };
      }
    }
    return { ok: false, reason: "The step this answer sets is no longer in the agent." };
  }
  const id = parseSkillRef(setting.skill).id;
  const own = next.definition.skills.find((s) => parseSkillRef(s.skill).id === id);
  if (!own) return { ok: false, reason: "The skill this answer sets is no longer in the agent." };
  own.parameters = { ...(own.parameters ?? {}), [setting.parameter]: value };
  return { ok: true, bundle: next };
}
