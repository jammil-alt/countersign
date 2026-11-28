// The Sales area's records (docs/plan.md §1.164): record keys built from the client's synced CRM
// records, their embeddings, the searches the match and the look-up make, and the aliases a
// person's answers teach. Every query is the client's own: inside withTenant (forced RLS) and
// filtered by tenant_id as well (invariant 1).

import { ComplianceRefusal } from "@countersign/core";
import { type Db, type Tx, tenant, tenantPack, withTenant } from "@countersign/db";
import {
  DEFAULT_EMBEDDING_MODEL,
  EMBED_BATCH_MAX,
  EMBEDDING_DIMENSIONS,
  type LlmClient,
} from "@countersign/llm";
import { and, asc, eq, inArray, type SQL, sql } from "drizzle-orm";
import { PACK_ID } from "./ids";
import {
  type CrmRecordMapper,
  keysOf,
  type MatchTextField,
  matchFieldsFrom,
  matchTextFieldsFrom,
  matchTextOf,
  textHash,
} from "./keys/build";
import { normalizeCrmPhone, normalizeEmail, words } from "./keys/normalize";
import { CRM_MAPPERS } from "./keys/zoho";
import { type CrmKeys, crmAlias, crmRecordKey } from "./schema";

/** A record key as the match and the look-up read it (its embedding left out). */
export interface KeyRow {
  id: string;
  connectionId: string;
  connector: string;
  module: string;
  externalId: string;
  rawRecordId: string;
  keys: CrmKeys;
  display: Record<string, string>;
  matchText: string;
}

const KEY_COLUMNS = {
  id: crmRecordKey.id,
  connectionId: crmRecordKey.connectionId,
  connector: crmRecordKey.connector,
  module: crmRecordKey.module,
  externalId: crmRecordKey.externalId,
  rawRecordId: crmRecordKey.rawRecordId,
  email: crmRecordKey.email,
  phone: crmRecordKey.phone,
  domain: crmRecordKey.domain,
  companyName: crmRecordKey.companyName,
  personName: crmRecordKey.personName,
  dealName: crmRecordKey.dealName,
  display: crmRecordKey.display,
  matchText: crmRecordKey.matchText,
};

type KeySelect = {
  [K in keyof typeof KEY_COLUMNS]: (typeof KEY_COLUMNS)[K]["_"]["data"] | null;
};

function keyRow(r: KeySelect): KeyRow {
  const keys: CrmKeys = {};
  if (r.email) keys.email = r.email;
  if (r.phone) keys.phone = r.phone;
  if (r.domain) keys.domain = r.domain;
  if (r.companyName) keys.company = r.companyName;
  if (r.personName) keys.name = r.personName;
  if (r.dealName) keys.deal = r.dealName;
  return {
    id: r.id as string,
    connectionId: r.connectionId as string,
    connector: r.connector as string,
    module: r.module as string,
    externalId: r.externalId as string,
    rawRecordId: r.rawRecordId as string,
    keys,
    display: (r.display ?? {}) as Record<string, string>,
    matchText: r.matchText ?? "",
  };
}

/** A Postgres text[] of the values (one parameter each). */
function textArray(values: readonly string[]): SQL {
  return sql`ARRAY[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::text[]`;
}

export function vectorLiteral(v: readonly number[]): string {
  return `[${v.map((x) => (Number.isFinite(x) ? x : 0)).join(",")}]`;
}

/** Whether the client has the Sales area on (a `tenant_pack` row). */
export async function salesOn(tx: Tx, tenantId: string): Promise<boolean> {
  const rows = await tx
    .select({ pack: tenantPack.pack })
    .from(tenantPack)
    .where(and(eq(tenantPack.tenantId, tenantId), eq(tenantPack.pack, PACK_ID)));
  return rows.length > 0;
}

export interface ClientMatchSettings {
  /** The keys the match text holds (`tenant.settings.sales.matchText`). */
  textFields: MatchTextField[];
  /** The client's own fields it also holds, per module (`tenant.settings.sales.matchFields`). */
  extraFields: Record<string, string[]>;
}

/** What the client's match text is built from. */
export async function clientMatchSettings(tx: Tx, tenantId: string): Promise<ClientMatchSettings> {
  const [row] = await tx
    .select({ settings: tenant.settings })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  return {
    textFields: matchTextFieldsFrom(row?.settings),
    extraFields: matchFieldsFrom(row?.settings),
  };
}

// ── Keys from synced records ────────────────────────────────────────────────────────────────────

/** Records whose keys are built in one pass at most; the rest are built on the next one. */
export const REFRESH_MAX = 5000;

export interface RefreshOptions {
  /** One connection's records only. */
  connectionId?: string | undefined;
  /** Only these raw records' records (what a sync page just stored). */
  rawRecordIds?: readonly string[] | undefined;
  /** Only these modules. */
  modules?: readonly string[] | undefined;
  /** Rebuild every key, not only those whose record has a newer version (a settings change). */
  rebuild?: boolean | undefined;
  limit?: number | undefined;
  mappers?: Readonly<Record<string, CrmRecordMapper>> | undefined;
}

export interface RefreshResult {
  /** Keys made or rebuilt. */
  built: number;
  /** Whether more were due than one pass builds. */
  more: boolean;
}

/**
 * Builds or rebuilds the keys of the client's synced CRM records whose latest raw record isn't the
 * one their keys were built from (every one with `rebuild`). Deterministic: no model.
 */
export async function refreshRecordKeys(
  tx: Tx,
  tenantId: string,
  options: RefreshOptions = {},
): Promise<RefreshResult> {
  const mappers = options.mappers ?? CRM_MAPPERS;
  const connectors = Object.keys(mappers);
  const modules = [
    ...new Set(
      Object.values(mappers).flatMap((m) =>
        Object.keys(m.modules).filter((mod) => !options.modules || options.modules.includes(mod)),
      ),
    ),
  ];
  if (connectors.length === 0 || modules.length === 0) return { built: 0, more: false };
  if (options.rawRecordIds && options.rawRecordIds.length === 0) return { built: 0, more: false };
  const limit = Math.min(options.limit ?? REFRESH_MAX, REFRESH_MAX);
  const settings = await clientMatchSettings(tx, tenantId);
  const scope = sql`r.tenant_id = ${tenantId} and not r.is_deleted
    and r.connector = any(${textArray(connectors)}) and r.entity_type = any(${textArray(modules)})
    ${options.connectionId ? sql`and r.connection_id = ${options.connectionId}` : sql``}
    ${
      options.rawRecordIds
        ? sql`and (r.connection_id, r.entity_type, r.external_id) in (
            select s.connection_id, s.entity_type, s.external_id from raw_record s
            where s.tenant_id = ${tenantId} and s.id = any(${sql`ARRAY[${sql.join(
              options.rawRecordIds.map((id) => sql`${id}`),
              sql`, `,
            )}]::uuid[]`}))`
        : sql``
    }`;
  // DECISION: a record's latest version is its newest raw record by `synced_at` (then id), never
  // by `external_version`: Zoho's may be `<Modified_Time>~<key>` (a re-read when a connection's
  // extra sync fields change) and two versions may share one Modified_Time.
  const due = await tx.execute<{
    id: string;
    connection_id: string;
    connector: string;
    entity_type: string;
    external_id: string;
    payload: unknown;
  }>(sql`
    select latest.id, latest.connection_id, latest.connector, latest.entity_type,
      latest.external_id, latest.payload
    from (
      select distinct on (r.connection_id, r.entity_type, r.external_id)
        r.id, r.connection_id, r.connector, r.entity_type, r.external_id, r.payload
      from raw_record r
      where ${scope}
      order by r.connection_id, r.entity_type, r.external_id, r.synced_at desc, r.id desc
    ) latest
    left join crm_record_key k on k.tenant_id = ${tenantId}
      and k.connection_id = latest.connection_id and k.module = latest.entity_type
      and k.external_id = latest.external_id
    where ${options.rebuild ? sql`true` : sql`k.id is null or k.raw_record_id <> latest.id`}
    order by latest.id
    limit ${limit + 1}`);
  const rows = [...due];
  const more = rows.length > limit;
  let built = 0;
  for (const r of rows.slice(0, limit)) {
    const mapper = mappers[r.connector];
    const mapped = mapper?.map(r.entity_type, r.payload) ?? null;
    // DECISION: a record its mapper can't read still gets a row, with no keys and no text, so it
    // isn't read again on every pass; it matches nothing until a newer version reads.
    const keys = mapped ? keysOf(mapped.fields) : {};
    // The client's own match fields, read from the payload by name (custom fields included).
    const extra: Record<string, string> = {};
    for (const name of settings.extraFields[r.entity_type] ?? []) {
      const v = mapped ? mapper?.field(r.payload, name) : undefined;
      if (v) extra[name] = v;
    }
    const matchText = matchTextOf(keys, settings.textFields, Object.values(extra));
    const values = {
      rawRecordId: r.id,
      email: keys.email ?? null,
      phone: keys.phone ?? null,
      domain: keys.domain ?? null,
      companyName: keys.company ?? null,
      personName: keys.name ?? null,
      dealName: keys.deal ?? null,
      display: mapped ? { ...extra, ...mapped.display } : {},
      matchText,
      matchHash: await textHash(matchText),
      updatedAt: new Date(),
    };
    await tx
      .insert(crmRecordKey)
      .values({
        tenantId,
        connectionId: r.connection_id,
        connector: r.connector,
        module: r.entity_type,
        externalId: r.external_id,
        ...values,
      })
      .onConflictDoUpdate({
        target: [
          crmRecordKey.tenantId,
          crmRecordKey.connectionId,
          crmRecordKey.module,
          crmRecordKey.externalId,
        ],
        set: values,
      });
    built += 1;
  }
  return { built, more };
}

/**
 * After a sync page committed: the client's keys for the records it stored, when the client has
 * the Sales area on. Deterministic, no model: embeddings are made by the next match or
 * `sales.keys.refresh`, on that step's model transport (its cost on the step).
 */
export async function keysAfterSync(
  db: Db,
  input: { tenantId: string; connectionId: string; rawRecordIds: readonly string[] },
): Promise<RefreshResult | null> {
  if (input.rawRecordIds.length === 0) return null;
  return withTenant(db, input.tenantId, async (tx) => {
    if (!(await salesOn(tx, input.tenantId))) return null;
    return refreshRecordKeys(tx, input.tenantId, {
      connectionId: input.connectionId,
      rawRecordIds: input.rawRecordIds,
    });
  });
}

// ── Embeddings ──────────────────────────────────────────────────────────────────────────────────

/** Record keys embedded in one call of the match or a refresh at most; the rest wait. */
export const EMBED_DUE_MAX = 1000;

export interface EmbedResult {
  embedded: number;
  /** Keys still due (no embedding, or one of an older text). */
  left: number;
  /** HIPAA mode refused the embedding vendor: matching works without meaning. */
  refused: boolean;
}

/**
 * Embeds texts in batches on the step's model transport. Null when there is none, or when the
 * client's compliance mode refuses the embedding vendor (`refused`).
 */
// DECISION (§1.164 "Embeddings and compliance"): a refusal is no failure: the match goes on with
// keys, text and the model, as the vendor catalog's search goes on by name without a transport.
export async function embedTexts(
  llm: LlmClient | null,
  texts: readonly string[],
  label: string,
): Promise<{ vectors: (number[] | null)[]; refused: boolean }> {
  if (texts.length === 0 || !llm) return { vectors: texts.map(() => null), refused: false };
  const out: number[][] = [];
  try {
    for (let i = 0; i < texts.length; i += EMBED_BATCH_MAX) {
      const r = await llm.embed({ texts: texts.slice(i, i + EMBED_BATCH_MAX), label });
      out.push(...r.embeddings);
    }
  } catch (error) {
    if (error instanceof ComplianceRefusal) {
      return { vectors: texts.map(() => null), refused: true };
    }
    throw error;
  }
  return {
    vectors: texts.map((_, i) => {
      const v = out[i];
      return v && v.length === EMBEDDING_DIMENSIONS ? v : null;
    }),
    refused: false,
  };
}

/**
 * Embeds the client's record keys whose match text has no embedding, or a newer text than the one
 * embedded, up to `limit`; each between transactions. A key whose text changed meanwhile is left
 * for the next pass.
 */
export async function embedDueKeys(
  ctx: { db: Db; tenantId: string; llm: LlmClient | null },
  options: { limit?: number; modules?: readonly string[] | undefined } = {},
): Promise<EmbedResult> {
  const limit = Math.min(options.limit ?? EMBED_DUE_MAX, EMBED_DUE_MAX);
  const dueWhere = (tenantId: string) =>
    and(
      eq(crmRecordKey.tenantId, tenantId),
      sql`${crmRecordKey.matchText} <> ''`,
      sql`${crmRecordKey.embeddedHash} is distinct from ${crmRecordKey.matchHash}`,
      options.modules ? inArray(crmRecordKey.module, [...options.modules]) : undefined,
      LIVE,
    );
  const todo = await withTenant(ctx.db, ctx.tenantId, async (tx) => {
    const rows = await tx
      .select({ id: crmRecordKey.id, text: crmRecordKey.matchText, hash: crmRecordKey.matchHash })
      .from(crmRecordKey)
      .where(dueWhere(ctx.tenantId))
      .orderBy(asc(crmRecordKey.updatedAt), asc(crmRecordKey.id))
      .limit(limit + 1);
    const [count] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(crmRecordKey)
      .where(dueWhere(ctx.tenantId));
    return { rows, total: Number(count?.n ?? 0) };
  });
  const batch = todo.rows.slice(0, limit);
  if (batch.length === 0 || !ctx.llm) {
    return { embedded: 0, left: todo.total, refused: false };
  }
  const { vectors, refused } = await embedTexts(
    ctx.llm,
    batch.map((r) => r.text),
    "sales.record_keys.embed",
  );
  if (refused) return { embedded: 0, left: todo.total, refused: true };
  let embedded = 0;
  await withTenant(ctx.db, ctx.tenantId, async (tx) => {
    for (const [i, r] of batch.entries()) {
      const v = vectors[i];
      if (!v) continue;
      const done = await tx
        .update(crmRecordKey)
        .set({ embedding: v, embeddedHash: r.hash, embeddingModel: DEFAULT_EMBEDDING_MODEL })
        .where(
          and(
            eq(crmRecordKey.id, r.id),
            eq(crmRecordKey.tenantId, ctx.tenantId),
            eq(crmRecordKey.matchHash, r.hash),
          ),
        )
        .returning({ id: crmRecordKey.id });
      embedded += done.length;
    }
  });
  return { embedded, left: Math.max(0, todo.total - embedded), refused: false };
}

// ── Records deleted in the CRM (2026-11-24) ─────────────────────────────────────────────────────

// DECISION: a record deleted in the client's CRM (its raw records marked `is_deleted` by the sync)
// is never a candidate, an alias's record, a look-up's answer or an embedding to make. Its key row
// stays: matches and aliases already made point at it as their evidence (invariant 10), and a
// record restored in the CRM comes back with its next version. No migration: the key's own raw
// record says it.
/** For a query over `crm_record_key k`: the key's record isn't deleted. */
const LIVE_K = sql`not exists (select 1 from raw_record r
  where r.tenant_id = k.tenant_id and r.id = k.raw_record_id and r.is_deleted)`;
/** The same over the table by name (Drizzle's queries). */
const LIVE = sql`not exists (select 1 from raw_record r
  where r.tenant_id = ${crmRecordKey.tenantId} and r.id = ${crmRecordKey.rawRecordId}
    and r.is_deleted)`;

// ── The match's searches ────────────────────────────────────────────────────────────────────────

/** Records sharing one exact key with a row, per key value, at most this many. */
const EXACT_PER_VALUE = 20;
/** Records found by similar text per row. */
export const TEXT_CANDIDATES = 10;
/** Records found by similar meaning per row. */
export const MEANING_CANDIDATES = 5;
/** The least cosine similarity a meaning candidate has. */
// DECISION: 0.4: unrelated short texts sit well under it with the default embedding model, so a
// row that is nobody's finds no candidate and reads as new, rather than its nearest stranger.
export const MEANING_SIMILARITY_MIN = 0.4;
/** The least trigram similarity a text candidate has (pg_trgm's own default is 0.3). */
// DECISION: 0.25, a little under pg_trgm's default, so a name with a typo and a company missing
// still comes up; the rules and the model decide what it is.
export const TEXT_SIMILARITY_MIN = 0.25;

/** Records in the modules with any of the emails, phones or domains, by key and value. */
export async function exactCandidates(
  tx: Tx,
  tenantId: string,
  modules: readonly string[],
  values: { emails: readonly string[]; phones: readonly string[]; domains: readonly string[] },
): Promise<KeyRow[]> {
  const parts: SQL[] = [];
  const by = (column: SQL, list: readonly string[]) =>
    sql`select * from (
      select k.id, row_number() over (partition by ${column} order by k.id) as n
      from crm_record_key k
      where k.tenant_id = ${tenantId} and k.module = any(${textArray(modules)})
        and ${column} = any(${textArray(list)}) and ${LIVE_K}
    ) x where x.n <= ${EXACT_PER_VALUE}`;
  if (values.emails.length) parts.push(by(sql`k.email`, values.emails));
  if (values.phones.length) parts.push(by(sql`k.phone`, values.phones));
  if (values.domains.length) parts.push(by(sql`k.domain`, values.domains));
  if (parts.length === 0 || modules.length === 0) return [];
  const ids = [...(await tx.execute<{ id: string }>(sql.join(parts, sql` union `)))].map(
    (r) => r.id,
  );
  return keyRowsByIds(tx, tenantId, ids);
}

/**
 * The key rows by id. A card showing a match made earlier reads them all, a deleted record's too;
 * `live` leaves out those whose record was deleted in the CRM (an alias's record).
 */
export async function keyRowsByIds(
  tx: Tx,
  tenantId: string,
  ids: readonly string[],
  options: { live?: boolean } = {},
): Promise<KeyRow[]> {
  if (ids.length === 0) return [];
  const rows = await tx
    .select(KEY_COLUMNS)
    .from(crmRecordKey)
    .where(
      and(
        eq(crmRecordKey.tenantId, tenantId),
        inArray(crmRecordKey.id, [...new Set(ids)]),
        options.live ? LIVE : undefined,
      ),
    );
  return rows.map(keyRow);
}

/** For each text (by its index), the records in the modules whose match text is most like it. */
export async function textCandidates(
  tx: Tx,
  tenantId: string,
  modules: readonly string[],
  texts: readonly string[],
  perRow = TEXT_CANDIDATES,
): Promise<Map<number, { row: KeyRow; similarity: number }[]>> {
  const out = new Map<number, { row: KeyRow; similarity: number }[]>();
  const asked = texts.map((t, i) => ({ t, i })).filter((x) => x.t.trim().length > 0);
  if (asked.length === 0 || modules.length === 0) return out;
  await tx.execute(
    sql`select set_config('pg_trgm.similarity_threshold', ${String(TEXT_SIMILARITY_MIN)}, true)`,
  );
  const found = await tx.execute<{ i: number; id: string; sim: number }>(sql`
    select q.i::int as i, c.id, c.sim
    from unnest(${textArray(asked.map((a) => a.t))}, ${sql`ARRAY[${sql.join(
      asked.map((a) => sql`${a.i}`),
      sql`, `,
    )}]::int[]`}) as q(t, i)
    cross join lateral (
      select k.id, similarity(k.match_text, q.t) as sim
      from crm_record_key k
      where k.tenant_id = ${tenantId} and k.module = any(${textArray(modules)})
        and k.match_text % q.t and ${LIVE_K}
      order by similarity(k.match_text, q.t) desc, k.id
      limit ${perRow}
    ) c`);
  const list = [...found];
  const rows = new Map(
    (
      await keyRowsByIds(
        tx,
        tenantId,
        list.map((r) => r.id),
      )
    ).map((r) => [r.id, r]),
  );
  for (const f of list) {
    const row = rows.get(f.id);
    if (!row) continue;
    const at = out.get(f.i) ?? [];
    at.push({ row, similarity: Number(f.sim) });
    out.set(f.i, at);
  }
  return out;
}

/** The records in the modules whose embedding is nearest a row's, by cosine similarity. */
// DECISION: an exact scan over the client's embedded records in the modules, no approximate
// index, as the vendor catalog's (packs/materials/src/vendor/store.ts).
export async function meaningCandidates(
  tx: Tx,
  tenantId: string,
  modules: readonly string[],
  vector: readonly number[],
  limit = MEANING_CANDIDATES,
): Promise<{ row: KeyRow; similarity: number }[]> {
  const distance = sql<number>`(${crmRecordKey.embedding} <=> ${vectorLiteral(vector)}::vector)`;
  const rows = await tx
    .select({ ...KEY_COLUMNS, distance })
    .from(crmRecordKey)
    .where(
      and(
        eq(crmRecordKey.tenantId, tenantId),
        inArray(crmRecordKey.module, [...modules]),
        sql`${crmRecordKey.embedding} is not null`,
        sql`${distance} <= ${1 - MEANING_SIMILARITY_MIN}`,
        LIVE,
      ),
    )
    .orderBy(distance, asc(crmRecordKey.id))
    .limit(limit);
  return rows.map((r) => ({ row: keyRow(r), similarity: 1 - Number(r.distance) }));
}

/** The aliases for the key hashes, in the modules: hash → the record a person chose. */
export async function aliasesFor(
  tx: Tx,
  tenantId: string,
  modules: readonly string[],
  hashes: readonly string[],
): Promise<Map<string, { aliasId: string; row: KeyRow }[]>> {
  const out = new Map<string, { aliasId: string; row: KeyRow }[]>();
  if (hashes.length === 0 || modules.length === 0) return out;
  const aliases = await tx
    .select({ id: crmAlias.id, hash: crmAlias.keyHash, recordKeyId: crmAlias.recordKeyId })
    .from(crmAlias)
    .where(
      and(
        eq(crmAlias.tenantId, tenantId),
        inArray(crmAlias.module, [...modules]),
        inArray(crmAlias.keyHash, [...new Set(hashes)]),
      ),
    )
    .orderBy(asc(crmAlias.id));
  const rows = new Map(
    (
      await keyRowsByIds(
        tx,
        tenantId,
        aliases.map((a) => a.recordKeyId),
        { live: true },
      )
    ).map((r) => [r.id, r]),
  );
  for (const a of aliases) {
    const row = rows.get(a.recordKeyId);
    if (!row) continue;
    out.set(a.hash, [...(out.get(a.hash) ?? []), { aliasId: a.id, row }]);
  }
  return out;
}

// ── The look-up ─────────────────────────────────────────────────────────────────────────────────

/** A synced record as the look-up shows it: its id in the CRM and the values a person knows it by. */
export interface LookupRecord {
  recordKeyId: string;
  connectionId: string;
  module: string;
  externalId: string;
  name: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
  deal: string | null;
  stage: string | null;
  amount: string | null;
  /** How alike its match text is to what was typed (1 for an exact email or phone). */
  similarity: number;
}

export const LOOKUP_MAX = 20;

export function lookupView(row: KeyRow, similarity: number): LookupRecord {
  const d = row.display;
  return {
    recordKeyId: row.id,
    connectionId: row.connectionId,
    module: row.module,
    externalId: row.externalId,
    name: d.name ?? null,
    company: d.company ?? null,
    email: d.email ?? null,
    phone: d.phone ?? null,
    deal: d.deal ?? null,
    stage: d.stage ?? null,
    amount: d.amount ?? null,
    similarity: Math.round(similarity * 1000) / 1000,
  };
}

/**
 * The look-up behind Confirm matches (§1.164 "The look-up"): the client's synced records in one
 * module, by an exact email or phone, then by trigrams on the match text, at most 20. The text is
 * what a person typed: a name, company, email, phone or deal name.
 */
export async function lookupRecords(
  tx: Tx,
  tenantId: string,
  input: { module: string; q: string; limit?: number | undefined },
): Promise<LookupRecord[]> {
  const limit = Math.max(1, Math.min(input.limit ?? LOOKUP_MAX, LOOKUP_MAX));
  const q = input.q.trim().slice(0, 200);
  if (!q) return [];
  const out: LookupRecord[] = [];
  const seen = new Set<string>();
  const email = normalizeEmail(q);
  const phone = normalizeCrmPhone(q);
  if (email || phone) {
    const exact = await tx
      .select(KEY_COLUMNS)
      .from(crmRecordKey)
      .where(
        and(
          eq(crmRecordKey.tenantId, tenantId),
          eq(crmRecordKey.module, input.module),
          email ? eq(crmRecordKey.email, email) : eq(crmRecordKey.phone, phone as string),
          LIVE,
        ),
      )
      .orderBy(asc(crmRecordKey.id))
      .limit(limit);
    for (const r of exact) {
      seen.add(r.id);
      out.push(lookupView(keyRow(r), 1));
    }
  }
  const text = words(q);
  if (text && out.length < limit) {
    const sim = sql<number>`greatest(similarity(${crmRecordKey.matchText}, ${text}),
      word_similarity(${text}, ${crmRecordKey.matchText}))`;
    await tx.execute(sql`select set_config('pg_trgm.word_similarity_threshold', '0.4', true)`);
    const rows = await tx
      .select({ ...KEY_COLUMNS, sim })
      .from(crmRecordKey)
      .where(
        and(
          eq(crmRecordKey.tenantId, tenantId),
          eq(crmRecordKey.module, input.module),
          sql`(${crmRecordKey.matchText} % ${text} or ${text} <% ${crmRecordKey.matchText})`,
          LIVE,
        ),
      )
      .orderBy(sql`${sim} desc`, asc(crmRecordKey.id))
      .limit(limit);
    for (const r of rows) {
      if (seen.has(r.id) || out.length >= limit) continue;
      seen.add(r.id);
      out.push(lookupView(keyRow(r), Number(r.sim)));
    }
  }
  return out;
}
