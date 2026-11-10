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
import { outcomeOfRow, STEP_OUTCOMES, type StepOutcomeWord } from "../process/outcomes";
import { APPROVAL_MODES, CONFER_VERDICTS, type ConferVerdict } from "../process/schema";

// ── Durable names ───────────────────────────────────────────────────────────────────────────────

/**
 * A step_run's or an item's node id split into the step it belongs to and the check suffix after it
 * (the executor's durable names: `<id>`, `<loop>:<n>:<child>` chains, then `:confer:<n>`,
 * `:approval:<n>:a<k>`, `:signoff:a<k>`, `:notify:<n>`, `:help`, `:seen` …). Step ids never hold
 * `:`, and a loop's index is all digits, so the first segment that is neither starts the suffix.
 */
export function stepNodeOf(nodeId: string): { node: string; suffix: string[] } {
  const segs = nodeId.split(":");
  let i = 1;
  while (i + 1 < segs.length && /^\d+$/.test(segs[i] as string)) i += 2;
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

// ── Which steps the client sees ─────────────────────────────────────────────────────────────────

/** Kinds only v4 has that the client sees by default: the work, never the logic. */
const V4_SHOWN = new Set(["read", "write", "conversation", "process"]);
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
});
export type TimelineChecks = z.infer<typeof TimelineChecks>;
