// The Close pack's records (docs/plan.md §1.232): a month's close per client and QuickBooks company,
// its checklist and its proposed journal entries. The checks are books health's (core
// `checkBooks`, over connectors' `loadQboBooks`) plus the Bookkeeping area's own records (its
// reconciliations and bank transactions, read here because this pack lives beside it). Entries are
// only proposed here: each is written to QuickBooks by the connector's external tool after a
// person's signature (invariant 8); this file reads what became of that write. A person signs the
// period off on the card once every line is done or waived and every entry decided.

import { loadQboBooks } from "@countersign/connectors";
import {
  type BooksFinding,
  checkBooks,
  dec,
  isPlainObject,
  packConfigOf,
  QBO_CONNECTOR_ID,
} from "@countersign/core";
import {
  appUser,
  connection,
  externalAction,
  ledgerAccount,
  type Tx,
  tenant,
} from "@countersign/db";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { PackRefusal } from "../pack";
import { clientTimezone, monthPeriod } from "../reconcile/store";
import { bankAccountLink, bankTxn, reconciliation } from "../schema";
import { CLOSE_CONFIG_DEFAULTS, CLOSE_CONFIG_FIELDS } from "./config";
import {
  accrualPatterns,
  booksAsOf,
  type EntryLine,
  entryTotal,
  monthBounds,
  monthsBefore,
  monthWords,
  nextDay,
} from "./engine";
import { CLOSE_PACK_ID } from "./ids";
import {
  type CloseEntryKind,
  type CloseEntryProposer,
  type CloseItemKind,
  type CloseItemStatus,
  closeEntry,
  closeEntryLine,
  closeItem,
  closePeriod,
} from "./schema";

/** The QuickBooks write each entry becomes. */
export const JOURNAL_CREATE_TOOL = "qbo.journal.create";

/** The mark an entry's QuickBooks write carries (`[Mezonas ce-<id>]`). */
export const entryReference = (entryId: string) => `ce-${entryId}`;

// ── Configuration (docs/plan.md §1.230: tenant.settings.packs.close) ─────────────────────────────

export interface CloseConfig {
  accruals: boolean;
  accrualAccount: string;
  accrualMonths: number;
}

/** The client's Close settings (`tenant.settings.packs.close`), with the defaults for what isn't set. */
export async function closeConfig(tx: Tx, tenantId: string): Promise<CloseConfig> {
  const [row] = await tx
    .select({ settings: tenant.settings })
    .from(tenant)
    .where(eq(tenant.id, tenantId))
    .limit(1);
  const settings = isPlainObject(row?.settings) ? (row.settings as Record<string, unknown>) : null;
  const v = packConfigOf(CLOSE_CONFIG_FIELDS, settings, CLOSE_PACK_ID);
  return {
    accruals: v.accruals === true,
    accrualAccount: String(v.accrual_account).trim() || CLOSE_CONFIG_DEFAULTS.accrualAccount,
    accrualMonths: Number(v.accrual_months),
  };
}

// ── Words ───────────────────────────────────────────────────────────────────────────────────────

export function moneyWords(amount: string, currency: string): string {
  const n = dec(amount).toFixed(2);
  const [whole, cents] = n.replace("-", "").split(".") as [string, string];
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const sign = n.startsWith("-") ? "-" : "";
  return currency === "USD"
    ? `${sign}$${grouped}.${cents}`
    : `${sign}${currency} ${grouped}.${cents}`;
}

function dayWords(day: string): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

// ── The company ─────────────────────────────────────────────────────────────────────────────────

/** The client's QuickBooks company: its connected connection synced most recently. */
// DECISION: one company per close, chosen as books health chooses it (a client has one QuickBooks
// company in v1); the close is kept per connection, so a second company would get its own.
export async function closeConnection(
  tx: Tx,
  tenantId: string,
): Promise<{ id: string; lastSyncAt: Date | null } | null> {
  const [c] = await tx
    .select({ id: connection.id, lastSyncAt: connection.lastSyncAt })
    .from(connection)
    .where(
      and(
        eq(connection.tenantId, tenantId),
        eq(connection.connector, QBO_CONNECTOR_ID),
        eq(connection.status, "connected"),
      ),
    )
    .orderBy(sql`${connection.lastSyncAt} desc nulls last`, desc(connection.createdAt))
    .limit(1);
  return c ?? null;
}

// ── Entries ─────────────────────────────────────────────────────────────────────────────────────

export interface NewEntry {
  tenantId: string;
  periodId: string;
  kind: CloseEntryKind;
  entryKey: string;
  proposedBy: CloseEntryProposer;
  txnDate: string;
  reverseOn?: string | null;
  currency: string;
  memo: string;
  reason?: string | null;
  fromEntryId?: string | null;
  sources: string[];
  agentVersionId?: string | null;
  runId?: string | null;
  userId?: string | null;
  lines: EntryLine[];
}

/**
 * Records a proposed entry and its lines; null when a live entry already holds its key (a re-check
 * never proposes the same entry twice). The lines must balance and each account must be one of the
 * client's active accounts on the period's company.
 */
export async function proposeEntry(
  tx: Tx,
  entry: NewEntry,
  connectionId: string,
): Promise<string | null> {
  const total = entryTotal(entry.lines);
  if ("problem" in total) throw new PackRefusal(total.problem);
  const ids = [...new Set(entry.lines.map((l) => l.ledgerAccountId))];
  const known = await tx
    .select({ id: ledgerAccount.id })
    .from(ledgerAccount)
    .where(
      and(
        eq(ledgerAccount.tenantId, entry.tenantId),
        eq(ledgerAccount.connectionId, connectionId),
        eq(ledgerAccount.active, true),
        inArray(ledgerAccount.id, ids),
      ),
    );
  if (known.length !== ids.length) {
    throw new PackRefusal("every line's account must be one of the company's active accounts");
  }
  const [row] = await tx
    .insert(closeEntry)
    .values({
      tenantId: entry.tenantId,
      periodId: entry.periodId,
      kind: entry.kind,
      entryKey: entry.entryKey,
      proposedBy: entry.proposedBy,
      txnDate: entry.txnDate,
      reverseOn: entry.reverseOn ?? null,
      amount: total.total,
      currency: entry.currency,
      memo: entry.memo.slice(0, 400),
      reason: entry.reason ?? null,
      fromEntryId: entry.fromEntryId ?? null,
      sources: entry.sources,
      agentVersionId: entry.agentVersionId ?? null,
      runId: entry.runId ?? null,
      userId: entry.userId ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: closeEntry.id });
  if (!row) return null;
  await tx.insert(closeEntryLine).values(
    entry.lines.map((l, i) => ({
      tenantId: entry.tenantId,
      entryId: row.id,
      lineNo: i + 1,
      ledgerAccountId: l.ledgerAccountId,
      posting: l.posting,
      amount: dec(l.amount).toFixed(4),
      description: l.description ?? null,
    })),
  );
  return row.id;
}

async function linesOf(tx: Tx, tenantId: string, entryIds: string[]) {
  if (entryIds.length === 0) return new Map<string, EntryLineView[]>();
  const rows = await tx
    .select({
      entryId: closeEntryLine.entryId,
      lineNo: closeEntryLine.lineNo,
      ledgerAccountId: closeEntryLine.ledgerAccountId,
      posting: closeEntryLine.posting,
      amount: closeEntryLine.amount,
      description: closeEntryLine.description,
      accountName: ledgerAccount.fullName,
      accountExternalId: ledgerAccount.externalId,
    })
    .from(closeEntryLine)
    .innerJoin(
      ledgerAccount,
      and(
        eq(ledgerAccount.id, closeEntryLine.ledgerAccountId),
        eq(ledgerAccount.tenantId, closeEntryLine.tenantId),
      ),
    )
    .where(and(eq(closeEntryLine.tenantId, tenantId), inArray(closeEntryLine.entryId, entryIds)))
    .orderBy(asc(closeEntryLine.entryId), asc(closeEntryLine.lineNo));
  const out = new Map<string, EntryLineView[]>();
  for (const r of rows) {
    const list = out.get(r.entryId) ?? [];
    list.push({
      ledgerAccountId: r.ledgerAccountId,
      accountName: r.accountName,
      accountExternalId: r.accountExternalId,
      posting: r.posting,
      amount: r.amount,
      description: r.description,
    });
    out.set(r.entryId, list);
  }
  return out;
}

/** Each entry's QuickBooks write, the latest by reference: what became of it. */
async function writesOf(tx: Tx, tenantId: string, entryIds: string[]) {
  const refs = entryIds.map(entryReference);
  if (refs.length === 0) return new Map<string, WriteState>();
  const ref = sql<string>`coalesce(${externalAction.editedInput} ->> 'reference', ${externalAction.input} ->> 'reference')`;
  const rows = await tx
    .select({
      reference: ref,
      status: externalAction.status,
      qboId: sql<string | null>`${externalAction.result} ->> 'id'`,
      error: sql<string | null>`${externalAction.error} ->> 'message'`,
      notWritten: sql<boolean>`coalesce((${externalAction.error} ->> 'notWritten')::boolean, false)`,
      id: externalAction.id,
    })
    .from(externalAction)
    .where(
      and(
        eq(externalAction.tenantId, tenantId),
        eq(externalAction.tool, JOURNAL_CREATE_TOOL),
        inArray(ref, refs),
      ),
    )
    .orderBy(asc(externalAction.createdAt));
  const out = new Map<string, WriteState>();
  for (const r of rows) {
    const entryId = r.reference.slice(3);
    out.set(entryId, {
      actionId: r.id,
      status: r.status,
      qboId: r.qboId,
      error: r.error,
      notWritten: r.notWritten,
    });
  }
  return out;
}

interface WriteState {
  actionId: string;
  status: string;
  qboId: string | null;
  error: string | null;
  notWritten: boolean;
}

/** A write that is waiting, being made or made: the entry isn't free to be turned down. */
const LIVE_WRITE = new Set(["proposed", "approved", "executing", "done"]);

/**
 * What became of each undecided entry's write: made → posted with its QuickBooks id; turned down →
 * rejected; failed → failed with why. A write still waiting leaves the entry as it is.
 */
// DECISION: read from the external actions by the entry's mark, not only from the step after the
// write, so a write turned down (the loop goes on past it) or made after a lost answer is still
// recorded on the next check, card or sign-off.
export async function settleEntries(tx: Tx, tenantId: string, periodId: string): Promise<void> {
  const open = await tx
    .select({ id: closeEntry.id, status: closeEntry.status })
    .from(closeEntry)
    .where(
      and(
        eq(closeEntry.tenantId, tenantId),
        eq(closeEntry.periodId, periodId),
        inArray(closeEntry.status, ["proposed", "failed"]),
      ),
    );
  const writes = await writesOf(
    tx,
    tenantId,
    open.map((e) => e.id),
  );
  for (const e of open) {
    const w = writes.get(e.id);
    if (!w) continue;
    if (w.status === "done" && w.qboId) {
      await tx
        .update(closeEntry)
        .set({
          status: "posted",
          qboId: w.qboId,
          externalActionId: w.actionId,
          postedAt: new Date(),
          error: null,
        })
        .where(and(eq(closeEntry.id, e.id), eq(closeEntry.tenantId, tenantId)));
    } else if (w.status === "rejected" && e.status === "proposed") {
      await tx
        .update(closeEntry)
        .set({ status: "rejected", externalActionId: w.actionId, decidedAt: new Date() })
        .where(and(eq(closeEntry.id, e.id), eq(closeEntry.tenantId, tenantId)));
    } else if (w.status === "failed" && e.status === "proposed") {
      await tx
        .update(closeEntry)
        .set({
          status: "failed",
          externalActionId: w.actionId,
          error: (w.error ?? "the write failed").slice(0, 500),
        })
        .where(and(eq(closeEntry.id, e.id), eq(closeEntry.tenantId, tenantId)));
    }
  }
}

/** The QuickBooks write an entry becomes (`qbo.journal.create`'s input). */
export interface JournalInput {
  txnDate: string;
  currency: string;
  expectedTotal: string;
  privateNote: string;
  reference: string;
  lines: { accountId: string; posting: "debit" | "credit"; amount: string; description?: string }[];
}

/**
 * The period's proposed entries with no write laid out yet, each with the QuickBooks write it
 * becomes. A failed one is offered again only after a person turns it down or the next check.
 */
export async function readyEntries(tx: Tx, tenantId: string, periodId: string) {
  const [p] = await tx
    .select({ status: closePeriod.status })
    .from(closePeriod)
    .where(and(eq(closePeriod.id, periodId), eq(closePeriod.tenantId, tenantId)));
  if (!p) throw new PackRefusal(`close ${periodId} isn't this client's`);
  if (p.status === "signed_off") return [];
  const rows = await tx
    .select()
    .from(closeEntry)
    .where(
      and(
        eq(closeEntry.tenantId, tenantId),
        eq(closeEntry.periodId, periodId),
        eq(closeEntry.status, "proposed"),
      ),
    )
    .orderBy(asc(closeEntry.txnDate), asc(closeEntry.createdAt));
  const ids = rows.map((r) => r.id);
  const writes = await writesOf(tx, tenantId, ids);
  const lines = await linesOf(tx, tenantId, ids);
  return rows
    .filter((r) => !writes.has(r.id))
    .map((r) => {
      const ls = lines.get(r.id) ?? [];
      const journal: JournalInput = {
        txnDate: r.txnDate,
        currency: r.currency,
        expectedTotal: dec(r.amount).toFixed(2),
        privateNote: r.memo,
        reference: entryReference(r.id),
        lines: ls.map((l) => ({
          accountId: l.accountExternalId,
          posting: l.posting,
          amount: dec(l.amount).toFixed(2),
          ...(l.description ? { description: l.description } : {}),
        })),
      };
      return { entryId: r.id, kind: r.kind, memo: r.memo, amount: r.amount, journal };
    });
}

/** The step after an entry's write: the QuickBooks id it became, or nothing when it wasn't made. */
export async function entryWritten(
  tx: Tx,
  tenantId: string,
  entryId: string,
  qboId: string | null,
): Promise<{ status: string }> {
  const [e] = await tx
    .select({ id: closeEntry.id, status: closeEntry.status, periodId: closeEntry.periodId })
    .from(closeEntry)
    .where(and(eq(closeEntry.id, entryId), eq(closeEntry.tenantId, tenantId)));
  if (!e) throw new PackRefusal(`entry ${entryId} isn't this client's`);
  if (qboId && e.status !== "posted") {
    await tx
      .update(closeEntry)
      .set({ status: "posted", qboId, postedAt: new Date(), error: null })
      .where(and(eq(closeEntry.id, entryId), eq(closeEntry.tenantId, tenantId)));
    return { status: "posted" };
  }
  await settleEntries(tx, tenantId, e.periodId);
  const [after] = await tx
    .select({ status: closeEntry.status })
    .from(closeEntry)
    .where(and(eq(closeEntry.id, entryId), eq(closeEntry.tenantId, tenantId)));
  return { status: after?.status ?? e.status };
}

// ── The check ───────────────────────────────────────────────────────────────────────────────────

export interface CloseActor {
  tenantId: string;
  agentVersionId: string;
  runId: string | null;
  mode: "live" | "test";
}

interface ItemResult {
  key: string;
  kind: CloseItemKind;
  title: string;
  done: boolean;
  amount: string | null;
  count: number;
  summary: string;
  detail: Record<string, unknown>;
  sources: string[];
}

class TestRollback extends Error {
  constructor(readonly output: CheckOutput) {
    super("a test run keeps nothing");
  }
}

export interface CheckOutput {
  periodId: string;
  /** The month closed (yyyy-mm). */
  month: string;
  periodStart: string;
  periodEnd: string;
  status: "open" | "signed_off";
  /** One plain sentence: the result and its numbers. */
  summary: string;
  open: number;
  items: { key: string; title: string; status: CloseItemStatus; summary: string | null }[];
  proposed: number;
  posted: number;
  /** Entries proposed in this check. */
  added: number;
  readyToSignOff: boolean;
}

/**
 * Opens (or finds) the month's close and checks it again: what became of its entries' writes, the
 * entries it should propose (reversals of last month's accruals, last month's recurring journals,
 * accruals by the vendors' billing patterns), and each line of the checklist. A signed-off close is
 * only read. A test run answers what it would have found and keeps nothing.
 */
export async function checkClose(
  tx: Tx,
  actor: CloseActor,
  input: { month?: string | undefined; today: Date },
): Promise<CheckOutput> {
  const run = async (t: Tx) => doCheck(t, actor, input);
  if (actor.mode === "live") return run(tx);
  try {
    await tx.transaction(async (sp) => {
      throw new TestRollback(await run(sp as unknown as Tx));
    });
  } catch (error) {
    if (error instanceof TestRollback) return error.output;
    throw error;
  }
  throw new Error("unreachable");
}

async function doCheck(
  tx: Tx,
  actor: CloseActor,
  input: { month?: string | undefined; today: Date },
): Promise<CheckOutput> {
  const { tenantId } = actor;
  const tz = await clientTimezone(tx, tenantId);
  const { periodStart, asOf: periodEnd } = monthPeriod(input.today, input.month, tz);
  const conn = await closeConnection(tx, tenantId);
  if (!conn) throw new PackRefusal("there's no connected QuickBooks company to close");
  const snapshot = booksAsOf(
    await loadQboBooks(tx, { tenantId, connectionId: conn.id }),
    periodEnd,
  );
  const currency = snapshot.currency;
  await tx
    .insert(closePeriod)
    .values({ tenantId, connectionId: conn.id, periodStart, periodEnd, currency })
    .onConflictDoNothing();
  const [period] = await tx
    .select()
    .from(closePeriod)
    .where(
      and(
        eq(closePeriod.tenantId, tenantId),
        eq(closePeriod.connectionId, conn.id),
        eq(closePeriod.periodStart, periodStart),
      ),
    );
  if (!period) throw new Error("the close period vanished");
  if (period.status === "signed_off") return output(tx, tenantId, period.id, 0);

  await settleEntries(tx, tenantId, period.id);
  const config = await closeConfig(tx, tenantId);
  const accounts = await tx
    .select()
    .from(ledgerAccount)
    .where(and(eq(ledgerAccount.tenantId, tenantId), eq(ledgerAccount.connectionId, conn.id)));
  const byExternal = new Map(accounts.map((a) => [a.externalId, a]));

  // ── Proposals ──
  let added = 0;
  const base = {
    tenantId,
    periodId: period.id,
    currency,
    agentVersionId: actor.agentVersionId,
    runId: actor.runId,
  };
  const previous = await previousPeriod(tx, tenantId, conn.id, periodStart);
  if (previous) {
    const posted = await tx
      .select()
      .from(closeEntry)
      .where(
        and(
          eq(closeEntry.tenantId, tenantId),
          eq(closeEntry.periodId, previous.id),
          eq(closeEntry.status, "posted"),
        ),
      )
      .orderBy(asc(closeEntry.createdAt));
    const lines = await linesOf(
      tx,
      tenantId,
      posted.map((e) => e.id),
    );
    for (const e of posted) {
      const ls = lines.get(e.id) ?? [];
      if (
        e.kind === "accrual" &&
        e.reverseOn &&
        e.reverseOn >= periodStart &&
        e.reverseOn <= periodEnd
      ) {
        // DECISION: an accrual posted last month is reversed on its `reverse_on` day (this month's
        // first), each line's side swapped, so the real bill books against it.
        const id = await proposeEntry(
          tx,
          {
            ...base,
            kind: "reversal",
            entryKey: `reversal:${e.id}`,
            proposedBy: "repeat",
            txnDate: e.reverseOn,
            memo: `Reversal: ${e.memo}`.slice(0, 400),
            reason: `Reverses last month's accrual (${moneyWords(e.amount, e.currency)}, QuickBooks journal ${e.qboId}).`,
            fromEntryId: e.id,
            sources: [e.id, ...e.sources],
            lines: ls.map((l) => ({
              ledgerAccountId: l.ledgerAccountId,
              posting: l.posting === "debit" ? "credit" : "debit",
              amount: l.amount,
              description: l.description,
            })),
          },
          conn.id,
        );
        if (id) added++;
      }
      if (e.kind === "recurring") {
        // DECISION: a recurring journal posted last month is proposed again at this month's end,
        // the same lines and memo, keeping its key, until a person turns it down.
        const id = await proposeEntry(
          tx,
          {
            ...base,
            kind: "recurring",
            entryKey: e.entryKey,
            proposedBy: "repeat",
            txnDate: periodEnd,
            memo: e.memo,
            reason: `Repeats last month's journal (${moneyWords(e.amount, e.currency)}, QuickBooks journal ${e.qboId}).`,
            fromEntryId: e.id,
            sources: [e.id],
            lines: ls.map((l) => ({
              ledgerAccountId: l.ledgerAccountId,
              posting: l.posting,
              amount: l.amount,
              description: l.description,
            })),
          },
          conn.id,
        );
        if (id) added++;
      }
    }
  }
  let accrualNote: string | null = null;
  if (config.accruals) {
    const name = config.accrualAccount.toLowerCase();
    const liability = accounts.find(
      (a) =>
        a.active &&
        a.classification === "liability" &&
        [a.name, a.fullName, a.number].some((n) => n?.toLowerCase() === name),
    );
    const patterns = accrualPatterns(
      snapshot,
      { start: periodStart, end: periodEnd },
      config.accrualMonths,
    );
    if (!liability && patterns.length > 0) {
      accrualNote = `No liability account named "${config.accrualAccount}" in QuickBooks, so ${patterns.length} accruals weren't proposed.`;
    }
    for (const p of patterns) {
      if (!liability) break;
      const expense = byExternal.get(p.accountId);
      if (!expense?.active) continue;
      const id = await proposeEntry(
        tx,
        {
          ...base,
          kind: "accrual",
          entryKey: p.key,
          proposedBy: "pattern",
          txnDate: periodEnd,
          reverseOn: nextDay(periodEnd),
          memo: `Accrued ${p.vendorName}, ${monthWords(periodStart.slice(0, 7))}`,
          reason: `${p.vendorName} billed ${expense.fullName} every month before (${p.months
            .map((m) => moneyWords(m.amount, currency))
            .join(", ")}) and hasn't billed ${monthWords(periodStart.slice(0, 7))} yet.`,
          sources: p.sources,
          lines: [
            {
              ledgerAccountId: expense.id,
              posting: "debit",
              amount: dec(p.amount).toFixed(2),
              description: p.vendorName,
            },
            {
              ledgerAccountId: liability.id,
              posting: "credit",
              amount: dec(p.amount).toFixed(2),
              description: p.vendorName,
            },
          ],
        },
        conn.id,
      );
      if (id) added++;
    }
  }

  // ── The checklist ──
  const results: ItemResult[] = [];
  results.push(...(await reconciliationItems(tx, tenantId, conn.id, accounts, periodEnd)));
  const report = checkBooks(snapshot, {
    asOf: periodEnd,
    checks: ["uncategorized", "duplicate_bills", "duplicate_vendors"],
  });
  const finding = (id: string) => report.findings.find((f) => f.check === id) ?? null;
  results.push(
    fromFinding(
      "uncategorized",
      "uncategorized",
      "Every transaction categorized",
      finding("uncategorized"),
      `No uncategorized transactions through ${dayWords(periodEnd)}.`,
    ),
    fromFinding(
      "duplicate_bills",
      "duplicates",
      "No bills entered twice",
      finding("duplicate_bills"),
      "No bill looks entered twice.",
    ),
    fromFinding(
      "duplicate_vendors",
      "duplicates",
      "No vendors kept twice",
      finding("duplicate_vendors"),
      "No vendor looks kept twice.",
    ),
  );
  results.push(await unbookedItem(tx, tenantId, periodStart, periodEnd, currency));
  results.push(await entriesItem(tx, tenantId, period.id, currency, accrualNote));

  const existing = new Map(
    (
      await tx
        .select()
        .from(closeItem)
        .where(and(eq(closeItem.tenantId, tenantId), eq(closeItem.periodId, period.id)))
    ).map((i) => [i.key, i]),
  );
  const now = new Date();
  for (const r of results) {
    const was = existing.get(r.key);
    // A person's waiver stands while the line is still open; once it is done, it is just done.
    const waived = !r.done && was?.status === "waived";
    const values = {
      title: r.title,
      status: (r.done ? "done" : waived ? "waived" : "open") as CloseItemStatus,
      amount: r.amount,
      count: r.count,
      summary: r.summary,
      detail: r.detail,
      sources: r.sources,
      agentVersionId: actor.agentVersionId,
      checkedAt: now,
      waivedBy: waived ? (was?.waivedBy ?? null) : null,
      note: waived ? (was?.note ?? null) : null,
      updatedAt: now,
    };
    if (was) {
      await tx
        .update(closeItem)
        .set(values)
        .where(and(eq(closeItem.id, was.id), eq(closeItem.tenantId, tenantId)));
    } else {
      await tx
        .insert(closeItem)
        .values({ tenantId, periodId: period.id, key: r.key, kind: r.kind, ...values });
    }
  }
  await tx
    .update(closePeriod)
    .set({
      agentVersionId: actor.agentVersionId,
      runId: actor.runId,
      checkedAt: now,
      updatedAt: now,
    })
    .where(and(eq(closePeriod.id, period.id), eq(closePeriod.tenantId, tenantId)));
  return output(tx, tenantId, period.id, added);
}

async function previousPeriod(tx: Tx, tenantId: string, connectionId: string, periodStart: string) {
  const start = monthBounds(monthsBefore(periodStart.slice(0, 7), 1)).start;
  const [p] = await tx
    .select({ id: closePeriod.id })
    .from(closePeriod)
    .where(
      and(
        eq(closePeriod.tenantId, tenantId),
        eq(closePeriod.connectionId, connectionId),
        eq(closePeriod.periodStart, start),
      ),
    );
  return p ?? null;
}

function fromFinding(
  key: string,
  kind: CloseItemKind,
  title: string,
  f: BooksFinding | null,
  clean: string,
): ItemResult {
  if (!f) {
    return {
      key,
      kind,
      title,
      done: true,
      amount: "0.0000",
      count: 0,
      summary: clean,
      detail: {},
      sources: [],
    };
  }
  return {
    key,
    kind,
    title,
    done: false,
    amount: dec(f.amount).toFixed(4),
    count: f.count,
    summary: f.summary,
    detail: { examples: f.examples, groups: f.groups },
    sources: f.sources,
  };
}

/** One line per active bank and card account: reconciled with us through the period's end. */
// DECISION: done when a reconciliation of the account as of the period's end (or later) is signed
// off, or balanced (a balanced month asks nobody, §1.80); an open one with something left says how
// much isn't explained yet. Read from the Bookkeeping area's reconciliations by the pair key's
// QuickBooks side (`qbo:<connection>:<account>`), as books health reads them.
async function reconciliationItems(
  tx: Tx,
  tenantId: string,
  connectionId: string,
  accounts: (typeof ledgerAccount.$inferSelect)[],
  periodEnd: string,
): Promise<ItemResult[]> {
  const money = accounts
    .filter((a) => a.active && (a.kind === "bank" || a.kind === "card"))
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
  if (money.length === 0) return [];
  const recs = await tx
    .select({
      id: reconciliation.id,
      pairKey: reconciliation.pairKey,
      asOf: reconciliation.asOf,
      status: reconciliation.status,
      outcome: reconciliation.outcome,
      residual: reconciliation.residual,
      currency: reconciliation.currency,
    })
    .from(reconciliation)
    .where(
      and(
        eq(reconciliation.tenantId, tenantId),
        sql`${reconciliation.status} <> 'superseded'`,
        sql`${reconciliation.asOf} >= ${periodEnd}`,
        sql`strpos(${reconciliation.pairKey}, ${`|qbo:${connectionId}:`}) > 0`,
      ),
    )
    .orderBy(desc(reconciliation.asOf));
  return money.map((a) => {
    const mine = recs.filter((r) => r.pairKey.endsWith(`|qbo:${connectionId}:${a.externalId}`));
    const settled = mine.find(
      (r) => r.status === "signed_off" || (r.status === "open" && r.outcome === "balanced"),
    );
    const open = mine.find((r) => r.status === "open" && r.outcome !== "balanced");
    const base = {
      key: `reconciliation:${a.id}`,
      kind: "reconciliation" as const,
      title: `${a.fullName} reconciled`,
    };
    if (settled) {
      return {
        ...base,
        done: true,
        amount: "0.0000",
        count: 0,
        summary: `${a.fullName} is reconciled through ${dayWords(settled.asOf)}.`,
        detail: { reconciliationId: settled.id },
        sources: [settled.id],
      };
    }
    if (open) {
      return {
        ...base,
        done: false,
        amount: dec(open.residual).abs().toFixed(4),
        count: 1,
        summary: dec(open.residual).isZero()
          ? `${a.fullName} is explained and waiting for a person to sign it off.`
          : `${a.fullName}: ${moneyWords(dec(open.residual).abs().toFixed(4), open.currency)} isn't explained yet.`,
        detail: { reconciliationId: open.id },
        sources: [open.id],
      };
    }
    return {
      ...base,
      done: false,
      amount: null,
      count: 1,
      summary: `${a.fullName} isn't reconciled through ${dayWords(periodEnd)} yet.`,
      detail: {},
      sources: [],
    };
  });
}

/** Bank and card transactions in the period on an account we book, not booked yet. */
async function unbookedItem(
  tx: Tx,
  tenantId: string,
  periodStart: string,
  periodEnd: string,
  currency: string,
): Promise<ItemResult> {
  const rows = await tx
    .select({ id: bankTxn.id, amount: bankTxn.amount })
    .from(bankTxn)
    .innerJoin(
      bankAccountLink,
      and(
        eq(bankAccountLink.id, bankTxn.accountLinkId),
        eq(bankAccountLink.tenantId, bankTxn.tenantId),
      ),
    )
    .where(
      and(
        eq(bankTxn.tenantId, tenantId),
        sql`${bankAccountLink.mode} <> 'off'`,
        sql`${bankTxn.txnDate} between ${periodStart} and ${periodEnd}`,
        inArray(bankTxn.status, ["new", "proposed", "needs_review", "approved"]),
      ),
    );
  const total = rows.reduce((s, r) => s.plus(dec(r.amount)), dec("0"));
  const base = {
    key: "unbooked",
    kind: "unbooked" as const,
    title: "Every bank transaction booked",
  };
  if (rows.length === 0) {
    return {
      ...base,
      done: true,
      amount: "0.0000",
      count: 0,
      summary: "Nothing from the bank feed waits to be booked.",
      detail: {},
      sources: [],
    };
  }
  return {
    ...base,
    done: false,
    amount: total.toFixed(4),
    count: rows.length,
    summary: `${rows.length} bank transactions (${moneyWords(total.toFixed(4), currency)}) aren't booked yet.`,
    detail: {},
    sources: rows.slice(0, 50).map((r) => r.id),
  };
}

/** Every entry of the period decided: posted, or turned down. */
async function entriesItem(
  tx: Tx,
  tenantId: string,
  periodId: string,
  currency: string,
  note: string | null,
): Promise<ItemResult> {
  const rows = await tx
    .select({ id: closeEntry.id, status: closeEntry.status, amount: closeEntry.amount })
    .from(closeEntry)
    .where(and(eq(closeEntry.tenantId, tenantId), eq(closeEntry.periodId, periodId)));
  const waiting = rows.filter((r) => r.status === "proposed" || r.status === "failed");
  const posted = rows.filter((r) => r.status === "posted").length;
  const total = waiting.reduce((s, r) => s.plus(dec(r.amount)), dec("0"));
  const base = {
    key: "entries",
    kind: "entries" as const,
    title: "Accruals and recurring journals decided",
  };
  const tail = note ? ` ${note}` : "";
  if (waiting.length === 0) {
    return {
      ...base,
      done: true,
      amount: "0.0000",
      count: 0,
      summary:
        (posted > 0
          ? `${posted} journal entries recorded in QuickBooks.`
          : "No journal entries to record this month.") + tail,
      detail: {},
      sources: rows.map((r) => r.id),
    };
  }
  return {
    ...base,
    done: false,
    amount: total.toFixed(4),
    count: waiting.length,
    summary: `${waiting.length} journal entries (${moneyWords(total.toFixed(4), currency)}) wait for a signature.${tail}`,
    detail: {},
    sources: waiting.map((r) => r.id),
  };
}

async function output(
  tx: Tx,
  tenantId: string,
  periodId: string,
  added: number,
): Promise<CheckOutput> {
  const view = await closeView(tx, tenantId, periodId);
  if (!view) throw new Error("the close period vanished");
  const p = view.period;
  const month = monthWords(p.periodStart.slice(0, 7));
  const summary =
    p.status === "signed_off"
      ? `${month} is closed: signed off.`
      : view.open === 0
        ? `${month} is ready to sign off: every line is done.`
        : `${month}: ${view.open} of ${view.items.length} lines still open.`;
  return {
    periodId,
    month: p.periodStart.slice(0, 7),
    periodStart: p.periodStart,
    periodEnd: p.periodEnd,
    status: p.status,
    summary,
    open: view.open,
    items: view.items.map((i) => ({
      key: i.key,
      title: i.title,
      status: i.status,
      summary: i.summary,
    })),
    proposed: view.entries.filter((e) => e.status === "proposed").length,
    posted: view.entries.filter((e) => e.status === "posted").length,
    added,
    readyToSignOff: view.readyToSignOff,
  };
}

// ── What a person sees ──────────────────────────────────────────────────────────────────────────

export interface EntryLineView {
  ledgerAccountId: string;
  accountName: string;
  accountExternalId: string;
  posting: "debit" | "credit";
  amount: string;
  description: string | null;
}

/**
 * One close as the card and the report show it: the checklist, the entries with their lines, and
 * whether it can be signed off and what stops it. No agent, prompt or cost (invariant 11).
 */
export async function closeView(tx: Tx, tenantId: string, periodId: string) {
  const [p] = await tx
    .select({
      id: closePeriod.id,
      periodStart: closePeriod.periodStart,
      periodEnd: closePeriod.periodEnd,
      currency: closePeriod.currency,
      status: closePeriod.status,
      checkedAt: closePeriod.checkedAt,
      signedOffAt: closePeriod.signedOffAt,
      signedOffBy: appUser.name,
      note: closePeriod.note,
    })
    .from(closePeriod)
    .leftJoin(appUser, eq(appUser.id, closePeriod.signedOffBy))
    .where(and(eq(closePeriod.id, periodId), eq(closePeriod.tenantId, tenantId)));
  if (!p) return null;
  const items = await tx
    .select()
    .from(closeItem)
    .where(and(eq(closeItem.tenantId, tenantId), eq(closeItem.periodId, periodId)))
    .orderBy(asc(closeItem.createdAt), asc(closeItem.key));
  const entries = await tx
    .select()
    .from(closeEntry)
    .where(
      and(
        eq(closeEntry.tenantId, tenantId),
        eq(closeEntry.periodId, periodId),
        sql`${closeEntry.status} <> 'superseded'`,
      ),
    )
    .orderBy(asc(closeEntry.txnDate), asc(closeEntry.createdAt));
  const lines = await linesOf(
    tx,
    tenantId,
    entries.map((e) => e.id),
  );
  const writes = await writesOf(
    tx,
    tenantId,
    entries.map((e) => e.id),
  );
  const open = items.filter((i) => i.status === "open").length;
  const undecided = entries.filter((e) => e.status === "proposed" || e.status === "failed").length;
  const blockers: string[] = [];
  if (items.length === 0) blockers.push("The checklist hasn't been checked yet.");
  if (open > 0) blockers.push(`${open} checklist lines are still open: finish or waive each.`);
  if (undecided > 0)
    blockers.push(`${undecided} journal entries aren't decided: sign or turn down each.`);
  return {
    period: {
      id: p.id,
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
      currency: p.currency,
      status: p.status,
      checkedAt: p.checkedAt?.toISOString() ?? null,
      signedOffAt: p.signedOffAt?.toISOString() ?? null,
      signedOffBy: p.signedOffBy ?? null,
      note: p.note,
    },
    items: items.map((i) => ({
      id: i.id,
      key: i.key,
      kind: i.kind,
      title: i.title,
      status: i.status,
      amount: i.amount,
      count: i.count,
      summary: i.summary,
      detail: i.detail,
      sources: i.sources,
      note: i.note,
    })),
    entries: entries.map((e) => {
      const w = writes.get(e.id);
      return {
        id: e.id,
        kind: e.kind,
        status: e.status,
        proposedBy: e.proposedBy,
        txnDate: e.txnDate,
        reverseOn: e.reverseOn,
        amount: e.amount,
        currency: e.currency,
        memo: e.memo,
        reason: e.reason,
        sources: e.sources,
        qboId: e.qboId,
        error: e.error,
        /** The write's state while it isn't recorded here yet: waiting for a signature, being made. */
        write: w && LIVE_WRITE.has(w.status) && e.status === "proposed" ? w.status : null,
        lines: (lines.get(e.id) ?? []).map((l) => ({
          accountName: l.accountName,
          posting: l.posting,
          amount: l.amount,
          description: l.description,
        })),
      };
    }),
    open,
    readyToSignOff: p.status === "open" && blockers.length === 0,
    blockers: p.status === "open" ? blockers : [],
  };
}

export type CloseView = NonNullable<Awaited<ReturnType<typeof closeView>>>;

/** The client's closes, newest first. */
export async function closeList(tx: Tx, tenantId: string, limit = 24) {
  const rows = await tx
    .select({
      id: closePeriod.id,
      periodStart: closePeriod.periodStart,
      periodEnd: closePeriod.periodEnd,
      status: closePeriod.status,
      signedOffAt: closePeriod.signedOffAt,
      open: sql<number>`(select count(*)::int from ${closeItem} i where i.period_id = ${closePeriod.id} and i.tenant_id = ${closePeriod.tenantId} and i.status = 'open')`,
      items: sql<number>`(select count(*)::int from ${closeItem} i where i.period_id = ${closePeriod.id} and i.tenant_id = ${closePeriod.tenantId})`,
    })
    .from(closePeriod)
    .where(eq(closePeriod.tenantId, tenantId))
    .orderBy(desc(closePeriod.periodStart))
    .limit(limit);
  return rows.map((r) => ({ ...r, signedOffAt: r.signedOffAt?.toISOString() ?? null }));
}

// ── A person's decisions on the card ─────────────────────────────────────────────────────────────

export type CloseDecision =
  | { action: "waive"; input: { itemId: string; note: string } }
  | { action: "unwaive"; input: { itemId: string } }
  | { action: "reject"; input: { entryId: string } }
  | { action: "sign_off"; input: { note?: string | null | undefined } };

export async function decideClose(
  tx: Tx,
  who: { tenantId: string; userId: string },
  periodId: string,
  d: CloseDecision,
): Promise<void> {
  const { tenantId } = who;
  const [p] = await tx
    .select({ status: closePeriod.status })
    .from(closePeriod)
    .where(and(eq(closePeriod.id, periodId), eq(closePeriod.tenantId, tenantId)))
    .for("update");
  if (!p) throw new PackRefusal(`close ${periodId} isn't this client's`);
  if (p.status === "signed_off") throw new PackRefusal("this month is signed off; nothing changes");
  const now = new Date();
  if (d.action === "waive" || d.action === "unwaive") {
    const [i] = await tx
      .select({ status: closeItem.status })
      .from(closeItem)
      .where(
        and(
          eq(closeItem.id, d.input.itemId),
          eq(closeItem.tenantId, tenantId),
          eq(closeItem.periodId, periodId),
        ),
      );
    if (!i) throw new PackRefusal("that line isn't on this month's checklist");
    if (d.action === "waive") {
      if (i.status !== "open") throw new PackRefusal("only an open line is waived");
      await tx
        .update(closeItem)
        .set({
          status: "waived",
          waivedBy: who.userId,
          note: d.input.note.trim().slice(0, 500),
          updatedAt: now,
        })
        .where(and(eq(closeItem.id, d.input.itemId), eq(closeItem.tenantId, tenantId)));
    } else {
      if (i.status !== "waived") throw new PackRefusal("that line isn't waived");
      await tx
        .update(closeItem)
        .set({ status: "open", waivedBy: null, note: null, updatedAt: now })
        .where(and(eq(closeItem.id, d.input.itemId), eq(closeItem.tenantId, tenantId)));
    }
    return;
  }
  await settleEntries(tx, tenantId, periodId);
  if (d.action === "reject") {
    const [e] = await tx
      .select({ status: closeEntry.status })
      .from(closeEntry)
      .where(
        and(
          eq(closeEntry.id, d.input.entryId),
          eq(closeEntry.tenantId, tenantId),
          eq(closeEntry.periodId, periodId),
        ),
      );
    if (!e) throw new PackRefusal("that entry isn't this month's");
    if (e.status !== "proposed" && e.status !== "failed") {
      throw new PackRefusal(`that entry is already ${e.status}`);
    }
    const w = (await writesOf(tx, tenantId, [d.input.entryId])).get(d.input.entryId);
    if (w && LIVE_WRITE.has(w.status)) {
      throw new PackRefusal(
        "its QuickBooks write is waiting for a signature or being made: decide it there",
      );
    }
    await tx
      .update(closeEntry)
      .set({ status: "rejected", userId: who.userId, decidedAt: now })
      .where(and(eq(closeEntry.id, d.input.entryId), eq(closeEntry.tenantId, tenantId)));
    await refreshEntriesItem(tx, tenantId, periodId);
    return;
  }
  // sign_off
  await refreshEntriesItem(tx, tenantId, periodId);
  const view = await closeView(tx, tenantId, periodId);
  if (!view?.readyToSignOff) {
    throw new PackRefusal(view?.blockers.join(" ") || "this month can't be signed off yet");
  }
  await tx
    .update(closePeriod)
    .set({
      status: "signed_off",
      signedOffBy: who.userId,
      signedOffAt: now,
      note: d.input.note?.trim() ? d.input.note.trim().slice(0, 1000) : null,
      updatedAt: now,
    })
    .where(and(eq(closePeriod.id, periodId), eq(closePeriod.tenantId, tenantId)));
}

/** The entries line again, after a decision on an entry (the rest wait for the next check). */
async function refreshEntriesItem(tx: Tx, tenantId: string, periodId: string): Promise<void> {
  const [was] = await tx
    .select()
    .from(closeItem)
    .where(
      and(
        eq(closeItem.tenantId, tenantId),
        eq(closeItem.periodId, periodId),
        eq(closeItem.key, "entries"),
      ),
    );
  if (!was) return;
  const [p] = await tx
    .select({ currency: closePeriod.currency })
    .from(closePeriod)
    .where(and(eq(closePeriod.id, periodId), eq(closePeriod.tenantId, tenantId)));
  const r = await entriesItem(tx, tenantId, periodId, p?.currency ?? "USD", null);
  const waived = !r.done && was.status === "waived";
  await tx
    .update(closeItem)
    .set({
      status: r.done ? "done" : waived ? "waived" : "open",
      amount: r.amount,
      count: r.count,
      summary: r.summary,
      sources: r.sources,
      waivedBy: waived ? was.waivedBy : null,
      note: waived ? was.note : null,
      updatedAt: new Date(),
    })
    .where(and(eq(closeItem.id, was.id), eq(closeItem.tenantId, tenantId)));
}
