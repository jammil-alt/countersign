// R8 (docs/plan.md §1.86, §9; ARCHITECTURE §10.14 "Checks", "Deadlines"): what a run's step_run
// rows and inbox items say about a step's checks, read the same way by the back office's run view
// (from the run's rows) and the portal's timeline (the server fills `TimelineStep` with it):
// - a confer is a row of its own (`<step>:confer:<n>`, nodeType `confer`): who was asked and the
//   verdict, agree / disagree / unsure / no_answer, with the note;
// - an approval is the step's items: each approver and what came of it, in the check's mode;
// - a step that went on (`proceededWithoutAnswer`) or stopped because nobody answered in time;
// - an urgent notice waiting for its "Seen".
// Pure: no database, no model text beyond what the rows hold.

import { z } from "zod";
import { isPlainObject } from "../json";
import {
  type ApprovalOutcome,
  combinedApproval,
  conferRecord,
  outcomeOfRow,
  plainError,
  STEP_OUTCOMES,
  STOP_STATUSES,
  type StepOutcomeWord,
  type StepRecord,
  type StopStatus,
  scopeOutputOfRow,
} from "../process/outcomes";
import {
  APPROVAL_MODES,
  CONFER_VERDICTS,
  type ConferVerdict,
  type Step as ProcessStep,
} from "../process/schema";
import type { Rules } from "../schemas/rules";
import { singleRef } from "../template/template";

// ── Durable names ───────────────────────────────────────────────────────────────────────────────

/**
 * A step_run's or an item's node id split into the step it belongs to and the check suffix after it
 * (the executor's durable names: `<id>`, `<loop>:<n>:<child>` chains, v0.17's
 * `<repeat>:r<pass>:<child>`, then `:confer:<n>`, `:approval:<n>:a<k>`, `:signoff:a<k>`,
 * `:notify:<n>`, `:help`, `:seen` …). Step ids never hold `:`, and a loop's index is all digits (a
 * repeat's pass `r` and digits), so the first segment that is neither starts the suffix.
 */
export function stepNodeOf(nodeId: string): { node: string; suffix: string[] } {
  const segs = nodeId.split(":");
  let i = 1;
  while (i + 1 < segs.length && /^r?\d+$/.test(segs[i] as string)) i += 2;
  return { node: segs.slice(0, i).join(":"), suffix: segs.slice(i) };
}

/** The kind of check a node id names after its step, or null for the step itself. */
export function checkKindOf(nodeId: string): string | null {
  return stepNodeOf(nodeId).suffix[0] ?? null;
}

// ── Confer ──────────────────────────────────────────────────────────────────────────────────────

export const ConferView = z.object({
  /** A second model, or a person from the client's People list. */
  reviewer: z.enum(["ai", "person"]),
  /** The person as the step names them (a role, a user id or a contact id); null for `ai`. */
  who: z.string().nullable(),
  verdict: z.enum(CONFER_VERDICTS),
  /** What they said with it; empty becomes null. */
  note: z.string().nullable(),
  /** They were away that day and were skipped. */
  away: z.boolean().optional(),
});
export type ConferView = z.infer<typeof ConferView>;

interface RowLike {
  nodeId: string;
  nodeType: string;
  status: string;
  input?: unknown;
  output?: unknown;
}

/** A confer row's reviewer and verdict, or null when the row is not a confer or has no answer yet. */
export function conferOf(row: RowLike): ConferView | null {
  if (row.nodeType !== "confer" && checkKindOf(row.nodeId) !== "confer") return null;
  const reviewer =
    isPlainObject(row.input) && typeof row.input.reviewer === "string" ? row.input.reviewer : null;
  const out = isPlainObject(row.output) ? row.output : {};
  const verdict = CONFER_VERDICTS.includes(out.verdict as ConferVerdict)
    ? (out.verdict as ConferVerdict)
    : null;
  if (!verdict) return null;
  const by = typeof out.by === "string" ? out.by : reviewer;
  const ai = by === "ai";
  const note = typeof out.note === "string" && out.note.trim() !== "" ? out.note : null;
  const away = !ai && verdict === "no_answer" && note === "away";
  return {
    reviewer: ai ? "ai" : "person",
    who: ai ? null : by,
    verdict,
    note: away ? null : note,
    ...(away ? { away: true } : {}),
  };
}

// ── No answer ───────────────────────────────────────────────────────────────────────────────────

export const NO_ANSWER_OUTCOMES = ["proceeded", "stopped"] as const;
export type NoAnswerOutcome = (typeof NO_ANSWER_OUTCOMES)[number];

/** Run error reasons the executor gives when nobody answered in time. */
const NO_ANSWER_REASONS = new Set(["timeout", "not_seen"]);

/**
 * What nobody answering did to a step: it went on (`proceededWithoutAnswer` on its output, the
 * write's approval's `ifNoAnswer: proceed`), or the run stopped there (the run's error names this
 * step, or one of its checks, with a timeout).
 */
export function noAnswerOf(row: RowLike, runError: unknown): NoAnswerOutcome | null {
  if (isPlainObject(row.output) && row.output.proceededWithoutAnswer === true) return "proceeded";
  if (!isPlainObject(runError)) return null;
  const reason = typeof runError.reason === "string" ? runError.reason : "";
  const at = typeof runError.nodeId === "string" ? runError.nodeId : null;
  if (!at || !NO_ANSWER_REASONS.has(reason)) return null;
  return at === row.nodeId || stepNodeOf(at).node === row.nodeId ? "stopped" : null;
}

// ── Approvals ───────────────────────────────────────────────────────────────────────────────────

export const APPROVER_STATES = ["waiting", "approved", "rejected", "no_answer"] as const;

export const ApproverView = z.object({
  itemId: z.string(),
  /** Who was asked: a role, or a person by id (the screens name them). */
  role: z.string().nullable(),
  userId: z.string().nullable(),
  /** Their name where the server knows it; null otherwise. */
  name: z.string().nullable().optional(),
  state: z.enum(APPROVER_STATES),
  /** When they answered, or when the asking ran out. */
  at: z.string().nullable(),
});
export type ApproverView = z.infer<typeof ApproverView>;

export const ApprovalView = z.object({
  mode: z.enum(APPROVAL_MODES),
  approvers: z.array(ApproverView),
});
export type ApprovalView = z.infer<typeof ApprovalView>;

interface ItemLike {
  id: string;
  kind: string;
  status: string;
  payload: Record<string, unknown>;
  resolution?: unknown;
  assigneeRole?: string | null;
  assigneeUserId?: string | null;
  resolvedAt?: string | null;
  /** Who resolved it (the column), where the resolution names nobody. */
  resolvedBy?: string | null;
  createdAt: string;
}

/** Inbox kinds that ask a person to sign or answer on a step's behalf. */
const ASKING = new Set(["approval", "external_action"]);

/** Whether an item asks for approval on this step row (its node id, or the gate's step id). */
export function itemOfStep(item: ItemLike, row: Pick<RowLike, "nodeId">): boolean {
  if (!ASKING.has(item.kind)) return false;
  const nodeId = typeof item.payload.nodeId === "string" ? item.payload.nodeId : null;
  if (nodeId) {
    const { node, suffix } = stepNodeOf(nodeId);
    // A confer's ask belongs to its confer row, not the step's approval.
    return node === row.nodeId && suffix[0] !== "confer";
  }
  const stepId = typeof item.payload.stepId === "string" ? item.payload.stepId : null;
  return stepId !== null && stepNodeOf(row.nodeId).node.split(":").at(-1) === stepId;
}

/** An item's answer: approved, rejected, nobody answered, or still waiting. */
export function approverState(item: ItemLike): (typeof APPROVER_STATES)[number] {
  if (item.status === "open") return "waiting";
  if (item.status === "expired") return "no_answer";
  const r = isPlainObject(item.resolution) ? item.resolution : {};
  if (r.approved === false || r.decision === "reject") return "rejected";
  return "approved";
}

/** The approvers of one step row, in the order they were asked, with the check's mode. */
export function approvalOf(
  row: Pick<RowLike, "nodeId">,
  items: readonly ItemLike[],
  mode: (typeof APPROVAL_MODES)[number] = "in_turn",
): ApprovalView | null {
  const mine = items
    .filter((i) => itemOfStep(i, row))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (mine.length === 0) return null;
  return {
    mode,
    approvers: mine.map((i) => ({
      itemId: i.id,
      role: i.assigneeRole ?? null,
      userId: i.assigneeUserId ?? null,
      state: approverState(i),
      at: i.resolvedAt ?? null,
    })),
  };
}

// ── Urgent notices ──────────────────────────────────────────────────────────────────────────────

export const UrgentView = z.object({
  /** Until when a "Seen" is due. */
  dueAt: z.string().nullable(),
  state: z.enum(["waiting", "seen", "not_seen"]),
  seenAt: z.string().nullable(),
});
export type UrgentView = z.infer<typeof UrgentView>;

/**
 * An urgent notice's "Seen": from the notify row's output (`urgent.dueAt`, `ackItemId`) or the
 * item it sent that waits for a Seen (`payload.urgent`, on the row's node). Null for a notice that
 * isn't urgent.
 */
// DECISION: both places are read, since the notify port (R3) names the item it made for the "Seen"
// but the step log doesn't store it yet; whichever holds it, the timeline reads the same.
export function urgentOf(row: RowLike, items: readonly ItemLike[]): UrgentView | null {
  if (row.nodeType !== "notify") return null;
  const out = isPlainObject(row.output) ? row.output : {};
  const urgentOut = isPlainObject(out.urgent) ? out.urgent : null;
  const ackId = typeof out.ackItemId === "string" ? out.ackItemId : null;
  const onRow = (nodeId: unknown) =>
    typeof nodeId === "string" && (nodeId === row.nodeId || nodeId.startsWith(`${row.nodeId}:`));
  const item = items.find(
    (i) => i.id === ackId || (isPlainObject(i.payload.urgent) && onRow(i.payload.nodeId)),
  );
  const itemUrgent = item && isPlainObject(item.payload.urgent) ? item.payload.urgent : null;
  if (!urgentOut && !itemUrgent && !ackId) return null;
  const due =
    (typeof urgentOut?.dueAt === "string" ? urgentOut.dueAt : null) ??
    (typeof itemUrgent?.dueAt === "string" ? itemUrgent.dueAt : null) ??
    item?.payload.dueAt ??
    null;
  const state: UrgentView["state"] = !item
    ? "waiting"
    : item.status === "resolved"
      ? "seen"
      : item.status === "expired"
        ? "not_seen"
        : "waiting";
  return {
    dueAt: typeof due === "string" ? due : null,
    state,
    seenAt: state === "seen" ? (item?.resolvedAt ?? null) : null,
  };
}

// ── How the step ended (wave 5) ─────────────────────────────────────────────────────────────────

/** Every outcome word of every kind (`processes.STEP_OUTCOMES`), for the views' schemas. */
export const OUTCOME_WORDS = [
  ...new Set(Object.values(STEP_OUTCOMES).flat()),
] as unknown as readonly [StepOutcomeWord, ...StepOutcomeWord[]];

/**
 * How a step's row ended, in the outcome words a later `if` routes on (`steps.<id>.outcome`): read
 * from the row as the executor left it, its approvers' answers and an urgent notice's "Seen". Null
 * for a check's own row (`<step>:confer:<n>`…), a step still under way, or a kind with no outcome.
 */
// DECISION (wave 5): the run view derives the outcome from what the rows and items already hold
// (`processes.outcomeOfRow`), so no column or migration is added; the executor's record and this
// read agree by construction (tested in packages/workflows).
export function outcomeOfStepRow(
  row: RowLike & { error?: string | null },
  items: readonly ItemLike[],
): StepOutcomeWord | null {
  if (checkKindOf(row.nodeId)) return null;
  const approval = approvalOf(row, items);
  const urgent = urgentOf(row, items);
  return outcomeOfRow({
    kind: row.nodeType,
    status: row.status,
    output: row.output,
    ...(row.error !== undefined ? { error: row.error } : {}),
    approvers: approval?.approvers.map((a) => a.state) ?? [],
    urgent: urgent?.state ?? null,
  });
}

// ── The route an if took (wave 5, web) ──────────────────────────────────────────────────────────

/**
 * Which path an `if` took and the earlier steps' outcomes its rules matched on ("Took the route
 * 'Rejected': Approve the bill was rejected"). `path` is null when no path matched (otherwise).
 * `because` holds only the `steps.<id>.outcome` rules that held, each step by the label the reader
 * may see: a rule over data, or over a step the reader doesn't see, adds nothing.
 */
export const RouteView = z.object({
  path: z.string().nullable(),
  because: z.array(z.object({ label: z.string(), outcome: z.enum(OUTCOME_WORDS) })),
});
export type RouteView = z.infer<typeof RouteView>;

interface IfLike {
  id: string;
  kind: string;
  paths?: readonly { id: string; name: string; when: Rules }[];
}

/** `{{steps.<id>.outcome}}` → the step id, else null. */
function outcomeRefOf(field: string): string | null {
  let path: string[] | null;
  try {
    path = singleRef(field);
  } catch {
    return null;
  }
  return path && path.length === 3 && path[0] === "steps" && path[2] === "outcome"
    ? (path[1] as string)
    : null;
}

/** Whether a rule `=`, `is` or `in` holds for the outcome word (other operators explain nothing). */
function ruleHolds(op: string, value: unknown, outcome: string): boolean {
  if (op === "=" || op === "is") return value === outcome;
  if (op === "in") return Array.isArray(value) && value.includes(outcome);
  return false;
}

/**
 * The route an `if`'s row took (its output's `pathId`), and why in outcome words: for each rule of
 * the taken path on an earlier step's `outcome` that held, that step's label (`labelOf`; null
 * leaves it out) and outcome (`outcomeAt`, by node id: a step in the same loop item reads that
 * item's row). Null for a row that isn't an ended `if`'s.
 */
// DECISION (wave 5, web): the "why" names outcome rules only, words a reader can follow; a rule over
// a field of the data shows the path's name alone, never the field or its value.
export function routeOfRow(
  step: IfLike,
  row: { nodeId: string; output?: unknown },
  outcomeAt: (nodeId: string) => StepOutcomeWord | null | undefined,
  labelOf: (stepId: string) => string | null | undefined,
): RouteView | null {
  if (step.kind !== "if") return null;
  if (!isPlainObject(row.output) || typeof row.output.pathId !== "string") return null;
  const pathId = row.output.pathId;
  const taken = step.paths?.find((p) => p.id === pathId);
  if (!taken) return { path: null, because: [] };
  const { node } = stepNodeOf(row.nodeId);
  const prefix = node.endsWith(step.id) ? node.slice(0, node.length - step.id.length) : "";
  const because: RouteView["because"] = [];
  for (const rule of taken.when.rules) {
    const id = outcomeRefOf(rule.field);
    if (!id) continue;
    const outcome = outcomeAt(`${prefix}${id}`) ?? (prefix ? outcomeAt(id) : null);
    if (!outcome || !ruleHolds(rule.op, rule.value, outcome)) continue;
    const label = labelOf(id);
    if (label && !because.some((b) => b.label === label && b.outcome === outcome)) {
      because.push({ label, outcome });
    }
  }
  return { path: taken.name, because };
}

/** The outcomes of a failure that a step's `onError: continue` went on past. */
const CARRIED_ON = new Set<string>([
  "failed",
  "needs_help",
  "some_failed",
  "all_failed",
  "stopped",
]);

/**
 * Whether a step failed and the run carried on past it (`onError: continue`): the run views say
 * so, in risk, rather than reading it as the run's failure.
 */
export function carriedOn(
  step: { onError?: string | undefined } | undefined,
  outcome: string | null | undefined,
): boolean {
  return step?.onError === "continue" && !!outcome && CARRIED_ON.has(outcome);
}

// ── Which steps the client sees ─────────────────────────────────────────────────────────────────

/** Kinds only v4 has that the client sees by default: the work, never the logic. */
// Hand off (2026-11-11): "Handed off to Price checker" is work the client sees too.
const V4_SHOWN = new Set(["read", "write", "conversation", "process", "handoff"]);
/** Kinds both schemas share that the client sees by default (v3's `isClientVisible`). */
const SHOWN = new Set(["skill", "action", "person", "notify", "use_automation"]);

/**
 * Whether the client's timeline shows a step, v3 or v4: its `client` setting, else its kind (the
 * work and the people; logic never). The back office marks the others "hidden from client".
 */
// DECISION: a v4 `read` shows by default, as the tool-mode skill it replaces did (R2 turned 85
// skills into reads and writes; their steps stay on the timeline the client already knew).
export function shownOnTimeline(step: {
  kind: string;
  client?: { visible: boolean } | undefined;
}): boolean {
  if (step.client) return step.client.visible;
  return V4_SHOWN.has(step.kind) || SHOWN.has(step.kind);
}

// ── The timeline's fields ───────────────────────────────────────────────────────────────────────

/** What the portal's timeline adds to a step for its checks (all optional: v3 runs have none). */
export const TimelineChecks = z.object({
  confer: ConferView.extend({
    /** The person's name where the client knows them; null for `ai` or someone not found. */
    name: z.string().nullable(),
  }).optional(),
  noAnswer: z.enum(NO_ANSWER_OUTCOMES).optional(),
  approval: ApprovalView.optional(),
  urgent: UrgentView.optional(),
  // Wave 5: how the step ended (`outcomeOfStepRow`), the word a later `if` routes on.
  outcome: z.enum(OUTCOME_WORDS).optional(),
  // Wave 5 (web): an `if`'s route and why (`routeOfRow`); a failure the run carried on past.
  route: RouteView.optional(),
  carriedOn: z.literal(true).optional(),
});
export type TimelineChecks = z.infer<typeof TimelineChecks>;

// ── A retry's reused step (wave 5 review) ───────────────────────────────────────────────────────

const RECORD_WORK_KINDS = new Set(["read", "skill", "write"]);

/** A node id with regex characters escaped, for matching its check rows. */
const escapeId = (id: string) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** An item's resolution as the run took it (apps/api `toRunResolution`): approved, and by whom. */
function resolutionOf(item: ItemLike): {
  approved: boolean;
  by: string | null;
  withdrawn: boolean;
} {
  const r = isPlainObject(item.resolution) ? item.resolution : {};
  const approved =
    typeof r.approved === "boolean"
      ? r.approved
      : r.decision === undefined || r.decision === "approve";
  const by = typeof r.by === "string" ? r.by : (item.resolvedBy ?? null);
  return { approved, by, withdrawn: r.withdrawn === true };
}

/** An item an escalation asked (`…:esc<d>`). */
const escalated = (i: ItemLike) =>
  typeof i.payload.nodeId === "string" && /:esc\d+$/.test(i.payload.nodeId);

/**
 * What one asking (a proposal's approval, or the sign-off) came to, from its items, as the
 * executor's approval engine decided it: a no ends it (`rejected`); `all` needs every approver
 * asked to say yes, `in_turn` and `any` the first yes (`approved`, by who signed); an escalation's
 * answer decides; nobody answering is `no_answer`. Null while nothing is decided (open, withdrawn).
 */
function askingDecision(
  items: readonly ItemLike[],
  mode: string,
): { outcome: ApprovalOutcome; by?: string | null } | null {
  const decided = items
    .filter((i) => i.status === "resolved" && !resolutionOf(i).withdrawn)
    .sort((a, b) => (a.resolvedAt ?? "").localeCompare(b.resolvedAt ?? ""));
  const no = decided.find((i) => !resolutionOf(i).approved);
  if (no) return { outcome: "rejected", by: resolutionOf(no).by };
  const yes = decided.filter((i) => resolutionOf(i).approved);
  const last = yes.at(-1);
  if (last) {
    const everyone =
      mode !== "all" ||
      yes.some(escalated) ||
      items.filter((i) => !escalated(i)).every((i) => yes.includes(i));
    return everyone ? { outcome: "approved", by: resolutionOf(last).by } : { outcome: "no_answer" };
  }
  if (items.some((i) => i.status === "expired")) return { outcome: "no_answer" };
  return null;
}

/**
 * A step's `steps.<id>.approval` read back from its items: one decision per asking (each
 * proposal's approval, `<node>:approval:<n>`, and the sign-off, `<node>:signoff`), combined as
 * the executor combines them (`combinedApproval`).
 */
// DECISION (wave 5 review): the gate's own item names the step (`payload.stepId`), not its asking;
// the gate makes one per proposal, in order, so the n-th is proposal n's first approver. The
// approvers asked after it name `<node>:approval:<n>:a<k>`, an escalation `…:esc<d>`, the
// sign-off's `<node>:signoff:a<k>`. A write that went ahead with nobody's answer (`proceed`) reads
// `no_answer`, its items having expired, as the run recorded it.
export function approvalOfStoredStep(
  row: Pick<RowLike, "nodeId">,
  items: readonly ItemLike[],
  mode = "in_turn",
): { outcome: ApprovalOutcome; by?: string | null } {
  const mine = items
    .filter((i) => itemOfStep(i, row))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const groups = new Map<string, ItemLike[]>();
  let gate = 0;
  for (const i of mine) {
    const nodeId = typeof i.payload.nodeId === "string" ? i.payload.nodeId : null;
    if (!nodeId) gate += 1;
    const key = nodeId ? approvalKeyOf(nodeId) : `${row.nodeId}:approval:${gate}`;
    groups.set(key, [...(groups.get(key) ?? []), i]);
  }
  const decisions = [...groups.values()]
    .map((g) => askingDecision(g, mode))
    .filter((d): d is NonNullable<typeof d> => d !== null);
  return combinedApproval(decisions);
}

/**
 * A step's confer read back from its rows (`<node>:confer:<k>`, or a skill's later proposal's
 * `<node>:approval:<n>:confer:<k>`): the latest confer, as the run's record held it. Null when
 * nobody was asked.
 */
export function conferOfStoredStep(
  nodeId: string,
  rows: readonly RowLike[],
): Record<string, unknown> | null {
  const pattern = new RegExp(`^${escapeId(nodeId)}(?::approval:(\\d+))?:confer:(\\d+)$`);
  let latest = -1;
  const byAsking = new Map<number, ({ verdict: ConferVerdict; by: string } | null)[]>();
  for (const r of rows) {
    const m = pattern.exec(r.nodeId);
    if (!m) continue;
    const out = isPlainObject(r.output) ? r.output : {};
    const verdict = CONFER_VERDICTS.includes(out.verdict as ConferVerdict)
      ? (out.verdict as ConferVerdict)
      : null;
    if (!verdict) continue;
    const asking = m[1] ? Number(m[1]) : 0;
    const place = Number(m[2]);
    const reviewer =
      isPlainObject(r.input) && typeof r.input.reviewer === "string" ? r.input.reviewer : "";
    const entries = byAsking.get(asking) ?? [];
    while (entries.length <= place) entries.push(null);
    entries[place] = { verdict, by: typeof out.by === "string" ? out.by : reviewer };
    byAsking.set(asking, entries);
    latest = Math.max(latest, asking);
  }
  const entries = byAsking.get(latest);
  return entries ? conferRecord(entries) : null;
}

/** What `recordOfStoredStep` reads of the stored step. */
export interface StoredStepLike {
  kind: string;
  onError?: ProcessStep["onError"];
  checks?: { approval?: { mode?: string | undefined } | undefined } | undefined;
  choices?: readonly { value: string }[] | undefined;
}

/**
 * How a step a retry reuses ended, rebuilt from the run retried's rows and inbox items as the run
 * recorded it in `steps.<id>` (`processes.StepRecord`): the outcome, a read's, skill's or write's
 * approval and confer, a person's quick answer, a loop's counts, and a failure the run carried on
 * past (`onError: continue`) with its plain error. A later `if` in the retry routes on it as the
 * run retried did.
 */
// DECISION (wave 5 review): rebuilt from what the rows and items already hold (no column, no
// migration), the reading the run views use; its agreement with the executor's own record is
// tested kind by kind in packages/workflows (forks.test.ts).
export function recordOfStoredStep(
  step: StoredStepLike,
  row: RowLike,
  rows: readonly RowLike[],
  items: readonly ItemLike[],
): StepRecord {
  const out = isPlainObject(row.output) ? row.output : {};
  const error = typeof out.error === "string" ? out.error : null;
  const outcome = outcomeOfStepRow({ ...row, error }, items);
  const rec: StepRecord = outcome ? { outcome } : {};
  if (RECORD_WORK_KINDS.has(step.kind)) {
    rec.approval = approvalOfStoredStep(row, items, step.checks?.approval?.mode ?? "in_turn");
    const confer = conferOfStoredStep(row.nodeId, rows);
    if (confer) rec.confer = confer;
  }
  const answer = out.answer;
  if (step.kind === "person" && typeof answer === "string") {
    if (step.choices?.some((c) => c.value === answer)) rec.choice = answer;
  }
  if (step.kind === "for_each" && outcome) {
    const count = typeof out.count === "number" ? out.count : 0;
    rec.counts = { items: count, failed: typeof out.failed === "number" ? out.failed : 0 };
  }
  if (step.kind === "process" && outcome === "stopped") {
    // DECISION (wave 5, fix 3): read from the process's own row first (`{ stopStatus }`, which a
    // retry copies, so a retry of a retry keeps it), then from the stop rows inside it for runs
    // stored before the row kept it.
    const own = STOP_STATUSES.includes(out.stopStatus as StopStatus)
      ? (out.stopStatus as StopStatus)
      : null;
    const stopStatus = own ?? stopStatusOf(row.nodeId, rows);
    if (stopStatus) rec.stopStatus = stopStatus;
  }
  if (step.onError === "continue" && row.status === "failed" && outcome) {
    rec.error = plainError(error ?? "", outcome === "needs_help" ? "needs_help" : undefined);
  }
  return rec;
}

/**
 * How the stop that ended a stopped process would have ended the run, for a run stored before the
 * process's own row kept it: the last stop row inside it (`<process>/…`), whose output keeps its
 * status. Null for a run stored before stop rows kept it.
 */
function stopStatusOf(processNode: string, rows: readonly RowLike[]): StopStatus | null {
  const stop = rows
    .filter((r) => r.nodeType === "stop" && r.nodeId.startsWith(`${processNode}/`))
    .at(-1);
  const status = stop && isPlainObject(stop.output) ? stop.output.status : undefined;
  return STOP_STATUSES.includes(status as StopStatus) ? (status as StopStatus) : null;
}

/** A step a retry reuses: its row as stored, and its record (`recordOfStoredStep`). */
export interface ReusedStep {
  status: "succeeded" | "skipped" | "failed";
  /** The row's output as stored, for the retry's copy of the row. */
  output: unknown;
  /** What later steps read as `steps.<id>.output`, as the run retried recorded it. */
  stepOutput: unknown;
  record: StepRecord;
}

/**
 * What a later step read as a stored step's output: the row's output, except a failed row's,
 * whose error the step log merged into it (that error is the record's), and a read's or skill's
 * output turned down at its sign-off, which the run never let later steps read (null). A stopped
 * process's reads as null too (its row keeps only `{ stopStatus }`).
 */
function stepOutputOf(row: RowLike, items: readonly ItemLike[], kind: string): unknown {
  if (row.status === "skipped" && RECORD_WORK_KINDS.has(row.nodeType)) {
    const signOff = `${row.nodeId}:signoff`;
    const signed = items.some(
      (i) =>
        itemOfStep(i, row) &&
        typeof i.payload.nodeId === "string" &&
        (i.payload.nodeId === signOff || i.payload.nodeId.startsWith(`${signOff}:`)),
    );
    if (signed) return null;
  }
  return scopeOutputOfRow(row.status, row.output, kind);
}

/**
 * Whether a retry reuses a step before the one it runs from, and as what: one that succeeded or
 * was skipped, and one that failed and the run carried on past (`onError: continue`), which must
 * not run again (its write failed and was decided; the run took its route). Null: run it again.
 */
// DECISION (wave 5 review): a failed row is reused only when its stored step carries on past a
// failure: a run that failed at a step ends there, so any failed row before the retry's step is
// one the run went on past.
export function reusedStepOf(
  step: StoredStepLike,
  row: RowLike,
  rows: readonly RowLike[],
  items: readonly ItemLike[],
): ReusedStep | null {
  const status = row.status;
  const reusable =
    status === "failed"
      ? step.onError === "continue"
      : status === "succeeded" || status === "skipped";
  if (!reusable) return null;
  return {
    status: status as ReusedStep["status"],
    output: row.output ?? null,
    stepOutput: stepOutputOf(row, items, step.kind),
    record: recordOfStoredStep(step, row, rows, items),
  };
}

/**
 * An approval item's node without its escalation and approver suffixes (`…:esc1:esc2`, `…:a3`),
 * by segments rather than one pattern, so a long node id can't make the match slow.
 */
function approvalKeyOf(nodeId: string): string {
  const parts = nodeId.split(":");
  while (parts.length > 1 && /^esc\d+$/.test(parts[parts.length - 1] ?? "")) parts.pop();
  if (parts.length > 1 && /^a\d+$/.test(parts[parts.length - 1] ?? "")) parts.pop();
  return parts.join(":");
}
