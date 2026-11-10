// R7 (docs/plan.md §1.86, §9): the event a v4 conversation step waits on. Each of a conversation's
// messages is a reach-out row whose subject is `converse:<run>:<step>`, and its approvals and hand-
// over are inbox items; a v3 `comms.converse` step waits on those rows' and items' own events, a
// v4 conversation step on one event for the whole conversation (core `conversationEventType`).
// Whatever wakes one, a reply, a message's wait ending, a held message going out or an item
// resolved, sends the other too: the run that waits takes it, any other ignores it.

import { isPlainObject, processes } from "@countersign/core";
import { type inboxItem, reachOut, type Tx } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import type { RunEvent, RunInstances } from "../runs/instances";

/** The conversation event for a reach-out row's subject; null for a plain reach-out. */
export function conversationEventOfSubject(subject: string | null | undefined): string | null {
  const id = subject ? processes.conversationIdOfSubject(subject) : null;
  return id ? processes.conversationEventType(id) : null;
}

/**
 * The conversation event for an inbox item of a conversation (a message's signature, by its
 * reach-out row; a hand-over, by its key), or null for any other item.
 */
export async function conversationEventOfItem(
  tx: Tx,
  item: Pick<typeof inboxItem.$inferSelect, "tenantId" | "runId" | "payload">,
): Promise<string | null> {
  const payload = isPlainObject(item.payload) ? item.payload : {};
  const converse = isPlainObject(payload.converse) ? payload.converse : null;
  if (!converse || !item.runId) return null;
  if (typeof converse.key === "string") {
    return processes.conversationEventType(processes.conversationId(item.runId, converse.key));
  }
  if (typeof payload.reachOutId !== "string") return null;
  const [row] = await tx
    .select({ subject: reachOut.subject })
    .from(reachOut)
    .where(and(eq(reachOut.id, payload.reachOutId), eq(reachOut.tenantId, item.tenantId)));
  return conversationEventOfSubject(row?.subject);
}

// DECISION (R7): the conversation's event goes beside the v3 one, always: which kind of step waits
// isn't known where a reply lands or a card is resolved, and an event nobody waits for is never
// read. The cron's re-sends (reach-outs not taken, resolved items not taken) carry it too.
/** Sends `event`, and the conversation's own event beside it when there is one. */
export async function sendWithConversation(
  instances: RunInstances,
  runId: string,
  event: RunEvent,
  conversationEvent: string | null,
): Promise<void> {
  await instances.sendEvent(runId, event);
  if (conversationEvent) {
    await instances.sendEvent(runId, { type: conversationEvent, payload: event.payload });
  }
}

/** An inbox item's resolution, as the conversation's event carries it. */
export function itemWakePayload(inboxItemId: string, resolution: unknown) {
  return { inboxItemId, resolution };
}
