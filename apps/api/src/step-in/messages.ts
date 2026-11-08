// P-6: a message waiting for approval, changed before it is approved (docs/plan.md §1.68;
// ARCHITECTURE §10.12, §11.1). A conversation's message or a reach-out's plan is a `reach_out` row
// waiting on its approval item; whoever approves it (the client's team, or the operator stepping
// in) may give the text to send instead. The edit becomes the row's fixed message, so what is
// approved is exactly what is sent, through the same send path and every check it makes (consent,
// quiet hours, the WhatsApp window, the matrix, the idempotency key). The agent's text is kept.

import { converseMaxChars } from "@countersign/agents";
import {
  CONVERSE_CHANNEL_WORDS,
  type ConverseChannel,
  EditedMessage,
  isConverseSubject,
  isPlainObject,
  type JsonObject,
  pickMessage,
  type ReachChannel,
  redactCardNumbers,
} from "@countersign/core";
import { inboxItem, reachOut, type Tx } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import type { StoredEdit } from "../converse/views";
import { HttpError, notFound } from "../http";
import type { InboxRow } from "../inbox";
import { reachMaxChars, type StoredPlan } from "../reach/service";

const CHANNEL_WORDS: Record<ReachChannel, string> = {
  email: "email",
  sms: "a text",
  whatsapp: "WhatsApp",
  voice: "a call",
};

/** Whether an item asks someone to approve a message (a conversation's or a reach-out's). */
export function isMessageItem(item: Pick<InboxRow, "kind" | "payload">): boolean {
  return (
    item.kind === "approval" &&
    isPlainObject(item.payload) &&
    typeof item.payload.reachOutId === "string"
  );
}

export interface EditedMessageResult {
  item: InboxRow;
  text: string;
  original: string | null;
  at: Date;
}

/**
 * Stores a person's text for a message waiting for approval. The item stays open: approving it is
 * the normal resolve. The caller has checked that this person may approve it.
 */
// DECISION: the edit is checked when it is made (not empty, card numbers redacted, the channel's
// length) and again when it is sent, by the send path's own checks: consent, quiet hours (held),
// the WhatsApp window and the matrix. A conversation opening that would go as an approved WhatsApp
// template outside the window loses the template when edited: the edited words go only inside the
// window, and outside it the send is refused, never the template in their place.
export async function editMessage(
  tx: Tx,
  input: {
    tenantId: string;
    item: InboxRow;
    text: string;
    by: { userId: string; byUs: boolean };
    now: Date;
  },
): Promise<EditedMessageResult> {
  const { item } = input;
  if (!isMessageItem(item)) {
    throw new HttpError(409, "not_a_message", "only a message waiting for approval can be edited");
  }
  if (item.status !== "open") {
    throw new HttpError(409, "already_resolved", "this message was already approved or declined");
  }
  const parsed = EditedMessage.safeParse(input.text);
  if (!parsed.success) {
    throw new HttpError(422, "invalid_message", "write the message to send (1 to 1600 characters)");
  }
  const reachOutId = (item.payload as { reachOutId: string }).reachOutId;
  const [row] = await tx
    .select()
    .from(reachOut)
    .where(and(eq(reachOut.id, reachOutId), eq(reachOut.tenantId, input.tenantId)))
    .for("update");
  if (!row) throw notFound("message");
  if (row.status !== "awaiting_approval" || row.inboxItemId !== item.id) {
    throw new HttpError(409, "not_waiting", "this message is no longer waiting for approval");
  }
  const plan = row.plan as unknown as StoredPlan & { edited?: StoredEdit };
  if (plan.channels.includes("voice")) {
    throw new HttpError(
      409,
      "not_editable",
      "a call says what its purpose says: its words can't be changed here",
    );
  }
  // Card numbers never go out in a message we write (docs/plan.md §1.35).
  const text = redactCardNumbers(parsed.data);
  const converse = isConverseSubject(row.subject);
  const limits = plan.channels.map((ch) =>
    converse
      ? converseMaxChars(ch as ConverseChannel)
      : reachMaxChars(ch, !!plan.attachments?.length),
  );
  const max = Math.min(...limits);
  if (text.length > max) {
    const words = plan.channels
      .map((ch) => (converse ? CONVERSE_CHANNEL_WORDS[ch as ConverseChannel] : CHANNEL_WORDS[ch]))
      .join(" or ");
    throw new HttpError(422, "too_long", `at most ${max} characters for ${words}`);
  }
  const current =
    "template" in plan.message ? pickMessage(plan.message.template, plan.language) : null;
  // A second edit keeps the agent's text as the original, never an earlier edit.
  const original = plan.edited ? plan.edited.original : current;
  const at = input.now;
  const edited: StoredEdit = {
    original,
    text,
    by: input.by.userId,
    byUs: input.by.byUs,
    at: at.toISOString(),
  };
  const { whatsappTemplate: _template, ...rest } = plan;
  const next = {
    ...rest,
    message: { template: { en: text, [plan.language]: text } },
    edited,
  };
  await tx
    .update(reachOut)
    .set({ plan: next as unknown as Record<string, unknown> })
    .where(and(eq(reachOut.id, row.id), eq(reachOut.tenantId, input.tenantId)));

  // The card shows the text that will go, and that it was changed (never our person's name).
  const payload = (isPlainObject(item.payload) ? item.payload : {}) as JsonObject;
  const withText = (key: "converse" | "reachOut") =>
    isPlainObject(payload[key])
      ? { [key]: { ...(payload[key] as JsonObject), message: text } }
      : {};
  const [updated] = await tx
    .update(inboxItem)
    .set({
      payload: {
        ...payload,
        ...withText("converse"),
        ...withText("reachOut"),
        edited: {
          message: text,
          original,
          at: at.toISOString(),
          byUs: input.by.byUs,
          ...(input.by.byUs ? {} : { by: input.by.userId }),
        },
      },
    })
    .where(and(eq(inboxItem.id, item.id), eq(inboxItem.tenantId, input.tenantId)))
    .returning();
  if (!updated) throw notFound("inbox item");
  return { item: updated, text, original, at };
}
