// The client's chart of accounts as the Bookkeeping area reads it (docs/plan.md §1.79): each account
// with what it is for, in three voices (the client's and the operator's words first, then the
// agent's, learned from what was booked there), and the payees most often booked to it. The
// accounts themselves are the platform's `ledger_account`, synced from the accounting tool.

import {
  LEDGER_NOTE_MAX,
  type LedgerAccountView,
  type LedgerKind,
  ledgerAccount,
  ledgerAccountNote,
  ledgerChart,
  type Tx,
} from "@countersign/db";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { PackRefusal } from "./pack";
import { bankTxn, booking, bookingLine } from "./schema";

/** At most this many example payees per account in a listing. */
export const EXAMPLES_PER_ACCOUNT = 5;
/** At most this many accounts on one account-questions card. */
export const QUESTIONS_MAX = 10;

export type AccountNoteView = LedgerAccountView["notes"][number];

/** An account as the platform's ledger lists it, with the payees most often booked there. */
export interface AccountView extends LedgerAccountView {
  /** Payees most often booked here (approved or posted bookings), most first. */
  examples: { payee: string; times: number }[];
}

/** Which classifications a listing may ask for. */
export type AccountKind = "expense" | "revenue" | "asset" | "liability" | "equity";

/**
 * The client's accounts with their notes (the platform's `ledgerChart`) and the payees booked to
 * each. Inactive accounts only when asked: a booking never goes to one.
 */
// DECISION (docs/plan.md §1.79): the chart and its notes are the platform's read, shared with
// `ledger.accounts.list`; the pack adds only what its own bookings show.
export async function listAccounts(
  tx: Tx,
  tenantId: string,
  opts: {
    classifications?: readonly AccountKind[];
    kinds?: readonly LedgerKind[];
    ids?: readonly string[];
    inactive?: boolean;
  } = {},
): Promise<AccountView[]> {
  const accounts = await ledgerChart(tx, tenantId, opts);
  if (accounts.length === 0) return [];
  const examples = await accountExamples(
    tx,
    tenantId,
    accounts.map((a) => a.id),
  );
  return accounts.map((a) => ({ ...a, examples: examples.get(a.id) ?? [] }));
}

/** The payees most often booked to each account, from approved and posted bookings. */
// DECISION: computed, never stored, so what the agent learns from bookings can't drift from them.
async function accountExamples(
  tx: Tx,
  tenantId: string,
  ids: readonly string[],
): Promise<Map<string, { payee: string; times: number }[]>> {
  const rows = await tx
    .select({
      accountId: bookingLine.ledgerAccountId,
      // One payee however the bank spells it this time ("Shell", "SHELL 5741"): by its key.
      payee: sql<string>`min(${bankTxn.payee})`,
      times: sql<number>`count(*)::int`,
    })
    .from(bookingLine)
    .innerJoin(
      booking,
      and(eq(booking.id, bookingLine.bookingId), eq(booking.tenantId, bookingLine.tenantId)),
    )
    .innerJoin(
      bankTxn,
      and(eq(bankTxn.id, booking.bankTxnId), eq(bankTxn.tenantId, booking.tenantId)),
    )
    .where(
      and(
        eq(bookingLine.tenantId, tenantId),
        inArray(bookingLine.ledgerAccountId, [...ids]),
        inArray(booking.status, ["approved", "posted"]),
        sql`${bankTxn.payee} is not null`,
      ),
    )
    .groupBy(bookingLine.ledgerAccountId, sql`coalesce(${bankTxn.payeeKey}, ${bankTxn.payee})`)
    .orderBy(desc(sql`count(*)`), asc(sql`min(${bankTxn.payee})`));
  const out = new Map<string, { payee: string; times: number }[]>();
  for (const r of rows) {
    const list = out.get(r.accountId) ?? [];
    if (list.length < EXAMPLES_PER_ACCOUNT && r.payee)
      list.push({ payee: r.payee, times: r.times });
    out.set(r.accountId, list);
  }
  return out;
}

/** One of the client's accounts, active, or a refusal in our words. */
export async function activeAccount(tx: Tx, tenantId: string, id: string) {
  const [a] = await tx
    .select()
    .from(ledgerAccount)
    .where(and(eq(ledgerAccount.tenantId, tenantId), eq(ledgerAccount.id, id)));
  if (!a) throw new PackRefusal(`account ${id} isn't one of this client's accounts`);
  if (!a.active) throw new PackRefusal(`${a.fullName} is inactive in the accounting tool`);
  return a;
}

export type NoteAuthor =
  | { source: "agent"; agentVersionId: string; sources: readonly string[] }
  | { source: "client" | "operator"; userId: string; inboxItemId?: string | null };

/** Adds a note on what an account is for. An agent's rests on records (invariant 10). */
export async function addNote(
  tx: Tx,
  tenantId: string,
  input: { ledgerAccountId: string; note: string },
  author: NoteAuthor,
): Promise<{ id: string }> {
  const text = input.note.replace(/\s+/g, " ").trim();
  if (!text) throw new PackRefusal("say what the account is for");
  if (text.length > LEDGER_NOTE_MAX) {
    throw new PackRefusal(`a note is at most ${LEDGER_NOTE_MAX} characters`);
  }
  await activeAccount(tx, tenantId, input.ledgerAccountId);
  if (author.source === "agent" && author.sources.length === 0) {
    throw new PackRefusal("an agent's note names the bookings it rests on (sources)");
  }
  const [row] = await tx
    .insert(ledgerAccountNote)
    .values({
      tenantId,
      ledgerAccountId: input.ledgerAccountId,
      note: text,
      source: author.source,
      ...(author.source === "agent"
        ? { agentVersionId: author.agentVersionId, sources: [...author.sources] }
        : { userId: author.userId, inboxItemId: author.inboxItemId ?? null }),
    })
    .returning({ id: ledgerAccountNote.id });
  if (!row) throw new Error("note not stored");
  return row;
}

/**
 * Accounts a booking might go to that nobody has described: active income, expense and
 * cost-of-goods accounts with no description in the accounting tool and no person's note. Those
 * named in `prefer` (the ones the model was unsure between) come first.
 */
export async function unclearAccounts(
  tx: Tx,
  tenantId: string,
  opts: { prefer?: readonly string[]; limit?: number } = {},
): Promise<AccountView[]> {
  const all = await listAccounts(tx, tenantId, { classifications: ["expense", "revenue"] });
  const prefer = new Set(opts.prefer ?? []);
  return all
    .filter((a) => !a.description && !a.notes.some((n) => n.source !== "agent"))
    .sort((x, y) => Number(prefer.has(y.id)) - Number(prefer.has(x.id)))
    .slice(0, Math.min(opts.limit ?? QUESTIONS_MAX, QUESTIONS_MAX));
}
