// What the SOP says, as keys the app translates (S5.7, overnight fixes 2026-11-23): the chart in
// Spanish said "We start it by hand" and "the run stops", made here in English. Each sentence made
// by code keeps its English (the back office, the stored revisions, the exports) and carries its
// key and values beside it; the app writes it in the reader's language from the key.
import { z } from "zod";

/**
 * A sentence by key: `params` are filled in as written (a name, a system), `paramKeys` are keys
 * the app translates first (a record type's name), each falling back to its `params` value.
 */
export const SopSay = z.object({
  key: z.string(),
  params: z.record(z.string(), z.string()).optional(),
  paramKeys: z.record(z.string(), z.string()).optional(),
});
export type SopSay = z.infer<typeof SopSay>;

/** Every key the SOP says by (the app has a message for each, in every language). */
export const SOP_SAY_KEYS = [
  "sop.say.trigger.documentReceived",
  "sop.say.trigger.documentExtracted",
  "sop.say.trigger.transactionCreated",
  "sop.say.trigger.transactionUpdated",
  "sop.say.trigger.messageReceived",
  "sop.say.trigger.runSucceeded",
  "sop.say.trigger.manualTeam",
  "sop.say.trigger.manualUs",
  "sop.say.trigger.command",
  "sop.say.trigger.webhook",
  "sop.say.trigger.message",
  "sop.say.trigger.handoff",
  "sop.say.trigger.handoffAny",
  "sop.say.trigger.started",
  "sop.say.then.stop",
  "sop.say.then.proceed",
  "sop.say.then.skip",
  "sop.say.then.escalate",
  "sop.say.rejected.continue",
  "sop.say.rejected.stop",
  "sop.say.onError.continue",
  "sop.say.purpose.reads",
  "sop.say.purpose.adds",
  "sop.say.purpose.removes",
  "sop.say.purpose.updates",
  "sop.say.where.mezonas",
  "sop.say.what.records",
] as const;
export type SopSayKey = (typeof SOP_SAY_KEYS)[number];

/** Record types with a name in every language: `sop.say.entity.<type>`, plural. */
export const SOP_SAY_ENTITIES = [
  "account",
  "attachment",
  "bill",
  "class",
  "customer",
  "deposit",
  "invoice",
  "item",
  "journal_entry",
  "location",
  "payment",
  "purchase",
  "purchase_order",
  "transfer",
  "vendor",
] as const;

/** The key for a record type's plural name, or null when it has none. */
export function sopEntityKey(entity: string): string | null {
  return (SOP_SAY_ENTITIES as readonly string[]).includes(entity)
    ? `sop.say.entity.${entity}`
    : null;
}

/** A sentence by key with its values: the shape the view carries. */
export function say(
  key: SopSayKey,
  params?: Record<string, string>,
  paramKeys?: Record<string, string>,
): SopSay {
  return {
    key,
    ...(params && Object.keys(params).length > 0 ? { params } : {}),
    ...(paramKeys && Object.keys(paramKeys).length > 0 ? { paramKeys } : {}),
  };
}
