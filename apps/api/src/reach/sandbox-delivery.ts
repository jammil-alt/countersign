// Replies to the Sandbox's redirected messages (owner, 2026-11-27): a message to a made-up person
// went to the operator's own address or number instead (`attemptFrom`, core `sandboxRedirect`),
// and the attempt keeps where (`redirectedTo`). In the Sandbox only, a reply from there counts as
// the made-up person's: an email by the reply address's tag, a text by the most recent open
// reach-out redirected to that number.

import { type ReachChannel, readSandboxDelivery } from "@countersign/core";
import { reachOut, type Tx, tenant } from "@countersign/db";
import { and, desc, eq } from "drizzle-orm";
import type { Attempt, ReachOutRow } from "./service";

/** Where this reach-out's latest message on `channel` went instead, if it was redirected. */
export function redirectedTo(row: Pick<ReachOutRow, "attempts">, channel: ReachChannel) {
  const sent = ((row.attempts ?? []) as unknown as Attempt[]).filter(
    (a) => a.status === "sent" && a.channel === channel,
  );
  return sent.at(-1)?.redirectedTo ?? null;
}

async function sandboxSettings(tx: Tx, tenantId: string): Promise<unknown | null> {
  const [t] = await tx
    .select({ settings: tenant.settings })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  const settings = t?.settings as { sandbox?: unknown } | undefined;
  return settings?.sandbox === true ? settings : null;
}

/** The address an email reply to these reach-outs may come from instead (the Sandbox only). */
export async function redirectedEmailSender(
  tx: Tx,
  tenantId: string,
  rows: readonly Pick<ReachOutRow, "attempts">[],
): Promise<string | null> {
  const to = rows.map((r) => redirectedTo(r, "email")).find((a) => a !== null);
  if (!to || !(await sandboxSettings(tx, tenantId))) return null;
  return to.toLowerCase();
}

/**
 * The Sandbox's most recent open reach-out whose message on `channel` went to `from` (the
 * Sandbox's delivery phone) instead of a made-up person; null anywhere else.
 */
// DECISION: a text from the delivery phone answers a redirected reach-out before any open one to
// the operator's own contact: in the Sandbox the operator is playing the made-up person.
export async function redirectedOpenFor(
  tx: Tx,
  tenantId: string,
  input: { from: string; channel: ReachChannel; agentId?: string },
): Promise<ReachOutRow | null> {
  const from = input.from.trim().replace(/^whatsapp:/i, "");
  const settings = await sandboxSettings(tx, tenantId);
  if (!settings || !from || readSandboxDelivery(settings).phone !== from) return null;
  const open = await tx
    .select()
    .from(reachOut)
    .where(
      and(
        eq(reachOut.tenantId, tenantId),
        eq(reachOut.status, "open"),
        ...(input.agentId ? [eq(reachOut.agentId, input.agentId)] : []),
      ),
    )
    .orderBy(desc(reachOut.updatedAt))
    .limit(50);
  return open.find((r) => redirectedTo(r, input.channel) === from) ?? null;
}
