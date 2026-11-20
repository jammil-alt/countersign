// Confirm matches (docs/plan.md §1.164 "Confirm matches"): the Sales pack's review card
// `sales.match`, on a person step after Match to CRM (payload `review: "sales.match"`, as
// Materials' `materials.match`). It shows each row of the batch: the sheet's values beside the
// record's for the fields matched on, the confidence in words with its number and how the row was
// found; the rows the match wasn't sure of first. A person approves the suggestion, picks another
// candidate, picks a record the look-up found, or says No match. Each of those (but No match) is a
// `human` decision that teaches an alias (`decideRow`), so the same row matches by itself next time.
// Finishing hands the run the confirmed matches (`answer`), the same list the step after it reads
// (`confirmedMatches`).
//
// Sheet values and CRM names are data and show as written (invariant 9). Everything is read for
// this client only (invariant 1): the route's transaction is the client's, and every query also
// filters by `tenant_id`.

import { type Db, rawRecord, type Tx, withTenant } from "@countersign/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  normalizeCompany,
  normalizeCrmPhone,
  normalizeDeal,
  normalizeEmail,
  normalizePerson,
  websiteDomain,
} from "./keys/normalize";
import { decideRow } from "./match/decide";
import { MATCH_ROWS_MAX } from "./match/match";
import { MATCH_THRESHOLD } from "./match/score";
import { SalesRefusal } from "./pack";
import { type CrmMatchDecision, type CrmMatchMethod, crmMatch, crmRecordKey } from "./schema";
import { keyRowsByIds, LOOKUP_MAX, type LookupRecord, lookupRecords } from "./store";

/** The card's key, as the person step's payload names it. */
export const MATCH_REVIEW = "sales.match";

// ── The card's contract with the platform ─────────────────────────────────────────────────────

/** A card's decision: `{action, input}`, checked here (the platform names no pack). */
export interface CardDecision {
  action: string;
  input: Record<string, unknown>;
}

/** An inbox card of this pack, by the `review` key of the item's payload (apps/api's shape). */
export interface PackReviewHandler {
  load(
    tx: Tx,
    tenantId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  decide(
    db: Db,
    input: {
      tenantId: string;
      userId: string;
      payload: Record<string, unknown>;
      decision: CardDecision | object;
      testRun: boolean;
    },
  ): Promise<void>;
  /** The card's search, for a person picking a record none of the candidates is. */
  lookup?(
    tx: Tx,
    tenantId: string,
    payload: Record<string, unknown>,
    query: { module?: string | undefined; q: string },
  ): Promise<Record<string, unknown>[]>;
  /** What the waiting run gets when the item is finished, built from what was recorded. */
  answer?(
    tx: Tx,
    tenantId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}

/** A card's refusal: the card's 422 (apps/api reads the name). */
export class ReviewError extends Error {
  override name = "ReviewError";
}

// ── The payload ────────────────────────────────────────────────────────────────────────────────

const SheetValues = z.record(z.string().max(100), z.string().max(500));

/** What the person step's payload carries (from Match to CRM's output; the run's own data). */
export const MatchReviewPayload = z.object({
  batchId: z.uuid(),
  /** The modules matched in: the look-up searches one of them. */
  modules: z.array(z.string().min(1).max(100)).min(1).max(10),
  threshold: z.number().gt(0).max(1).optional(),
  /** Each row's values as written, by row index. */
  sheet: z.array(SheetValues).max(MATCH_ROWS_MAX).default([]),
});
export type MatchReviewPayload = z.infer<typeof MatchReviewPayload>;

function payloadOf(payload: Record<string, unknown>): MatchReviewPayload {
  const p = MatchReviewPayload.safeParse(payload);
  if (!p.success) throw new ReviewError("this card has no batch of matches to show");
  return p.data;
}

// ── The view ───────────────────────────────────────────────────────────────────────────────────

export const CONFIDENCE_WORDS = ["high", "medium", "low"] as const;
export type ConfidenceWord = (typeof CONFIDENCE_WORDS)[number];

/**
 * The confidence in words. High: the match would decide alone (at or over the step's threshold);
 * Medium: 0.7 up to it; Low under 0.7.
 */
// DECISION: the words follow the step's own threshold, so "High" always means "we would have
// matched it without you"; 0.7 is where the rules' near matches (similar name, same company)
// start.
export function confidenceWord(score: number, threshold = MATCH_THRESHOLD): ConfidenceWord {
  if (score >= threshold) return "high";
  if (score >= 0.7) return "medium";
  return "low";
}

/** How a row or a candidate was found, as the card says it. */
export const FOUND_WORDS = [
  "email",
  "phone",
  "website",
  "alias",
  "name",
  "meaning",
  "model",
  "person",
] as const;
export type FoundWord = (typeof FOUND_WORDS)[number];

interface StoredCandidate {
  recordKeyId: string;
  connectionId: string;
  module: string;
  externalId: string;
  values: Record<string, string>;
  score: number;
  foundBy: string[];
  key: "email" | "phone" | "domain" | null;
  vetoed: "email" | "phone" | null;
}

const StoredCandidateSchema = z.object({
  recordKeyId: z.string(),
  connectionId: z.string(),
  module: z.string(),
  externalId: z.string(),
  values: z.record(z.string(), z.string()).catch({}),
  score: z.number().catch(0),
  foundBy: z.array(z.string()).catch([]),
  key: z.enum(["email", "phone", "domain"]).nullable().catch(null),
  vetoed: z.enum(["email", "phone"]).nullable().catch(null),
});

function storedCandidates(value: unknown): StoredCandidate[] {
  if (!Array.isArray(value)) return [];
  const out: StoredCandidate[] = [];
  for (const c of value) {
    const p = StoredCandidateSchema.safeParse(c);
    if (p.success) out.push(p.data);
  }
  return out;
}

function candidateFound(c: Pick<StoredCandidate, "key" | "foundBy">): FoundWord | null {
  if (c.key === "email") return "email";
  if (c.key === "phone") return "phone";
  if (c.key === "domain") return "website";
  if (c.foundBy.includes("alias")) return "alias";
  if (c.foundBy.includes("text")) return "name";
  if (c.foundBy.includes("meaning")) return "meaning";
  return null;
}

/** How the agent's decision was reached, in the card's words. */
function rowFound(method: CrmMatchMethod, best: StoredCandidate | undefined): FoundWord | null {
  switch (method) {
    case "human":
      return "person";
    case "alias":
      return "alias";
    case "model":
      return "model";
    case "meaning":
      return best ? (candidateFound(best) ?? "meaning") : "meaning";
    case "key":
    case "text":
      return best ? candidateFound(best) : null;
  }
}

/** The fields a sheet value and a record value are compared on, and how each is normalised. */
const COMPARED: readonly {
  field: string;
  sheet: (s: Record<string, string>) => string | undefined;
  record: (r: Record<string, string>) => string | undefined;
  same: (a: string, b: string) => boolean;
}[] = [
  {
    field: "name",
    sheet: (s) => s.name ?? ([s.firstName, s.lastName].filter(Boolean).join(" ") || undefined),
    record: (r) => r.name,
    same: (a, b) => normalizePerson(a) === normalizePerson(b),
  },
  {
    field: "company",
    sheet: (s) => s.company,
    record: (r) => r.company,
    same: (a, b) => normalizeCompany(a) === normalizeCompany(b),
  },
  {
    field: "email",
    sheet: (s) => s.email,
    record: (r) => r.email,
    same: (a, b) => normalizeEmail(a) === normalizeEmail(b),
  },
  {
    field: "phone",
    sheet: (s) => s.phone,
    record: (r) => r.phone,
    same: (a, b) => (normalizeCrmPhone(a) ?? a) === (normalizeCrmPhone(b) ?? b),
  },
  {
    field: "website",
    sheet: (s) => s.website,
    record: (r) => r.website,
    same: (a, b) => (websiteDomain(a) ?? a) === (websiteDomain(b) ?? b),
  },
  {
    field: "deal",
    sheet: (s) => s.deal,
    record: (r) => r.deal,
    same: (a, b) => normalizeDeal(a) === normalizeDeal(b),
  },
];

export interface ComparedField {
  field: string;
  sheet: string | null;
  record: string | null;
  /** Both have it and they differ (after normalising case, spacing, phone and email form). */
  differs: boolean;
}

/** The sheet's values beside a record's, for the fields either has. */
export function compareValues(
  sheet: Record<string, string>,
  record: Record<string, string> | null,
): ComparedField[] {
  const out: ComparedField[] = [];
  for (const c of COMPARED) {
    const a = c.sheet(sheet) ?? null;
    const b = record ? (c.record(record) ?? null) : null;
    if (a === null && b === null) continue;
    out.push({
      field: c.field,
      sheet: a,
      record: b,
      differs: a !== null && b !== null && !c.same(a, b),
    });
  }
  return out;
}

interface MatchRow {
  id: string;
  rowIndex: number;
  decision: CrmMatchDecision;
  method: CrmMatchMethod;
  score: string;
  recordKeyId: string | null;
  connectionId: string | null;
  module: string | null;
  externalId: string | null;
  candidates: unknown;
  decidedByUserId: string | null;
  decidedAt: Date;
}

/** Every decision about the batch's rows, oldest first per row (the agent's, then a person's). */
async function batchRows(tx: Tx, tenantId: string, batchId: string): Promise<MatchRow[]> {
  return tx
    .select({
      id: crmMatch.id,
      rowIndex: crmMatch.rowIndex,
      decision: crmMatch.decision,
      method: crmMatch.method,
      score: crmMatch.score,
      recordKeyId: crmMatch.recordKeyId,
      connectionId: crmMatch.connectionId,
      module: crmMatch.module,
      externalId: crmMatch.externalId,
      candidates: crmMatch.candidates,
      decidedByUserId: crmMatch.decidedByUserId,
      decidedAt: crmMatch.decidedAt,
    })
    .from(crmMatch)
    .where(and(eq(crmMatch.tenantId, tenantId), eq(crmMatch.batchId, batchId)))
    .orderBy(asc(crmMatch.rowIndex), asc(crmMatch.decidedAt), asc(crmMatch.id));
}

/** Per row: the agent's decision (its candidates) and the newest decision (a person's, if any). */
function byRow(rows: readonly MatchRow[]) {
  const out = new Map<number, { agent: MatchRow; latest: MatchRow }>();
  for (const r of rows) {
    const at = out.get(r.rowIndex);
    if (!at) {
      out.set(r.rowIndex, { agent: r, latest: r });
      continue;
    }
    // The agent's is the one no person decided; the latest is the newest by time.
    if (at.agent.decidedByUserId !== null && r.decidedByUserId === null) at.agent = r;
    at.latest = r;
  }
  return out;
}

/** What the card shows for a candidate. */
function candidateView(c: StoredCandidate, threshold: number) {
  return {
    recordKeyId: c.recordKeyId,
    module: c.module,
    externalId: c.externalId,
    values: c.values,
    score: c.score,
    confidence: confidenceWord(c.score, threshold),
    found: candidateFound(c),
    vetoed: c.vetoed,
  };
}

async function recordValues(tx: Tx, tenantId: string, ids: readonly string[]) {
  const rows = await keyRowsByIds(tx, tenantId, ids);
  return new Map(rows.map((r) => [r.id, r]));
}

/** The card's data: every row of the batch, the unsure first, with what a person decided. */
export async function matchReviewView(tx: Tx, tenantId: string, payload: Record<string, unknown>) {
  const p = payloadOf(payload);
  const threshold = p.threshold ?? MATCH_THRESHOLD;
  const rows = byRow(await batchRows(tx, tenantId, p.batchId));
  const chosen = [...rows.values()]
    .map((r) => r.latest.recordKeyId)
    .filter((id): id is string => id !== null);
  const records = await recordValues(tx, tenantId, chosen);
  const view = [...rows.values()].map(({ agent, latest }) => {
    const candidates = storedCandidates(agent.candidates);
    const sheet = p.sheet[agent.rowIndex] ?? {};
    const person = latest.decidedByUserId !== null;
    const agentScore = Number(agent.score);
    // The record shown: the person's choice, else the agent's match, else its suggestion.
    const recordId =
      latest.recordKeyId ??
      (latest.decision === "unsure"
        ? (candidates.find((c) => !c.vetoed)?.recordKeyId ?? null)
        : null);
    const stored = recordId ? records.get(recordId) : undefined;
    const fromCandidates = candidates.find((c) => c.recordKeyId === recordId);
    const record = recordId
      ? {
          recordKeyId: recordId,
          module: stored?.module ?? fromCandidates?.module ?? latest.module ?? "",
          externalId: stored?.externalId ?? fromCandidates?.externalId ?? latest.externalId ?? "",
          values: stored?.display ?? fromCandidates?.values ?? {},
        }
      : null;
    const best = candidates[0];
    return {
      index: agent.rowIndex,
      /** The agent's own decision: what the card folds by. */
      agent: {
        decision: agent.decision,
        method: agent.method,
        score: agentScore,
        confidence: confidenceWord(agentScore, threshold),
        found: rowFound(agent.method, best),
      },
      /** Where the row stands now. */
      decision: latest.decision,
      decidedBy: person ? ("person" as const) : ("agent" as const),
      /** A record the row is (matched), or the agent's suggestion (unsure); null for none. */
      record,
      suggested: latest.decision === "unsure" && record !== null,
      sheet,
      compare: compareValues(sheet, record?.values ?? null),
      candidates: candidates.map((c) => candidateView(c, threshold)),
    };
  });
  // The unsure first (by row), then the rest in row order.
  view.sort(
    (a, b) =>
      Number(b.agent.decision === "unsure") - Number(a.agent.decision === "unsure") ||
      a.index - b.index,
  );
  const counts = { unsure: 0, matched: 0, none: 0, waiting: 0, decided: 0 };
  for (const r of view) {
    counts[r.agent.decision] += 1;
    if (r.decision === "unsure") counts.waiting += 1;
    if (r.decidedBy === "person") counts.decided += 1;
  }
  return { batchId: p.batchId, threshold, modules: p.modules, rows: view, counts };
}

// ── Decisions ──────────────────────────────────────────────────────────────────────────────────

const Index = z.number().int().min(0).max(MATCH_ROWS_MAX);

/** A person's decision on the card, checked here (the platform passes `{action, input}`). */
export const MatchReviewDecision = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("approve"), input: z.strictObject({ index: Index }) }),
  z.strictObject({
    action: z.literal("pick"),
    input: z.strictObject({ index: Index, recordKeyId: z.uuid() }),
  }),
  z.strictObject({
    action: z.literal("lookup"),
    input: z.strictObject({ index: Index, recordKeyId: z.uuid() }),
  }),
  z.strictObject({ action: z.literal("no_match"), input: z.strictObject({ index: Index }) }),
  z.strictObject({ action: z.literal("approve_high"), input: z.strictObject({}) }),
]);
export type MatchReviewDecision = z.infer<typeof MatchReviewDecision>;

function parseDecision(decision: unknown): MatchReviewDecision {
  const d = MatchReviewDecision.safeParse(decision);
  if (!d.success) {
    throw new ReviewError(
      "decide a row: approve, pick a candidate, a record you looked up, or no match",
    );
  }
  return d.data;
}

/** Records a person's decision about the card's rows, and the aliases it teaches. */
export async function decideMatchReview(
  db: Db,
  input: {
    tenantId: string;
    userId: string;
    payload: Record<string, unknown>;
    decision: unknown;
    testRun: boolean;
  },
): Promise<void> {
  const p = payloadOf(input.payload);
  const d = parseDecision(input.decision);
  const threshold = p.threshold ?? MATCH_THRESHOLD;
  const rows = await withTenant(db, input.tenantId, async (tx) =>
    byRow(await batchRows(tx, input.tenantId, p.batchId)),
  );
  const decide = (agent: MatchRow, recordKeyId: string | null) =>
    decideRow(db, {
      tenantId: input.tenantId,
      userId: input.userId,
      matchId: agent.id,
      recordKeyId,
      testRun: input.testRun,
    });

  if (d.action === "approve_high") {
    // The folded rows the agent matched with High confidence, not yet a person's.
    for (const { agent, latest } of rows.values()) {
      if (agent.decision !== "matched" || latest.decidedByUserId !== null) continue;
      if (confidenceWord(Number(agent.score), threshold) !== "high" || !agent.recordKeyId) continue;
      await decide(agent, agent.recordKeyId);
    }
    return;
  }
  const row = rows.get(d.input.index);
  if (!row) throw new ReviewError("that row isn't part of this review");
  const { agent } = row;
  const candidates = storedCandidates(agent.candidates);
  switch (d.action) {
    case "approve": {
      // The agent's match, else its suggestion (the best candidate the rules leave).
      const id = agent.recordKeyId ?? candidates.find((c) => !c.vetoed)?.recordKeyId ?? null;
      if (!id)
        throw new ReviewError("there's no suggestion to approve: look one up or say no match");
      await decide(agent, id);
      return;
    }
    case "pick": {
      const c = candidates.find((x) => x.recordKeyId === d.input.recordKeyId);
      if (!c) throw new ReviewError("that record isn't one of this row's candidates");
      // DECISION: a candidate the hard rules ruled out (two different emails or phones) isn't
      // offered to pick, as Materials' card leaves vetoed items out; a person who knows better
      // finds it with the look-up.
      if (c.vetoed) throw new ReviewError("that record has a different email or phone");
      await decide(agent, c.recordKeyId);
      return;
    }
    case "lookup": {
      // The record must be this client's (the query filters by client) and in a module matched.
      const [found] = await withTenant(db, input.tenantId, (tx) =>
        keyRowsByIds(tx, input.tenantId, [d.input.recordKeyId]),
      );
      if (!found) throw new ReviewError("that record isn't one of yours");
      if (!p.modules.includes(found.module)) {
        throw new ReviewError(`pick a record from ${p.modules.join(" or ")}`);
      }
      await decide(agent, found.id);
      return;
    }
    case "no_match":
      await decide(agent, null);
      return;
  }
}

// ── The look-up ────────────────────────────────────────────────────────────────────────────────

/** The card's search: one of the batch's modules, the client's synced records, at most 20. */
export async function lookupForReview(
  tx: Tx,
  tenantId: string,
  payload: Record<string, unknown>,
  query: { module?: string | undefined; q: string },
): Promise<LookupRecord[]> {
  const p = payloadOf(payload);
  const module = query.module ?? p.modules[0];
  if (!module || !p.modules.includes(module)) {
    throw new ReviewError(`look up in ${p.modules.join(" or ")}`);
  }
  return lookupRecords(tx, tenantId, { module, q: query.q, limit: LOOKUP_MAX });
}

// ── The confirmed matches ──────────────────────────────────────────────────────────────────────

export interface ConfirmedMatch {
  index: number;
  recordKeyId: string;
  connectionId: string;
  module: string;
  externalId: string;
  /** Who decided it last: the agent (by key, alias, text, meaning or model) or a person. */
  decidedBy: "agent" | "person";
  method: CrmMatchMethod;
  /** The record's `Modified_Time` as synced, so an update refuses a record changed since. */
  modifiedTime: string | null;
}

export interface ConfirmedMatches {
  batchId: string;
  matches: ConfirmedMatch[];
  /** Rows no record is (a person's No match, or none found). */
  none: number[];
  /** Rows still waiting on a person (nobody answered in time). */
  unsure: number[];
  sources: string[];
}

/** The newest decision about each row of the batch, as the update steps take them. */
export async function confirmedMatches(
  tx: Tx,
  tenantId: string,
  batchId: string,
): Promise<ConfirmedMatches> {
  const rows = byRow(await batchRows(tx, tenantId, batchId));
  const matches: ConfirmedMatch[] = [];
  const none: number[] = [];
  const unsure: number[] = [];
  const matchedIds: string[] = [];
  const sources: string[] = [];
  for (const { latest } of rows.values()) {
    sources.push(latest.id);
    if (latest.decision === "none") none.push(latest.rowIndex);
    else if (latest.decision === "unsure") unsure.push(latest.rowIndex);
    else if (latest.recordKeyId) matchedIds.push(latest.recordKeyId);
  }
  const keyRows = matchedIds.length
    ? await tx
        .select({ id: crmRecordKey.id, rawRecordId: crmRecordKey.rawRecordId })
        .from(crmRecordKey)
        .where(and(eq(crmRecordKey.tenantId, tenantId), inArray(crmRecordKey.id, matchedIds)))
    : [];
  const rawIds = keyRows.map((k) => k.rawRecordId);
  const raws = rawIds.length
    ? await tx
        .select({ id: rawRecord.id, payload: rawRecord.payload })
        .from(rawRecord)
        .where(and(eq(rawRecord.tenantId, tenantId), inArray(rawRecord.id, rawIds)))
    : [];
  const modified = new Map<string, string | null>();
  for (const k of keyRows) {
    const raw = raws.find((r) => r.id === k.rawRecordId)?.payload as
      | Record<string, unknown>
      | undefined;
    const m = raw?.Modified_Time;
    modified.set(k.id, typeof m === "string" ? m : null);
    sources.push(k.rawRecordId);
  }
  for (const { latest } of rows.values()) {
    if (latest.decision !== "matched" || !latest.recordKeyId) continue;
    matches.push({
      index: latest.rowIndex,
      recordKeyId: latest.recordKeyId,
      connectionId: latest.connectionId ?? "",
      module: latest.module ?? "",
      externalId: latest.externalId ?? "",
      decidedBy: latest.decidedByUserId ? "person" : "agent",
      method: latest.method,
      modifiedTime: modified.get(latest.recordKeyId) ?? null,
    });
  }
  return { batchId, matches, none, unsure, sources: [...new Set(sources)] };
}

/** Finishing the card: the confirmed matches, once no row is left waiting on a person. */
export async function matchReviewAnswer(
  tx: Tx,
  tenantId: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const p = payloadOf(payload);
  const confirmed = await confirmedMatches(tx, tenantId, p.batchId);
  if (confirmed.unsure.length > 0) {
    throw new ReviewError(
      `${confirmed.unsure.length} ${confirmed.unsure.length === 1 ? "row is" : "rows are"} still waiting on you`,
    );
  }
  return { ...confirmed };
}

/** The pack's review cards, by the `review` key of an item's payload. */
export const SALES_REVIEWS: Readonly<Record<string, PackReviewHandler>> = {
  [MATCH_REVIEW]: {
    load: (tx, tenantId, payload) => matchReviewView(tx, tenantId, payload),
    decide: (db, input) => asReview(() => decideMatchReview(db, input)),
    lookup: (tx, tenantId, payload, query) =>
      asReview(async () =>
        (await lookupForReview(tx, tenantId, payload, query)).map((r) => ({ ...r })),
      ),
    answer: (tx, tenantId, payload) => asReview(() => matchReviewAnswer(tx, tenantId, payload)),
  },
};

/** The pack's refusals as the card's 422. */
async function asReview<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof SalesRefusal) throw new ReviewError(error.message);
    if (error instanceof z.ZodError) {
      throw new ReviewError(error.issues.map((i) => i.message).join("; "));
    }
    throw error;
  }
}
