// Rows matched to the client's synced CRM records (docs/plan.md §1.164 "The match"; invariant 7:
// deterministic first, model second, human last).
//   1. exact email, phone or website domain   2. aliases a person taught   3. candidates by similar
//   text (trigrams), then by similar meaning (embeddings)   4. a small model chooses among at most
//   five, or says none   5. under the threshold, a person decides.
// Hard rules veto a pair whatever the model says: two different emails, or two different phones,
// are never the same record. Model calls and embeddings happen between transactions, never inside
// one. Every decision is a crm_match row with the agent version that made it (invariant 10); a test
// run records none.

import { uuidv7 } from "@countersign/core";
import { withTenant } from "@countersign/db";
import { z } from "zod";
import { keysHash, keysOf, matchTextOf, type RecordFields } from "../keys/build";
import { CRM_MAPPERS } from "../keys/zoho";
import { type PackToolContext, SalesRefusal } from "../pack";
import { type CrmKeys, type CrmMatchDecision, type CrmMatchMethod, crmMatch } from "../schema";
import {
  aliasesFor,
  clientMatchSettings,
  type EmbedResult,
  embedDueKeys,
  embedTexts,
  exactCandidates,
  type KeyRow,
  meaningCandidates,
  refreshRecordKeys,
  salesOn,
  textCandidates,
} from "../store";
import { chooseRecord, MODEL_CANDIDATES, type RecordChoice } from "./model";
import {
  decideByRules,
  KEY_FIELDS,
  type KeyField,
  MATCH_THRESHOLD,
  type PairScore,
  type RecordKind,
  round3,
  scorePair,
  type Veto,
  type Weighed,
} from "./score";

/** At most this many rows in one match (a step's file may hold more: it is matched in parts). */
// DECISION: 2,000 rows a call, so one step's work (searches, embeddings, at most a model call a
// row) stays within a Worker's time; Read table's 10,000-row files are matched by a for-each.
export const MATCH_ROWS_MAX = 2000;

/** No candidate by keys, text or meaning: the row is none of the client's records. */
// DECISION: "none" at the default threshold when every search ran (meaning included); when the
// meaning search couldn't run (no transport, HIPAA mode), 0.8: a person decides under the default.
export const NONE_SCORE = 0.9;
export const NONE_SCORE_WITHOUT_MEANING = 0.8;

/** Where the row's values are: the sheet's (or step's) field for each key. */
export const KeyMapping = z
  .object({
    email: z.string().min(1).max(200),
    phone: z.string().min(1).max(200),
    website: z.string().min(1).max(200),
    company: z.string().min(1).max(200),
    name: z.string().min(1).max(200),
    firstName: z.string().min(1).max(200),
    lastName: z.string().min(1).max(200),
    deal: z.string().min(1).max(200),
    /**
     * The client's own CRM fields its match text also holds (`tenant.settings.sales.matchFields`):
     * the CRM field's name → the row's field.
     */
    extra: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,99}$/), z.string().min(1).max(200)),
  })
  .partial()
  .refine((m) => Object.keys(m).length > 0, "map at least one of the row's fields to a key");
export type KeyMapping = z.infer<typeof KeyMapping>;

export const MatchRecordsInput = z.object({
  rows: z.array(z.record(z.string(), z.unknown())).min(1).max(MATCH_ROWS_MAX),
  keys: KeyMapping,
  /** The CRM modules to match in (Zoho's `Leads`, `Contacts`, `Accounts`, `Deals`). */
  modules: z.array(z.string().min(1).max(100)).min(1).max(10),
  /** A stricter threshold than the step's; it never loosens the step's own. */
  threshold: z.number().gt(0).max(1).optional(),
  /** The keys compared (the step's `match_on` when absent; every key when neither). */
  matchOn: z.array(z.enum(KEY_FIELDS)).min(1).optional(),
});
export type MatchRecordsInput = z.infer<typeof MatchRecordsInput>;

export const FOUND_BY = ["key", "alias", "text", "meaning"] as const;
export type FoundBy = (typeof FOUND_BY)[number];

/** A candidate record as the result and the Confirm matches card show it. */
export interface CandidateView {
  recordKeyId: string;
  connectionId: string;
  module: string;
  externalId: string;
  /** The record's values as written in the CRM (name, company, email, phone, deal, stage, …). */
  values: Record<string, string>;
  score: number;
  foundBy: FoundBy[];
  /** The exact key the score rests on, when one does. */
  key: "email" | "phone" | "domain" | null;
  /** A hard rule ruled it out. */
  vetoed: Veto | null;
  textSimilarity: number | null;
  meaningSimilarity: number | null;
}

export interface MatchedRecord {
  recordKeyId: string;
  connectionId: string;
  module: string;
  externalId: string;
  values: Record<string, string>;
}

export interface RowMatch {
  index: number;
  decision: CrmMatchDecision;
  method: CrmMatchMethod;
  score: number;
  /** The record, when matched. */
  record: MatchedRecord | null;
  /** The best candidate, when a person decides (the card's suggestion). */
  suggestion: CandidateView | null;
  /** Up to five, best first. */
  candidates: CandidateView[];
  /** The row's normalised keys. */
  keys: CrmKeys;
  /** The row's values for the mapped keys, as written. */
  values: Record<string, string>;
  /** Below the threshold, or two equally sure: a person decides. */
  needsReview: boolean;
  /** The model's reason, when it chose. */
  reason: string | null;
  sources: string[];
  /** The decision's crm_match row; null in a test run (nothing recorded). */
  matchId: string | null;
}

export interface MatchRecordsResult {
  batchId: string;
  rows: RowMatch[];
  counts: { matched: number; none: number; unsure: number };
  anyNeedsReview: boolean;
  threshold: number;
  /** The CRM modules matched in (the Confirm matches card's look-up offers them). */
  modules: string[];
  /**
   * Each row's values for the mapped keys, as written, by row index: what the Confirm matches
   * card shows beside a record (the person step's payload carries it; `rows` is too large to).
   */
  sheet: Record<string, string>[];
  /** Record keys built from newly synced records, and embedded, before matching. */
  keys: { built: number; embedded: EmbedResult | null };
  /** Whether the rows were searched by meaning (null: no transport; `refused`: HIPAA mode). */
  meaning: "searched" | "refused" | null;
  testRun: boolean;
  sources: string[];
}

/** `match_threshold` from the step's settings, else the default. */
export function thresholdFrom(settings: Readonly<Record<string, unknown>>): number {
  const v = Number(settings.match_threshold);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : MATCH_THRESHOLD;
}

const MATCH_ON_WORDS: Readonly<Record<string, KeyField>> = {
  email: "email",
  emails: "email",
  phone: "phone",
  phones: "phone",
  domain: "domain",
  website: "domain",
  company: "company",
  account: "company",
  name: "name",
  person: "name",
  deal: "deal",
};

/**
 * `match_on` from the step's settings: the keys compared, as words ("email, phone, name"); absent
 * or empty, every key. A word it doesn't know fails the step in plain words rather than being
 * skipped (as Materials' `match_on`).
 */
export function matchOnFrom(settings: Readonly<Record<string, unknown>>): KeyField[] | null {
  const raw = settings.match_on;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const out = new Set<KeyField>();
  for (const part of raw.split(/[,;\n]/)) {
    const word = part.trim().toLowerCase();
    if (!word) continue;
    const key = MATCH_ON_WORDS[word];
    if (!key) {
      throw new SalesRefusal(
        `match_on: "${part.trim()}" isn't something Match to CRM compares; use email, phone, website, company, name or deal`,
      );
    }
    out.add(key);
  }
  return out.size > 0 ? KEY_FIELDS.filter((k) => out.has(k)) : null;
}

/** What each module's records are, from the connectors' mappers (a person when unknown). */
export function kindOf(module: string): RecordKind {
  for (const m of Object.values(CRM_MAPPERS)) {
    const kind = m.modules[module];
    if (kind) return kind;
  }
  return "person";
}

function cell(v: unknown): string | undefined {
  if (typeof v === "string") return v.trim() ? v.trim().slice(0, 500) : undefined;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return undefined;
}

/** A row's values for the mapped keys, as written (strings). */
export function rowValues(
  row: Record<string, unknown>,
  mapping: KeyMapping,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, field] of Object.entries(mapping)) {
    if (typeof field !== "string" || !Object.hasOwn(row, field)) continue;
    const v = cell(row[field]);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/**
 * A row's values for the client's own match fields in the modules (`keys.extra`: the CRM field's
 * name → the row's field), in the order the client lists them, so its text reads like the records'.
 */
export function extraValues(
  row: Record<string, unknown>,
  extra: Readonly<Record<string, string>> | undefined,
  fields: Readonly<Record<string, readonly string[]>>,
  modules: readonly string[],
): string[] {
  if (!extra) return [];
  const names = [...new Set(modules.flatMap((m) => fields[m] ?? []))];
  const out: string[] = [];
  for (const name of names) {
    const field = Object.hasOwn(extra, name) ? extra[name] : undefined;
    if (!field || !Object.hasOwn(row, field)) continue;
    const v = cell(row[field]);
    if (v !== undefined) out.push(v);
  }
  return out;
}

/** A row's normalised keys, from its mapped values. */
export function rowKeys(values: Record<string, string>): CrmKeys {
  const fields: RecordFields = {
    email: values.email,
    phone: values.phone,
    website: values.website,
    company: values.company,
    name: values.name,
    firstName: values.firstName,
    lastName: values.lastName,
    deal: values.deal,
  };
  return keysOf(fields);
}

interface Found {
  row: KeyRow;
  foundBy: Set<FoundBy>;
  textSimilarity: number | null;
  meaningSimilarity: number | null;
}

function view(f: Found, pair: PairScore): CandidateView {
  return {
    recordKeyId: f.row.id,
    connectionId: f.row.connectionId,
    module: f.row.module,
    externalId: f.row.externalId,
    values: f.row.display,
    score: pair.score,
    foundBy: FOUND_BY.filter((b) => f.foundBy.has(b)),
    key: pair.key,
    vetoed: pair.vetoed,
    textSimilarity: f.textSimilarity === null ? null : round3(f.textSimilarity),
    meaningSimilarity: f.meaningSimilarity === null ? null : round3(f.meaningSimilarity),
  };
}

function recordOf(row: KeyRow): MatchedRecord {
  return {
    recordKeyId: row.id,
    connectionId: row.connectionId,
    module: row.module,
    externalId: row.externalId,
    values: row.display,
  };
}

/** A row's candidates, weighed by the rules: best first, the vetoed last. */
function weigh(keys: CrmKeys, found: Iterable<Found>, fields: readonly KeyField[]) {
  const out: Weighed<Found>[] = [];
  for (const f of found) {
    out.push({
      candidate: f,
      pair: scorePair(keys, f.row.keys, { kind: kindOf(f.row.module), fields }),
    });
  }
  return out.sort(
    (a, b) =>
      Number(a.pair.vetoed !== null) - Number(b.pair.vetoed !== null) ||
      b.pair.score - a.pair.score ||
      (b.candidate.textSimilarity ?? b.candidate.meaningSimilarity ?? 0) -
        (a.candidate.textSimilarity ?? a.candidate.meaningSimilarity ?? 0) ||
      a.candidate.row.id.localeCompare(b.candidate.row.id),
  );
}

interface Work {
  index: number;
  values: Record<string, string>;
  keys: CrmKeys;
  hash: string;
  text: string;
  found: Map<string, Found>;
  outcome: Omit<RowMatch, "index" | "keys" | "values" | "matchId"> | null;
}

function add(work: Work, row: KeyRow, by: FoundBy, similarity?: number) {
  const at = work.found.get(row.id) ?? {
    row,
    foundBy: new Set<FoundBy>(),
    textSimilarity: null,
    meaningSimilarity: null,
  };
  at.foundBy.add(by);
  if (by === "text" && similarity !== undefined) at.textSimilarity = similarity;
  if (by === "meaning" && similarity !== undefined) at.meaningSimilarity = similarity;
  work.found.set(row.id, at);
}

function sourcesOf(rows: readonly KeyRow[]): string[] {
  return [...new Set(rows.flatMap((r) => [r.rawRecordId, r.id]))];
}

/** The rules' outcome for a row, or null when it is still open (the meaning search, the model). */
function byRules(
  work: Work,
  fields: readonly KeyField[],
  threshold: number,
  final: { meaningSearched: boolean } | null,
): Work["outcome"] {
  const weighed = weigh(work.keys, work.found.values(), fields);
  const views = weighed.slice(0, MODEL_CANDIDATES).map((w) => view(w.candidate, w.pair));
  const verdict = decideByRules(weighed, threshold);
  if (verdict.kind === "matched") {
    const f = verdict.best.candidate;
    const method: CrmMatchMethod = verdict.best.pair.key
      ? "key"
      : f.foundBy.has("meaning") && !f.foundBy.has("text")
        ? "meaning"
        : "text";
    return {
      decision: "matched",
      method,
      score: verdict.best.pair.score,
      record: recordOf(f.row),
      suggestion: null,
      candidates: views,
      needsReview: false,
      reason: null,
      sources: sourcesOf([f.row]),
    };
  }
  if (!final) return null;
  if (verdict.kind === "nothing" && weighed.length === 0) {
    const score = final.meaningSearched ? NONE_SCORE : NONE_SCORE_WITHOUT_MEANING;
    const sure = score >= threshold;
    return {
      decision: sure ? "none" : "unsure",
      method: final.meaningSearched ? "meaning" : "text",
      score,
      record: null,
      suggestion: null,
      candidates: [],
      needsReview: !sure,
      reason: null,
      sources: [],
    };
  }
  // Something is close (or only vetoed records are): a person decides.
  const best = weighed[0];
  return {
    decision: "unsure",
    method: best?.pair.key ? "key" : "text",
    score: verdict.kind === "open" ? (verdict.ranked[0]?.pair.score ?? 0) : 0,
    record: null,
    suggestion: views[0] ?? null,
    candidates: views,
    needsReview: true,
    reason: null,
    sources: sourcesOf(weighed.slice(0, MODEL_CANDIDATES).map((w) => w.candidate.row)),
  };
}

/** The model's choice among the open row's best candidates, held to the rules and the threshold. */
async function byModel(
  ctx: PackToolContext,
  work: Work,
  fields: readonly KeyField[],
  threshold: number,
): Promise<Work["outcome"]> {
  const weighed = weigh(work.keys, work.found.values(), fields);
  // Only candidates the hard rules leave go to the model (the vetoed are shown to the person).
  const eligible = weighed.filter((w) => w.pair.vetoed === null).slice(0, MODEL_CANDIDATES);
  const views = weighed.slice(0, MODEL_CANDIDATES).map((w) => view(w.candidate, w.pair));
  const sources = sourcesOf(weighed.slice(0, MODEL_CANDIDATES).map((w) => w.candidate.row));
  const unsure = (score: number, reason: string | null, suggestion = views[0] ?? null) => ({
    decision: "unsure" as const,
    method: "model" as const,
    score: round3(score),
    record: null,
    suggestion,
    candidates: views,
    needsReview: true,
    reason,
    sources,
  });
  if (!ctx.llm || eligible.length === 0) return null;
  let answer: RecordChoice;
  try {
    answer = await chooseRecord(
      ctx.llm,
      work.values,
      eligible.map((w) => ({
        id: w.candidate.row.id,
        module: w.candidate.row.module,
        values: w.candidate.row.display,
      })),
      "sales.match_records:choose",
    );
  } catch {
    // DECISION: an unusable model answer is "unsure": a person decides, nothing is guessed.
    return unsure(eligible[0]?.pair.score ?? 0, null);
  }
  const reason = answer.reason.trim() || null;
  if (answer.decision === "matched") {
    const chosen = eligible.find((w) => w.candidate.row.id === answer.record_id);
    // A record that wasn't offered (or one the rules vetoed) is never matched.
    if (!chosen) return unsure(0, reason);
    const chosenView = view(chosen.candidate, chosen.pair);
    if (answer.confidence < threshold) return unsure(answer.confidence, reason, chosenView);
    return {
      decision: "matched",
      method: "model",
      score: round3(answer.confidence),
      record: recordOf(chosen.candidate.row),
      suggestion: null,
      candidates: views,
      needsReview: false,
      reason,
      sources: sourcesOf([chosen.candidate.row]),
    };
  }
  if (answer.decision === "none" && answer.confidence >= threshold) {
    // DECISION: the model's "none" stands only when no candidate is sure by the rules' own score
    // either; one close by the rules goes to a person.
    if ((eligible[0]?.pair.score ?? 0) < 0.8) {
      return {
        decision: "none",
        method: "model",
        score: round3(answer.confidence),
        record: null,
        suggestion: null,
        candidates: views,
        needsReview: false,
        reason,
        sources,
      };
    }
  }
  return unsure(
    answer.decision === "unsure" ? answer.confidence : (eligible[0]?.pair.score ?? 0),
    reason,
  );
}

/**
 * Matches rows to the client's synced records in the modules, and records each decision. The
 * client's keys are brought up to date first (records synced since) and embedded when due.
 */
export async function matchRecords(
  ctx: PackToolContext,
  raw: MatchRecordsInput,
): Promise<MatchRecordsResult> {
  const input = MatchRecordsInput.parse(raw);
  const threshold = Math.max(thresholdFrom(ctx.settings), input.threshold ?? 0);
  const fields: readonly KeyField[] = input.matchOn ?? matchOnFrom(ctx.settings) ?? KEY_FIELDS;
  const modules = [...new Set(input.modules)];
  const testRun = ctx.mode === "test";

  // Keys up to date (deterministic): the records synced since the last pass.
  // DECISION: a test run brings the keys up to date too: they are the synced records' index, as
  // sync itself keeps them, not a decision; it records no decision and embeds no record.
  const prepared = await withTenant(ctx.db, ctx.tenantId, async (tx) => {
    if (!(await salesOn(tx, ctx.tenantId))) {
      throw new SalesRefusal(
        "the Sales area is off for this client; switch it on to match records",
      );
    }
    const refreshed = await refreshRecordKeys(tx, ctx.tenantId, { modules });
    return { refreshed, settings: await clientMatchSettings(tx, ctx.tenantId) };
  });
  const embedded = !testRun && ctx.llm ? await embedDueKeys(ctx, { modules }) : null;

  const work: Work[] = await Promise.all(
    input.rows.map(async (row, index) => {
      const values = rowValues(row, input.keys);
      const keys = rowKeys(values);
      return {
        index,
        values,
        keys,
        hash: await keysHash(keys),
        text: matchTextOf(
          keys,
          prepared.settings.textFields,
          extraValues(row, input.keys.extra, prepared.settings.extraFields, modules),
        ),
        found: new Map<string, Found>(),
        outcome: null,
      };
    }),
  );

  // 1–3a. Aliases, exact keys and similar text, in one transaction.
  await withTenant(ctx.db, ctx.tenantId, async (tx) => {
    const keyed = work.filter((w) => Object.keys(w.keys).length > 0);
    const aliases = await aliasesFor(
      tx,
      ctx.tenantId,
      modules,
      keyed.map((w) => w.hash),
    );
    const pick = (f: "email" | "phone" | "domain") =>
      fields.includes(f)
        ? [...new Set(keyed.map((w) => w.keys[f]).filter((v): v is string => !!v))]
        : [];
    const exact = await exactCandidates(tx, ctx.tenantId, modules, {
      emails: pick("email"),
      phones: pick("phone"),
      domains: pick("domain"),
    });
    const texts = await textCandidates(
      tx,
      ctx.tenantId,
      modules,
      work.map((w) => (Object.keys(w.keys).length > 0 ? w.text : "")),
    );
    for (const w of keyed) {
      for (const r of exact) {
        if (
          (fields.includes("email") && w.keys.email && r.keys.email === w.keys.email) ||
          (fields.includes("phone") && w.keys.phone && r.keys.phone === w.keys.phone) ||
          (fields.includes("domain") && w.keys.domain && r.keys.domain === w.keys.domain)
        ) {
          add(w, r, "key");
        }
      }
      for (const t of texts.get(w.index) ?? []) add(w, t.row, "text", t.similarity);
      // 2. An alias a person taught settles the row, unless the record now breaks a hard rule.
      const taught = aliases.get(w.hash) ?? [];
      if (taught.length === 1 && taught[0]) {
        const hit = taught[0];
        add(w, hit.row, "alias");
        const pair = scorePair(w.keys, hit.row.keys, {
          kind: kindOf(hit.row.module),
          fields,
        });
        if (pair.vetoed === null) {
          w.outcome = {
            decision: "matched",
            method: "alias",
            score: 1,
            record: recordOf(hit.row),
            suggestion: null,
            candidates: [view(w.found.get(hit.row.id) as Found, { ...pair, score: 1 })],
            needsReview: false,
            reason: null,
            sources: [...sourcesOf([hit.row]), hit.aliasId],
          };
          continue;
        }
      } else {
        for (const t of taught) add(w, t.row, "alias");
      }
      w.outcome = byRules(w, fields, threshold, null);
    }
  });
  for (const w of work) {
    if (!w.outcome && Object.keys(w.keys).length === 0) {
      w.outcome = {
        decision: "unsure",
        method: "text",
        score: 0,
        record: null,
        suggestion: null,
        candidates: [],
        needsReview: true,
        reason: "The row has none of the mapped values to match on.",
        sources: [],
      };
    }
  }

  // 3b. Similar meaning, for the rows still open (between transactions: the embedding call).
  let meaning: MatchRecordsResult["meaning"] = null;
  const open = work.filter((w) => !w.outcome && w.text);
  if (open.length > 0 && ctx.llm) {
    const { vectors, refused } = await embedTexts(
      ctx.llm,
      open.map((w) => w.text),
      "sales.match_records:embed",
    );
    meaning = refused ? "refused" : "searched";
    if (!refused) {
      await withTenant(ctx.db, ctx.tenantId, async (tx) => {
        for (const [i, w] of open.entries()) {
          const v = vectors[i];
          if (!v) continue;
          for (const m of await meaningCandidates(tx, ctx.tenantId, modules, v)) {
            add(w, m.row, "meaning", m.similarity);
          }
          w.outcome = byRules(w, fields, threshold, null);
        }
      });
    }
  }

  // 4. The model, for what is still open; 5. a person for the rest.
  for (const w of work) {
    if (w.outcome) continue;
    w.outcome =
      (await byModel(ctx, w, fields, threshold)) ??
      byRules(w, fields, threshold, { meaningSearched: meaning === "searched" });
  }

  // Record (a test run records nothing).
  const batchId = uuidv7();
  const decided = work.map((w) => ({ w, o: w.outcome as NonNullable<Work["outcome"]> }));
  const ids: (string | null)[] = testRun
    ? decided.map(() => null)
    : await withTenant(ctx.db, ctx.tenantId, async (tx) => {
        const rows = await tx
          .insert(crmMatch)
          .values(
            decided.map(({ w, o }) => ({
              tenantId: ctx.tenantId,
              batchId,
              runId: ctx.runId,
              step: ctx.stepId ?? null,
              rowIndex: w.index,
              keys: w.keys,
              decision: o.decision,
              method: o.method,
              recordKeyId: o.record?.recordKeyId ?? null,
              connectionId: o.record?.connectionId ?? null,
              module: o.record?.module ?? null,
              externalId: o.record?.externalId ?? null,
              score: o.score.toFixed(3),
              candidates: o.candidates,
              sources: o.sources,
              agentVersionId: ctx.agentVersionId,
            })),
          )
          .returning({ id: crmMatch.id, rowIndex: crmMatch.rowIndex });
        const byIndex = new Map(rows.map((r) => [r.rowIndex, r.id]));
        return decided.map(({ w }) => byIndex.get(w.index) ?? null);
      });

  const rows: RowMatch[] = decided.map(({ w, o }, i) => ({
    index: w.index,
    ...o,
    keys: w.keys,
    values: w.values,
    matchId: ids[i] ?? null,
  }));
  const counts = { matched: 0, none: 0, unsure: 0 };
  for (const r of rows) counts[r.decision] += 1;
  return {
    batchId,
    rows,
    counts,
    anyNeedsReview: counts.unsure > 0,
    threshold,
    modules,
    sheet: rows.map((r) => r.values),
    keys: { built: prepared.refreshed.built, embedded },
    meaning,
    testRun,
    sources: [...new Set(rows.flatMap((r) => r.sources))],
  };
}
