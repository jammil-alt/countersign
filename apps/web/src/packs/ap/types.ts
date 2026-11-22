// The AP pack's web types (Plan entry §1.233): the week's approve-to-pay list as the pack's report
// and card return it (packs/materials/src/ap/store.ts `PayListView`, `BillView`).
import type { PlainKey } from "../../i18n/catalog";
import type { Tone } from "../../ui/primitives";

export const AP_PAY_LIST_REVIEW = "ap.pay_list";

export type FlagSeverity = "block" | "warn" | "info";
export type BillStatus = "open" | "approved" | "held" | "rejected";

export interface ApFlag {
  kind: string;
  severity: FlagSeverity;
  message: string;
  lineNo?: number;
  impact?: string;
  sources: string[];
}

export interface BillLine {
  id: string;
  lineNo: number;
  /** As the invoice printed it: data, shown as written. */
  description: string;
  qty: string | null;
  unit: string | null;
  unitPrice: string | null;
  amount: string;
  account: { id: string; name: string; number: string | null } | null;
  codedBy: "history" | "person" | null;
  proposal: { account: { id: string; name: string }; reason: string | null } | null;
}

export interface Bill {
  id: string;
  status: BillStatus;
  vendorName: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  amount: string;
  currency: string;
  documentId: string | null;
  matchStatus: "pending" | "matched" | "partial" | "proposed" | "none";
  order: { id: string; reference: string | null } | null;
  flags: ApFlag[];
  ready: boolean;
  decidedBy: string | null;
  decisionNote: string | null;
  lines: BillLine[];
}

export interface PayList {
  week: string;
  payDay: string;
  bills: Bill[];
  count: number;
  totals: { currency: string; listed: string; approved: string; ready: string }[];
  ready: number;
  needsYou: number;
}

export interface Account {
  id: string;
  name: string;
  number: string | null;
}

export type PayListDecision =
  | { action: "approve"; input: { billId: string; note?: string } }
  | { action: "hold" | "reject"; input: { billId: string; note: string } }
  | { action: "approve_ready"; input: Record<string, never> }
  | { action: "code_line"; input: { billLineId: string; ledgerAccountId: string } }
  | { action: "take_proposal"; input: { billLineId: string } }
  | { action: "confirm_order" | "not_this_order" | "received"; input: { billId: string } };

export const FLAG_TONE: Record<FlagSeverity, Tone> = {
  block: "risk",
  warn: "warning",
  info: "neutral",
};

const FLAG_KINDS = [
  "duplicate",
  "possible_duplicate",
  "price_over_order",
  "price_under_order",
  "unit_not_compared",
  "qty_over_order",
  "qty_over_received",
  "not_received",
  "amount_differs",
  "no_order",
  "order_to_confirm",
  "uncoded",
  "read_again",
] as const;

/** A flag's name in the reader's language; one we don't know reads as a flag. */
export function flagLabel(kind: string): PlainKey {
  return (FLAG_KINDS as readonly string[]).includes(kind)
    ? (`ap.flag.${kind}` as PlainKey)
    : "ap.flag.other";
}

export const STATUS_LABEL: Record<BillStatus, PlainKey> = {
  open: "ap.status.open",
  approved: "ap.status.approved",
  held: "ap.status.held",
  rejected: "ap.status.rejected",
};

export const STATUS_TONE: Record<BillStatus, Tone> = {
  open: "warning",
  approved: "person",
  held: "warning",
  rejected: "neutral",
};
