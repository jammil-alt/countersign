// Resolving an inbox item (ARCHITECTURE §11; docs/plan.md §1.2 "Waiting on inbox items"), shared by
// `POST /api/inbox/:id/resolve` and its /ops twin: write the resolution (an external action's
// approval goes through packages/agents), emit `inbox.resolved` in the same transaction, and tell
// the caller which run to resume, with what, once the transaction has committed.

import {
  type Approver,
  mayResolve,
  type ProceededWrite,
  proceededWriteTx,
  resolveExternalActionTx,
  resolveLateAnswerTx,
  type ToolRegistry,
} from "@countersign/agents";
import type { JsonObject, ResolveBody } from "@countersign/core";
import {
  // v0.12 W2-D
  ACCOUNT_CHANGE_SUBJECT,
  choiceProblem,
  FORBIDDEN_PORTAL_FIELD,
  isPlainObject,
  processes,
  readChoices,
  undoSecondsOf,
} from "@countersign/core";
import { inboxItem, membership, run, type Tx, tenant } from "@countersign/db";
import { type EventRow, type EventTypeRegistry, emit } from "@countersign/senses";
import { leadOf, senseEmitPosted } from "@countersign/threads";
import { type InboxResolution, inboxEventType } from "@countersign/workflows";
import { and, eq, sql } from "drizzle-orm";
import type { z } from "zod";
import { refuseGenericResolve } from "./access/release";
import { auditInTx } from "./audit";
// R7
import { conversationEventOfItem, itemWakePayload } from "./converse/wake";
import { applySuggestion, isDirectorySuggestion } from "./directory/suggestions";
import { HttpError, notFound } from "./http";
// v0.12 W1-A: go-live sign-off
import { isGoLiveItem, resolveGoLive } from "./lifecycle/stages";
import { senseEmitter } from "./runs/dispatch";
// R5: a late answer and its undo
import { type LateAnswerNote, lateTitle, type UndoOffer } from "./undo/offer";

export type InboxRow = typeof inboxItem.$inferSelect;

export interface ResolveInput {
  tenantId: string;
  itemId: string;
  by: Approver;
  body: z.output<typeof ResolveBody>;
  registry: EventTypeRegistry;
  /** Emitted events land here for dispatch after the commit. */
  collect: EventRow[];
  /**
   * R5: the platform's tools, to tell whether a write that went ahead can be taken back (its
   * `undo`). Absent: a late no is recorded and the lead told, but no undo is offered.
   */
  tools?: Pick<ToolRegistry, "get">;
}

export interface ResolveOutcome {
  item: InboxRow;
  /** The run to resume and the event to send it, or null (no run, or nothing changed). */
  resume: { runId: string; type: string; payload: InboxResolution } | null;
  // R7 (docs/plan.md §1.86)
  /**
   * A conversation's item: the event a v4 conversation step waits on, sent beside `resume` (the
   * cron re-sends both until the run takes the item, ./runs/resume.ts).
   */
  conversation?: { runId: string; type: string; payload: unknown } | null;
}

/** An event for a run, sent once the transaction commits. */
export interface RunWake {
  runId: string;
  type: string;
  payload: unknown;
}

/** Sends a resolution's events to its run: the item's own, and a conversation's beside it. */
export async function sendResolution(
  instances: { sendEvent(runId: string, event: { type: string; payload: unknown }): Promise<void> },
  outcome: { resume?: RunWake | null | undefined; conversation?: RunWake | null | undefined },
): Promise<void> {
  const { resume, conversation } = outcome;
  if (resume)
    await instances.sendEvent(resume.runId, { type: resume.type, payload: resume.payload });
  if (conversation) {
    await instances.sendEvent(conversation.runId, {
      type: conversation.type,
      payload: conversation.payload,
    });
  }
}

async function lockItem(tx: Tx, tenantId: string, itemId: string): Promise<InboxRow> {
  const [item] = await tx
    .select()
    .from(inboxItem)
    .where(and(eq(inboxItem.id, itemId), eq(inboxItem.tenantId, tenantId)))
    .for("update");
  if (!item) throw notFound("inbox item");
  return item;
}

/** What a stored resolution means to a waiting run (also read by the run's check-before-wait). */
export function toRunResolution(item: Pick<InboxRow, "resolution" | "resolvedBy">) {
  const r = (isPlainObject(item.resolution) ? item.resolution : {}) as Record<string, unknown>;
  const approved =
    typeof r.approved === "boolean"
      ? r.approved
      : r.decision === undefined
        ? null
        : r.decision === "approve";
  const by = typeof r.by === "string" ? r.by : (item.resolvedBy ?? null);
  // P-6: an item withdrawn by a take-over is no decision (docs/plan.md §1.68).
  return {
    approved,
    answer: r.answer ?? null,
    by,
    ...(r.withdrawn === true ? { withdrawn: true } : {}),
  } satisfies InboxResolution;
}

export async function resolveInboxItem(tx: Tx, input: ResolveInput): Promise<ResolveOutcome> {
  // v0.12 W1-D: a viewer signs nothing (ARCHITECTURE §4).
  input = { ...input, by: await withCanSign(tx, input.tenantId, input.by) };
  if (input.by.canSign === false) {
    throw new HttpError(
      403,
      "cannot_sign",
      "you can see this, but you don't approve for your team",
    );
  }
  const item = await lockItem(tx, input.tenantId, input.itemId);
  // A request for a code is resolved only by its code (docs/plan.md §1.26), never by a click.
  refuseGenericResolve(item);
  const { decision, answer, note } = input.body;
  if (item.kind === "change_request") {
    // A client's request is resolved in the requests queue, where its outcome and links are kept.
    throw new HttpError(409, "use_requests", "resolve requests in the requests queue");
  }
  // v0.12 W2-D: a change Sloan drafted is signed by the client admin through its own route, which
  // applies it with the portal's code (POST /api/account-changes/:id/resolve).
  if (item.subjectType === ACCOUNT_CHANGE_SUBJECT) {
    throw new HttpError(409, "use_account_change", "approve this change from its own card");
  }
  // R5: the run went ahead without this answer (a deadline's `ifNoAnswer: proceed`): the answer
  // is recorded as late, the lead is told, a late no is offered an undo, and nothing reaches the
  // run. Checked before `expired`: an item the deadline passed may still be answered late.
  const proceeded = await proceededWriteTx(tx, input.tenantId, item);
  if (proceeded) return resolveLate(tx, input, item, proceeded);
  if (item.status === "expired") {
    throw new HttpError(409, "expired", "this item expired: the run stopped waiting for it");
  }
  if (item.status === "resolved") {
    // A repeated click is fine; a different answer is not.
    const stored = toRunResolution(item);
    if (decision === undefined || stored.approved === (decision === "approve")) {
      return { item, resume: null };
    }
    throw new HttpError(409, "already_resolved", "this item was already resolved");
  }

  let testRun = false;
  if (item.runId) {
    const [r] = await tx.select({ mode: run.mode }).from(run).where(eq(run.id, item.runId));
    testRun = r?.mode === "test";
  }
  // v0.12 W1-D: a question with quick answers takes one of them (a decline needs none).
  const choices = readChoices(isPlainObject(item.payload) ? item.payload.choices : undefined);
  if (choices && item.kind === "request" && decision !== "reject") {
    const problem = choiceProblem(choices, answer);
    if (problem) throw new HttpError(422, "invalid_answer", problem);
  }
  const emitter = senseEmitter(input.registry, { collect: input.collect, testRun });

  let resolution: InboxResolution;
  if (item.kind === "external_action") {
    if (!decision) throw new HttpError(400, "invalid_request", "approve or reject this change");
    await resolveExternalActionTx(tx, {
      tenantId: input.tenantId,
      inboxItemId: item.id,
      decision,
      by: input.by,
      ...(note === undefined ? {} : { note }),
      emit: emitter,
    });
    resolution = { approved: decision === "approve", answer: null, by: input.by.userId };
  } else {
    const suggestion = isDirectorySuggestion(item);
    // DECISION: a directory suggestion is the client admin's, and the operator, who edits the
    // directory fully, may decide it too (docs/plan.md §1.27).
    const allowed = suggestion
      ? input.by.role === "client_admin" || input.by.role === "operator"
      : mayResolve(item, input.by);
    if (!allowed) {
      throw new HttpError(403, "not_assignee", "this item is assigned to someone else");
    }
    let approved: boolean;
    if (item.kind === "request") {
      // An answer counts as yes unless the person declined.
      approved = decision !== "reject";
    } else {
      if (!decision) throw new HttpError(400, "invalid_request", "approve or reject this item");
      approved = decision === "approve";
    }
    // v0.12 W1-A: the client admin's go-live sign-off moves the agent's stage in this transaction:
    // approved → live; rejected → back to trial with the reason (ARCHITECTURE §10.9).
    if (isGoLiveItem(item)) {
      await resolveGoLive(tx, {
        tenantId: input.tenantId,
        item,
        approved,
        by: { userId: input.by.userId, role: input.by.role },
        note,
        emitPosted: senseEmitPosted({ registry: input.registry, collect: input.collect, testRun }),
      });
    }
    // An accepted suggestion changes the directory in this transaction, or nothing is resolved.
    const applied =
      suggestion && approved
        ? await applySuggestion(tx, input.tenantId, item, input.by.userId)
        : null;
    const stored = {
      ...(decision === undefined ? {} : { decision }),
      approved,
      answer: answer ?? null,
      by: input.by.userId,
      ...(note === undefined ? {} : { note }),
      ...(applied ? { applied } : {}),
    };
    await tx
      .update(inboxItem)
      .set({
        status: "resolved",
        resolution: stored,
        resolvedBy: input.by.userId,
        resolvedAt: new Date(),
      })
      .where(and(eq(inboxItem.id, item.id), eq(inboxItem.tenantId, input.tenantId)));
    const row = await emit(
      tx,
      {
        tenantId: input.tenantId,
        type: "inbox.resolved",
        subjectType: "inbox_item",
        subjectId: item.id,
        payload: {
          inboxItemId: item.id,
          kind: item.kind,
          runId: item.runId,
          approved,
          resolvedBy: input.by.userId,
        },
      },
      { registry: input.registry, testRun },
    );
    if (row) input.collect.push(row);
    resolution = { approved, answer: answer ?? null, by: input.by.userId };
  }

  // v0.12 W1-D: the undo window. An approval reaches the run only once it has passed: the cron
  // delivers it (runs/resume.ts), so nothing is sent now.
  const held = await holdForUndo(tx, input.tenantId, item, resolution, testRun);
  const updated = await lockItem(tx, input.tenantId, item.id);
  const conversation = item.runId && !held ? await conversationEventOfItem(tx, item) : null;
  return {
    item: updated,
    resume:
      item.runId && !held
        ? { runId: item.runId, type: inboxEventType(item.id), payload: resolution }
        : null,
    ...(conversation && item.runId
      ? {
          conversation: {
            runId: item.runId,
            type: conversation,
            payload: itemWakePayload(item.id, resolution),
          },
        }
      : {}),
  };
}

// ── v0.12 W1-D: viewers and the undo window (ARCHITECTURE §4, §11.1) ─────────────────────────────

/** The approver with `canSign` from their membership in this client (client people only). */
export async function withCanSign(tx: Tx, tenantId: string, by: Approver): Promise<Approver> {
  if (by.role === "operator" || by.canSign !== undefined) return by;
  const [m] = await tx
    .select({ canSign: membership.canSign })
    .from(membership)
    .where(and(eq(membership.tenantId, tenantId), eq(membership.userId, by.userId)));
  return { ...by, canSign: m?.canSign ?? false };
}

/** Kinds whose approval waits out the undo window. */
const HELD_KINDS = new Set(["external_action", "approval"]);

/**
 * Sets `deliver_after` on a just-approved item of a live run when the client has an undo window.
 * Rejections, answers and test runs are delivered at once.
 */
// DECISION: the window holds approvals of changes and of approval steps in live runs, whoever
// signed (a client person, or the operator on a delegated item or in the Sandbox); test runs write
// nothing, so they get none. The clock is the database's, as in undo and delivery.
async function holdForUndo(
  tx: Tx,
  tenantId: string,
  item: InboxRow,
  resolution: InboxResolution,
  testRun: boolean,
): Promise<boolean> {
  if (!item.runId || testRun || resolution.approved !== true || !HELD_KINDS.has(item.kind)) {
    return false;
  }
  const [t] = await tx
    .select({ settings: tenant.settings })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  const seconds = undoSecondsOf(t?.settings);
  if (seconds === 0) return false;
  await tx
    .update(inboxItem)
    .set({ deliverAfter: sql`now() + make_interval(secs => ${seconds}::double precision)` })
    .where(and(eq(inboxItem.id, item.id), eq(inboxItem.tenantId, tenantId)));
  return true;
}

/** Drops every field a portal response may never carry, at any depth (invariant 11). */
export function scrubForPortal(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubForPortal);
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (FORBIDDEN_PORTAL_FIELD.test(k)) continue;
    out[k] = scrubForPortal(v);
  }
  return out;
}

// ── R5: an answer after the run went ahead (docs/plan.md §1.86, §9) ──────────────────────────────

/**
 * Resolves an item whose run went ahead without it: who answered and when go on the item and in
 * the audit log, the lead gets an item saying so, and a late no to a write that can be taken back
 * is offered an undo, to the person who said no and to the lead. Nothing is undone here, and the
 * run (which isn't waiting) is told nothing.
 */
// DECISION: the lead hears through an operator `review` item (as a write that may have happened
// does, docs/plan.md §1.22), assigned to the lead by name, else to the operator role. In a test
// run nothing was written: the answer is recorded and audited, and nobody else is told.
async function resolveLate(
  tx: Tx,
  input: ResolveInput,
  item: InboxRow,
  proceeded: ProceededWrite,
): Promise<ResolveOutcome> {
  const { decision, answer, note } = input.body;
  let approved: boolean;
  if (item.kind === "request") {
    // A question with quick answers takes one of them, late or not (a decline needs none).
    const choices = readChoices(isPlainObject(item.payload) ? item.payload.choices : undefined);
    if (choices && decision !== "reject") {
      const problem = choiceProblem(choices, answer);
      if (problem) throw new HttpError(422, "invalid_answer", problem);
    }
    approved = decision !== "reject";
  } else {
    if (!decision) throw new HttpError(400, "invalid_request", "approve or reject this item");
    approved = decision === "approve";
  }
  let testRun = false;
  if (item.runId) {
    const [r] = await tx.select({ mode: run.mode }).from(run).where(eq(run.id, item.runId));
    testRun = r?.mode === "test";
  }
  const late = await resolveLateAnswerTx(tx, {
    tenantId: input.tenantId,
    item,
    proceeded,
    decision,
    approved,
    answer,
    note,
    by: input.by,
    emit: senseEmitter(input.registry, { collect: input.collect, testRun }),
  });
  const { action } = late;
  const note_: LateAnswerNote = {
    at: late.at.toISOString(),
    by: input.by.userId,
    approved,
    actionId: action?.id ?? null,
    actionStatus: action?.status ?? null,
  };
  const lead = testRun ? null : await leadOf(tx, input.tenantId);
  const offer = testRun ? null : undoOffer(input, action, approved);
  const payload = {
    ...(isPlainObject(item.payload) ? (item.payload as JsonObject) : {}),
    lateAnswer: note_,
    ...(offer ? { undo: offer } : {}),
  } as JsonObject;
  await tx
    .update(inboxItem)
    .set({ payload })
    .where(and(eq(inboxItem.id, item.id), eq(inboxItem.tenantId, input.tenantId)));
  if (!testRun) {
    await tx.insert(inboxItem).values({
      tenantId: input.tenantId,
      kind: "review",
      agentId: item.agentId,
      subjectType: action ? "external_action" : "inbox_item",
      subjectId: action?.id ?? item.id,
      runId: item.runId,
      assigneeRole: "operator",
      assigneeUserId: lead?.userId ?? null,
      title: lateTitle(item.title),
      payload: {
        reason: approved
          ? "They said yes after we went ahead without their answer."
          : offer
            ? "They said no after we went ahead without their answer. You or they can undo the change."
            : "They said no after we went ahead without their answer, and the change can't be undone.",
        sourceItemId: item.id,
        actionId: action?.id ?? null,
        lateAnswer: note_,
        ...(offer ? { undo: offer } : {}),
      } as JsonObject,
    });
  }
  // Who answered and when, after we went ahead (invariant 14): ids only, as every audit row.
  await auditInTx(tx, null, {
    tenantId: input.tenantId,
    actorKind: "user",
    actorUserId: input.by.userId,
    actorRole: input.by.role,
    action: "inbox.answered_after_proceeding",
    outcome: "ok",
    target: {
      item: item.id,
      answer: approved ? "yes" : "no",
      ...(item.runId ? { run: item.runId } : {}),
      ...(action ? { action: action.id } : {}),
      ...(offer ? { undo: "offered" } : {}),
    },
  });
  const updated = await lockItem(tx, input.tenantId, item.id);
  return { item: updated, resume: null };
}

/** The undo a late no is offered, or null: a done write whose tool says how it is taken back. */
function undoOffer(
  input: ResolveInput,
  action: ProceededWrite["action"],
  approved: boolean,
): UndoOffer | null {
  if (approved || action?.status !== "done") return null;
  const spec = input.tools?.get(action.tool)?.spec;
  const described = spec ? processes.describeUndo(spec) : null;
  if (!described?.undoable) return null;
  return {
    actionId: action.id,
    tool: action.tool,
    text: described.text,
    for: [input.by.userId],
    lead: true,
    status: "offered",
  };
}
