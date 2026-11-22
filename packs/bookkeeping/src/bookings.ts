// Deciding how each bank transaction is booked (docs/plan.md §1.79), in invariant 7's order:
// a record already in the accounting tool (match), a move between two of the client's accounts on
// the feed (transfer), the client's rule for the payee, then the model's proposal, and a person
// last. Every decision is a `booking` with its lines; nothing here writes to the accounting tool.

import { dec, toNumeric } from "@countersign/core";
import {
  type LedgerKind,
  ledgerAccount,
  rawRecord,
  receivable,
  type Tx,
  transaction,
  vendor,
} from "@countersign/db";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { activeAccount, addNote } from "./accounts";
import { PackRefusal } from "./pack";
import { isGenericPayeeKey, payeeKey } from "./payee";
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
/** Ledger kinds that hold money (a bank or card account): a booking to one is a transfer. */
export const MONEY_KINDS: readonly LedgerKind[] = ["bank", "card"];
/** How far back an open bill or invoice is looked for, for a payment of it. */
export const OPEN_ITEM_DAYS = 180;

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
export function kindFor(direction: Direction, ledgerKind: LedgerKind): BookingKind {
  if (MONEY_KINDS.includes(ledgerKind)) return "transfer";
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
): Promise<{ lines: (LineInput & { amount: string })[]; types: LedgerKind[] }> {
  if (lines.length === 0) throw new PackRefusal("a booking has at least one line");
  if (lines.length > 20) throw new PackRefusal("a booking has at most 20 lines");
  const total = dec(t.amount);
  const out: (LineInput & { ledgerAccountId: string; amount: string })[] = [];
  const types: LedgerKind[] = [];
  for (const l of lines) {
    const account = await activeAccount(tx, tenantId, l.ledgerAccountId);
    types.push(account.kind);
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

// ── The two sides of a transfer ──────────────────────────────────────────────────────────────────
//
// A transfer is booked once, on one side; the other side is `matched` with `ext.transferBookingId`
// (the booking) and `ext.pairedTxnId` (the side it is booked on). When that booking stops standing:
// - a person (or the model) decides the booked side as something other than a transfer: the
//   pairing was wrong, and the other side is freed (`new`) to be decided on its own;
// - the write isn't made, the booked side is left out, or the bank changes it: the money may still
//   have moved between the two accounts, so the other side waits for a person (`needs_review`,
//   `ext.pairedTxnId` kept, `ext.heldWhy` saying why) and is never proposed on its own;
// - the booked side is booked as a transfer again: the other side is matched to the new booking.
// A side the bank dropped after it was decided (`removedAfterPosting`) is never changed here.

const PAIR_KEYS = ["transferBookingId", "pairedTxnId", "heldWhy"] as const;

function withoutPair(ext: Record<string, unknown>): Record<string, unknown> {
  const out = { ...ext };
  for (const k of PAIR_KEYS) delete out[k];
  return out;
}

/** The other sides paired with this transaction (matched to its transfer, or held for a person). */
async function pairedSides(tx: Tx, tenantId: string, t: Pick<TxnRow, "id">) {
  return tx
    .select({ txn: bankTxn, ledgerAccountId: bankAccountLink.ledgerAccountId })
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
        ne(bankTxn.id, t.id),
        inArray(bankTxn.status, ["matched", "needs_review"]),
        sql`coalesce((${bankTxn.ext} ->> 'removedAfterPosting')::boolean, false) = false`,
        or(
          sql`${bankTxn.ext} ->> 'pairedTxnId' = ${t.id}::text`,
          // Pairings made before `pairedTxnId` was kept name only the booking.
          sql`${bankTxn.ext} ->> 'transferBookingId' in (select b.id::text from ${booking} b where b.tenant_id = ${tenantId} and b.bank_txn_id = ${t.id})`,
        ),
      ),
    );
}

/** One side matched to the transfer booked on the other: its own proposals give way. */
async function matchSide(
  tx: Tx,
  tenantId: string,
  side: TxnRow,
  transferBookingId: string,
  pairedTxnId: string,
  decidedBy: Record<string, unknown> | null = null,
): Promise<void> {
  await supersede(tx, tenantId, side.id);
  await setStatus(tx, tenantId, side.id, "matched", {
    ...withoutPair(side.ext),
    transferBookingId,
    pairedTxnId,
    ...(decidedBy ? { matchedBy: decidedBy } : {}),
  });
}

/** One side no longer paired: `new`, its proposals made while it was held given way. */
async function freeSide(tx: Tx, tenantId: string, side: TxnRow): Promise<void> {
  await supersede(tx, tenantId, side.id);
  await setStatus(tx, tenantId, side.id, "new", withoutPair(side.ext));
}

/**
 * The booked side's transfer stopped standing without anyone deciding it isn't a transfer (the
 * write wasn't made, it was left out, the bank changed it): its other side waits for a person.
 */
export async function holdPaired(
  tx: Tx,
  tenantId: string,
  t: Pick<TxnRow, "id">,
  why: "not_written" | "left_out" | "changed",
): Promise<number> {
  const sides = await pairedSides(tx, tenantId, t);
  for (const { txn: side } of sides) {
    if (side.status !== "matched") continue;
    const ext = { ...withoutPair(side.ext), pairedTxnId: t.id, heldWhy: why };
    await setStatus(tx, tenantId, side.id, "needs_review", ext);
  }
  return sides.length;
}

/**
 * After a person's or the model's new booking of `t`: as a transfer, the other side (either one
 * paired with it, or the one it was itself held for) is matched to it when it is that account's,
 * else freed; as anything else, the sides paired with it are freed.
 */
async function repairPaired(
  tx: Tx,
  tenantId: string,
  t: TxnRow,
  made: {
    bookingId: string;
    kind: BookingKind;
    lineAccountId: string | null;
    byPerson?: boolean;
    /** Who decided it, kept on a side matched to it (invariant 10). */
    decidedBy?: Record<string, unknown>;
  },
): Promise<void> {
  const sides = await pairedSides(tx, tenantId, t);
  const heldFor = (t.ext as { pairedTxnId?: unknown }).pairedTxnId;
  if (made.kind === "transfer" && typeof heldFor === "string") {
    // This side was the one held: the side the transfer was first booked on is matched to it.
    const [first] = await tx
      .select({ txn: bankTxn, ledgerAccountId: bankAccountLink.ledgerAccountId })
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
          sql`${bankTxn.id}::text = ${heldFor}`,
          inArray(bankTxn.status, ["new", "needs_review", "skipped"]),
          sql`coalesce((${bankTxn.ext} ->> 'removedAfterPosting')::boolean, false) = false`,
        ),
      );
    if (first) sides.push(first);
  }
  for (const { txn: side, ledgerAccountId } of sides) {
    if (made.kind === "transfer" && ledgerAccountId === made.lineAccountId) {
      await matchSide(tx, tenantId, side, made.bookingId, t.id, made.decidedBy ?? null);
    } else if (side.status === "matched" || (side.ext as { heldWhy?: unknown }).heldWhy) {
      await freeSide(tx, tenantId, side);
    }
  }
  // A held side keeps saying what it was held for until a person decides it.
  if (typeof heldFor === "string" && made.byPerson) {
    const [now] = await tx
      .select({ ext: bankTxn.ext })
      .from(bankTxn)
      .where(and(eq(bankTxn.tenantId, tenantId), eq(bankTxn.id, t.id)));
    if (now) {
      await tx
        .update(bankTxn)
        .set({ ext: withoutPair(now.ext) })
        .where(and(eq(bankTxn.tenantId, tenantId), eq(bankTxn.id, t.id)));
    }
  }
}

/**
 * The same transfer already booked from the other side: a live transfer on another transaction,
 * on the account this one's transfer goes to, whose line is this transaction's account, the same
 * amount the other way, within TRANSFER_BOOKED_DAYS, that no other transaction is matched to.
 */
async function otherSideBooked(
  tx: Tx,
  tenantId: string,
  t: TxnRow,
  lineAccountId: string,
): Promise<{ bookingId: string; status: string; side: TxnRow; mode: string } | null> {
  const link = await linkOf(tx, tenantId, t.accountLinkId);
  if (!link.ledgerAccountId) return null;
  const day = (n: number) => sql`(${t.txnDate}::date + ${n}::int)`;
  const [found] = await tx
    .select({ b: booking, side: bankTxn, mode: bankAccountLink.mode })
    .from(booking)
    .innerJoin(
      bankTxn,
      and(eq(bankTxn.id, booking.bankTxnId), eq(bankTxn.tenantId, booking.tenantId)),
    )
    .innerJoin(
      bankAccountLink,
      and(
        eq(bankAccountLink.id, bankTxn.accountLinkId),
        eq(bankAccountLink.tenantId, bankTxn.tenantId),
      ),
    )
    .where(
      and(
        eq(booking.tenantId, tenantId),
        eq(booking.kind, "transfer"),
        inArray(booking.status, [...LIVE_BOOKING_STATUSES]),
        ne(bankTxn.id, t.id),
        eq(bankAccountLink.ledgerAccountId, lineAccountId),
        eq(bankTxn.direction, t.direction === "out" ? "in" : "out"),
        eq(bankTxn.amount, t.amount),
        eq(bankTxn.currency, t.currency),
        gte(bankTxn.txnDate, day(-TRANSFER_BOOKED_DAYS)),
        lte(bankTxn.txnDate, day(TRANSFER_BOOKED_DAYS)),
        sql`exists (select 1 from ${bookingLine} l where l.tenant_id = ${booking.tenantId} and l.booking_id = ${booking.id} and l.ledger_account_id = ${link.ledgerAccountId})`,
        // A side the bank removed doesn't hold the transfer: its copy, or the side itself, may join.
        sql`not exists (select 1 from ${bankTxn} o where o.tenant_id = ${booking.tenantId} and o.id <> ${t.id} and o.status = 'matched' and o.ext ->> 'transferBookingId' = ${booking.id}::text and coalesce((o.ext ->> 'removedAfterPosting')::boolean, false) = false)`,
      ),
    )
    .orderBy(sql`abs(${bankTxn.txnDate} - ${t.txnDate}::date)`, asc(booking.id))
    .limit(1);
  return found
    ? { bookingId: found.b.id, status: found.b.status, side: found.side, mode: found.mode }
    : null;
}

/** This side matched to the transfer booked on the other: its own pairings freed first. */
async function joinBooked(
  tx: Tx,
  tenantId: string,
  t: TxnRow,
  other: { bookingId: string; side: TxnRow },
  decidedBy: Record<string, unknown>,
): Promise<void> {
  await repairPaired(tx, tenantId, t, {
    bookingId: other.bookingId,
    kind: "match",
    lineAccountId: null,
  });
  const [now] = await tx
    .select()
    .from(bankTxn)
    .where(and(eq(bankTxn.tenantId, tenantId), eq(bankTxn.id, t.id)));
  await matchSide(tx, tenantId, now ?? t, other.bookingId, other.side.id, decidedBy);
}

/**
 * The other side's own proposed transfer gives way to this one's: it is matched to it. Only for a
 * proposal on an account set to suggest, which is never written (`joinProposed` otherwise).
 */
async function takeOver(
  tx: Tx,
  tenantId: string,
  other: { side: TxnRow },
  bookingId: string,
  t: TxnRow,
  decidedBy: Record<string, unknown>,
): Promise<void> {
  await repairPaired(tx, tenantId, other.side, { bookingId, kind: "match", lineAccountId: null });
  const [now] = await tx
    .select()
    .from(bankTxn)
    .where(and(eq(bankTxn.tenantId, tenantId), eq(bankTxn.id, other.side.id)));
  await matchSide(tx, tenantId, now ?? other.side, bookingId, t.id, decidedBy);
}

/**
 * A person books this side as the transfer the other side's proposal already is, on an account set
 * to book: that proposal is approved as the person's, and this side is matched to it.
 */
// DECISION: the other side's proposal may already be laid out for a signature in a run; replacing
// it with this side's own booking would let both be written (under two references). Approving the
// same proposal keeps one booking, so at most one write, whichever run makes it.
async function joinProposed(
  tx: Tx,
  who: PersonDecision,
  t: TxnRow,
  other: { bookingId: string; side: TxnRow },
): Promise<string> {
  const approved = await tx
    .update(booking)
    .set({ status: "approved", userId: who.userId, decidedAt: sql`now()` })
    .where(
      and(
        eq(booking.tenantId, who.tenantId),
        eq(booking.id, other.bookingId),
        eq(booking.status, "proposed"),
      ),
    )
    .returning({ id: booking.id });
  if (approved.length === 0) {
    throw new PackRefusal("the other side's transfer changed meanwhile: decide this one again");
  }
  await setStatus(tx, who.tenantId, other.side.id, "approved");
  await joinBooked(tx, who.tenantId, t, other, { userId: who.userId });
  return other.bookingId;
}

/** Held for a person because it may be the other side of a transfer that didn't stand. */
export function heldPairOf(t: Pick<TxnRow, "ext" | "status">): string | null {
  const ext = t.ext as { pairedTxnId?: unknown; heldWhy?: unknown };
  return t.status === "needs_review" && typeof ext.pairedTxnId === "string" && ext.heldWhy
    ? ext.pairedTxnId
    : null;
}

// ── Settling: what code decides ──────────────────────────────────────────────────────────────────

export interface SettleResult {
  checked: number;
  skipped: number;
  matched: number;
  transfers: number;
  ruled: number;
  /** Paying an open bill or invoice: sent to a person, never proposed as an expense or income. */
  review: number;
  /** Still to decide: for the model, then a person. */
  open: string[];
}

/** How many undecided transactions one settling pass reads. */
export const SETTLE_LIMIT = 500;
/** How many standing proposals on `suggest` accounts one pass checks for a match again. */
export const RECHECK_LIMIT = 200;
/** How far back (from the account's latest transaction) those proposals are checked again. */
export const RECHECK_DAYS = 60;

/**
 * The client's undecided transactions, through the steps code decides: off or too early
 * (`skipped`), already in the accounting tool (`matched`), a transfer between two of its accounts
 * on the feed, a payment of an open bill or invoice (for a person), a rule. What is left stays
 * `new` for the model.
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
    review: 0,
    open: [],
  };
  // Writes made and synced back but never recorded, first: they leave the transactions read below.
  if (!opts.testRun) await recordWritten(tx, who);
  const fromLinks = () =>
    tx
      .select()
      .from(bankTxn)
      .innerJoin(
        bankAccountLink,
        and(
          eq(bankAccountLink.id, bankTxn.accountLinkId),
          eq(bankAccountLink.tenantId, bankTxn.tenantId),
        ),
      );
  // DECISION: what is undecided is read on its own, first, with its own limit, so nothing read
  // again every pass (a skipped history, standing proposals) can fill the batch. A skipped one is
  // read again only once it has become bookable (its account switched on, or booking starting
  // earlier).
  const undecided = await fromLinks()
    .where(
      and(
        eq(bankTxn.tenantId, tenantId),
        or(
          eq(bankTxn.status, "new"),
          and(
            eq(bankTxn.status, "skipped"),
            ne(bankAccountLink.mode, "off"),
            sql`${bankAccountLink.ledgerAccountId} is not null`,
            or(isNull(bankAccountLink.bookFrom), gte(bankTxn.txnDate, bankAccountLink.bookFrom)),
          ),
        ),
      ),
    )
    // DECISION: what was never handed to the model comes first, then what was handed on longest
    // ago (`ext.offeredAt`, stamped by the settle tool), so what the model leaves can't keep newer
    // transactions from it.
    .orderBy(
      sql`${bankTxn.ext} ->> 'offeredAt' asc nulls first`,
      asc(bankTxn.txnDate),
      asc(bankTxn.id),
    )
    .limit(opts.limit ?? SETTLE_LIMIT);
  // DECISION: a proposal on an account set to `suggest` waits for the client to enter it in the
  // accounting tool; once it is there, the match step finds it and the proposal gives way. Checked
  // again only within RECHECK_DAYS of the account's latest transaction, and only when a record of
  // the same amount the match step could take is there at all (bounded, RECHECK_LIMIT a pass).
  const standing = await fromLinks()
    .where(
      and(
        eq(bankTxn.tenantId, tenantId),
        inArray(bankTxn.status, ["proposed", "needs_review"]),
        eq(bankAccountLink.mode, "suggest"),
        sql`${bankTxn.txnDate} >= (select max(x.txn_date) from ${bankTxn} x where x.tenant_id = ${bankTxn.tenantId} and x.account_link_id = ${bankTxn.accountLinkId}) - ${RECHECK_DAYS}::int`,
        sql`exists (select 1 from ${transaction} r where r.tenant_id = ${bankTxn.tenantId} and r.kind = (case when ${bankTxn.direction} = 'out' then 'purchase' else 'vendor_credit' end) and r.total = ${bankTxn.amount} and r.currency = ${bankTxn.currency} and r.txn_date between ${bankTxn.txnDate} - ${MATCH_DAYS}::int and ${bankTxn.txnDate} + ${MATCH_DAYS}::int)`,
      ),
    )
    .orderBy(desc(bankTxn.txnDate), asc(bankTxn.id))
    .limit(RECHECK_LIMIT);
  const links = new Map<string, LinkRow>();
  const used = new Set<string>();
  for (const { bank_txn: t } of [...undecided, ...standing]) {
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
      if (!opts.testRun) await linkResent(tx, tenantId, t);
      continue;
    }
    const resent = await resentMatch(tx, who, t, opts.testRun);
    if (resent === "review") {
      result.review += 1;
      continue;
    }
    if (resent) {
      result.matched += 1;
      continue;
    }
    if (await transferBooked(tx, who, t, link, opts.testRun)) {
      result.transfers += 1;
      continue;
    }
    const other = await transferPair(tx, who, t, link, used, opts.testRun);
    if (other) {
      used.add(other);
      result.transfers += 1;
      continue;
    }
    const item = await openItemFor(tx, t, link);
    if (item?.confirmed) {
      if (!opts.testRun) {
        await setStatus(tx, tenantId, t.id, "needs_review", {
          ...withoutOpenItem(t.ext),
          openItem: { ...item, decidedBy: deciderOf(who) },
        });
      }
      result.review += 1;
      continue;
    }
    if (await applyRule(tx, who, t, opts.testRun)) {
      result.ruled += 1;
      continue;
    }
    result.open.push(t.id);
    if (opts.testRun) continue;
    // An unconfirmed candidate is only a hint, for the model and the card; a stale one goes.
    const ext = item
      ? { ...withoutOpenItem(t.ext), openItem: { ...item, decidedBy: deciderOf(who) } }
      : withoutOpenItem(t.ext);
    if (t.status === "skipped" || item || openItemOf(t)) {
      await setStatus(tx, tenantId, t.id, "new", ext);
    }
  }
  if (!opts.testRun) await recheckOpenItems(tx, who);
  return result;
}

function deciderOf(who: Decider): Record<string, unknown> {
  return { agentVersionId: who.agentVersionId, runId: who.runId };
}

/**
 * A record already in the accounting tool for this money: the same amount to the cent, dated
 * within MATCH_DAYS, paid from the linked account, not matched to another transaction, and not
 * written by the Bookkeeper for another transaction.
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
  // The booking or bank transaction a record's mark names (`[Mezonas bk-<booking id>]` from
  // before marks named the transaction, `[Mezonas bt-<bank transaction id>]` since).
  const markOf = (prefix: string) =>
    sql`substring(coalesce(${transaction.memo}, '') from ${`\\[Mezonas ${prefix}-([0-9a-f-]{36})\\]`}::text)`;
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
        // Never a record the Bookkeeper wrote for ANOTHER bank transaction of the same amount: one
        // a booking of it was posted as, or one whose mark names it or one of its bookings.
        // DECISION: unless that transaction was dropped by the bank after it was decided
        // (`removedAfterPosting`): the same money sent again under a new id is then that record,
        // matched rather than written twice. A record written for this same transaction (a write
        // nobody recorded) may be matched to it. A mark naming nothing of the client's is taken
        // as written for another all the same.
        sql`not exists (select 1 from ${booking} b join ${bankTxn} o on o.id = b.bank_txn_id and o.tenant_id = b.tenant_id where b.tenant_id = ${transaction.tenantId} and o.id <> ${t.id} and b.kind <> 'match' and coalesce((o.ext ->> 'removedAfterPosting')::boolean, false) = false and ((b.status = 'posted' and b.qbo_id = ${transaction.ext} -> 'qbo' ->> 'id' and b.qbo_entity = ${transaction.ext} -> 'qbo' ->> 'entity') or b.id::text = ${markOf("bk")}))`,
        sql`(${markOf("bk")} is null or exists (select 1 from ${booking} b where b.tenant_id = ${transaction.tenantId} and b.id::text = ${markOf("bk")}))`,
        sql`(${markOf("bt")} is null or ${markOf("bt")} = ${t.id}::text or exists (select 1 from ${bankTxn} o where o.tenant_id = ${transaction.tenantId} and o.id::text = ${markOf("bt")} and coalesce((o.ext ->> 'removedAfterPosting')::boolean, false)))`,
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
  const id = await insertBooking(
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
  // Not a transfer after all: a side paired with its proposal is freed.
  if (replacing) {
    await repairPaired(tx, who.tenantId, t, { bookingId: id, kind: "match", lineAccountId: null });
  }
  return true;
}

/** Stamps the transactions handed on to the model, so the next pass offers others first. */
export async function markOffered(tx: Tx, tenantId: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await tx
    .update(bankTxn)
    .set({ ext: sql`${bankTxn.ext} || jsonb_build_object('offeredAt', now()::text)` })
    .where(and(eq(bankTxn.tenantId, tenantId), inArray(bankTxn.id, [...ids])));
}

/**
 * A transaction and every earlier copy it was sent again in place of (`resentOf`, followed all
 * the way back): one money, whichever copy a write was made for.
 */
export async function resentChain(tx: Tx, tenantId: string, id: string): Promise<string[]> {
  const rows = await tx.execute<{ id: string }>(sql`
    with recursive chain(id) as (
      select ${id}::uuid
      union
      select (b.ext ->> 'resentOf')::uuid from ${bankTxn} b join chain c on b.id = c.id
      where b.tenant_id = ${tenantId} and b.ext ->> 'resentOf' is not null
    )
    select id::text as id from chain`);
  return [...rows].map((r) => r.id);
}

/** The plain note on a copy the bank sent again, waiting for a person. */
export const RESENT_NOTE = "The bank sent this again after removing an earlier copy";

/** The earlier copy the bank removed that this transaction was sent again in place of, if any. */
export function resentOfId(t: Pick<TxnRow, "ext">): string | null {
  const id = (t.ext as { resentOf?: unknown }).resentOf;
  return typeof id === "string" ? id : null;
}

/**
 * Earlier copies of this transaction the bank removed: the same account, day, amount and
 * direction, removed after it was decided (`removedAfterPosting`: approved, posted, matched or
 * left out) or while proposed or waiting for a person, and not taken by another copy yet. A
 * posted one first, then one matched to a transfer, then the oldest.
 */
async function resentEarlier(
  tx: Tx,
  tenantId: string,
  t: TxnRow,
): Promise<{ earlier: TxnRow; posted: typeof booking.$inferSelect | null } | null> {
  const rows = await tx
    .select()
    .from(bankTxn)
    .where(
      and(
        eq(bankTxn.tenantId, tenantId),
        ne(bankTxn.id, t.id),
        eq(bankTxn.accountLinkId, t.accountLinkId),
        eq(bankTxn.direction, t.direction),
        eq(bankTxn.amount, t.amount),
        eq(bankTxn.currency, t.currency),
        eq(bankTxn.txnDate, t.txnDate),
        sql`${bankTxn.ext} ->> 'resentAs' is null`,
        or(
          sql`coalesce((${bankTxn.ext} ->> 'removedAfterPosting')::boolean, false)`,
          and(
            eq(bankTxn.status, "removed"),
            // Not a pending transaction that posted under a new id.
            sql`${bankTxn.ext} ->> 'postedAs' is null`,
            or(
              sql`${bankTxn.ext} ->> 'removedFrom' in ('proposed', 'needs_review')`,
              sql`exists (select 1 from ${booking} x where x.tenant_id = ${bankTxn.tenantId} and x.bank_txn_id = ${bankTxn.id})`,
            ),
          ),
        ),
      ),
    )
    .orderBy(asc(bankTxn.id))
    .limit(10);
  if (rows.length === 0) return null;
  const posted = await tx
    .select()
    .from(booking)
    .where(
      and(
        eq(booking.tenantId, tenantId),
        inArray(
          booking.bankTxnId,
          rows.map((r) => r.id),
        ),
        eq(booking.status, "posted"),
      ),
    );
  const postedOf = (id: string) => posted.find((b) => b.bankTxnId === id) ?? null;
  const rank = (r: TxnRow) => (postedOf(r.id) ? 0 : r.status === "matched" ? 1 : 2);
  const [earlier] = [...rows].sort((a, b) => rank(a) - rank(b));
  return earlier ? { earlier, posted: postedOf(earlier.id) } : null;
}

/**
 * The bank sent a transaction again under a new id after removing an earlier copy (see
 * `resentEarlier`). Posted with its own booking: the copy is what was already written, recorded as
 * posted from that booking. Matched to a transfer posted or approved from the other side: the copy
 * is matched to that transfer. Anything else (approved and not written yet, proposed, left out):
 * the copy waits for a person and is never offered to the model, and the earlier copy's approval is
 * not written.
 */
// DECISION: re-sends are conservative: a person decides, and code matches only what is proven
// safe: a write already made (its booking says what was written, since deposits and transfers
// aren't synced back from QuickBooks) or the transfer the earlier copy was the other side of. The
// same day only (a re-send keeps it; a daily charge of the same amount is another), one copy per
// earlier one (`ext.resentAs`), and never a write another transaction already stands for.
async function resentMatch(
  tx: Tx,
  who: Decider,
  t: TxnRow,
  testRun = false,
): Promise<"posted" | "matched" | "review" | null> {
  const found = await resentEarlier(tx, who.tenantId, t);
  if (!found) return null;
  const { earlier, posted } = found;
  let outcome: "posted" | "matched" | "review" = "review";
  let transfer: { id: string; bankTxnId: string } | null = null;
  if (posted) {
    // Not what another transaction already stands for (matched to the record itself).
    // The earlier copy's own chain (and any copy since sent again) is this same money.
    const chain = await resentChain(tx, who.tenantId, earlier.id);
    const [taken] = posted.qboId
      ? await tx
          .select({ id: booking.id })
          .from(booking)
          .innerJoin(
            bankTxn,
            and(eq(bankTxn.id, booking.bankTxnId), eq(bankTxn.tenantId, booking.tenantId)),
          )
          .where(
            and(
              eq(booking.tenantId, who.tenantId),
              notInArray(booking.bankTxnId, [...chain, t.id]),
              sql`${bankTxn.ext} ->> 'resentAs' is null`,
              inArray(booking.status, [...LIVE_BOOKING_STATUSES]),
              eq(booking.qboId, posted.qboId),
              sql`${booking.qboEntity} is not distinct from ${posted.qboEntity}`,
            ),
          )
          .limit(1)
      : [];
    if (!taken) outcome = "posted";
  } else if (earlier.status === "matched") {
    const id = (earlier.ext as { transferBookingId?: unknown }).transferBookingId;
    const [b] =
      typeof id === "string"
        ? await tx
            .select({ id: booking.id, bankTxnId: booking.bankTxnId })
            .from(booking)
            .where(
              and(
                eq(booking.tenantId, who.tenantId),
                sql`${booking.id}::text = ${id}`,
                eq(booking.kind, "transfer"),
                inArray(booking.status, ["approved", "posted"]),
                // No other side, still on the feed, is matched to it.
                sql`not exists (select 1 from ${bankTxn} o where o.tenant_id = ${booking.tenantId} and o.id <> ${earlier.id} and o.id <> ${t.id} and o.status = 'matched' and o.ext ->> 'transferBookingId' = ${booking.id}::text and coalesce((o.ext ->> 'removedAfterPosting')::boolean, false) = false)`,
              ),
            )
        : [];
    if (b) {
      transfer = b;
      outcome = "matched";
    }
  }
  if (testRun) return outcome;
  if (outcome === "posted" && posted) {
    await recordResentPosted(tx, who, t, earlier, posted);
  } else if (outcome === "matched" && transfer) {
    await matchSide(tx, who.tenantId, t, transfer.id, transfer.bankTxnId, deciderOf(who));
    const [now] = await tx
      .select({ ext: bankTxn.ext })
      .from(bankTxn)
      .where(and(eq(bankTxn.tenantId, who.tenantId), eq(bankTxn.id, t.id)));
    await tx
      .update(bankTxn)
      .set({ ext: { ...(now?.ext ?? t.ext), resentOf: earlier.id } })
      .where(and(eq(bankTxn.tenantId, who.tenantId), eq(bankTxn.id, t.id)));
  } else {
    await retireEarlier(tx, who.tenantId, earlier);
    // An open bill or invoice the earlier copy was held for (or hinted at) holds the copy too.
    const item = openItemOf(earlier);
    await setStatus(tx, who.tenantId, t.id, "needs_review", {
      ...t.ext,
      ...(item ? { openItem: item } : {}),
      resentOf: earlier.id,
      note: RESENT_NOTE,
    });
  }
  await markResent(tx, who.tenantId, earlier.id, t.id);
  return outcome;
}

/** The earlier copy names the copy that took its place. */
async function markResent(tx: Tx, tenantId: string, earlierId: string, copyId: string) {
  await tx
    .update(bankTxn)
    .set({
      ext: sql`${bankTxn.ext} || jsonb_build_object('resentAs', ${copyId}::text)`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(bankTxn.tenantId, tenantId), eq(bankTxn.id, earlierId)));
}

/**
 * An earlier copy approved and not written yet: its approval gives way (the person decides on the
 * copy) and it is `removed`, so nobody decides it again; a side matched to it waits for a person.
 */
async function retireEarlier(tx: Tx, tenantId: string, earlier: TxnRow): Promise<void> {
  const standing = await liveBooking(tx, tenantId, earlier.id);
  if (!standing || standing.status === "posted") return;
  await supersede(tx, tenantId, earlier.id);
  await holdPaired(tx, tenantId, earlier, "changed");
  await setStatus(tx, tenantId, earlier.id, "removed");
}

/** The copy recorded as posted from the earlier copy's booking: nothing is written again. */
async function recordResentPosted(
  tx: Tx,
  who: Decider,
  t: TxnRow,
  earlier: TxnRow,
  b: typeof booking.$inferSelect,
): Promise<void> {
  const lines = await tx
    .select()
    .from(bookingLine)
    .where(and(eq(bookingLine.tenantId, who.tenantId), eq(bookingLine.bookingId, b.id)))
    .orderBy(asc(bookingLine.lineNo));
  await supersede(tx, who.tenantId, t.id);
  await insertBooking(
    tx,
    who.tenantId,
    t,
    {
      kind: b.kind,
      status: "posted",
      decidedBy: "match",
      confidence: 1,
      matchedTransactionId: b.matchedTransactionId,
      transferLinkId: b.transferLinkId,
      vendorId: b.vendorId,
      memo: b.memo,
      reason: `The bank sent this again under a new id: already in the accounting tool${b.qboEntity && b.qboId ? ` as ${b.qboEntity} ${b.qboId}` : ""}`,
      sources: [earlier.rawRecordId, b.id],
      agentVersionId: who.agentVersionId,
      runId: who.runId,
      qboEntity: b.qboEntity,
      qboId: b.qboId,
    },
    lines.map((l) => ({
      ledgerAccountId: l.ledgerAccountId,
      amount: l.amount,
      classRef: l.classRef,
      customerRef: l.customerRef,
      description: l.description,
    })),
  );
  const { note: _, ...ext } = t.ext as { note?: unknown };
  await setStatus(tx, who.tenantId, t.id, "matched", { ...ext, resentOf: earlier.id });
}

/**
 * After a code match of a new transaction to a record already in the accounting tool: an earlier
 * copy the bank removed is linked to it, and an approval of that copy not written yet gives way.
 */
async function linkResent(tx: Tx, tenantId: string, t: TxnRow): Promise<void> {
  const found = await resentEarlier(tx, tenantId, t);
  if (!found) return;
  await retireEarlier(tx, tenantId, found.earlier);
  const [now] = await tx
    .select({ ext: bankTxn.ext })
    .from(bankTxn)
    .where(and(eq(bankTxn.tenantId, tenantId), eq(bankTxn.id, t.id)));
  await tx
    .update(bankTxn)
    .set({ ext: { ...(now?.ext ?? t.ext), resentOf: found.earlier.id } })
    .where(and(eq(bankTxn.tenantId, tenantId), eq(bankTxn.id, t.id)));
  await markResent(tx, tenantId, found.earlier.id, t.id);
}

/**
 * An earlier copy's approval, laid out for a signature before its copy arrived, was written after
 * all: it is recorded as posted, and the copy, unless a person already wrote or left it out, is
 * recorded as that write (its own standing booking gives way).
 */
export async function resentWritten(
  tx: Tx,
  who: Decider,
  earlierId: string,
  b: { id: string },
  qbo: { entity: string; id: string },
): Promise<boolean> {
  const [earlier] = await tx
    .select()
    .from(bankTxn)
    .where(and(eq(bankTxn.tenantId, who.tenantId), eq(bankTxn.id, earlierId)));
  const copyId = (earlier?.ext as { resentAs?: unknown } | undefined)?.resentAs;
  if (!earlier || typeof copyId !== "string") return false;
  if (await liveBooking(tx, who.tenantId, earlier.id)) return false;
  await tx
    .update(booking)
    .set({ status: "posted", qboEntity: qbo.entity, qboId: qbo.id, postedAt: sql`now()` })
    .where(and(eq(booking.tenantId, who.tenantId), eq(booking.id, b.id)));
  await setStatus(tx, who.tenantId, earlier.id, "posted");
  const [copy] = await tx
    .select()
    .from(bankTxn)
    .where(and(eq(bankTxn.tenantId, who.tenantId), eq(bankTxn.id, copyId)));
  const standing = copy ? await liveBooking(tx, who.tenantId, copy.id) : null;
  if (!copy || !DECIDABLE.includes(copy.status) || standing?.status === "posted") return true;
  const [posted] = await tx
    .select()
    .from(booking)
    .where(and(eq(booking.tenantId, who.tenantId), eq(booking.id, b.id)));
  if (posted) await recordResentPosted(tx, who, copy, earlier, posted);
  return true;
}

/** A booking's mark in a synced record's memo, as POSIX patterns (the transaction's, a booking's). */
const TXN_MARK = "\\[Mezonas bt-([0-9a-f-]{36})\\]";
const BOOKING_MARK = "\\[Mezonas bk-([0-9a-f-]{36})\\]";

/**
 * A write made for a transaction that nobody recorded (a run stopped after the write), now synced
 * back with the transaction's mark: its standing booking is recorded as posted with that record,
 * so it isn't laid out and refused again every day. A record of another kind than the booking
 * would write (a purchase for a booking now a transfer) fails the booking for a person instead.
 */
async function recordWritten(tx: Tx, who: Decider): Promise<void> {
  const rows = await tx
    .select({ b: booking, t: bankTxn, r: transaction, ledgerKind: ledgerAccount.kind })
    .from(booking)
    .innerJoin(
      bankTxn,
      and(eq(bankTxn.id, booking.bankTxnId), eq(bankTxn.tenantId, booking.tenantId)),
    )
    .innerJoin(
      bankAccountLink,
      and(
        eq(bankAccountLink.id, bankTxn.accountLinkId),
        eq(bankAccountLink.tenantId, bankTxn.tenantId),
      ),
    )
    .leftJoin(
      ledgerAccount,
      and(
        eq(ledgerAccount.id, bankAccountLink.ledgerAccountId),
        eq(ledgerAccount.tenantId, bankAccountLink.tenantId),
      ),
    )
    .innerJoin(
      transaction,
      and(
        eq(transaction.tenantId, booking.tenantId),
        sql`coalesce((${transaction.ext} -> 'qbo' ->> 'deleted')::boolean, false) = false`,
        or(
          sql`substring(coalesce(${transaction.memo}, '') from ${TXN_MARK}::text) = ${bankTxn.id}::text`,
          sql`substring(coalesce(${transaction.memo}, '') from ${BOOKING_MARK}::text) in (select e.id::text from ${booking} e where e.tenant_id = ${booking.tenantId} and e.bank_txn_id = ${bankTxn.id})`,
        ),
      ),
    )
    .where(
      and(
        eq(booking.tenantId, who.tenantId),
        inArray(booking.status, ["proposed", "approved"]),
        inArray(booking.kind, ["expense", "deposit", "transfer"]),
        // Only accounts the Bookkeeper writes for; on one set to suggest the match step decides.
        eq(bankAccountLink.mode, "book"),
      ),
    )
    .limit(RECHECK_LIMIT);
  const done = new Set<string>();
  for (const { b, t, r, ledgerKind } of rows) {
    if (done.has(b.id)) continue;
    done.add(b.id);
    const qbo = (r.ext as { qbo?: { entity?: string; id?: string } }).qbo ?? {};
    // What this booking would write: a purchase for an expense, or money back onto a card.
    const writesPurchase = b.kind === "expense" || (b.kind === "deposit" && ledgerKind === "card");
    if (writesPurchase && qbo.entity === "Purchase" && qbo.id) {
      await tx
        .update(booking)
        .set({
          status: "posted",
          qboEntity: "Purchase",
          qboId: qbo.id,
          postedAt: sql`now()`,
          decidedAt: b.decidedAt ?? sql`now()`,
        })
        .where(and(eq(booking.tenantId, who.tenantId), eq(booking.id, b.id)));
      await setStatus(tx, who.tenantId, t.id, "posted");
    } else {
      await tx
        .update(booking)
        .set({
          status: "failed",
          error: `Already in QuickBooks as ${qbo.entity ?? "a record"} ${qbo.id ?? ""} from an earlier booking of this transaction`,
          decidedAt: sql`now()`,
        })
        .where(and(eq(booking.tenantId, who.tenantId), eq(booking.id, b.id)));
      await setStatus(tx, who.tenantId, t.id, "needs_review");
      await holdPaired(tx, who.tenantId, t, "not_written");
    }
  }
}

/** Sides of a transfer this far apart, the first already booked as one, are still the same. */
export const TRANSFER_BOOKED_DAYS = 10;

/**
 * Money out of one account on the feed and the same amount into another within
 * TRANSFER_BOOKED_DAYS (a card payment, a move to savings): one transfer, booked on the side the
 * money left. Answers the other side's id. The other side is undecided, or held for a person as
 * this one's pair.
 */
// DECISION: the two sides are paired up to TRANSFER_BOOKED_DAYS apart before either reaches the
// model, so the model never books both (a card payment can post days later across a weekend).
// The nearest wins; further apart than MATCH_DAYS, the transfer is proposed for a person
// (needs_review) rather than for the write steps.
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
        or(
          inArray(bankTxn.status, ["new", "skipped"]),
          and(
            eq(bankTxn.status, "needs_review"),
            sql`${bankTxn.ext} ->> 'pairedTxnId' = ${t.id}::text`,
          ),
        ),
        gte(bankTxn.txnDate, day(-TRANSFER_BOOKED_DAYS)),
        lte(bankTxn.txnDate, day(TRANSFER_BOOKED_DAYS)),
      ),
    )
    .orderBy(sql`abs(${bankTxn.txnDate} - ${t.txnDate}::date)`, asc(bankTxn.id));
  const pair = others.find((o) => !used.has(o.txn.id));
  if (!pair?.link.ledgerAccountId || !link.ledgerAccountId) return null;
  if (testRun) return pair.txn.id;
  const [from, fromLink, to, toLink] =
    t.direction === "out" ? [t, link, pair.txn, pair.link] : [pair.txn, pair.link, t, link];
  const apart = Math.abs(
    (Date.parse(`${from.txnDate}T00:00:00Z`) - Date.parse(`${to.txnDate}T00:00:00Z`)) / 86_400_000,
  );
  const near = apart <= MATCH_DAYS;
  // A held side the transfer is now booked on: what was proposed for it while held gives way.
  await supersede(tx, who.tenantId, from.id);
  const id = await insertBooking(
    tx,
    who.tenantId,
    from,
    {
      kind: "transfer",
      status: "proposed",
      decidedBy: "match",
      confidence: near ? 0.9 : 0.7,
      transferLinkId: toLink.id,
      reason: `The same amount left ${fromLink.name ?? "one account"} and reached ${toLink.name ?? "another"} ${apart === 0 ? "the same day" : `${apart} day${apart === 1 ? "" : "s"} apart`}`,
      sources: [to.rawRecordId],
      agentVersionId: who.agentVersionId,
      runId: who.runId,
    },
    [{ ledgerAccountId: toLink.ledgerAccountId ?? "", amount: from.amount }],
  );
  await setStatus(
    tx,
    who.tenantId,
    from.id,
    near ? "proposed" : "needs_review",
    withoutPair(from.ext),
  );
  await matchSide(tx, who.tenantId, to, id, from.id, deciderOf(who));
  return pair.txn.id;
}

/**
 * The other side of a transfer already booked: a live transfer on another linked account whose
 * line is this account, the same amount the other way, dated within TRANSFER_BOOKED_DAYS, that no
 * other transaction is the other side of. This side is then matched to it, not booked again.
 */
// DECISION: a wider window than pairing two undecided sides (MATCH_DAYS): the booked transfer
// names this very account, and a card payment can post days later across a weekend.
async function transferBooked(
  tx: Tx,
  who: Decider,
  t: TxnRow,
  link: LinkRow,
  testRun = false,
): Promise<boolean> {
  if (!link.ledgerAccountId) return false;
  const day = (n: number) => sql`(${t.txnDate}::date + ${n}::int)`;
  const [found] = await tx
    .select({ id: booking.id, bankTxnId: booking.bankTxnId })
    .from(booking)
    .innerJoin(
      bankTxn,
      and(eq(bankTxn.id, booking.bankTxnId), eq(bankTxn.tenantId, booking.tenantId)),
    )
    .where(
      and(
        eq(booking.tenantId, who.tenantId),
        eq(booking.kind, "transfer"),
        inArray(booking.status, [...LIVE_BOOKING_STATUSES]),
        ne(bankTxn.accountLinkId, link.id),
        eq(bankTxn.direction, t.direction === "out" ? "in" : "out"),
        eq(bankTxn.amount, t.amount),
        eq(bankTxn.currency, t.currency),
        gte(bankTxn.txnDate, day(-TRANSFER_BOOKED_DAYS)),
        lte(bankTxn.txnDate, day(TRANSFER_BOOKED_DAYS)),
        sql`exists (select 1 from ${bookingLine} l where l.tenant_id = ${booking.tenantId} and l.booking_id = ${booking.id} and l.ledger_account_id = ${link.ledgerAccountId})`,
        // A side the bank removed doesn't hold the transfer: its copy, or the side itself, may join.
        sql`not exists (select 1 from ${bankTxn} o where o.tenant_id = ${booking.tenantId} and o.id <> ${t.id} and o.status = 'matched' and o.ext ->> 'transferBookingId' = ${booking.id}::text and coalesce((o.ext ->> 'removedAfterPosting')::boolean, false) = false)`,
      ),
    )
    .orderBy(sql`abs(${bankTxn.txnDate} - ${t.txnDate}::date)`, asc(booking.id))
    .limit(1);
  if (!found) return false;
  if (testRun) return true;
  // Invariant 10: who matched it.
  await matchSide(tx, who.tenantId, t, found.id, found.bankTxnId, deciderOf(who));
  return true;
}

/** An open bill (money out) or invoice (money in) this transaction may be the payment of. */
export interface OpenItem {
  kind: "bill" | "invoice";
  /** The bill's transaction id, or null for an invoice. */
  transactionId: string | null;
  /** The invoice's receivable id, or null for a bill. */
  receivableId: string | null;
  docNumber: string | null;
  /** The vendor's or customer's name. */
  name: string | null;
  date: string | null;
  balance: string;
  currency: string;
  /** The vendor or customer is the transaction's payee: a person decides it. Else a hint only. */
  confirmed: boolean;
  /** Paid in QuickBooks since: the card asks whether this is that payment, to leave it out. */
  paid?: boolean;
}

/** The payee and a vendor's or customer's name are one: every word of the shorter in the other. */
function samePayee(payee: string | null, names: readonly (string | null | undefined)[]): boolean {
  if (!payee || isGenericPayeeKey(payee)) return false;
  const mine = payee.split(" ");
  return names.some((n) => {
    const key = payeeKey(n);
    if (!key || isGenericPayeeKey(key)) return false;
    const theirs = key.split(" ");
    const [short, long] = theirs.length <= mine.length ? [theirs, mine] : [mine, theirs];
    return short.every((w) => long.includes(w));
  });
}

/**
 * A payment of an open bill or invoice is not an expense or income of its own: booking it so would
 * count it twice and leave the bill or invoice open. One open for exactly this amount (dated up to
 * OPEN_ITEM_DAYS before, or MATCH_DAYS after) is the candidate; `confirmed` when its vendor or
 * customer is this transaction's payee.
 */
// DECISION: only the same amount to the cent as what is still owed. Only a confirmed candidate
// sends the transaction to a person ahead of the client's rules; an unconfirmed one (a stale bill
// of another vendor's, a deposit the bank names no one on) is a hint for the model and the card.
// The bill's balance is its latest synced version's (QuickBooks lowers it as payments are
// entered), its total when the version gives none. Bills on any linked account (a card can pay one
// too); invoices only for money into a bank account.
async function openItemFor(tx: Tx, t: TxnRow, link: LinkRow): Promise<OpenItem | null> {
  if (!link.ledgerAccountId) return null;
  const tenantId = t.tenantId;
  const [account] = await tx
    .select()
    .from(ledgerAccount)
    .where(and(eq(ledgerAccount.tenantId, tenantId), eq(ledgerAccount.id, link.ledgerAccountId)));
  if (!account) return null;
  const day = (n: number) => sql`(${t.txnDate}::date + ${n}::int)`;
  const items: OpenItem[] = [];
  if (t.direction === "out") {
    const balance = sql<string>`coalesce((${rawRecord.payload} ->> 'Balance')::numeric, ${transaction.total})`;
    const bills = await tx
      .select({ bill: transaction, balance, vendor })
      .from(transaction)
      .leftJoin(
        rawRecord,
        and(
          eq(rawRecord.id, transaction.sourceRawRecordId),
          eq(rawRecord.tenantId, transaction.tenantId),
        ),
      )
      .leftJoin(
        vendor,
        and(eq(vendor.id, transaction.vendorId), eq(vendor.tenantId, transaction.tenantId)),
      )
      .where(
        and(
          eq(transaction.tenantId, tenantId),
          eq(transaction.connector, account.connector),
          eq(transaction.kind, "bill"),
          eq(transaction.currency, t.currency),
          gte(transaction.txnDate, day(-OPEN_ITEM_DAYS)),
          lte(transaction.txnDate, day(MATCH_DAYS)),
          sql`coalesce((${transaction.ext} -> 'qbo' ->> 'deleted')::boolean, false) = false`,
          sql`${balance} = ${t.amount}::numeric`,
        ),
      )
      .orderBy(desc(transaction.txnDate), asc(transaction.id))
      .limit(20);
    for (const b of bills) {
      const qbo = (b.bill.ext as { qbo?: { docNumber?: string | null } }).qbo ?? {};
      items.push({
        kind: "bill",
        transactionId: b.bill.id,
        receivableId: null,
        docNumber: qbo.docNumber ?? null,
        name: b.vendor?.name ?? null,
        date: b.bill.txnDate,
        balance: toNumeric(dec(String(b.balance))),
        currency: b.bill.currency,
        confirmed: b.vendor
          ? samePayee(t.payeeKey, [b.vendor.name, b.vendor.normalizedName, ...b.vendor.aliases])
          : false,
      });
    }
  } else if (account.kind === "bank" && account.connectionId) {
    const invoices = await tx
      .select()
      .from(receivable)
      .where(
        and(
          eq(receivable.tenantId, tenantId),
          eq(receivable.connectionId, account.connectionId),
          eq(receivable.status, "open"),
          eq(receivable.balance, t.amount),
          eq(receivable.currency, t.currency),
          gte(receivable.txnDate, day(-OPEN_ITEM_DAYS)),
          lte(receivable.txnDate, day(MATCH_DAYS)),
        ),
      )
      .orderBy(desc(receivable.txnDate), asc(receivable.id))
      .limit(20);
    for (const i of invoices) {
      items.push({
        kind: "invoice",
        transactionId: null,
        receivableId: i.id,
        docNumber: i.docNumber,
        name: i.customerName,
        date: i.txnDate,
        balance: i.balance,
        currency: i.currency,
        confirmed: samePayee(t.payeeKey, [i.customerName]),
      });
    }
  }
  return items.find((i) => i.confirmed) ?? items[0] ?? null;
}

function withoutOpenItem(ext: Record<string, unknown>): Record<string, unknown> {
  const { openItem: _, ...rest } = ext;
  return rest;
}

/** The open bill or invoice a transaction was sent to a person for, or hinted at, if any. */
export function openItemOf(t: Pick<TxnRow, "ext">): OpenItem | null {
  const item = (t.ext as { openItem?: OpenItem }).openItem;
  return item && typeof item === "object" ? item : null;
}

/** Where a bill or invoice a transaction was held for stands now. */
async function itemNow(
  tx: Tx,
  tenantId: string,
  item: OpenItem,
): Promise<{ gone: boolean; balance: string | null; paid: boolean }> {
  if (item.kind === "bill" && item.transactionId) {
    const [bill] = await tx
      .select({
        deleted: sql<boolean>`coalesce((${transaction.ext} -> 'qbo' ->> 'deleted')::boolean, false)`,
        balance: sql<string>`coalesce((${rawRecord.payload} ->> 'Balance')::numeric, ${transaction.total})::text`,
      })
      .from(transaction)
      .leftJoin(
        rawRecord,
        and(
          eq(rawRecord.id, transaction.sourceRawRecordId),
          eq(rawRecord.tenantId, transaction.tenantId),
        ),
      )
      .where(and(eq(transaction.tenantId, tenantId), eq(transaction.id, item.transactionId)));
    if (!bill || bill.deleted) return { gone: true, balance: null, paid: false };
    return { gone: false, balance: toNumeric(dec(bill.balance)), paid: false };
  }
  if (item.kind === "invoice" && item.receivableId) {
    const [inv] = await tx
      .select()
      .from(receivable)
      .where(and(eq(receivable.tenantId, tenantId), eq(receivable.id, item.receivableId)));
    if (!inv || inv.status === "void" || inv.status === "deleted") {
      return { gone: true, balance: null, paid: false };
    }
    return { gone: false, balance: inv.balance, paid: inv.status === "paid" };
  }
  return { gone: true, balance: null, paid: false };
}

/**
 * Transactions waiting for a person because of an open bill or invoice, checked again. Paid in
 * QuickBooks (what is owed fell by exactly this amount, or the invoice is paid): it stays with a
 * person, the card asking whether this is that payment. Open again for what it was (the payment
 * there undone): back to the open bill or invoice. Deleted, voided or changed to another amount:
 * it goes back to `new`, to be decided again.
 */
// DECISION: a bill or invoice paid in QuickBooks never frees its payment to be booked again (bill
// payments aren't synced, so the bank transaction would become a second expense); the card asks
// the person whether this is that payment, to leave it out. It is checked again while it waits, so
// "paid" doesn't stick once the payment is undone or the bill is gone.
async function recheckOpenItems(tx: Tx, who: Decider): Promise<void> {
  const held = await tx
    .select({ t: bankTxn })
    .from(bankTxn)
    .where(
      and(
        eq(bankTxn.tenantId, who.tenantId),
        eq(bankTxn.status, "needs_review"),
        sql`${bankTxn.ext} -> 'openItem' ->> 'confirmed' = 'true'`,
      ),
    )
    .limit(RECHECK_LIMIT);
  for (const { t } of held) {
    const was = openItemOf(t);
    if (!was) continue;
    const now = await itemNow(tx, who.tenantId, was);
    const balance = !now.gone && now.balance !== null ? dec(now.balance) : null;
    const open = balance !== null && !now.paid && balance.eq(dec(was.balance));
    const paid =
      balance !== null && (now.paid || dec(was.balance).minus(balance).eq(dec(t.amount)));
    if (open) {
      // Still open for what it was: unchanged, or the payment there undone.
      if (was.paid) {
        const { paid: _, ...item } = was;
        await setStatus(tx, who.tenantId, t.id, "needs_review", { ...t.ext, openItem: item });
      }
    } else if (paid || was.paid) {
      // Once paid there, only the payment being undone frees it: a bill edited or deleted since
      // keeps it with a person (the payment may still be applied there).
      if (!was.paid) {
        await setStatus(tx, who.tenantId, t.id, "needs_review", {
          ...t.ext,
          // What was owed stays, for the card to name; the bill or invoice is paid now.
          openItem: { ...was, paid: true },
        });
      }
    } else if (await liveBooking(tx, who.tenantId, t.id)) {
      // A suggestion stands: it stays with a person, without the stale candidate.
      await setStatus(tx, who.tenantId, t.id, "needs_review", withoutOpenItem(t.ext));
    } else {
      await setStatus(tx, who.tenantId, t.id, "new", withoutOpenItem(t.ext));
    }
  }
}

/** The client's rule for this payee: a person's before a learned one, an account's before any. */
export async function ruleFor(
  tx: Tx,
  tenantId: string,
  t: Pick<TxnRow, "payeeKey" | "direction" | "accountLinkId">,
) {
  if (!t.payeeKey || isGenericPayeeKey(t.payeeKey)) return null;
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
      kind: kindFor(t.direction, account.kind),
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
/**
 * A test run's proposal (docs/plan.md §1.212): the checks `propose` makes, reading only, and the
 * status it would give, so a test run refuses what a live run refuses.
 */
// DECISION: found by the golden datasets: a test run answered `proposed` for a split whose lines
// didn't add up, which a live run refuses. The checks are the live ones; nothing is written.
export async function checkProposal(
  tx: Tx,
  tenantId: string,
  input: ProposeInput,
  threshold: number = BOOK_CONFIDENCE_AUTO,
): Promise<"proposed" | "needs_review"> {
  const t = await txnOf(tx, tenantId, input.bankTxnId);
  if (!["new", "needs_review"].includes(t.status)) {
    throw new PackRefusal(
      `transaction ${t.id} is ${t.status}: only an undecided one is proposed for`,
    );
  }
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    throw new PackRefusal("confidence is between 0 and 1");
  }
  const { lines, types } = await checkLines(tx, tenantId, t, input.lines);
  if (lines.length > 1 && types.some((ty) => MONEY_KINDS.includes(ty))) {
    throw new PackRefusal("a transfer has one line");
  }
  const hold =
    openItemOf(t)?.confirmed === true || heldPairOf(t) !== null || resentOfId(t) !== null;
  return input.confidence >= threshold && !hold ? "proposed" : "needs_review";
}

export async function propose(
  tx: Tx,
  who: Decider,
  input: ProposeInput,
  threshold: number = BOOK_CONFIDENCE_AUTO,
): Promise<{ bookingId: string; status: "proposed" | "needs_review" | "matched" }> {
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
      ? kindFor(t.direction, types[0] ?? "other")
      : t.direction === "out"
        ? "expense"
        : "deposit";
  if (lines.length > 1 && types.some((ty) => MONEY_KINDS.includes(ty))) {
    throw new PackRefusal("a transfer has one line");
  }
  // The same transfer, already booked from the other side: this side is matched to it.
  const other =
    kind === "transfer" && lines[0]
      ? await otherSideBooked(tx, who.tenantId, t, lines[0].ledgerAccountId)
      : null;
  if (other) {
    await joinBooked(tx, who.tenantId, t, other, deciderOf(who));
    return { bookingId: other.bookingId, status: "matched" };
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
  // A payment of an open bill or invoice, a side held as a transfer's pair, or a copy the bank sent
  // again of one already decided, waits for a person however sure the model is.
  const hold =
    openItemOf(t)?.confirmed === true || heldPairOf(t) !== null || resentOfId(t) !== null;
  const status = input.confidence >= threshold && !hold ? "proposed" : "needs_review";
  await setStatus(tx, who.tenantId, t.id, status);
  await repairPaired(tx, who.tenantId, t, {
    bookingId,
    kind,
    lineAccountId: lines[0]?.ledgerAccountId ?? null,
    decidedBy: deciderOf(who),
  });
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
  let other: Awaited<ReturnType<typeof otherSideBooked>> = null;
  if (live.kind === "transfer") {
    const [line] = await tx
      .select()
      .from(bookingLine)
      .where(and(eq(bookingLine.tenantId, who.tenantId), eq(bookingLine.bookingId, live.id)));
    if (line) other = await otherSideBooked(tx, who.tenantId, t, line.ledgerAccountId);
  }
  // The same transfer approved or written from the other side: this side is matched to it.
  if (other && other.status !== "proposed") {
    await joinBooked(tx, who.tenantId, t, other, { userId: who.userId });
    return other.bookingId;
  }
  // Proposed there, on an account set to book: that proposal is the one approved.
  if (other && other.mode === "book") return joinProposed(tx, who, t, other);
  await tx
    .update(booking)
    .set({ status: "approved", userId: who.userId, decidedAt: sql`now()` })
    .where(and(eq(booking.tenantId, who.tenantId), eq(booking.id, live.id)));
  await setStatus(tx, who.tenantId, t.id, "approved");
  if (other) await takeOver(tx, who.tenantId, other, live.id, t, { userId: who.userId });
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
      ? kindFor(t.direction, types[0] ?? "other")
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
  // The same transfer booked from the other side: a person's or approved one stands and this side
  // is matched to it; so does a proposal there on an account set to book (approved now). A
  // proposal on an account set to suggest gives way to this person's booking.
  const other =
    kind === "transfer" && lines[0]
      ? await otherSideBooked(tx, who.tenantId, t, lines[0].ledgerAccountId)
      : null;
  const why = input.why?.replace(/\s+/g, " ").trim() || null;
  const first = lines[0];
  let id: string;
  if (other && other.status !== "proposed") {
    await joinBooked(tx, who.tenantId, t, other, { userId: who.userId });
    id = other.bookingId;
  } else if (other && other.mode === "book") {
    id = await joinProposed(tx, who, t, other);
  } else {
    await supersede(tx, who.tenantId, t.id);
    id = await insertBooking(
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
    await repairPaired(tx, who.tenantId, t, {
      bookingId: id,
      kind,
      lineAccountId: first?.ledgerAccountId ?? null,
      byPerson: true,
      decidedBy: { userId: who.userId },
    });
    if (other) await takeOver(tx, who.tenantId, other, id, t, { userId: who.userId });
  }
  // Joined to the other side's transfer or booked here, the person's note and rule are kept.
  if (why && first) {
    await addNote(
      tx,
      who.tenantId,
      { ledgerAccountId: first.ledgerAccountId, note: why },
      { source: "client", userId: who.userId },
    );
  }
  // DECISION: a rule asked for on a transaction that names no payee (no words, or only generic
  // bank words) isn't made, and the booking stands; the transaction notes why.
  const ruleable = !!t.payeeKey && !isGenericPayeeKey(t.payeeKey);
  if (input.makeRule && !ruleable) {
    const [now] = await tx
      .select({ ext: bankTxn.ext })
      .from(bankTxn)
      .where(and(eq(bankTxn.tenantId, who.tenantId), eq(bankTxn.id, t.id)));
    await tx
      .update(bankTxn)
      .set({ ext: { ...(now?.ext ?? {}), ruleNotMade: "names no payee" } })
      .where(and(eq(bankTxn.tenantId, who.tenantId), eq(bankTxn.id, t.id)));
  } else if (input.makeRule && first && lines.length === 1 && t.payeeKey) {
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
  // Left out isn't "not a transfer": a side paired with it waits for a person too.
  await holdPaired(tx, who.tenantId, t, "left_out");
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
  if (isGenericPayeeKey(key)) {
    throw new PackRefusal(
      `"${key}" names no payee, only how the money moved: a rule for it would book every such transaction the same way`,
    );
  }
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
  if (!t.payeeKey || isGenericPayeeKey(t.payeeKey)) return null;
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
