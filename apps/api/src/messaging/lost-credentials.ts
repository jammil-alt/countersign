// A Twilio connection whose stored credentials can't be opened any more (overnight S8.2): its
// client key was retired after staging's master key was lost (2026-11-21), so every hourly pass
// failed on it (Sentry MEZONAS-API-C). The subaccount is ours, made under Mezonas' main account,
// so its credentials are read back with the main account and stored anew under the client's
// current key, as reconnecting a disconnected client does (routes/messaging-setup.ts). Where that
// can't be done, the connection is marked as needing attention once, and the passes skip it
// (they follow only connected connections) until the operator sets texting up again.

import { dbConnectionAttention } from "@countersign/agents";
import {
  credentialsUnopenable,
  type FetchLike,
  fetchSubaccount,
  type TwilioAuth,
  type TwilioConfig,
  TwilioError,
  twilioCredentialsOf,
} from "@countersign/connectors";
import { type connection, connectionChange, type Db, type Tx } from "@countersign/db";
import type { EventTypeRegistry } from "@countersign/senses";
import type { Bindings } from "../env";
import { senseEmitter } from "../runs/dispatch";
import { connectionCredentials } from "../secrets";

type ConnectionRow = typeof connection.$inferSelect;

/** What the connection's credentials came to: open (maybe after a repair), none, or lost. */
export type TwilioAuthResult =
  | { kind: "open"; auth: TwilioAuth | null; repaired: boolean }
  | { kind: "lost"; detail: string };

function mainAccount(env: Bindings): TwilioAuth | null {
  const accountSid = env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = env.TWILIO_AUTH_TOKEN?.trim();
  return accountSid && authToken ? { accountSid, authToken } : null;
}

/**
 * The subaccount's credentials, in `tx` (scoped to the client). When the stored ones can never
 * be opened again, they are read back from Twilio with Mezonas' main account and stored anew
 * (a fresh client key is made on that write), and the repair is logged on the connection.
 */
// DECISION: the self-repair reads only (`GET Accounts/{sid}` with the main account, the call
// reconnecting already makes) and writes only our own row; it never changes the client's Twilio.
// Twilio answers a subaccount of another parent with a 404, and the sid it returns must be the
// one we hold. Fields stored beside the subaccount's (the EIN, a2p.ts) were under the lost key
// too: they are gone, and the client gives the EIN again if Twilio asks for changes.
export async function openTwilioCredentials(
  tx: Tx,
  deps: { env: Bindings; fetch: FetchLike },
  row: ConnectionRow,
  config: TwilioConfig,
): Promise<TwilioAuthResult> {
  const accessor = await connectionCredentials(tx, deps.env, row);
  let reason: string;
  try {
    return { kind: "open", auth: twilioCredentialsOf(await accessor.get()), repaired: false };
  } catch (error) {
    if (!credentialsUnopenable(error)) throw error;
    reason = error.code;
  }
  const lost = `the stored Twilio credentials can't be opened (${reason}); set up texting again`;
  const main = mainAccount(deps.env);
  if (!main) return { kind: "lost", detail: lost };
  let creds: TwilioAuth;
  try {
    creds = await fetchSubaccount(deps.fetch, main, config.subaccountSid);
  } catch (error) {
    // Twilio refused (not ours, closed, our keys): a person looks. No answer or a 5xx: next hour.
    if (error instanceof TwilioError && error.notWritten) return { kind: "lost", detail: lost };
    throw error;
  }
  if (creds.accountSid !== config.subaccountSid) return { kind: "lost", detail: lost };
  await accessor.set({ ...creds });
  await tx.insert(connectionChange).values({
    tenantId: row.tenantId,
    connectionId: row.id,
    actorId: null,
    change: { kind: "credentials_restored", by: "system", reason, account: creds.accountSid },
  });
  return { kind: "open", auth: creds, repaired: true };
}

/** Marks the connection as needing attention, once (a connection in `error` is left as it is). */
export async function markTwilioCredentialsLost(
  db: Db,
  events: EventTypeRegistry | undefined,
  input: { tenantId: string; connectionId: string; detail: string },
): Promise<void> {
  await dbConnectionAttention(db, events ? { emit: senseEmitter(events) } : {}).needsAttention(
    input.tenantId,
    {
      connectionId: input.connectionId,
      // DECISION: `signin_expired`, as S3.7 does for QuickBooks: the connection is put right only
      // by connecting it again (for Twilio, the operator's "Set up texting"), and the back office
      // already shows that reason with the detail.
      reason: "signin_expired",
      detail: input.detail,
    },
  );
}
