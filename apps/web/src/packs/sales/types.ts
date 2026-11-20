// The Sales pack's card shapes, as the API answers them (packs/sales review.ts). The route contract
// types pack cards as objects (the platform names no pack); the pack's card declares what it reads.
import type { PlainKey } from "../../i18n/catalog";

export const SALES_MATCH_REVIEW = "sales.match";

export type Confidence = "high" | "medium" | "low";
export type FoundBy =
  | "email"
  | "phone"
  | "website"
  | "alias"
  | "name"
  | "meaning"
  | "model"
  | "person";
export type RowDecision = "matched" | "none" | "unsure";

export interface MatchCandidate {
  recordKeyId: string;
  module: string;
  externalId: string;
  values: Record<string, string>;
  score: number;
  confidence: Confidence;
  found: FoundBy | null;
  vetoed: "email" | "phone" | null;
}

export interface ComparedField {
  field: string;
  sheet: string | null;
  record: string | null;
  differs: boolean;
}

export interface MatchRow {
  index: number;
  agent: {
    decision: RowDecision;
    method: string;
    score: number;
    confidence: Confidence;
    found: FoundBy | null;
  };
  decision: RowDecision;
  decidedBy: "agent" | "person";
  record: {
    recordKeyId: string;
    module: string;
    externalId: string;
    values: Record<string, string>;
  } | null;
  /** The record is the agent's suggestion, not yet anyone's match. */
  suggested: boolean;
  sheet: Record<string, string>;
  compare: ComparedField[];
  candidates: MatchCandidate[];
}

export interface SalesMatchData {
  batchId: string;
  threshold: number;
  modules: string[];
  rows: MatchRow[];
  counts: { unsure: number; matched: number; none: number; waiting: number; decided: number };
}

/** A record the look-up found (packs/sales `LookupRecord`). */
export interface LookupRecord {
  recordKeyId: string;
  module: string;
  externalId: string;
  name: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
  deal: string | null;
  stage: string | null;
  amount: string | null;
  similarity: number;
}

export const CONFIDENCE_LABEL: Record<Confidence, PlainKey> = {
  high: "sales.review.confidence.high",
  medium: "sales.review.confidence.medium",
  low: "sales.review.confidence.low",
};

export const FOUND_LABEL: Record<FoundBy, PlainKey> = {
  email: "sales.review.found.email",
  phone: "sales.review.found.phone",
  website: "sales.review.found.website",
  alias: "sales.review.found.alias",
  name: "sales.review.found.name",
  meaning: "sales.review.found.meaning",
  model: "sales.review.found.model",
  person: "sales.review.found.person",
};

export const FIELD_LABEL: Record<string, PlainKey> = {
  name: "sales.review.field.name",
  company: "sales.review.field.company",
  email: "sales.review.field.email",
  phone: "sales.review.field.phone",
  website: "sales.review.field.website",
  deal: "sales.review.field.deal",
};
