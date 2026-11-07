// Voice samples by email (ARCHITECTURE v0.12 §6.4, docs/plan.md §1.42): mail to the client's
// forwarding address with the `+voice` tag (`label-…-secret+voice@domain`) becomes a voice sample.
// Only that tagged address keeps a body: the text only (no attachments, no HTML), quoted history
// cut, at most 4,000 characters, card numbers redacted, and only from the client's allowed
// senders. Ordinary forwarding still keeps no body. The text is data (invariant 9).

import {
  countForwarded,
  forwardingOf,
  MAX_FORWARDED_BYTES,
  parseForwardingAddress,
  parseReplyEmail,
  sameAddress,
  senderAllowed,
  trustedFromHeader,
  UPLOAD_CONNECTOR_ID,
} from "@countersign/connectors";
import { voiceTagged } from "@countersign/core";
import { connection, type Db, withTenant } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { addVoiceSample, voicePerson, voicePersonByEmail } from "./voice-samples";

export interface VoiceEmail {
  /** Envelope sender (MAIL FROM). */
  from: string;
  /** Envelope recipient. */
  to: string;
  raw: Uint8Array;
  size?: number;
}

export type VoiceEmailOutcome =
  | { status: "accepted"; tenantId: string; entryId: string; personUserId: string }
  | {
      status: "dropped";
      tenantId: string | null;
      reason: "unknown_address" | "sender_not_allowed" | "too_large" | "unreadable" | "no_person";
    };

/** Whether this message is for a `+voice` address on our domain (else it is ordinary mail). */
export function isVoiceSampleAddress(to: string, domain: string): boolean {
  const t = voiceTagged(to);
  return t.tagged && parseForwardingAddress(t.address, domain) !== null;
}

/**
 * Receives one `+voice` message. Whose voice it is: the client's own user with the sender's
 * address (the envelope sender, or the From header when its domain passed DMARC), else the
 * client's first client admin. Never the forwarded message's own headers, which anyone can write.
 */
// DECISION: a sender who is on the allowed list but is not one of the client's users (e.g. a
// shared `ap@` mailbox) records the sample as the client admin's voice, the §1.42 default.
export async function receiveVoiceSampleEmail(
  deps: { db: Db },
  message: VoiceEmail,
  options: { domain: string; now?: () => Date },
): Promise<VoiceEmailOutcome> {
  const now = options.now ?? (() => new Date());
  const tagged = voiceTagged(message.to);
  const target = tagged.tagged ? parseForwardingAddress(tagged.address, options.domain) : null;
  if (!target) return { status: "dropped", tenantId: null, reason: "unknown_address" };
  const { tenantId } = target;
  return withTenant(deps.db, tenantId, async (tx) => {
    const [conn] = await tx
      .select()
      .from(connection)
      .where(and(eq(connection.tenantId, tenantId), eq(connection.connector, UPLOAD_CONNECTOR_ID)))
      .orderBy(connection.createdAt)
      .limit(1);
    const forwarding = conn ? forwardingOf(conn) : null;
    if (!conn || !forwarding?.address || !sameAddress(forwarding.address, tagged.address)) {
      if (conn) {
        await countForwarded(tx, conn, { accepted: false, reason: "unknown_address" }, now());
      }
      return {
        status: "dropped" as const,
        tenantId: conn ? tenantId : null,
        reason: "unknown_address" as const,
      };
    }
    const drop = async (reason: Exclude<VoiceEmailOutcome, { status: "accepted" }>["reason"]) => {
      await countForwarded(tx, conn, { accepted: false, reason }, now());
      return { status: "dropped" as const, tenantId, reason };
    };
    if ((message.size ?? message.raw.length) > MAX_FORWARDED_BYTES) return drop("too_large");
    let parsed: Awaited<ReturnType<typeof parseReplyEmail>>;
    try {
      parsed = await parseReplyEmail(message.raw);
    } catch {
      return drop("unreadable");
    }
    const fromHeader = trustedFromHeader(parsed.from, parsed.dmarcPassFrom)
      ? [parsed.from as string]
      : [];
    const senders = [message.from.toLowerCase(), ...fromHeader];
    if (!senderAllowed(forwarding.allowedSenders, senders)) return drop("sender_not_allowed");

    let person = null;
    for (const s of senders) {
      person ??= await voicePersonByEmail(tx, tenantId, s);
    }
    try {
      person ??= await voicePerson(tx, tenantId, null);
    } catch {
      return drop("no_person");
    }
    const entry = await addVoiceSample(tx, tenantId, {
      title: parsed.subject?.trim() || "Voice sample by email",
      text: parsed.text,
      personUserId: person.id,
      channel: "email",
      // DECISION: the version's author is the person whose voice it is, with the client's side's
      // role (the column knows only `operator` and `client_admin`): the client sent it.
      author: { id: person.id, role: "client_admin" },
    });
    await countForwarded(tx, conn, { accepted: true }, now());
    return { status: "accepted" as const, tenantId, entryId: entry.id, personUserId: person.id };
  });
}
