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
