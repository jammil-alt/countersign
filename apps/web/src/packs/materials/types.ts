// The Materials pack's report and review shapes, as the API answers them (packs/materials reports.ts
// and api.ts). The route contract types pack reports as objects (the platform names no pack); the
// pack's screens declare what they read here.

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

export const UNIT_LABEL: Record<string, string> = {
  sheet: "sheet",
  board_foot: "board foot",
  linear_foot: "linear foot",
  each: "each",
  gallon: "gallon",
  quart: "quart",
};

export const CATEGORY_LABEL: Record<string, string> = {
  sheet_goods: "Sheet goods",
  hardwood: "Hardwood",
  mouldings: "Mouldings and edgebanding",
  hardware: "Hardware",
  finishes: "Finishes and adhesives",
  other: "Other",
};

export const ALERT_LABEL: Record<string, string> = {
  price_jump: "Price up",
  price_vs_avg: "Over average",
  vendor_spread: "Cheaper elsewhere",
  price_creep: "Creeping up",
  new_fee: "New fee",
  outlier: "Unusual",
};
