// The Bookkeeping pack's report and card shapes, as the API answers them (packs/bookkeeping api.ts).
// The route contract types pack reports as objects (the platform names no pack); the pack's
// screens declare what they read here.
import type { PlainKey } from "../../i18n/catalog";
import type { Tone } from "../../ui/primitives";

export const BOOKINGS_REVIEW = "bookkeeping.bookings";
export const ACCOUNT_QUESTIONS = "bookkeeping.account-questions";

export type BankTxnStatus =
  | "pending"
  | "new"
  | "matched"
  | "proposed"
  | "needs_review"
  | "approved"
  | "posted"
  | "excluded"
  | "removed"
  | "skipped";

export const STATUS_LABEL: Record<BankTxnStatus, PlainKey> = {
  pending: "bookkeeping.status.pending",
  new: "bookkeeping.status.new",
  matched: "bookkeeping.status.matched",
  proposed: "bookkeeping.status.proposed",
  needs_review: "bookkeeping.status.needs_review",
  approved: "bookkeeping.status.approved",
  posted: "bookkeeping.status.posted",
  excluded: "bookkeeping.status.excluded",
  removed: "bookkeeping.status.removed",
  skipped: "bookkeeping.status.skipped",
};

// Brand book: gold waits on you (always with a word), copper is a person's sign-off, positive is
// done, slate (accent) is our proposal; the rest stay neutral.
export const STATUS_TONE: Record<BankTxnStatus, Tone> = {
  pending: "neutral",
  new: "neutral",
  matched: "positive",
  proposed: "accent",
  needs_review: "warning",
  approved: "person",
  posted: "positive",
  excluded: "neutral",
  removed: "neutral",
  skipped: "neutral",
};

export interface FeedAccount {
  id: string;
  name: string | null;
  mask: string | null;
  kind: "bank" | "card" | "other";
  mode: "off" | "suggest" | "book";
  bookFrom: string | null;
  ledgerAccountId: string | null;
  ledgerAccount: string | null;
}

export interface TransactionRow {
  id: string;
  date: string;
  account: string | null;
  mask: string | null;
  payee: string | null;
  direction: "in" | "out";
  amount: string;
  currency: string;
  status: BankTxnStatus;
  kind: string | null;
  bookedTo: string | null;
}

export interface TransactionsReport {
  counts: Partial<Record<BankTxnStatus, number>>;
  accounts: FeedAccount[];
  transactions: TransactionRow[];
}

export interface AccountNote {
  id: string;
  note: string;
  source: "client" | "operator" | "agent";
  createdAt: string;
}

export interface ChartAccount {
  id: string;
  name: string;
  fullName: string;
  number: string | null;
  classification: string | null;
  type: string;
  subType: string | null;
  description: string | null;
  active: boolean;
  notes: AccountNote[];
  examples: { payee: string; times: number }[];
}

export interface RuleRow {
  id: string;
  payee: string;
  direction: "in" | "out";
  account: string;
  ledgerAccountId: string;
  accountLinkId: string | null;
  source: "person" | "learned";
  active: boolean;
  hits: number;
}

export interface BookingLineView {
  ledgerAccountId: string;
  account: string;
  amount: string;
  classRef: string | null;
  description: string | null;
}

export interface ReviewTransaction {
  id: string;
  date: string;
  amount: string;
  currency: string;
  direction: "in" | "out";
  payee: string | null;
  description: string | null;
  status: BankTxnStatus;
  account: { id: string; name: string | null; mask: string | null; kind: string };
  booking: {
    id: string;
    kind: string;
    status: string;
    decidedBy: string;
    confidence: string;
    reason: string | null;
    alternatives: string[];
    lines: BookingLineView[];
  } | null;
}

export interface BookingsReviewData {
  transactions: ReviewTransaction[];
  accounts: {
    id: string;
    fullName: string;
    number: string | null;
    type: string;
    classification: string | null;
    description: string | null;
    note: string | null;
  }[];
}

export interface AccountQuestionsData {
  accounts: {
    id: string;
    fullName: string;
    number: string | null;
    type: string;
    description: string | null;
    notes: AccountNote[];
    examples: { payee: string; times: number }[];
  }[];
}

/** Statuses a person may still decide on the card. */
export const DECIDABLE: readonly BankTxnStatus[] = ["new", "proposed", "needs_review", "skipped"];
