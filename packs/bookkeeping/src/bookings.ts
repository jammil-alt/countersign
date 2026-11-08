// Deciding how each bank transaction is booked (docs/plan.md §1.79), in invariant 7's order:
// a record already in the accounting tool (match), a move between two of the client's accounts on
// the feed (transfer), the client's rule for the payee, then the model's proposal, and a person
// last. Every decision is a `booking` with its lines; nothing here writes to the accounting tool.

import { dec, toNumeric } from "@countersign/core";
import { ledgerAccount, type Tx, transaction } from "@countersign/db";
import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { activeAccount, addNote } from "./accounts";
import { PackRefusal } from "./pack";
import { payeeKey } from "./payee";
import {
  type BankTxnStatus,
  type BookingKind,
  bankAccountLink,
  bankTxn,
  booking,
  bookingLine,
  bookingRule,
  type DecidedBy,
  type Direction,
  LIVE_BOOKING_STATUSES,
} from "./schema";

/** A proposal at or above this confidence waits as `proposed`; below it, a person decides. */
export const BOOK_CONFIDENCE_AUTO = 0.85;
/** How many days apart a bank's date and the accounting record's may be and still match. */
export const MATCH_DAYS = 3;
/** Approvals of one payee to one account, with no other, that make a learned rule. */
export const LEARN_AFTER = 2;
/** Account types that are a bank or card account: a booking to one is a transfer. */
export const MONEY_ACCOUNT_TYPES = ["Bank", "Credit Card"] as const;

export interface Decider {
  tenantId: string;
  agentVersionId: string;
  runId: string | null;
}

export interface LineInput {
  ledgerAccountId: string;
  /** Absent on a single line: the whole amount. */
  amount?: string | undefined;
  classRef?: string | null | undefined;
  customerRef?: string | null | undefined;
  description?: string | null | undefined;
}

type TxnRow = typeof bankTxn.$inferSelect;
type LinkRow = typeof bankAccountLink.$inferSelect;

/** Statuses a decision may still be made or changed in. */
const DECIDABLE: readonly BankTxnStatus[] = [
  "new",
  "skipped",
  "proposed",
  "needs_review",
  "approved",
];

/** The kind a booking to this account is, for money going this way. */
export function kindFor(direction: Direction, accountType: string): BookingKind {
  if ((MONEY_ACCOUNT_TYPES as readonly string[]).includes(accountType)) return "transfer";
  return direction === "out" ? "expense" : "deposit";
}

async function txnOf(tx: Tx, tenantId: string, id: string): Promise<TxnRow> {
  const [t] = await tx
    .select()
    .from(bankTxn)
    .where(and(eq(bankTxn.tenantId, tenantId), eq(bankTxn.id, id)));
  if (!t) throw new PackRefusal(`transaction ${id} isn't one of this client's`);
  return t;
}

async function linkOf(tx: Tx, tenantId: string, id: string): Promise<LinkRow> {
  const [l] = await tx
    .select()
    .from(bankAccountLink)
    .where(and(eq(bankAccountLink.tenantId, tenantId), eq(bankAccountLink.id, id)));
  if (!l) throw new Error(`bank account link ${id} not found`);
  return l;
}

async function setStatus(
  tx: Tx,
  tenantId: string,
  id: string,
  status: BankTxnStatus,
  ext?: Record<string, unknown>,
): Promise<void> {
  await tx
    .update(bankTxn)
    .set({ status, updatedAt: sql`now()`, ...(ext ? { ext } : {}) })
    .where(and(eq(bankTxn.tenantId, tenantId), eq(bankTxn.id, id)));
}

/** The booking that stands for a transaction now, if any. */
export async function liveBooking(tx: Tx, tenantId: string, bankTxnId: string) {
  const [b] = await tx
    .select()
    .from(booking)
    .where(
      and(
        eq(booking.tenantId, tenantId),
        eq(booking.bankTxnId, bankTxnId),
        inArray(booking.status, [...LIVE_BOOKING_STATUSES]),
      ),
    );
  return b ?? null;
}

/** Lines checked: the client's active accounts, positive amounts that add up to the total. */
async function checkLines(
  tx: Tx,
  tenantId: string,
  t: TxnRow,
  lines: readonly LineInput[],
): Promise<{ lines: (LineInput & { amount: string })[]; types: string[] }> {
  if (lines.length === 0) throw new PackRefusal("a booking has at least one line");
  if (lines.length > 20) throw new PackRefusal("a booking has at most 20 lines");
  const total = dec(t.amount);
  const out: (LineInput & { ledgerAccountId: string; amount: string })[] = [];
  const types: string[] = [];
  for (const l of lines) {
    const account = await activeAccount(tx, tenantId, l.ledgerAccountId);
    types.push(account.accountType);
    const amount = l.amount ?? (lines.length === 1 ? t.amount : undefined);
    if (amount === undefined) throw new PackRefusal("each line of a split says its amount");
    const a = dec(amount);
    if (!a.isFinite() || a.lte(0)) throw new PackRefusal("a line's amount is more than zero");
    if (a.decimalPlaces() > 4) throw new PackRefusal("a line's amount has at most 4 decimals");
    out.push({ ...l, amount: toNumeric(a) });
  }
  const sum = out.reduce((s, l) => s.plus(dec(l.amount)), dec("0"));
  // Invariant 6: decimal, to the cent and below; never a float's "close enough".
  if (!sum.eq(total)) {
    throw new PackRefusal(
      `the lines add up to ${toNumeric(sum)}, not the transaction's ${t.amount}`,
    );
  }
  return { lines: out, types };
}

interface NewBooking {
  kind: BookingKind;
  status: "proposed" | "approved" | "posted";
  decidedBy: DecidedBy;
  confidence: number;
  ruleId?: string | null;
  matchedTransactionId?: string | null;
  transferLinkId?: string | null;
  vendorId?: string | null;
  memo?: string | null;
  reason?: string | null;
  alternatives?: readonly string[];
  sources?: readonly string[];
  agentVersionId?: string | null;
  runId?: string | null;
  userId?: string | null;
  qboEntity?: string | null;
  qboId?: string | null;
}

async function insertBooking(
  tx: Tx,
  tenantId: string,
  t: TxnRow,
  b: NewBooking,
  lines: readonly (LineInput & { amount: string })[],
): Promise<string> {
  const now = new Date();
  const [row] = await tx
    .insert(booking)
    .values({
      tenantId,
      bankTxnId: t.id,
      kind: b.kind,
      status: b.status,
      decidedBy: b.decidedBy,
      confidence: b.confidence.toFixed(3),
      ruleId: b.ruleId ?? null,
      matchedTransactionId: b.matchedTransactionId ?? null,
      transferLinkId: b.transferLinkId ?? null,
      vendorId: b.vendorId ?? null,
      memo: b.memo ?? null,
      reason: b.reason ?? null,
      alternatives: [...(b.alternatives ?? [])],
      // Invariant 10: the transaction's raw record is always among the sources.
      sources: [...new Set([t.rawRecordId, ...(b.sources ?? [])])],
      agentVersionId: b.agentVersionId ?? null,
      runId: b.runId ?? null,
      userId: b.userId ?? null,
      qboEntity: b.qboEntity ?? null,
      qboId: b.qboId ?? null,
      decidedAt: b.status === "proposed" ? null : now,
      postedAt: b.status === "posted" ? now : null,
    })
    .returning({ id: booking.id });
  if (!row) throw new Error("booking not stored");
  let n = 1;
  for (const l of lines) {
    await tx.insert(bookingLine).values({
      tenantId,
      bookingId: row.id,
      lineNo: n++,
      ledgerAccountId: l.ledgerAccountId,
      amount: l.amount,
      classRef: l.classRef ?? null,
      customerRef: l.customerRef ?? null,
      description: l.description ?? null,
    });
  }
  return row.id;
}

/** The standing proposal (or approval, not yet posted) gives way to a new decision. */
async function supersede(tx: Tx, tenantId: string, bankTxnId: string): Promise<void> {
  await tx
    .update(booking)
    .set({ status: "superseded", decidedAt: sql`now()` })
    .where(
      and(
        eq(booking.tenantId, tenantId),
        eq(booking.bankTxnId, bankTxnId),
        inArray(booking.status, ["proposed", "approved"]),
      ),
    );
}

// ── Settling: what code decides ──────────────────────────────────────────────────────────────────

export interface SettleResult {
  checked: number;
  skipped: number;
  matched: number;
  transfers: number;
  ruled: number;
  /** Still to decide: for the model, then a person. */
  open: string[];
}

/**
 * The client's undecided transactions, through the steps code decides: off or too early
 * (`skipped`), already in the accounting tool (`matched`), a transfer between two of its accounts
 * on the feed, a rule. What is left stays `new` for the model.
 */
export async function settle(
  tx: Tx,
  who: Decider,
  opts: { limit?: number; testRun?: boolean } = {},
): Promise<SettleResult> {
  const { tenantId } = who;
  const result: SettleResult = {
    checked: 0,
    skipped: 0,
    matched: 0,
    transfers: 0,
    ruled: 0,
    open: [],
  };
  // DECISION: a proposal on an account set to `suggest` waits for the client to enter it in the
  // accounting tool; once it is there, the match step finds it and the proposal gives way.
  const txns = await tx
    .select()
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
        or(
          inArray(bankTxn.status, ["new", "skipped"]),
          and(
            inArray(bankTxn.status, ["proposed", "needs_review"]),
            eq(bankAccountLink.mode, "suggest"),
          ),
        ),
      ),
    )
    .orderBy(asc(bankTxn.txnDate), asc(bankTxn.id))
    .limit(opts.limit ?? 500);
  const links = new Map<string, LinkRow>();
  const used = new Set<string>();
  for (const { bank_txn: t } of txns) {
    if (used.has(t.id)) continue;
    result.checked += 1;
    const link = links.get(t.accountLinkId) ?? (await linkOf(tx, tenantId, t.accountLinkId));
    links.set(link.id, link);
    const on =
      link.mode !== "off" &&
      link.ledgerAccountId !== null &&
      (link.bookFrom === null || t.txnDate >= link.bookFrom);
    if (!on) {
      if (t.status !== "skipped") {
        result.skipped += 1;
        if (!opts.testRun) await setStatus(tx, tenantId, t.id, "skipped");
      }
      continue;
    }
    if (t.status === "proposed" || t.status === "needs_review") {
      // Only a match changes it now; otherwise the proposal stands.
      if (await matchExisting(tx, who, t, link, opts.testRun, true)) result.matched += 1;
      continue;
    }
    if (await matchExisting(tx, who, t, link, opts.testRun)) {
      result.matched += 1;
      continue;
    }
    const other = await transferPair(tx, who, t, link, used, opts.testRun);
    if (other) {
      used.add(other);
      result.transfers += 1;
      continue;
    }
    if (await applyRule(tx, who, t, opts.testRun)) {
      result.ruled += 1;
      continue;
    }
    result.open.push(t.id);
    if (t.status === "skipped" && !opts.testRun) await setStatus(tx, tenantId, t.id, "new");
  }
  return result;
}

/**
 * A record already in the accounting tool for this money: the same amount to the cent, dated
 * within MATCH_DAYS, paid from the linked account, and not matched to another transaction.
 */
async function matchExisting(
  tx: Tx,
  who: Decider,
  t: TxnRow,
  link: LinkRow,
  testRun = false,
  replacing = false,
): Promise<boolean> {
  if (!link.ledgerAccountId) return false;
  const [account] = await tx
    .select()
    .from(ledgerAccount)
    .where(
      and(eq(ledgerAccount.tenantId, who.tenantId), eq(ledgerAccount.id, link.ledgerAccountId)),
    );
  if (!account) return false;
  // Money out is a purchase paid from the account; money in, a refund (a credit) to it.
  // DECISION: deposits and transfers aren't synced from QuickBooks yet, so money in matches only a
  // card or bank credit; the rest goes on to rules and the model (docs/plan.md §1.79).
  const kind = t.direction === "out" ? "purchase" : "vendor_credit";
  const day = (n: number) => sql`(${t.txnDate}::date + ${n}::int)`;
  const candidates = await tx
    .select()
    .from(transaction)
    .where(
      and(
        eq(transaction.tenantId, who.tenantId),
        eq(transaction.connector, account.connector),
        eq(transaction.kind, kind),
        eq(transaction.total, t.amount),
        eq(transaction.currency, t.currency),
        gte(transaction.txnDate, day(-MATCH_DAYS)),
        lte(transaction.txnDate, day(MATCH_DAYS)),
        sql`coalesce((${transaction.ext} -> 'qbo' ->> 'deleted')::boolean, false) = false`,
        or(
          sql`${transaction.ext} -> 'qbo' ->> 'accountId' = ${account.externalId}`,
          and(
            sql`${transaction.ext} -> 'qbo' ->> 'accountId' is null`,
            eq(transaction.purchaserRef, account.name),
          ),
        ),
        sql`not exists (select 1 from ${booking} b where b.tenant_id = ${transaction.tenantId} and b.matched_transaction_id = ${transaction.id} and b.status in ('proposed', 'approved', 'posted'))`,
      ),
    )
    .orderBy(sql`abs(${transaction.txnDate} - ${t.txnDate}::date)`, asc(transaction.id))
    .limit(1);
  const found = candidates[0];
  if (!found) return false;
  if (testRun) return true;
  // A proposal the client has since entered themselves gives way to the match.
  if (replacing) await supersede(tx, who.tenantId, t.id);
  const qbo = (found.ext as { qbo?: { entity?: string; id?: string } }).qbo ?? {};
  await insertBooking(
    tx,
    who.tenantId,
    t,
    {
      kind: "match",
      status: "posted",
      decidedBy: "match",
      confidence: 1,
      matchedTransactionId: found.id,
      reason: "Already in the accounting tool: same amount, date within 3 days, same account",
      sources: [found.id, ...(found.sourceRawRecordId ? [found.sourceRawRecordId] : [])],
      agentVersionId: who.agentVersionId,
      runId: who.runId,
      qboEntity: qbo.entity ?? null,
      qboId: qbo.id ?? null,
    },
    [],
  );
  await setStatus(tx, who.tenantId, t.id, "matched");
  return true;
}

/**
 * Money out of one account on the feed and the same amount into another within MATCH_DAYS (a
 * card payment, a move to savings): one transfer, booked on the side the money left. Answers the
 * other side's id.
 */
async function transferPair(
  tx: Tx,
  who: Decider,
  t: TxnRow,
  link: LinkRow,
  used: ReadonlySet<string>,
  testRun = false,
): Promise<string | null> {
  const day = (n: number) => sql`(${t.txnDate}::date + ${n}::int)`;
  const others = await tx
    .select({ txn: bankTxn, link: bankAccountLink })
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
        eq(bankTxn.tenantId, who.tenantId),
        ne(bankTxn.accountLinkId, link.id),
        ne(bankAccountLink.mode, "off"),
        sql`${bankAccountLink.ledgerAccountId} is not null`,
        eq(bankTxn.direction, t.direction === "out" ? "in" : "out"),
        eq(bankTxn.amount, t.amount),
        eq(bankTxn.currency, t.currency),
        inArray(bankTxn.status, ["new", "skipped"]),
        gte(bankTxn.txnDate, day(-MATCH_DAYS)),
        lte(bankTxn.txnDate, day(MATCH_DAYS)),
      ),
    )
    .orderBy(sql`abs(${bankTxn.txnDate} - ${t.txnDate}::date)`, asc(bankTxn.id));
  const pair = others.find((o) => !used.has(o.txn.id));
  if (!pair?.link.ledgerAccountId || !link.ledgerAccountId) return null;
  if (testRun) return pair.txn.id;
  const [from, fromLink, to, toLink] =
    t.direction === "out" ? [t, link, pair.txn, pair.link] : [pair.txn, pair.link, t, link];
  const id = await insertBooking(
    tx,
    who.tenantId,
    from,
    {
      kind: "transfer",
      status: "proposed",
      decidedBy: "match",
      confidence: 0.9,
      transferLinkId: toLink.id,
      reason: `The same amount left ${fromLink.name ?? "one account"} and reached ${toLink.name ?? "another"} within 3 days`,
      sources: [to.rawRecordId],
      agentVersionId: who.agentVersionId,
      runId: who.runId,
    },
    [{ ledgerAccountId: toLink.ledgerAccountId ?? "", amount: from.amount }],
  );
  await setStatus(tx, who.tenantId, from.id, "proposed");
  await setStatus(tx, who.tenantId, to.id, "matched", { ...to.ext, transferBookingId: id });
  return pair.txn.id;
}

/** The client's rule for this payee: a person's before a learned one, an account's before any. */
export async function ruleFor(
  tx: Tx,
  tenantId: string,
  t: Pick<TxnRow, "payeeKey" | "direction" | "accountLinkId">,
) {
  if (!t.payeeKey) return null;
  const [rule] = await tx
    .select()
    .from(bookingRule)
    .where(
      and(
        eq(bookingRule.tenantId, tenantId),
        eq(bookingRule.active, true),
        eq(bookingRule.payeeKey, t.payeeKey),
        eq(bookingRule.direction, t.direction),
        or(isNull(bookingRule.accountLinkId), eq(bookingRule.accountLinkId, t.accountLinkId)),
      ),
    )
    .orderBy(
      sql`case when ${bookingRule.source} = 'person' then 0 else 1 end`,
      sql`case when ${bookingRule.accountLinkId} is null then 1 else 0 end`,
      desc(bookingRule.updatedAt),
    )
    .limit(1);
  return rule ?? null;
}

async function applyRule(tx: Tx, who: Decider, t: TxnRow, testRun = false): Promise<boolean> {
  const rule = await ruleFor(tx, who.tenantId, t);
  if (!rule) return false;
  const [account] = await tx
    .select()
    .from(ledgerAccount)
    .where(
      and(eq(ledgerAccount.tenantId, who.tenantId), eq(ledgerAccount.id, rule.ledgerAccountId)),
    );
  // A rule to an account made inactive since is left for the model and a person.
  if (!account?.active) return false;
  if (testRun) return true;
  await insertBooking(
    tx,
    who.tenantId,
    t,
    {
      kind: kindFor(t.direction, account.accountType),
      status: "proposed",
      decidedBy: "rule",
      confidence: 1,
      ruleId: rule.id,
      vendorId: rule.vendorId,
      memo: rule.memo,
      reason:
        rule.source === "person"
          ? "The client's rule for this payee"
          : "Learned from earlier approvals of this payee",
      sources: [rule.id],
      agentVersionId: who.agentVersionId,
      runId: who.runId,
    },
    [{ ledgerAccountId: account.id, amount: t.amount, classRef: rule.classRef }],
  );
  await tx
    .update(bookingRule)
    .set({ hits: sql`${bookingRule.hits} + 1` })
    .where(and(eq(bookingRule.tenantId, who.tenantId), eq(bookingRule.id, rule.id)));
  await setStatus(tx, who.tenantId, t.id, "proposed");
  return true;
}

// ── The model's proposal ─────────────────────────────────────────────────────────────────────────

export interface ProposeInput {
  bankTxnId: string;
  lines: LineInput[];
  vendorId?: string | null | undefined;
  memo?: string | null | undefined;
  confidence: number;
  reason: string;
  alternatives?: string[] | undefined;
  sources?: string[] | undefined;
}

/**
 * The model's booking for a transaction nobody has decided: `proposed` at or above the threshold,
 * else the transaction waits for a person (`needs_review`) with this as the suggestion.
 */
export async function propose(
  tx: Tx,
  who: Decider,
  input: ProposeInput,
  threshold: number = BOOK_CONFIDENCE_AUTO,
): Promise<{ bookingId: string; status: "proposed" | "needs_review" }> {
  const t = await txnOf(tx, who.tenantId, input.bankTxnId);
  if (!["new", "needs_review"].includes(t.status)) {
    throw new PackRefusal(
      `transaction ${t.id} is ${t.status}: only an undecided one is proposed for`,
    );
  }
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    throw new PackRefusal("confidence is between 0 and 1");
  }
  const { lines, types } = await checkLines(tx, who.tenantId, t, input.lines);
  const kind =
    lines.length === 1
      ? kindFor(t.direction, types[0] ?? "")
      : t.direction === "out"
        ? "expense"
        : "deposit";
  if (
    lines.length > 1 &&
    types.some((ty) => (MONEY_ACCOUNT_TYPES as readonly string[]).includes(ty))
  ) {
    throw new PackRefusal("a transfer has one line");
  }
  await supersede(tx, who.tenantId, t.id);
  const bookingId = await insertBooking(
    tx,
    who.tenantId,
    t,
    {
      kind,
      status: "proposed",
      decidedBy: "model",
      confidence: input.confidence,
      vendorId: input.vendorId ?? null,
      memo: input.memo ?? null,
      reason: input.reason.slice(0, 500),
      alternatives: (input.alternatives ?? [])
        .filter((a) => a !== lines[0]?.ledgerAccountId)
        .slice(0, 5),
      sources: input.sources ?? [],
      agentVersionId: who.agentVersionId,
      runId: who.runId,
    },
    lines,
  );
  const status = input.confidence >= threshold ? "proposed" : "needs_review";
  await setStatus(tx, who.tenantId, t.id, status);
  return { bookingId, status };
}

// ── A person's decision ──────────────────────────────────────────────────────────────────────────

export interface PersonDecision {
  tenantId: string;
  userId: string;
}

/** A person approves the standing proposal as it is. */
export async function approve(tx: Tx, who: PersonDecision, bankTxnId: string): Promise<string> {
  const t = await txnOf(tx, who.tenantId, bankTxnId);
  const live = await liveBooking(tx, who.tenantId, t.id);
  if (!live || live.status !== "proposed") {
    throw new PackRefusal("there's no proposal for this transaction to approve");
  }
  await tx
    .update(booking)
    .set({ status: "approved", userId: who.userId, decidedAt: sql`now()` })
    .where(and(eq(booking.tenantId, who.tenantId), eq(booking.id, live.id)));
  await setStatus(tx, who.tenantId, t.id, "approved");
  await learn(tx, who, t);
  return live.id;
}

export interface BookInput {
  bankTxnId: string;
  lines: LineInput[];
  vendorId?: string | null | undefined;
  memo?: string | null | undefined;
  /** In the person's words: kept as the client's note on the (first) account. */
  why?: string | null | undefined;
  /** Book this payee the same way from now on. */
  makeRule?: boolean | undefined;
}

/** A person books a transaction their way: approved at once, the proposal superseded. */
export async function bookByPerson(tx: Tx, who: PersonDecision, input: BookInput): Promise<string> {
  const t = await txnOf(tx, who.tenantId, input.bankTxnId);
  if (!DECIDABLE.includes(t.status) && t.status !== "pending") {
    throw new PackRefusal(`transaction ${t.id} is ${t.status} and can't be booked again`);
  }
  if (t.status === "pending") throw new PackRefusal("the bank hasn't posted this transaction yet");
  const { lines, types } = await checkLines(tx, who.tenantId, t, input.lines);
  const kind =
    lines.length === 1
      ? kindFor(t.direction, types[0] ?? "")
      : t.direction === "out"
        ? "expense"
        : "deposit";
  const before = await liveBooking(tx, who.tenantId, t.id);
  // A learned rule a person corrects is turned off: it was wrong at least once.
  if (before?.ruleId && before.decidedBy === "rule") {
    const [line] = await tx
      .select()
      .from(bookingLine)
      .where(and(eq(bookingLine.tenantId, who.tenantId), eq(bookingLine.bookingId, before.id)));
    if (line && line.ledgerAccountId !== lines[0]?.ledgerAccountId) {
      await tx
        .update(bookingRule)
        .set({ active: false, updatedAt: sql`now()` })
        .where(
          and(
            eq(bookingRule.tenantId, who.tenantId),
            eq(bookingRule.id, before.ruleId),
            eq(bookingRule.source, "learned"),
          ),
        );
    }
  }
  await supersede(tx, who.tenantId, t.id);
  const why = input.why?.replace(/\s+/g, " ").trim() || null;
  const id = await insertBooking(
    tx,
    who.tenantId,
    t,
    {
      kind,
      status: "approved",
      decidedBy: "person",
      confidence: 1,
      vendorId: input.vendorId ?? null,
      memo: input.memo ?? null,
      reason: why,
      userId: who.userId,
    },
    lines,
  );
  await setStatus(tx, who.tenantId, t.id, "approved");
  const first = lines[0];
  if (why && first) {
    await addNote(
      tx,
      who.tenantId,
      { ledgerAccountId: first.ledgerAccountId, note: why },
      { source: "client", userId: who.userId },
    );
  }
  if (input.makeRule && first && lines.length === 1) {
    if (!t.payeeKey) throw new PackRefusal("this transaction names no payee a rule could match");
    await addRule(tx, who, {
      payeeKey: t.payeeKey,
      direction: t.direction,
      ledgerAccountId: first.ledgerAccountId,
      vendorId: input.vendorId ?? null,
      classRef: first.classRef ?? null,
      memo: input.memo ?? null,
    });
  } else {
    await learn(tx, who, t);
  }
  return id;
}

/** A person says not to book it (a personal charge, a duplicate the bank shows). */
export async function exclude(
  tx: Tx,
  who: PersonDecision,
  input: { bankTxnId: string; why?: string | null | undefined },
): Promise<void> {
  const t = await txnOf(tx, who.tenantId, input.bankTxnId);
  if (!DECIDABLE.includes(t.status)) {
    throw new PackRefusal(`transaction ${t.id} is ${t.status} and can't be left out now`);
  }
  await tx
    .update(booking)
    .set({ status: "rejected", userId: who.userId, decidedAt: sql`now()` })
    .where(
      and(
        eq(booking.tenantId, who.tenantId),
        eq(booking.bankTxnId, t.id),
        inArray(booking.status, ["proposed", "approved"]),
      ),
    );
  const why = input.why?.replace(/\s+/g, " ").trim();
  await setStatus(tx, who.tenantId, t.id, "excluded", {
    ...t.ext,
    excludedBy: who.userId,
    ...(why ? { excludedWhy: why.slice(0, 500) } : {}),
  });
}

export interface RuleInput {
  payeeKey: string;
  direction: Direction;
  ledgerAccountId: string;
  accountLinkId?: string | null | undefined;
  vendorId?: string | null | undefined;
  classRef?: string | null | undefined;
  memo?: string | null | undefined;
}

/** A person's rule (it replaces their earlier one for the same payee, direction and account). */
export async function addRule(tx: Tx, who: PersonDecision, input: RuleInput): Promise<string> {
  const key = payeeKey(input.payeeKey);
  if (!key) throw new PackRefusal("say which payee the rule is for");
  await activeAccount(tx, who.tenantId, input.ledgerAccountId);
  if (input.accountLinkId) await linkOf(tx, who.tenantId, input.accountLinkId);
  await tx
    .update(bookingRule)
    .set({ active: false, updatedAt: sql`now()` })
    .where(
      and(
        eq(bookingRule.tenantId, who.tenantId),
        eq(bookingRule.payeeKey, key),
        eq(bookingRule.direction, input.direction),
        input.accountLinkId
          ? eq(bookingRule.accountLinkId, input.accountLinkId)
          : isNull(bookingRule.accountLinkId),
        eq(bookingRule.active, true),
      ),
    );
  const [row] = await tx
    .insert(bookingRule)
    .values({
      tenantId: who.tenantId,
      payeeKey: key,
      direction: input.direction,
      accountLinkId: input.accountLinkId ?? null,
      ledgerAccountId: input.ledgerAccountId,
      vendorId: input.vendorId ?? null,
      classRef: input.classRef ?? null,
      memo: input.memo ?? null,
      source: "person",
      createdBy: who.userId,
    })
    .returning({ id: bookingRule.id });
  if (!row) throw new Error("rule not stored");
  return row.id;
}

/**
 * After a person's approval: LEARN_AFTER approved bookings of one payee to one account, and none
 * to any other, make a learned rule (when no rule covers the payee yet).
 */
// DECISION: learned only from people's approvals of single-line bookings, so a model's guess never
// teaches itself; a person's correction turns the learned rule off (`bookByPerson`).
export async function learn(tx: Tx, who: PersonDecision, t: TxnRow): Promise<string | null> {
  if (!t.payeeKey) return null;
  if (await ruleFor(tx, who.tenantId, { ...t, accountLinkId: t.accountLinkId })) return null;
  const rows = await tx
    .select({
      bookingId: booking.id,
      accountId: bookingLine.ledgerAccountId,
      vendorId: booking.vendorId,
      lines: sql<number>`(select count(*)::int from booking_line l where l.tenant_id = ${booking.tenantId} and l.booking_id = ${booking.id})`,
    })
    .from(booking)
    .innerJoin(
      bankTxn,
      and(eq(bankTxn.id, booking.bankTxnId), eq(bankTxn.tenantId, booking.tenantId)),
    )
    .innerJoin(
      bookingLine,
      and(eq(bookingLine.bookingId, booking.id), eq(bookingLine.tenantId, booking.tenantId)),
    )
    .where(
      and(
        eq(booking.tenantId, who.tenantId),
        inArray(booking.status, ["approved", "posted"]),
        inArray(booking.kind, ["expense", "deposit"]),
        eq(bankTxn.payeeKey, t.payeeKey),
        eq(bankTxn.direction, t.direction),
        sql`${booking.userId} is not null`,
      ),
    )
    .orderBy(desc(booking.createdAt));
  if (rows.some((r) => r.lines !== 1)) return null;
  const accounts = new Set(rows.map((r) => r.accountId));
  const [account] = [...accounts];
  if (accounts.size !== 1 || !account || rows.length < LEARN_AFTER) return null;
  const [row] = await tx
    .insert(bookingRule)
    .values({
      tenantId: who.tenantId,
      payeeKey: t.payeeKey,
      direction: t.direction,
      ledgerAccountId: account,
      vendorId: rows[0]?.vendorId ?? null,
      source: "learned",
    })
    .returning({ id: bookingRule.id });
  return row?.id ?? null;
}

// ── Lists the steps and cards read ───────────────────────────────────────────────────────────────

/** Transactions waiting for a person (`needs_review`), oldest first. */
export async function toReview(tx: Tx, tenantId: string, limit = 50): Promise<string[]> {
  const rows = await tx
    .select({ id: bankTxn.id })
    .from(bankTxn)
    .where(and(eq(bankTxn.tenantId, tenantId), eq(bankTxn.status, "needs_review")))
    .orderBy(asc(bankTxn.txnDate), asc(bankTxn.id))
    .limit(limit);
  return rows.map((r) => r.id);
}
