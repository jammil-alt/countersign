// P-6: a person takes a live conversation over, or ends it (docs/plan.md §1.68; ARCHITECTURE
// §10.12). From the back office's run page the operator may, with a reason; from the portal, the
// conversation's approver (the client's team by default). Taking over: the agent sends nothing
// more, the message waiting (for a reply or for approval) is ended, and the step hands over to that
// person, who answers with the result as with any hand-over. Ending: the step's onReject. Both are
// written on the conversation's last message row (its transcript), in the request's transaction,
// with no model call; the run is woken by the event it already waits for.

import { type Approver, approvalRoutingTx, mayResolve } from "@countersign/agents";
import {
  type Approval,
  type ConversationAction,
  type ConverseChannel,
  findNodeStep,
  type OwnerWatchedStep,
  ownerStepApproval,
  ownerWatches,
  parseDuration,
} from "@countersign/core";
import { agentVersion, inboxItem, reachOut, run, stepRun, type Tx } from "@countersign/db";
import type { EventRow, EventTypeRegistry } from "@countersign/senses";
import { and, asc, eq, like } from "drizzle-orm";
import { HttpError, notFound } from "../http";
import { type RunWake, withCanSign } from "../inbox";
import { endReachOut, type ReachOutRow, reachOutEventType } from "../reach/service";
import { closeItem } from "../step-in/service";
import {
  conversationRoute,
  handoverItemValues,
  json,
  metaOf,
  type planOf,
  setupOf,
  withHandover,
} from "./service";
import { ENDED, type StoredEvent, TAKEN_OVER } from "./views";
import { conversationEventOfSubject } from "./wake";

type RunRow = typeof run.$inferSelect;

/** A conversation's message rows, in turn order, found by the step run it started in. */
async function conversationRows(
  tx: Tx,
  tenantId: string,
  runId: string,
  stepRunId: string,
  lock: boolean,
): Promise<ReachOutRow[] | null> {
  const q = tx
    .select()
    .from(reachOut)
    .where(
      and(
        eq(reachOut.tenantId, tenantId),
        eq(reachOut.runId, runId),
        like(reachOut.subject, `converse:${runId}:%`),
      ),
    )
    .orderBy(asc(reachOut.createdAt));
  const rows = lock ? await q.for("update") : await q;
  const bySubject = new Map<string, ReachOutRow[]>();
  for (const r of rows) bySubject.set(r.subject, [...(bySubject.get(r.subject) ?? []), r]);
  for (const list of bySubject.values()) {
    list.sort((a, b) => metaOf(a).turn - metaOf(b).turn);
    if (list[0]?.stepRunId === stepRunId && metaOf(list[0]).setup) return list;
  }
  return null;
}

/**
 * The conversation step's approval as the run's version has it (for its approver and its
 * timeout), and the step run's node. Wave 3c: a v3 skill's `approval` or a v4 step's
 * `checks.approval` (its first approver), read by core's rule for both, as the Desk reads it.
 */
async function stepOf(
  tx: Tx,
  r: RunRow,
  stepRunId: string,
): Promise<{ approval: Approval | undefined; nodeId: string | null }> {
  const [s] = await tx
    .select({ nodeId: stepRun.nodeId })
    .from(stepRun)
    .where(and(eq(stepRun.id, stepRunId), eq(stepRun.tenantId, r.tenantId)));
  const [v] = await tx
    .select({ bundle: agentVersion.bundle })
    .from(agentVersion)
    .where(and(eq(agentVersion.id, r.agentVersionId), eq(agentVersion.tenantId, r.tenantId)));
  const wf = v?.bundle.workflows.find((w) => w.slug === r.workflowSlug)?.workflow;
  // Inside a for_each the node is `<step>:<index>:<child>`: findNodeStep reads its last part.
  const step = wf && s ? findNodeStep(wf, s.nodeId) : undefined;
  const approval =
    step && ownerWatches(step) ? ownerStepApproval(step as OwnerWatchedStep) : undefined;
  return { approval, nodeId: s?.nodeId ?? null };
}

/**
 * Whether this person may take the conversation over or end it: the operator stepping in, or a
 * client person who approves this conversation (as its approval would be routed now).
 */
async function mayControlRows(
  tx: Tx,
  r: RunRow,
  stepRunId: string,
  rows: ReachOutRow[],
  by: Approver,
): Promise<boolean> {
  if (by.role === "operator") return by.steppingIn === true;
  const who = await withCanSign(tx, r.tenantId, by);
  if (who.canSign === false) return false;
  const setup = setupOf(rows);
  const { approval } = await stepOf(tx, r, stepRunId);
  const { assignee } = await conversationRoute(
    tx,
    await approvalRoutingTx(tx, r.tenantId),
    r,
    setup.input.channel as ConverseChannel,
    approval?.approver,
  );
  return mayResolve(assignee, who);
}

/** For the portal's run page: whether this person may take this live conversation over. */
export async function mayControlConversation(
  tx: Tx,
  tenantId: string,
  runId: string,
  stepRunId: string,
  by: Approver,
): Promise<boolean> {
  const [r] = await tx
    .select()
    .from(run)
    .where(and(eq(run.id, runId), eq(run.tenantId, tenantId)));
  if (r?.mode !== "live") return false;
  const rows = await conversationRows(tx, tenantId, runId, stepRunId, false);
  if (!rows) return false;
  const last = rows.at(-1) as ReachOutRow;
  if (metaOf(last).end) return false;
  return mayControlRows(tx, r, stepRunId, rows, by);
}

export interface ControlInput {
  tenantId: string;
  runId: string;
  stepRunId: string;
  action: ConversationAction;
  /** The operator stepping in (`steppingIn`), or a client person. */
  by: Approver;
  reason: string | null;
  registry: EventTypeRegistry;
  collect: EventRow[];
  now: Date;
}

/**
 * The events to send the run once the transaction commits, if it waits for one: the item's or the
 * message's own (`resume`), and (wave 2c) the conversation's beside it (`sendResolution`).
 */
export interface ControlOutcome {
  resume: RunWake | null;
  conversation: RunWake | null;
}

export async function controlConversation(tx: Tx, input: ControlInput): Promise<ControlOutcome> {
  const { tenantId, by, now } = input;
  const [r] = await tx
    .select()
    .from(run)
    .where(and(eq(run.id, input.runId), eq(run.tenantId, tenantId)));
  if (!r) throw notFound("run");
  if (r.mode !== "live") {
    // Test runs are hidden from the portal (ARCHITECTURE §10.4).
    if (by.role !== "operator") throw notFound("run");
    throw new HttpError(409, "test_run", "a test run sends nothing: there is nothing to take over");
  }
  const rows = await conversationRows(tx, tenantId, r.id, input.stepRunId, true);
  if (!rows) throw notFound("conversation");
  if (!(await mayControlRows(tx, r, input.stepRunId, rows, by))) {
    throw new HttpError(
      403,
      "not_approver",
      "only whoever approves this conversation can take it over or end it",
    );
  }
  const last = rows.at(-1) as ReachOutRow;
  const meta = metaOf(last);
  if (meta.end) throw new HttpError(409, "ended", "this conversation has already ended");

  const byUs = by.role === "operator";
  const event: StoredEvent = {
    kind: input.action === "take_over" ? "taken_over" : "ended",
    at: now.toISOString(),
    by: by.userId,
    byUs,
    reason: input.reason,
  };
  const why = input.reason ? `: ${input.reason}` : "";
  const ending =
    input.action === "take_over"
      ? `${TAKEN_OVER}${byUs ? " by Mezonas" : ""}${why}`
      : `${ENDED} ${byUs ? "Mezonas" : "the client"}${why}`;
  // Taken over: the hand-over item goes to that person (the operator's own item when it is us).
  const assignee = byUs
    ? { assigneeRole: "operator" as const, assigneeUserId: by.userId }
    : { assigneeRole: null, assigneeUserId: by.userId };
  const withEvent = (plan: Record<string, unknown>) => {
    const p = plan as unknown as ReturnType<typeof planOf>;
    return json({
      ...p,
      converse: { ...p.converse, events: [...(p.converse.events ?? []), event] },
    });
  };
  const savePlan = (row: ReachOutRow, plan: Record<string, unknown>) =>
    tx
      .update(reachOut)
      .set({ plan })
      .where(and(eq(reachOut.id, row.id), eq(reachOut.tenantId, tenantId)));
  const openItem = async (id: string) => {
    const [item] = await tx
      .select()
      .from(inboxItem)
      .where(and(eq(inboxItem.id, id), eq(inboxItem.tenantId, tenantId)))
      .for("update");
    if (item?.status !== "open") {
      throw new HttpError(409, "busy", "someone just answered this: look again in a moment");
    }
    return item;
  };
  const close = (item: typeof inboxItem.$inferSelect, approved: boolean, withdrawn = false) =>
    closeItem(tx, {
      tenantId,
      item,
      approved,
      withdrawn,
      by: by.userId,
      note: ending,
      registry: input.registry,
      collect: input.collect,
      now,
    });
  const handOverTo = async (row: ReachOutRow) => {
    const { approval, nodeId } = await stepOf(tx, r, input.stepRunId);
    const timeout = approval?.timeout ?? "7 days";
    const [item] = await tx
      .insert(inboxItem)
      .values(
        handoverItemValues({
          info: r,
          nodeId: nodeId ?? meta.key,
          key: meta.key,
          rows,
          reason: ending,
          proposed: meta.proposed ?? null,
          assignee,
          dueAt: new Date(now.getTime() + parseDuration(timeout)),
          title: `Finish the conversation with ${setupOf(rows).contactName} yourself`,
        }),
      )
      .returning({ id: inboxItem.id });
    if (!item) throw new Error("inbox item insert returned nothing");
    await savePlan(row, withEvent(withHandover(row, item.id, ending)));
  };

  // Already with a person (a limit handed it over): take it, or end it.
  if (meta.handover) {
    const item = await openItem(meta.handover.inboxItemId);
    await savePlan(last, withEvent(last.plan));
    if (input.action === "take_over") {
      await tx
        .update(inboxItem)
        .set(assignee)
        .where(and(eq(inboxItem.id, item.id), eq(inboxItem.tenantId, tenantId)));
      return { resume: null, conversation: null };
    }
    return close(item, false);
  }

  // A message waiting for approval: it never goes. Taken over, its card is withdrawn (no one
  // decided it) and the step waits on the person; ended, its card is declined (the onReject).
  if (last.status === "awaiting_approval" && last.inboxItemId) {
    const item = await openItem(last.inboxItemId);
    const ended = await endReachOut(tx, last, { outcome: "declined", reason: ending }, now);
    if (!ended) throw new HttpError(409, "busy", "the conversation just moved on: look again");
    if (input.action === "take_over") await handOverTo(ended);
    else await savePlan(ended, withEvent(ended.plan));
    return close(item, false, input.action === "take_over");
  }

  // A message out (or held for quiet hours): its wait ends now; a late reply is kept in the
  // person's thread like any text.
  if (last.status === "open") {
    const ended = await endReachOut(tx, last, { outcome: "declined", reason: ending }, now);
    if (!ended) throw new HttpError(409, "busy", "the conversation just moved on: look again");
    if (input.action === "take_over") await handOverTo(ended);
    else await savePlan(ended, withEvent(ended.plan));
    const payload = { reachOutId: ended.id };
    const type = conversationEventOfSubject(ended.subject);
    return {
      resume: { runId: r.id, type: reachOutEventType(ended.id), payload },
      conversation: type ? { runId: r.id, type, payload } : null,
    };
  }

  // DECISION: between a reply and the agent's next message (seconds), there is nothing to stop
  // yet: the person tries again, rather than a flag the run would have to find later.
  throw new HttpError(409, "busy", "the agent is between messages: try again in a moment");
}
