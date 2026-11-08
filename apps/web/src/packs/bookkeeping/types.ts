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
  /** The accounting connection (a company) whose ledger it is. */
  connectionId: string;
  /** What it is in the platform's words (`bank`, `card`, `expense`, …). */
  kind: string;
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

// ── R-1 (docs/plan.md §1.80): reconciliation ────────────────────────────────────────────────────

export const RECONCILIATION_REVIEW = "bookkeeping.reconciliation";

export type ReconOutcome = "balanced" | "explained" | "unexplained";
export type ReconStatus = "open" | "signed_off" | "superseded";
export type ReconLabel = "timing" | "missing" | "amount_differs" | "duplicate";
export type ReconMethod = "exact" | "amount_date" | "group" | "model" | "person";

export const OUTCOME_LABEL: Record<ReconOutcome, PlainKey> = {
  balanced: "bookkeeping.recon.outcome.balanced",
  explained: "bookkeeping.recon.outcome.explained",
  unexplained: "bookkeeping.recon.outcome.unexplained",
};
// Brand book: done is positive; leftovers explained wait on a person's sign-off (gold, with a
// word); what isn't explained is a risk.
export const OUTCOME_TONE: Record<ReconOutcome, Tone> = {
  balanced: "positive",
  explained: "warning",
  unexplained: "risk",
};
export const RECON_STATUS_LABEL: Record<ReconStatus, PlainKey> = {
  open: "bookkeeping.recon.status.open",
  signed_off: "bookkeeping.recon.status.signed_off",
  superseded: "bookkeeping.recon.status.superseded",
};
export const LABEL_WORDS: Record<ReconLabel, PlainKey> = {
  timing: "bookkeeping.recon.label.timing",
  missing: "bookkeeping.recon.label.missing",
  amount_differs: "bookkeeping.recon.label.amount_differs",
  duplicate: "bookkeeping.recon.label.duplicate",
};
export const METHOD_WORDS: Record<ReconMethod, PlainKey> = {
  exact: "bookkeeping.recon.method.exact",
  amount_date: "bookkeeping.recon.method.amount_date",
  group: "bookkeeping.recon.method.group",
  model: "bookkeeping.recon.method.model",
  person: "bookkeeping.recon.method.person",
};

export interface ReconItem {
  id: string;
  side: "a" | "b";
  ref: string;
  date: string | null;
  /** How much it moves its side's balance (signed). */
  effect: string;
  /** The source's words: data, shown as written. */
  description: string | null;
  reference: string | null;
  carried: boolean;
  addedByPerson: boolean;
  state: "matched" | "unmatched";
  label: ReconLabel | null;
}

export interface ReconMatch {
  id: string;
  method: ReconMethod;
  status: "accepted" | "proposed" | "rejected";
  aItemIds: string[];
  bItemIds: string[];
  confidence: string | null;
  reason: string | null;
}

export interface ReconciliationView {
  id: string;
  aLabel: string;
  bLabel: string;
  periodStart: string | null;
  asOf: string;
  currency: string;
  aOpening: string | null;
  aClosing: string;
  bOpening: string | null;
  bClosing: string;
  difference: string;
  residual: string;
  outcome: ReconOutcome;
  status: ReconStatus;
  signedOffAt: string | null;
  note: string | null;
  summary: string;
  items: ReconItem[];
  matches: ReconMatch[];
}

export interface ReconciliationsReport {
  reconciliations: {
    id: string;
    asOf: string;
    periodStart: string | null;
    aLabel: string;
    bLabel: string;
    aClosing: string;
    bClosing: string;
    difference: string;
    residual: string;
    currency: string;
    outcome: ReconOutcome;
    status: ReconStatus;
    signedOffAt: string | null;
  }[];
}
