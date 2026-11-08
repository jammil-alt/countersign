// The Materials pack's report and review shapes, as the API answers them (packs/materials reports.ts
// and api.ts). The route contract types pack reports as objects (the platform names no pack); the
// pack's screens declare what they read here.
import type { PlainKey } from "../../i18n/catalog";

export interface PriceWatchRow {
  catalogItemId: string;
  item: string;
  category: string;
  standardUom: string;
  vendorId: string;
  vendor: string;
  lastPrice: string;
  lastOn: string;
  previousPrice: string | null;
  changePct: string | null;
  series: { on: string; price: string }[];
  purchases90: number;
  qty90: string;
  openAlerts: number;
}

export interface PriceWatchAlert {
  id: string;
  kind: string;
  severity: string;
  status: string;
  title: string;
  body: string;
  dollarImpact: string | null;
  createdAt: string;
  catalogItemId: string | null;
  vendorId: string | null;
  evidence: string[];
  documents: { id: string; label: string }[];
}

export interface PriceWatchReport {
  asOf: string;
  rows: PriceWatchRow[];
  alerts: PriceWatchAlert[];
  totals: { items: number; vendors: number; openAlerts: number; dollarImpact: string };
}

export interface CatalogRow {
  id: string;
  category: string;
  name: string;
  standardUom: string;
  attributes: Record<string, string>;
  vendors: number;
  aliases: number;
  purchases: number;
  lastPrice: string | null;
  lastOn: string | null;
}

export interface CatalogReport {
  items: CatalogRow[];
}

export interface ReviewLine {
  docLineId: string;
  lineNo: number;
  description: string;
  vendorSku: string | null;
  qty: string;
  uom: string | null;
  unitPrice: string;
  decision: "matched" | "new_item" | "unsure" | null;
  method: string | null;
  catalogItemId: string | null;
  catalogItemName: string | null;
  candidates: { catalogItemId: string; name: string; confidence: number; vetoed: boolean }[];
}

export interface MatchReviewData {
  documentId: string | null;
  lines: ReviewLine[];
}

/** The review key the match review's inbox items carry (`payload.review`). */
export const MATCH_REVIEW = "materials.match";

// Units, categories and alert kinds in the reader's words (../../i18n/messages); one the pack adds
// later shows as the pack names it until it has words here.
export const UNIT_LABEL: Record<string, PlainKey> = {
  sheet: "materials.unit.sheet",
  board_foot: "materials.unit.board_foot",
  linear_foot: "materials.unit.linear_foot",
  each: "materials.unit.each",
  gallon: "materials.unit.gallon",
  quart: "materials.unit.quart",
};

export const CATEGORY_LABEL: Record<string, PlainKey> = {
  sheet_goods: "materials.category.sheet_goods",
  hardwood: "materials.category.hardwood",
  mouldings: "materials.category.mouldings",
  hardware: "materials.category.hardware",
  finishes: "materials.category.finishes",
  other: "materials.category.other",
};

export const ALERT_LABEL: Record<string, PlainKey> = {
  price_jump: "materials.alert.kind.price_jump",
  price_vs_avg: "materials.alert.kind.price_vs_avg",
  vendor_spread: "materials.alert.kind.vendor_spread",
  price_creep: "materials.alert.kind.price_creep",
  new_fee: "materials.alert.kind.new_fee",
  outlier: "materials.alert.kind.outlier",
};

// ── P-9: purchase requests (docs/plan.md §1.71) ─────────────────────────────────────────────────

export const REQUEST_LINES_REVIEW = "materials.request-lines";
export const VENDOR_CHOICE_REVIEW = "materials.vendor-choice";

export type RequestStatus = "open" | "quoting" | "quoted" | "ordered" | "cancelled" | "closed";
export type QuoteStatus = "draft" | "sent" | "received" | "declined" | "expired";

export interface RequestsReportRow {
  id: string;
  createdAt: string;
  status: RequestStatus;
  channel: string;
  neededBy: string | null;
  fulfillment: string | null;
  lines: { description: string; qty: string | null; unit: string | null; matched: boolean }[];
  quotes: { vendor: string; status: QuoteStatus; receivedAt: string | null }[];
  order: string | null;
}

export interface Offer {
  quoteRequestId: string;
  vendorId: string;
  vendorName: string;
  unitPrice: string | null;
  unit: string | null;
  currency: string;
  /** What the line would cost from this vendor (decimal). */
  lineTotal: string | null;
  leadTimeDays: number | null;
  available: boolean;
  comparable: boolean;
}

export interface Comparison {
  requestId: string;
  neededBy: string | null;
  lines: {
    requestLineId: string;
    lineNo: number;
    description: string;
    qty: string;
    unit: string | null;
    offers: Offer[];
    best: { quoteRequestId: string; vendorId: string } | null;
  }[];
  vendors: {
    quoteRequestId: string;
    vendorId: string;
    vendorName: string;
    total: string;
    currency: string | null;
    complete: boolean;
    late: boolean;
    maxLeadTimeDays: number | null;
  }[];
  suggestion: {
    kind: "single" | "split" | "none";
    quoteRequestId: string | null;
    total: string | null;
    currency: string | null;
    split: { quoteRequestId: string; vendorId: string; requestLineIds: string[]; total: string }[];
    reasons: string[];
  };
}

export interface Choice {
  kind: "single" | "split";
  quoteRequestId: string | null;
  split: { quoteRequestId: string; requestLineIds: string[] }[];
  at: string;
}

export interface RequestPage {
  id: string;
  status: RequestStatus;
  channel: string;
  neededBy: string | null;
  fulfillment: "delivery" | "pickup" | null;
  deliverTo: string | null;
  notes: string | null;
  createdAt: string;
  orders: { connector: string; externalId: string; quoteRequestId: string | null; at: string }[];
  lines: {
    id: string;
    lineNo: number;
    description: string;
    qty: string | null;
    unit: string | null;
    catalogItemName: string | null;
    matched: boolean;
  }[];
  quotes: {
    id: string;
    vendorId: string;
    vendorName: string;
    status: QuoteStatus;
    sentAt: string | null;
    receivedAt: string | null;
    lines: {
      requestLineId: string;
      unitPrice: string | null;
      unit: string | null;
      currency: string;
      leadTimeDays: number | null;
      available: boolean;
    }[];
  }[];
  comparison: Comparison | null;
  choice: Choice | null;
  documents: { id: string; filename: string; kind: string }[];
}

export interface RequestLinesData {
  requestId: string;
  status: RequestStatus;
  lines: {
    id: string;
    lineNo: number;
    description: string;
    qty: string | null;
    unit: string | null;
    catalogItemId: string | null;
    catalogItemName: string | null;
    matchMethod: string | null;
    candidates: { catalogItemId: string; name: string; confidence: number }[];
    settled: boolean;
  }[];
  catalog: { id: string; name: string; standardUom: string }[];
}

export interface VendorChoiceData {
  requestId: string;
  status: RequestStatus;
  comparison: Comparison;
  choice: Choice | null;
}

export const REQUEST_STATUS_LABEL: Record<RequestStatus, PlainKey> = {
  open: "materials.requests.status.open",
  quoting: "materials.requests.status.quoting",
  quoted: "materials.requests.status.quoted",
  ordered: "materials.requests.status.ordered",
  cancelled: "materials.requests.status.cancelled",
  closed: "materials.requests.status.closed",
};

export const QUOTE_STATUS_LABEL: Record<QuoteStatus, PlainKey> = {
  draft: "materials.request.quote.draft",
  sent: "materials.request.quote.sent",
  received: "materials.request.quote.received",
  declined: "materials.request.quote.declined",
  expired: "materials.request.quote.expired",
};
