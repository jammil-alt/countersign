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
import { connection, type Db, meteredUsage, type Tx, withOperator } from "@countersign/db";
import {
  createLlmClient,
  type LlmCallRecord,
  type LlmClient,
  type LlmTransport,
} from "@countersign/llm";
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

/** Where the back office's own model calls are recorded (`metered_usage.source`, always ours). */
export type BackOfficeModelSource = Extract<
  MeterSource,
  | "reggie_read"
  | "reshape"
  | "dev_queue"
  | "builder"
  | "build"
  | "assist"
  | "questions"
  | "summaries"
  | "dictation"
  | "background_read"
>;

/** One model call's cost as the ledger keeps it: fresh input, output and the cache apart. */
export interface ModelCost {
  model: string;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** USD; null when the model has no price (recorded at 0, so it still shows). */
  costUsd: string | null;
}

/** A call record's cost, the cache kept apart from fresh input. */
export const costOf = (c: LlmCallRecord): ModelCost => ({
  model: c.model,
  tokensIn: c.usage.inputTokens,
  tokensOut: c.usage.outputTokens,
  cacheReadTokens: c.usage.cacheReadTokens,
  cacheWriteTokens: c.usage.cacheWriteTokens,
  costUsd: c.costUsd,
});

/**
 * Records the back office's model calls outside any run (the Builder's drafts, revisions and
 * failed turns, builds' failed turns and brief reviews, Reggie's read, reshape, the dev queue's
 * reuse check, Assist, the back office's questions, Sloan's summaries, dictation): one row per
 * call that used anything, with its model, tokens and cost. Always ours.
 */
export async function meterModelCalls(
  tx: Tx,
  input: {
    tenantId: string | null;
    source: BackOfficeModelSource;
    /**
     * Ours unless said otherwise: only a failed background read of the client's own (whose
     * successful reads are the client's usage, §1.43) is not.
     */
    ours?: boolean;
    /** Unique to this batch of calls (each call's index is added). */
    key: string;
    calls: readonly (LlmCallRecord | ModelCost)[];
  },
): Promise<void> {
  for (const [i, call] of input.calls.entries()) {
    const c = "usage" in call ? costOf(call) : call;
    const cacheRead = c.cacheReadTokens ?? 0;
    const cacheWrite = c.cacheWriteTokens ?? 0;
    if (c.tokensIn + c.tokensOut + cacheRead + cacheWrite === 0 && !c.costUsd) continue;
    await insertMetered(tx, {
      tenantId: input.tenantId,
      agentId: null,
      runId: null,
      measure: "model",
      quantity: 1,
      source: input.source,
      ours: input.ours !== false || input.tenantId === null,
      model: c.model,
      tokensIn: c.tokensIn,
      tokensOut: c.tokensOut,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      // Rounded up to the column's ten-thousandth, as a run's calls are (§1.199): never free.
      costUsd: new Decimal(c.costUsd ?? "0").toDecimalPlaces(4, Decimal.ROUND_UP).toFixed(4),
      key: `${input.key}:${i}`.slice(0, 500),
    });
  }
}

/** What a request needs to record its calls after it ends: the database and its deferred work. */
export interface MeterDeps {
  db: Db;
  defer(task: () => Promise<unknown>): void;
}

/** A request's MeterDeps, from its Hono context (any route kind: mount, mountLong, public). */
export function meterDepsOf(ctx: {
  c: { get(key: "req"): { deferred: (() => Promise<unknown>)[] } };
  services: { db: Db };
}): MeterDeps {
  return { db: ctx.services.db, defer: (task) => ctx.c.get("req").deferred.push(task) };
}

/**
 * A model client for one back-office request whose every call (answered, failed or cut off) is
 * recorded as ours once the request ends, in a transaction of its own: a request that fails rolls
 * its own transaction back, and its calls were paid for all the same. `settled()` says the calls
 * so far are recorded elsewhere (a Builder turn's or a build answer's own row), so a request that
 * saves its answer's cost isn't counted twice; calls after it are still recorded.
 */
// DECISION: recorded after the response (the request's deferred work, which runs whether the
// handler returned or threw), never in the request's transaction, which an error rolls back.
export function meteredLlm(
  deps: MeterDeps,
  input: { transport: LlmTransport; tenantId: string | null; source: BackOfficeModelSource },
): { llm: LlmClient; settled(): void; calls: readonly LlmCallRecord[] } {
  const calls: LlmCallRecord[] = [];
  let from = 0;
  let deferred = false;
  const key = `${input.source}:${crypto.randomUUID()}`;
  const llm = createLlmClient({
    transport: input.transport,
    onCall: (record) => {
      calls.push(record);
      if (deferred) return;
      deferred = true;
      deps.defer(async () => {
        const left = calls.slice(from);
        if (left.length === 0) return;
        const scope = input.tenantId ? [input.tenantId] : [];
        await withOperator(deps.db, scope, (tx) =>
          meterModelCalls(tx, { tenantId: input.tenantId, source: input.source, key, calls: left }),
        );
      });
    },
  });
  return {
    llm,
    calls,
    settled: () => {
      from = calls.length;
    },
  };
}

async function insertMetered(tx: Tx, row: typeof meteredUsage.$inferInsert): Promise<void> {
  try {
    await tx.transaction(async (sp) => {
      await sp.insert(meteredUsage).values(row);
    });
  } catch (error) {
    // Counted already: the key is taken. DECISION: a plain insert and this, never ON CONFLICT,
    // which also holds the new row to the read policy, and a client's session may write but never
    // read a row that is ours (Sloan's summary, a portal question with no account agent).
    if (pgCode(error) === "23505") return;
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

/**
 * §1.210: a back-office answer's tokens, for the `meta` of the row that keeps its cost (a
 * Builder turn, a build answer, Reggie's answer), so the back office's tokens add up with its
 * cost: fresh input, output, and the cache apart.
 */
export function tokensMeta(calls: readonly LlmCallRecord[]): {
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
} {
  const sum = (f: (c: LlmCallRecord) => number) => calls.reduce((n, c) => n + f(c), 0);
  return {
    tokensIn: sum((c) => c.usage.inputTokens),
    tokensOut: sum((c) => c.usage.outputTokens),
    cacheReadTokens: sum((c) => c.usage.cacheReadTokens),
    cacheWriteTokens: sum((c) => c.usage.cacheWriteTokens),
  };
}

/** A Postgres error's code, through drizzle's wrapper. */
function pgCode(error: unknown): string | undefined {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return e?.code ?? e?.cause?.code;
}
