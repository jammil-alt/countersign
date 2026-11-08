// P-6: the client runs it, we step in (docs/plan.md §1.68; ARCHITECTURE §4, §11). The client's team
// runs its agents day to day: approvals, questions, hand-overs and conversations go to them by
// default. The operator oversees, and may step into any open item of a client they serve, with a
// reason: approve, reject or answer it (through `resolveInboxItem`, the client's own path, so an
// external action is still approved once and executed once with its before state by the run), or
// pass it to someone of the client. The item says it was us, on the client's behalf, with the
// reason; the client's lead thread gets a line, so the person it waited on hears of it; the route
// writes the audit row (`mount`).

import type { Approver } from "@countersign/agents";
import {
  ACCOUNT_CHANGE_SUBJECT,
  clientLanguage,
  isPlainObject,
  type JsonObject,
  type ReassignTarget,
  type StepInBody,
  type SteppedIn,
  stepInLine,
} from "@countersign/core";
import { inboxItem, membership, run, type Tx, tenant } from "@countersign/db";
import { type EventRow, type EventTypeRegistry, emit } from "@countersign/senses";
import { leadThread, postMessage, senseEmitPosted } from "@countersign/threads";
import { inboxEventType } from "@countersign/workflows";
import { and, eq, inArray } from "drizzle-orm";
import { refuseGenericResolve } from "../access/release";
import { plainTitle } from "../change-display";
import { isDirectorySuggestion } from "../directory/suggestions";
import { HttpError, notFound } from "../http";
import { type InboxRow, type ResolveOutcome, resolveInboxItem, toRunResolution } from "../inbox";
import { isGoLiveItem } from "../lifecycle/stages";
import { editMessage } from "./messages";

/** The operator, stepping in: set only here, on the server (packages/agents `mayResolve`). */
export function steppingIn(userId: string): Approver {
  return { userId, role: "operator", steppingIn: true };
}

/**
 * What the portal and the back office read of a stepped-in item (`payload.steppedIn`). A decision
 * of ours counts only while it stands: an approval undone in its window opens the item again with
 * no resolution, and whoever resolves it then is the one shown.
 */
export function steppedInOf(item: Pick<InboxRow, "payload" | "resolution">): SteppedIn | null {
  const v = isPlainObject(item.payload) ? item.payload.steppedIn : undefined;
  if (!isPlainObject(v)) return null;
  const { action, reason, at } = v as Record<string, unknown>;
  if (typeof action !== "string" || typeof reason !== "string" || typeof at !== "string") {
    return null;
  }
  const decided = isPlainObject(item.resolution) && isPlainObject(item.resolution.steppedIn);
  if (action !== "reassign" && !decided) return null;
  return { action: action as SteppedIn["action"], reason, at };
}

async function lockOpenItem(tx: Tx, tenantId: string, itemId: string): Promise<InboxRow> {
  const [item] = await tx
    .select()
    .from(inboxItem)
    .where(and(eq(inboxItem.id, itemId), eq(inboxItem.tenantId, tenantId)))
    .for("update");
  if (!item) throw notFound("inbox item");
  return item;
}

/** Who a reassigned item goes to: a client role, or a person of this client who signs. */
async function assigneeFor(tx: Tx, tenantId: string, to: ReassignTarget) {
  if (to.kind === "role") return { assigneeRole: to.role, assigneeUserId: null };
  const [m] = await tx
    .select({ role: membership.role, canSign: membership.canSign })
    .from(membership)
    .where(
      and(
        eq(membership.tenantId, tenantId),
        eq(membership.userId, to.userId),
        inArray(membership.role, ["client_admin", "client_user"]),
      ),
    );
  if (!m) throw new HttpError(422, "not_a_member", "that person isn't one of this client's people");
  // A viewer is never an approver (ARCHITECTURE §4).
  if (!m.canSign) {
    throw new HttpError(422, "not_a_signer", "that person sees everything but approves nothing");
  }
  return { assigneeRole: null, assigneeUserId: to.userId };
}

export interface StepInOutcome {
  item: InboxRow;
  resume: ResolveOutcome["resume"];
}

/**
 * Steps in on one open item of a client the operator serves (the route has checked the client).
 * Refused for a request for a code (only the client's own code releases it, docs/plan.md §1.26)
 * and for a go-live sign-off (the client's own acceptance).
 */
export async function stepIn(
  tx: Tx,
  input: {
    tenantId: string;
    itemId: string;
    userId: string;
    body: StepInBody;
    registry: EventTypeRegistry;
    collect: EventRow[];
    now: Date;
  },
): Promise<StepInOutcome> {
  const { tenantId, body } = input;
  const item = await lockOpenItem(tx, tenantId, input.itemId);
  refuseGenericResolve(item);
  if (item.status !== "open") {
    throw new HttpError(409, "not_open", "this item is no longer waiting on anyone");
  }
  // DECISION: the go-live sign-off is the client's acceptance of its agent: never ours to sign
  // (docs/plan.md §1.68).
  if (isGoLiveItem(item)) {
    throw new HttpError(409, "client_sign_off", "only the client signs off an agent to go live");
  }
  // A client's request is resolved in the requests queue (as resolveInboxItem says too).
  if (item.kind === "change_request") {
    throw new HttpError(409, "use_requests", "resolve requests in the requests queue");
  }
  // DECISION: a change Sloan drafted and a directory suggestion are the client admin's by
  // design (they apply with the admin's rights), so they are never passed to someone else.
  if (
    body.action === "reassign" &&
    (item.subjectType === ACCOUNT_CHANGE_SUBJECT || isDirectorySuggestion(item))
  ) {
    throw new HttpError(409, "not_reassignable", "this one is the client admin's to decide");
  }
  const at = input.now.toISOString();
  const steppedIn: SteppedIn = { action: body.action, reason: body.reason, at };
  const by = steppingIn(input.userId);
  const before = { role: item.assigneeRole, userId: item.assigneeUserId };
  let resume: ResolveOutcome["resume"] = null;

  if (body.action === "reassign") {
    const assignee = await assigneeFor(tx, tenantId, body.to);
    const payload = (isPlainObject(item.payload) ? item.payload : {}) as JsonObject;
    const passed = Array.isArray(payload.reassigned) ? payload.reassigned : [];
    await tx
      .update(inboxItem)
      .set({
        ...assignee,
        payload: {
          ...payload,
          steppedIn,
          reassigned: [
            ...passed,
            { from: before, to: body.to, reason: body.reason, at, byUs: true },
          ] as JsonObject[],
        },
      })
      .where(and(eq(inboxItem.id, item.id), eq(inboxItem.tenantId, tenantId)));
  } else {
    if (body.action === "answer" && item.kind !== "request") {
      throw new HttpError(409, "not_a_question", "only a question takes an answer");
    }
    if (body.action === "approve" && body.message !== undefined) {
      // Edit, then approve: what is approved is exactly what is sent.
      await editMessage(tx, {
        tenantId,
        item,
        text: body.message,
        by: { userId: input.userId, byUs: true },
        now: input.now,
      });
    }
    // The client's own path: the gate, the external action's once-only approval, the undo window.
    const outcome = await resolveInboxItem(tx, {
      tenantId,
      itemId: item.id,
      by,
      body:
        body.action === "answer"
          ? { answer: body.answer }
          : {
              decision: body.action,
              ...(body.note === undefined ? {} : { note: body.note }),
            },
      registry: input.registry,
      collect: input.collect,
    });
    resume = outcome.resume;
    const resolved = outcome.item;
    const resolution = (
      isPlainObject(resolved.resolution) ? resolved.resolution : {}
    ) as JsonObject;
    const payload = (isPlainObject(resolved.payload) ? resolved.payload : {}) as JsonObject;
    await tx
      .update(inboxItem)
      .set({
        // Who stepped in stays on the operator's side; the payload says only that it was us.
        resolution: { ...resolution, steppedIn: { ...steppedIn, by: input.userId } },
        payload: { ...payload, steppedIn },
      })
      .where(and(eq(inboxItem.id, item.id), eq(inboxItem.tenantId, tenantId)));
  }

  // The person it waited on hears of it: a line in the client's lead thread, which the
  // lead-message notification carries to the client's people (ARCHITECTURE §11.3).
  if (before.role !== "operator") await tellClient(tx, input, item, body);
  const [row] = await tx
    .select()
    .from(inboxItem)
    .where(and(eq(inboxItem.id, item.id), eq(inboxItem.tenantId, tenantId)));
  if (!row) throw notFound("inbox item");
  return { item: row, resume };
}

// DECISION: the existing path that reaches the person an item waited on is the lead thread's
// notification (`lead_message`, to the client's people when a message from us is unread for ten
// minutes), so stepping in posts one line there, in the client's language, from us. Test runs'
// items are ours and skipped.
async function tellClient(
  tx: Tx,
  input: { tenantId: string; userId: string; registry: EventTypeRegistry; collect: EventRow[] },
  item: InboxRow,
  body: StepInBody,
) {
  if (item.runId) {
    const [r] = await tx.select({ mode: run.mode }).from(run).where(eq(run.id, item.runId));
    if (r?.mode === "test") return;
  }
  const [t] = await tx
    .select({ settings: tenant.settings })
    .from(tenant)
    .where(eq(tenant.id, input.tenantId));
  const locale = clientLanguage(t?.settings) ?? "en";
  const lead = await leadThread(tx, input.tenantId);
  await postMessage(
    tx,
    {
      tenantId: input.tenantId,
      thread: lead,
      senderType: "user",
      senderId: input.userId,
      kind: "text",
      body: {
        text: stepInLine(
          locale,
          body.action,
          plainTitle(item).replace(/\.$/, ""),
          body.reason,
        ).slice(0, 4000),
        steppedIn: { inboxItemId: item.id, action: body.action },
      },
      sources: [item.id],
      audience: "client",
    },
    senseEmitPosted({ registry: input.registry, collect: input.collect }),
  );
}

/**
 * Resolves an item that is not an external action without asking whose it is: the caller has
 * checked (a conversation's approver, or the operator stepping in). `withdrawn` marks an item no
 * one decided (a conversation taken over), so the run reads no rejection into it. Emits
 * `inbox.resolved` and returns the event its run waits for.
 */
export async function closeItem(
  tx: Tx,
  input: {
    tenantId: string;
    item: InboxRow;
    approved: boolean;
    withdrawn?: boolean;
    by: string;
    note: string;
    registry: EventTypeRegistry;
    collect: EventRow[];
    now: Date;
  },
): Promise<ResolveOutcome["resume"]> {
  const { item } = input;
  if (item.kind === "external_action") throw new Error("a change is resolved through the gate");
  const resolution = {
    decision: input.approved ? "approve" : "reject",
    approved: input.approved,
    answer: null,
    by: input.by,
    note: input.note,
    ...(input.withdrawn ? { withdrawn: true } : {}),
  };
  const [row] = await tx
    .update(inboxItem)
    .set({ status: "resolved", resolution, resolvedBy: input.by, resolvedAt: input.now })
    .where(
      and(
        eq(inboxItem.id, item.id),
        eq(inboxItem.tenantId, input.tenantId),
        eq(inboxItem.status, "open"),
      ),
    )
    .returning();
  if (!row) throw new HttpError(409, "not_open", "this item is no longer waiting on anyone");
  const event = await emit(
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
        approved: input.approved,
        resolvedBy: input.by,
      },
    },
    { registry: input.registry },
  );
  if (event) input.collect.push(event);
  return item.runId
    ? { runId: item.runId, type: inboxEventType(item.id), payload: toRunResolution(row) }
    : null;
}
