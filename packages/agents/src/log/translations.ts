// P-7: message translation over the database (docs/plan.md §1.69; ARCHITECTURE §10.13).
//
// One function, `translateAndStore`, for every path: the background job, a person's own text on the
// Desk or in a thread, and an agent's `comms.translate`. It detects the language in code, applies
// the client's daily limit, makes at most one model call (outside any transaction), and inserts one
// `message_translation` row beside the original whatever the outcome. The original is never
// touched (invariant 3); the row is never updated (a trigger). Each read and write is a short
// client-scoped transaction (invariant 1).

import {
  clipForTranslation,
  type DetectedLanguage,
  detectLanguage,
  type Locale,
  MIN_LETTERS,
  type OpsTranslationView,
  payloadText,
  type TranslationSettings,
  type TranslationView,
  translationOf,
} from "@countersign/core";
import {
  type Db,
  message,
  messageTranslation,
  rawRecord,
  type Tx,
  tenant,
  withTenant,
} from "@countersign/db";
import {
  createLlmClient,
  DEFAULT_MODELS,
  type LlmCallRecord,
  type LlmExchange,
  type LlmTransport,
} from "@countersign/llm";
import { and, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { translateOnce } from "../runtime/translate";

export type TranslationRow = typeof messageTranslation.$inferSelect;

export type TranslationSource =
  | { kind: "raw_record"; id: string }
  | { kind: "message"; id: string }
  | { kind: "reach_out"; id: string };

/** An agent's call: its version, run and step (invariant 10). */
export interface TranslationAgent {
  agentVersionId: string;
  runId: string;
  stepRunId: string;
}

export interface TranslateParams {
  tenantId: string;
  source: TranslationSource;
  field?: string;
  direction: "in" | "out";
  /** The original's words (the caller read them, or a person wrote them). */
  text: string;
  to: Locale;
  settings: TranslationSettings;
  agent?: TranslationAgent | undefined;
  requestedBy?: string | null | undefined;
  /** Decided before any detection (a contact who is off): stored as skipped, no call. */
  skip?: string | undefined;
  /** Each model call, for a run's step (its usage and `model_call` row). */
  onCall?: ((record: LlmCallRecord, exchange: LlmExchange) => Promise<void>) | undefined;
  now?: Date | undefined;
}

/** The model a client's translations run on: its own choice, else the classification model. */
export function translationModel(settings: TranslationSettings): string {
  return settings.model ?? DEFAULT_MODELS.classification;
}

const sourceColumns = (s: TranslationSource) => ({
  rawRecordId: s.kind === "raw_record" ? s.id : null,
  messageId: s.kind === "message" ? s.id : null,
  reachOutId: s.kind === "reach_out" ? s.id : null,
});

function sourceWhere(s: TranslationSource) {
  if (s.kind === "raw_record") return eq(messageTranslation.rawRecordId, s.id);
  if (s.kind === "message") return eq(messageTranslation.messageId, s.id);
  return eq(messageTranslation.reachOutId, s.id);
}

/** The UTC day `at` falls on, as the rollup counts it. */
function dayStart(at: Date): Date {
  return new Date(`${at.toISOString().slice(0, 10)}T00:00:00.000Z`);
}

/** Model translations (rows with a model) a client made today (UTC), against its limit. */
export async function translationsToday(tx: Tx, tenantId: string, now = new Date()) {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(messageTranslation)
    .where(
      and(
        eq(messageTranslation.tenantId, tenantId),
        isNotNull(messageTranslation.model),
        gte(messageTranslation.createdAt, dayStart(now)),
      ),
    );
  return row?.n ?? 0;
}

/** The client's translation settings and its language, from `tenant.settings`. */
export async function clientTranslation(
  tx: Tx,
  tenantId: string,
): Promise<{
  settings: TranslationSettings;
  language: Locale | null;
  raw: Record<string, unknown>;
}> {
  const [row] = await tx
    .select({ settings: tenant.settings })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  const raw = (row?.settings ?? {}) as Record<string, unknown>;
  const language = typeof raw.language === "string" ? (raw.language as Locale) : null;
  return { settings: translationOf(raw), language, raw };
}

/** A stored translation of the same original, field and language, if there is one. */
async function existing(tx: Tx, p: TranslateParams, field: string) {
  const [row] = await tx
    .select()
    .from(messageTranslation)
    .where(
      and(
        eq(messageTranslation.tenantId, p.tenantId),
        sourceWhere(p.source),
        eq(messageTranslation.field, field),
        eq(messageTranslation.targetLanguage, p.to),
        eq(messageTranslation.status, "translated"),
      ),
    )
    .limit(1);
  return row ?? null;
}

type Outcome = Pick<
  typeof messageTranslation.$inferInsert,
  "status" | "reason" | "text" | "sourceLanguage" | "detectedBy" | "truncated"
> & { model?: string | null; tokensIn?: number; tokensOut?: number; costUsd?: string };

/**
 * Translates `p.text` into `p.to` (or decides not to) and stores the outcome beside the original.
 * Returns the row; a translation already stored is returned with no call.
 */
export async function translateAndStore(
  db: Db,
  transport: LlmTransport | null,
  p: TranslateParams,
): Promise<TranslationRow> {
  const field = p.field ?? "text";
  const now = p.now ?? new Date();
  const store = (o: Outcome) =>
    withTenant(db, p.tenantId, async (tx) => {
      const [row] = await tx
        .insert(messageTranslation)
        .values({
          tenantId: p.tenantId,
          ...sourceColumns(p.source),
          field,
          direction: p.direction,
          sourceLanguage: o.sourceLanguage,
          targetLanguage: p.to,
          detectedBy: o.detectedBy,
          status: o.status,
          reason: o.reason ?? null,
          text: o.text ?? null,
          originalChars: [...p.text].length,
          truncated: o.truncated ?? false,
          model: o.model ?? null,
          tokensIn: o.tokensIn ?? 0,
          tokensOut: o.tokensOut ?? 0,
          costUsd: o.costUsd ?? "0",
          agentVersionId: p.agent?.agentVersionId ?? null,
          runId: p.agent?.runId ?? null,
          stepRunId: p.agent?.stepRunId ?? null,
          requestedBy: p.requestedBy ?? null,
          createdAt: now,
        })
        .onConflictDoNothing()
        .returning();
      // Another job translated it meanwhile (the one `translated` row per original): use theirs.
      return row ?? ((await existing(tx, p, field)) as TranslationRow);
    });

  if (p.skip) {
    return store({
      status: "skipped",
      reason: p.skip,
      sourceLanguage: "unknown",
      detectedBy: "none",
    });
  }
  const found = await withTenant(db, p.tenantId, (tx) => existing(tx, p, field));
  if (found) return found;

  const detected = detectLanguage(p.text);
  if (detected.letters < MIN_LETTERS) {
    return store({
      status: "skipped",
      reason: "no_words",
      sourceLanguage: "unknown",
      detectedBy: "rule",
    });
  }
  if (detected.confidence === "sure") {
    if (detected.language === "unknown") {
      return store({
        status: "skipped",
        reason: "unknown_language",
        sourceLanguage: "unknown",
        detectedBy: "rule",
      });
    }
    if (detected.language === p.to) {
      return store({
        status: "skipped",
        reason: "same_language",
        sourceLanguage: detected.language,
        detectedBy: "rule",
      });
    }
  }
  const from: Locale | null =
    detected.confidence === "sure" && detected.language !== "unknown" ? detected.language : null;
  const guess: DetectedLanguage = from ?? detected.language;
  const model = translationModel(p.settings);

  // The daily limit, counted before the call (docs/plan.md §1.69).
  const today = await withTenant(db, p.tenantId, (tx) => translationsToday(tx, p.tenantId, now));
  if (today >= p.settings.dailyLimit) {
    return store({
      status: "capped",
      reason: "daily_limit",
      sourceLanguage: guess,
      detectedBy: "rule",
    });
  }
  if (!transport) {
    return store({
      status: "failed",
      reason: "no_model",
      sourceLanguage: guess,
      detectedBy: "rule",
    });
  }

  const clip = clipForTranslation(p.text);
  let usage = { tokensIn: 0, tokensOut: 0, costUsd: "0" };
  const llm = createLlmClient({
    transport,
    onCall: async (record, exchange) => {
      usage = {
        tokensIn:
          record.usage.inputTokens + record.usage.cacheWriteTokens + record.usage.cacheReadTokens,
        tokensOut: record.usage.outputTokens,
        costUsd: record.costUsd ?? "0",
      };
      await p.onCall?.(record, exchange);
    },
  });
  try {
    const answer = await translateOnce(llm, {
      text: clip.text,
      from,
      hint: from ? null : detected.language === "unknown" ? null : detected.language,
      to: p.to,
      model,
      label: "comms.translate",
    });
    const spent = { model, ...usage };
    if (answer.sourceLanguage === "other") {
      return store({
        status: "skipped",
        reason: "unknown_language",
        sourceLanguage: "unknown",
        detectedBy: "model",
        ...spent,
      });
    }
    const source = from ?? answer.sourceLanguage;
    if (answer.sourceLanguage === p.to) {
      return store({
        status: "skipped",
        reason: "same_language",
        sourceLanguage: p.to,
        detectedBy: from ? "rule" : "model",
        ...spent,
      });
    }
    return store({
      status: "translated",
      text: answer.translation,
      truncated: clip.truncated,
      sourceLanguage: source,
      detectedBy: from ? "rule" : "model",
      ...spent,
    });
  } catch (error) {
    // A HIPAA client and a provider without a signed BAA: refused before any call (§1.35).
    const refused = error instanceof Error && error.name === "ComplianceRefusal";
    return store({
      status: refused ? "refused" : "failed",
      reason: refused ? "not_covered" : "model_error",
      sourceLanguage: guess,
      detectedBy: "rule",
      // A refused call never reached a model; a failed one may have cost something.
      ...(refused ? {} : { model, ...usage }),
    });
  }
}

// ── Originals and views ─────────────────────────────────────────────────────────────────────────

/** The words of an original of this client at `field`, or null (not found, not text). */
export async function originalText(
  tx: Tx,
  tenantId: string,
  sourceId: string,
  field = "text",
): Promise<{ source: TranslationSource; text: string } | null> {
  const [raw] = await tx
    .select({ payload: rawRecord.payload })
    .from(rawRecord)
    .where(and(eq(rawRecord.id, sourceId), eq(rawRecord.tenantId, tenantId)));
  if (raw) {
    const text = payloadText(raw.payload, field);
    return text === null ? null : { source: { kind: "raw_record", id: sourceId }, text };
  }
  if (field !== "text") return null;
  const [m] = await tx
    .select({ body: message.body })
    .from(message)
    .where(and(eq(message.id, sourceId), eq(message.tenantId, tenantId)));
  const text = (m?.body as { text?: unknown } | undefined)?.text;
  return typeof text === "string" ? { source: { kind: "message", id: sourceId }, text } : null;
}

/** A row as the portal shows it: never the model or the cost (invariant 11). */
export function translationView(row: TranslationRow): TranslationView {
  return {
    id: row.id,
    status: row.status,
    reason: row.reason ?? null,
    from: row.sourceLanguage,
    to: row.targetLanguage as Locale,
    text: row.text ?? null,
    truncated: row.truncated,
    at: row.createdAt.toISOString(),
  };
}

/** A row as the back office shows it: with its model and cost. */
export function opsTranslationView(row: TranslationRow): OpsTranslationView {
  return { ...translationView(row), model: row.model ?? null, costUsd: String(row.costUsd) };
}

/**
 * The latest row for each original among `ids` (field `text`), keyed by the original's id. A
 * `translated` row wins over a later attempt that didn't translate (a retry that hit the limit).
 */
export async function latestTranslations(
  tx: Tx,
  tenantId: string,
  ids: {
    rawRecordIds?: readonly string[];
    messageIds?: readonly string[];
    reachOutIds?: readonly string[];
  },
): Promise<Map<string, TranslationRow>> {
  const out = new Map<string, TranslationRow>();
  const lists = [
    [messageTranslation.rawRecordId, ids.rawRecordIds ?? []],
    [messageTranslation.messageId, ids.messageIds ?? []],
    [messageTranslation.reachOutId, ids.reachOutIds ?? []],
  ] as const;
  for (const [column, list] of lists) {
    const wanted = [...new Set(list.filter((v) => typeof v === "string" && v.length === 36))];
    if (wanted.length === 0) continue;
    const rows = await tx
      .select()
      .from(messageTranslation)
      .where(
        and(
          eq(messageTranslation.tenantId, tenantId),
          inArray(column, wanted),
          eq(messageTranslation.field, "text"),
        ),
      )
      .orderBy(desc(messageTranslation.createdAt));
    for (const row of rows) {
      const key = row.rawRecordId ?? row.messageId ?? row.reachOutId;
      if (!key) continue;
      const held = out.get(key);
      if (!held || (held.status !== "translated" && row.status === "translated")) out.set(key, row);
    }
  }
  return out;
}
