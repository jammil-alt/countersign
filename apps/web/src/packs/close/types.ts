// The Close pack's screens' shapes (docs/plan.md §1.232), as the API's close report and the sign-off
// card send them. Amounts are decimal strings; nothing here names an agent, a prompt or a cost.
import type { PlainKey } from "../../i18n/catalog";
import type { Tone } from "../../ui/primitives";

export const CLOSE_REVIEW = "close.signoff";

export type CloseItemStatus = "open" | "done" | "waived";
export type CloseEntryStatus = "proposed" | "rejected" | "posted" | "failed" | "superseded";
export type CloseEntryKind = "accrual" | "reversal" | "recurring";

export interface CloseItem {
  id: string;
  key: string;
  kind: string;
  title: string;
  status: CloseItemStatus;
  amount: string | null;
  count: number;
  summary: string | null;
  note: string | null;
}

export interface CloseEntry {
  id: string;
  kind: CloseEntryKind;
  status: CloseEntryStatus;
  txnDate: string;
  reverseOn: string | null;
  amount: string;
  currency: string;
  memo: string;
  reason: string | null;
  qboId: string | null;
  error: string | null;
  /** The QuickBooks write's state while it isn't recorded yet. */
  write: string | null;
  lines: {
    accountName: string;
    posting: "debit" | "credit";
    amount: string;
    description: string | null;
  }[];
}

export interface CloseMonth {
  period: {
    id: string;
    periodStart: string;
    periodEnd: string;
    currency: string;
    status: "open" | "signed_off";
    checkedAt: string | null;
    signedOffAt: string | null;
    signedOffBy: string | null;
    note: string | null;
  };
  items: CloseItem[];
  entries: CloseEntry[];
  open: number;
  readyToSignOff: boolean;
  blockers: string[];
}

export interface ClosePeriodRow {
  id: string;
  periodStart: string;
  periodEnd: string;
  status: "open" | "signed_off";
  signedOffAt: string | null;
  open: number;
  items: number;
}

export interface CloseReport {
  periods: ClosePeriodRow[];
  close: CloseMonth | null;
}

export const ITEM_LABEL: Record<CloseItemStatus, PlainKey> = {
  open: "close.item.open",
  done: "close.item.done",
  waived: "close.item.waived",
};
export const ITEM_TONE: Record<CloseItemStatus, Tone> = {
  open: "warning",
  done: "positive",
  waived: "person",
};
export const ENTRY_LABEL: Record<CloseEntryStatus, PlainKey> = {
  proposed: "close.entry.proposed",
  rejected: "close.entry.rejected",
  posted: "close.entry.posted",
  failed: "close.entry.failed",
  superseded: "close.entry.superseded",
};
export const ENTRY_TONE: Record<CloseEntryStatus, Tone> = {
  proposed: "warning",
  rejected: "neutral",
  posted: "positive",
  failed: "risk",
  superseded: "neutral",
};
export const KIND_LABEL: Record<CloseEntryKind, PlainKey> = {
  accrual: "close.kind.accrual",
  reversal: "close.kind.reversal",
  recurring: "close.kind.recurring",
};
