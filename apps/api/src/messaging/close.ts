// §1.160: a retired client's Twilio is given up. Every number in its subaccount is released and
// the subaccount closed, so we stop paying Twilio for a client we no longer serve. Hourly, after
// the retirement has committed, with Mezonas' main account (the client's own credentials went
// when its connection was disconnected).

import {
  closeSubaccount,
  type FetchLike,
  isTwilioNotFound,
  readTwilioConfig,
  releaseNumber,
  TWILIO_CONNECTOR_ID,
  type TwilioAuth,
  type TwilioConfig,
  TwilioError,
} from "@countersign/connectors";
import {
  connection,
  connectionChange,
  type Db,
  type Tx,
  tenant,
  withTenant,
} from "@countersign/db";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import type { Bindings } from "../env";
import { reportHandled } from "../observability/report";

// DECISION: released by the hourly pass, never inside the retirement's own transaction: a release
// can't be undone, so it happens only once the retirement is committed. A client has no way back
// from retirement, so nothing waits for the 30 days its files are kept.
export async function closeRetiredTwilio(
  db: Db,
  deps: { env: Bindings; fetch: FetchLike },
  now: Date,
): Promise<{ tenantId: string; released: number; closed: boolean }[]> {
  const main = mainTwilio(deps.env);
  if (!main) return [];
  const retired = await db
    .select({ id: tenant.id })
    .from(tenant)
    .where(isNotNull(tenant.retiredAt));
  const done: { tenantId: string; released: number; closed: boolean }[] = [];
  for (const t of retired) {
    try {
      const out = await withTenant(db, t.id, (tx) => closeOne(tx, deps.fetch, main, t.id, now));
      if (out) done.push({ tenantId: t.id, ...out });
    } catch (error) {
      reportHandled(`closing retired client ${t.id}'s Twilio failed`, error, {
        job: "twilio_close",
        client: t.id,
      });
    }
  }
  return done;
}

async function closeOne(
  tx: Tx,
  fetch: FetchLike,
  main: TwilioAuth,
  tenantId: string,
  now: Date,
): Promise<{ released: number; closed: boolean } | null> {
  const [row] = await tx
    .select()
    .from(connection)
    .where(and(eq(connection.tenantId, tenantId), eq(connection.connector, TWILIO_CONNECTOR_ID)))
    .orderBy(desc(connection.createdAt))
    .limit(1);
  const config = row ? readTwilioConfig(row.config) : null;
  if (!row || !config || config.closedAt) return null;
  const record = (change: Record<string, unknown>) =>
    tx.insert(connectionChange).values({
      tenantId,
      connectionId: row.id,
      actorId: null,
      change: { by: "system", reason: "client retired", ...change },
    });
  const save = (next: TwilioConfig) =>
    tx
      .update(connection)
      .set({ config: next as unknown as Record<string, unknown> })
      .where(and(eq(connection.id, row.id), eq(connection.tenantId, tenantId)));

  let numbers = config.numbers;
  let released = 0;
  try {
    for (const n of config.numbers) {
      try {
        await releaseNumber(fetch, main, n.sid, config.subaccountSid);
      } catch (error) {
        // Already gone at Twilio (released in the console): nothing left to pay for.
        if (!isTwilioNotFound(error)) throw error;
      }
      numbers = numbers.filter((x) => x.sid !== n.sid);
      released++;
      await record({ kind: "number_released", number: n.phoneNumber, sid: n.sid });
    }
    try {
      await closeSubaccount(fetch, main, config.subaccountSid);
    } catch (error) {
      if (!isTwilioNotFound(error)) throw error;
    }
  } catch (error) {
    if (!(error instanceof TwilioError)) throw error;
    // The numbers released so far stay released; the rest wait for the next hour.
    const { closeError: _old, ...rest } = config;
    await save({
      ...rest,
      numbers,
      closeError: { at: now.toISOString(), message: `Twilio: ${error.message}` },
    });
    return { released, closed: false };
  }
  const { closeError: _old, ...rest } = config;
  await save({ ...rest, numbers: [], closedAt: now.toISOString() });
  await record({ kind: "subaccount_closed", subaccountSid: config.subaccountSid });
  return { released, closed: true };
}

function mainTwilio(env: Bindings): TwilioAuth | null {
  const accountSid = env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = env.TWILIO_AUTH_TOKEN?.trim();
  return accountSid && authToken ? { accountSid, authToken } : null;
}
