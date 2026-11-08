// Item matching (ARCHITECTURE §12.3): deterministic first, model second, human last.
//   1. normalize   2. alias lookup → matched (alias, 1.0)   3. parse (rules, then the model's
//   fallback reading)   4. candidates (equal key attributes, then trigrams)   5. adjudicate (model)
//   6. route by match_confidence_auto   7. hard rules veto any match whose key attributes differ.
// Model calls happen between transactions, never inside one. Every decision is an item_match row
// with the agent version that made it (invariant 10); automatic ones teach `auto` aliases.

import { type Db, type Tx, withTenant } from "@countersign/db";
import type { LlmClient } from "@countersign/llm";
import { emit } from "@countersign/senses";
import { materialsEventRegistry } from "../events";
import type { MatchDecision, MatchMethod } from "../schema";
import { type ParsedLine, parseNormalized, RULE_CONFIDENCE, scorePair } from "./keys";
import { adjudicate, modelParse } from "./model";
import { descriptionHash, normalize } from "./normalize";
import { MATCH_CONFIDENCE_AUTO } from "./settings";
import {
  type Candidate,
  type CatalogItemRow,
  createItem,
  findAlias,
  findCandidates,
  learnAlias,
  liveItem,
  loadLine,
  recordMatch,
} from "./store";

export { MATCH_CONFIDENCE_AUTO };

// DECISION: when no live item could be the line (every candidate differs on a key attribute, or
// there are none) and every required key attribute is stated, the rules create the item with
// confidence 0.95: above the default threshold, so a new item never waits for the model.
export const RULE_NEW_ITEM_CONFIDENCE = 0.95;

/** A model answer is never trusted above this when the hard rules vetoed it. */
const VETOED_CONFIDENCE = 0.5;

export interface MatchDeps {
  db: Db;
  /** The model, for fallback parsing and adjudication; without it those lines go to review. */
  llm?: LlmClient | null | undefined;
}

export interface MatchLineInput {
  tenantId: string;
  docLineId: string;
  /** The vendor, when the line's document has no transaction yet. */
  vendorId?: string | undefined;
  agentVersionId: string;
  /** match_confidence_auto from the skill's settings. */
  threshold?: number | undefined;
  /** A test run emits no events (they could start other workflows). */
  testRun?: boolean | undefined;
}

export interface CandidateView {
  catalogItemId: string;
  name: string;
  confidence: number;
  hinge: string | null;
  similarity: number | null;
  vetoed: boolean;
}

export interface MatchLineResult {
  docLineId: string;
  matchId: string;
  decision: MatchDecision;
  catalogItemId: string | null;
  catalogItemName: string | null;
  createdItem: boolean;
  confidence: number;
  method: MatchMethod;
  hingeAttribute: string | null;
  /** Below the threshold: a person decides (the workflow's match review). */
  needsReview: boolean;
  candidates: CandidateView[];
  category: string;
  attributes: Record<string, string>;
}

export class MatchError extends Error {
  override name = "MatchError";
  constructor(
    readonly code:
      | "line_not_found"
      | "no_vendor"
      | "not_found"
      | "different_category"
      | "different_uom"
      | "same_item",
    message: string,
  ) {
    super(message);
  }
}

interface Prepared {
  line: { raw: string; normalized: string; sku: string | null; hash: string };
  vendorId: string;
}

async function prepare(
  tx: Tx,
  input: { tenantId: string; docLineId: string; vendorId?: string | undefined },
): Promise<Prepared> {
  const row = await loadLine(tx, input.tenantId, input.docLineId);
  if (!row) throw new MatchError("line_not_found", `document line ${input.docLineId} not found`);
  const vendorId = input.vendorId ?? row.vendorId;
  if (!vendorId) {
    throw new MatchError("no_vendor", "the line's document has no vendor; pass vendorId");
  }
  const normalized = normalize(row.rawDescription, { abbreviations: row.abbreviations });
  return {
    line: {
      raw: row.rawDescription,
      normalized,
      sku: row.vendorSku?.trim().toUpperCase() || null,
      hash: await descriptionHash(normalized),
    },
    vendorId,
  };
}

function view(c: Candidate, parsed: ParsedLine): CandidateView {
  const s = scorePair(parsed, {
    category: c.item.category,
    attributes: c.item.attributes as Record<string, string>,
  });
  return {
    catalogItemId: c.item.id,
    name: c.item.canonicalName,
    confidence: s.confidence,
    hinge: s.hinge,
    similarity: c.similarity,
    vetoed: s.comparison.differ.length > 0,
  };
}

interface Verdict {
  decision: MatchDecision;
  item: CatalogItemRow | null;
  confidence: number;
  method: MatchMethod;
  hinge: string | null;
}

/** Matches one document line and records the decision. */
export async function matchLine(deps: MatchDeps, input: MatchLineInput): Promise<MatchLineResult> {
  const threshold = input.threshold ?? MATCH_CONFIDENCE_AUTO;
  const registry = materialsEventRegistry();

  // 1–2. Normalize; an alias settles it at once.
  const first = await withTenant(deps.db, input.tenantId, async (tx) => {
    const prepared = await prepare(tx, input);
    const hit = await findAlias(tx, input.tenantId, {
      vendorId: prepared.vendorId,
      vendorSku: prepared.line.sku,
      descriptionHash: prepared.line.hash,
    });
    if (!hit) return { prepared, result: null };
    const parsed = parseNormalized(prepared.line.normalized);
    const verdict: Verdict = {
      decision: "matched",
      item: hit.item,
      confidence: 1,
      method: "alias",
      hinge: null,
    };
    const result = await record(
      tx,
      input,
      prepared,
      parsed,
      verdict,
      [],
      false,
      threshold,
      registry,
    );
    return { prepared, result };
  });
  if (first.result) return first.result;
  const { prepared } = first;

  // 3. Parse: rules, then the model's reading when required attributes are missing.
  let parsed = parseNormalized(prepared.line.normalized);
  if (
    !parsed.complete &&
    deps.llm &&
    parsed.category !== "sheet_goods" &&
    parsed.category !== "hardwood"
  ) {
    try {
      const reading = await modelParse(deps.llm, prepared.line, "materials.match_line:parse");
      if (
        reading.complete ||
        Object.keys(reading.attributes).length > Object.keys(parsed.attributes).length
      ) {
        parsed = reading;
      }
    } catch {
      // DECISION: a failed fallback reading keeps the rules' reading; the line goes to review.
    }
  }

  // 4. Candidates, scored by the rules.
  const candidates = await withTenant(deps.db, input.tenantId, (tx) =>
    findCandidates(tx, input.tenantId, parsed),
  );
  const views = candidates.map((c) => view(c, parsed));
  const exact = candidates.filter((_, i) => (views[i]?.confidence ?? 0) >= RULE_CONFIDENCE.exact);
  const possible = candidates.filter((_, i) => (views[i]?.confidence ?? 0) > RULE_CONFIDENCE.veto);

  let verdict: Verdict;
  if (exact.length === 1 && exact[0]) {
    verdict = {
      decision: "matched",
      item: exact[0].item,
      confidence: RULE_CONFIDENCE.exact,
      method: "rules",
      hinge: null,
    };
  } else if (possible.length === 0 && parsed.complete && parsed.category !== "other") {
    verdict = {
      decision: "new_item",
      item: null,
      confidence: RULE_NEW_ITEM_CONFIDENCE,
      method: "rules",
      hinge: views.find((v) => v.vetoed)?.hinge ?? null,
    };
  } else if (deps.llm) {
    // 5. Adjudicate: the candidates the rules didn't rule out, best first, then the near-misses
    // they did (context for the model; the hard rules still veto them in adjudicateLine).
    // DECISION: near-misses are shown to the model after the plausible candidates, up to five.
    const ranked = candidates
      .map((c, i) => ({ c, v: views[i] as CandidateView }))
      .sort(
        (a, b) =>
          Number(a.v.vetoed) - Number(b.v.vetoed) ||
          b.v.confidence - a.v.confidence ||
          (b.v.similarity ?? 1) - (a.v.similarity ?? 1),
      );
    verdict = await adjudicateLine(
      deps.llm,
      prepared,
      parsed,
      ranked.map((x) => x.c),
      exact.length,
    );
  } else {
    verdict = {
      decision: "unsure",
      item: null,
      confidence: Math.max(0, ...views.map((v) => v.confidence)),
      method: "rules",
      hinge: parsed.missing[0] ?? views.find((v) => !v.vetoed)?.hinge ?? null,
    };
  }

  // 6–7. Route and record.
  return withTenant(deps.db, input.tenantId, (tx) =>
    record(tx, input, prepared, parsed, verdict, views, true, threshold, registry),
  );
}

async function adjudicateLine(
  llm: LlmClient,
  prepared: Prepared,
  parsed: ParsedLine,
  candidates: readonly Candidate[],
  exactCount: number,
): Promise<Verdict> {
  const top = candidates.slice(0, 5);
  let answer: Awaited<ReturnType<typeof adjudicate>>;
  try {
    answer = await adjudicate(
      llm,
      { raw: prepared.line.raw, parsed },
      top.map((c) => ({
        id: c.item.id,
        name: c.item.canonicalName,
        attributes: c.item.attributes as Record<string, string>,
      })),
      "materials.match_line:adjudicate",
    );
  } catch {
    // DECISION: an unusable model answer is "unsure": a person decides, nothing is guessed.
    return { decision: "unsure", item: null, confidence: 0, method: "llm", hinge: null };
  }
  const hinge = answer.hinge_attribute?.trim().toLowerCase() || null;
  if (answer.decision === "matched") {
    const chosen = top.find((c) => c.item.id === answer.catalog_item_id);
    if (!chosen) return { decision: "unsure", item: null, confidence: 0, method: "llm", hinge };
    // 7. Hard rules: never a match when a key attribute differs.
    const s = scorePair(parsed, {
      category: chosen.item.category,
      attributes: chosen.item.attributes as Record<string, string>,
    });
    if (s.comparison.differ.length > 0) {
      return {
        decision: "unsure",
        item: null,
        confidence: Math.min(answer.confidence, VETOED_CONFIDENCE),
        method: "llm",
        hinge: s.comparison.differ[0] ?? hinge,
      };
    }
    return {
      decision: "matched",
      item: chosen.item,
      confidence: answer.confidence,
      method: "llm",
      hinge,
    };
  }
  if (answer.decision === "new_item" && exactCount > 0) {
    // An item with every key attribute equal exists: the line is not new.
    return {
      decision: "unsure",
      item: null,
      confidence: Math.min(answer.confidence, VETOED_CONFIDENCE),
      method: "llm",
      hinge,
    };
  }
  return {
    decision: answer.decision,
    item: null,
    confidence: answer.confidence,
    method: "llm",
    hinge,
  };
}

async function record(
  tx: Tx,
  input: MatchLineInput,
  prepared: Prepared,
  parsed: ParsedLine,
  verdict: Verdict,
  candidates: CandidateView[],
  learn: boolean,
  threshold: number,
  registry: ReturnType<typeof materialsEventRegistry>,
): Promise<MatchLineResult> {
  // 6. Route: below the threshold, a person decides.
  let { decision, item } = verdict;
  let createdItem = false;
  const sure = verdict.confidence >= threshold;
  if (decision === "matched" && !sure) {
    decision = "unsure";
    item = null;
  }
  if (decision === "new_item") {
    if (sure) {
      const made = await createItem(tx, input.tenantId, parsed, {
        agentVersionId: input.agentVersionId,
      });
      item = made.item;
      createdItem = made.created;
      // Another run made the same item a moment ago: this line matches it.
      if (!made.created) decision = "matched";
    } else {
      decision = "unsure";
    }
  }
  const matchId = await recordMatch(tx, input.tenantId, {
    docLineId: input.docLineId,
    catalogItemId: decision === "unsure" ? null : (item?.id ?? null),
    decision,
    confidence: verdict.confidence,
    method: verdict.method,
    hingeAttribute: verdict.hinge,
    candidates,
    by: { agentVersionId: input.agentVersionId },
  });
  if (learn && decision !== "unsure" && item) {
    await learnAlias(tx, input.tenantId, {
      vendorId: prepared.vendorId,
      vendorSku: prepared.line.sku,
      descriptionHash: prepared.line.hash,
      normalizedDescription: prepared.line.normalized,
      catalogItemId: item.id,
      source: "auto",
    });
  }
  const confidence = verdict.confidence.toFixed(3);
  await emit(
    tx,
    {
      tenantId: input.tenantId,
      type: decision === "unsure" ? "materials.line.needs_review" : "materials.line.matched",
      subjectId: input.docLineId,
      payload: {
        docLineId: input.docLineId,
        matchId,
        catalogItemId: decision === "unsure" ? null : (item?.id ?? null),
        decision,
        method: verdict.method,
        confidence,
      },
    },
    { registry, testRun: input.testRun ?? false },
  );
  return {
    docLineId: input.docLineId,
    matchId,
    decision,
    catalogItemId: decision === "unsure" ? null : (item?.id ?? null),
    catalogItemName: decision === "unsure" ? null : (item?.canonicalName ?? null),
    createdItem,
    confidence: Number(confidence),
    method: verdict.method,
    hingeAttribute: verdict.hinge,
    needsReview: decision === "unsure",
    candidates,
    category: parsed.category,
    attributes: parsed.attributes,
  };
}

export interface HumanDecisionInput {
  tenantId: string;
  docLineId: string;
  userId: string;
  decision: "matched" | "new_item";
  /** The item, when matched. */
  catalogItemId?: string | undefined;
  vendorId?: string | undefined;
  testRun?: boolean | undefined;
}

/**
 * A person's decision (match review): a new item_match row (method `human`), and the vendor's
 * `human` aliases, so the same line from that vendor never needs review again. Learning stays
 * with this client (invariant 1).
 */
export async function decideLine(db: Db, input: HumanDecisionInput): Promise<MatchLineResult> {
  const registry = materialsEventRegistry();
  return withTenant(db, input.tenantId, async (tx) => {
    const prepared = await prepare(tx, input);
    const parsed = parseNormalized(prepared.line.normalized);
    let item: CatalogItemRow | null = null;
    let createdItem = false;
    if (input.decision === "matched") {
      if (!input.catalogItemId) throw new MatchError("not_found", "a match names its catalog item");
      item = await liveItem(tx, input.tenantId, input.catalogItemId);
      if (!item) throw new MatchError("not_found", `catalog item ${input.catalogItemId} not found`);
    } else {
      const made = await createItem(tx, input.tenantId, parsed, { userId: input.userId });
      item = made.item;
      createdItem = made.created;
    }
    const matchId = await recordMatch(tx, input.tenantId, {
      docLineId: input.docLineId,
      catalogItemId: item.id,
      decision: input.decision,
      confidence: 1,
      method: "human",
      hingeAttribute: null,
      candidates: [],
      by: { userId: input.userId },
    });
    await learnAlias(tx, input.tenantId, {
      vendorId: prepared.vendorId,
      vendorSku: prepared.line.sku,
      descriptionHash: prepared.line.hash,
      normalizedDescription: prepared.line.normalized,
      catalogItemId: item.id,
      source: "human",
    });
    await emit(
      tx,
      {
        tenantId: input.tenantId,
        type: "materials.match.decided",
        subjectId: input.docLineId,
        payload: {
          docLineId: input.docLineId,
          matchId,
          catalogItemId: item.id,
          decision: input.decision,
          method: "human",
          confidence: "1.000",
        },
      },
      { registry, testRun: input.testRun ?? false },
    );
    return {
      docLineId: input.docLineId,
      matchId,
      decision: input.decision,
      catalogItemId: item.id,
      catalogItemName: item.canonicalName,
      createdItem,
      confidence: 1,
      method: "human" as const,
      hingeAttribute: null,
      needsReview: false,
      candidates: [],
      category: item.category,
      attributes: item.attributes as Record<string, string>,
    };
  });
}
