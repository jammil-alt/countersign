// What we pay vendors for outside a run's model calls (docs/plan.md §1.210, build plans 11's
// metering): one `metered_usage` row each, written in the caller's transaction, counted once by
// its key. An email through Resend, a text no run sent, a sign-in code, Browser Run's seconds, a
// connected bank's month, and the back office's own model calls (Reggie's read, reshape, the dev
// queue's reuse check). The rollups count the client's rows into `usage_daily` (an agent's) and
// `usage_platform_daily` (the client's own), so billing prices them at `billing_unit_cost` like
// texts and calls; rows marked `ours` are the back office's and the platform's, shown on Usage as
// their own lines and never in a client's usage or bill.

import { BANKFEED_CONNECTOR_ID } from "@countersign/connectors";
import { Decimal, type MeteredMeasure, type MeterSource } from "@countersign/core";
import { connection, meteredUsage, type Tx } from "@countersign/db";
import type { LlmCallRecord } from "@countersign/llm";
import { and, eq, inArray } from "drizzle-orm";
import { reportHandled } from "./observability/report";

export interface MeterInput {
  /** The client; null only for our own cost with no client (then `ours` is implied). */
  tenantId: string | null;
  measure: Exclude<MeteredMeasure, "model">;
  source: MeterSource;
  /** Counted once: the provider's id where there is one (`twilio:SM…`, `resend:…`). */
  key: string;
  quantity?: number;
  agentId?: string | null;
  runId?: string | null;
  ours?: boolean;
}

/**
 * Records one metered thing in `tx` (its scope must hold the client, or, for a row with no
 * client, any scope). A repeat of the key adds nothing. Never throws: a meter that fails is
 * reported and the work it measured goes on, as the browser's own session record does.
 */
// DECISION: recorded in the caller's own transaction, never one of its own: a portal request
// holds the database's one pooled connection, so a second transaction would wait on itself.
// A savepoint keeps a failed insert from aborting the caller's transaction.
export async function meter(tx: Tx, input: MeterInput): Promise<void> {
  const quantity = Math.ceil(input.quantity ?? 1);
  if (!(quantity > 0)) return;
  await insertMetered(tx, {
    tenantId: input.tenantId,
    agentId: input.tenantId ? (input.agentId ?? null) : null,
    runId: input.tenantId ? (input.runId ?? null) : null,
    measure: input.measure,
    quantity,
    source: input.source,
    ours: input.ours === true || input.tenantId === null,
    key: input.key.slice(0, 500),
  });
}

/**
 * Records the back office's model calls outside any run (Reggie's read, reshape, the dev queue's
 * reuse check): one row per call that answered, with its model, tokens and cost; a call with no
 * price is recorded at 0 so it still shows. Always ours.
 */
export async function meterModelCalls(
  tx: Tx,
  input: {
    tenantId: string | null;
    source: Extract<MeterSource, "reggie_read" | "reshape" | "dev_queue">;
    /** Unique to this batch of calls (each call's index is added). */
    key: string;
    calls: readonly LlmCallRecord[];
  },
): Promise<void> {
  for (const [i, c] of input.calls.entries()) {
    // Input counts cache reads and writes, as the token report does (§1.115).
    const tokensIn = c.usage.inputTokens + c.usage.cacheReadTokens + c.usage.cacheWriteTokens;
    if (tokensIn + c.usage.outputTokens === 0 && !c.costUsd) continue;
    await insertMetered(tx, {
      tenantId: input.tenantId,
      agentId: null,
      runId: null,
      measure: "model",
      quantity: 1,
      source: input.source,
      ours: true,
      model: c.model,
      tokensIn,
      tokensOut: c.usage.outputTokens,
      // Rounded up to the column's ten-thousandth, as a run's calls are (§1.199): never free.
      costUsd: new Decimal(c.costUsd ?? "0").toDecimalPlaces(4, Decimal.ROUND_UP).toFixed(4),
      key: `${input.key}:${i}`.slice(0, 500),
    });
  }
}

async function insertMetered(tx: Tx, row: typeof meteredUsage.$inferInsert): Promise<void> {
  try {
    await tx.transaction(async (sp) => {
      await sp.insert(meteredUsage).values(row).onConflictDoNothing({ target: meteredUsage.key });
    });
  } catch (error) {
    reportHandled("a metered cost was not recorded", error, {
      measure: row.measure,
      source: row.source,
    });
  }
}

/**
 * Plaid bills Transactions per connected item per month (`/item/remove` stops it): one
 * `bank_item_months` row for each of the client's bank feeds that is connected, or in error but
 * not removed, in the month of `now` (UTC), counted once per item and month. Run by the cron's
 * hourly usage sweep, so an item connected for any hour of a month counts for that month.
 */
// DECISION: counted from the connections each hour rather than at the exchange and the remove:
// a month is billed whole, and the cron already walks every client (docs/plan.md §1.210).
export async function meterBankItems(tx: Tx, tenantId: string, now: Date): Promise<void> {
  const month = now.toISOString().slice(0, 7);
  const rows = await tx
    .select({ id: connection.id, item: connection.externalAccountId })
    .from(connection)
    .where(
      and(
        eq(connection.tenantId, tenantId),
        eq(connection.connector, BANKFEED_CONNECTOR_ID),
        inArray(connection.status, ["connected", "error"]),
      ),
    );
  for (const r of rows) {
    await meter(tx, {
      tenantId,
      measure: "bank_item_months",
      source: "bank_feed",
      key: `plaid:${r.item ?? r.id}:${month}`,
    });
  }
}
