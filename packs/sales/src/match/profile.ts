// The Sales area's CRM records profile (docs/step-model-plan.md §7, §10e), run by core's Match
// engine: the client's synced CRM records (leads, contacts, accounts, deals), matched by email,
// phone and website first, then by names and meaning (a shortlist a model chooses from). It
// replaces Match to CRM records (`sales.match_records`); the record keys it reads are kept up to
// date by the sync (`SALES_SYNCED`), so "Refresh the record keys" (`sales.keys.refresh`) is no
// longer an action of its own.
//
// Matching is against our records (§7, "Where matching happens"): the raw copies a connector syncs,
// with their key index (`crm_record_key`); no table per record type. The hard rules are the area's:
// two different emails, or two different phones, are never the same record. A key counts as an
// exact hit only where the area's rules say the key settles it (a phone or a website doesn't, when
// the names disagree). A person's answer is a `crm_match` row of theirs and a `crm_alias`, so the
// same row is an exact hit next time (invariants 3, 10). One client's records only (invariant 1).

import {
  type ProfileCandidate,
  type ProfileMatcher,
  type ProfileRecord,
  type ProfileStore,
  steps,
  uuidv7,
} from "@countersign/core";
import { type Tx, withTenant } from "@countersign/db";
import { sql } from "drizzle-orm";
import { keysHash, matchTextOf } from "../keys/build";
import { CRM_MAPPERS, ZOHO_CONNECTOR } from "../keys/zoho";
import type { PackToolContext } from "../pack";
import { type CrmKeys, crmAlias, crmMatch } from "../schema";
import {
  aliasesFor,
  clientMatchSettings,
  embedTexts,
  exactCandidates,
  type KeyRow,
  keyRowsByIds,
  meaningCandidates,
  textCandidates,
} from "../store";
import { kindOf, rowKeys } from "./match";
import { MATCH_THRESHOLD, scorePair } from "./score";

/** What a profile's store needs of a call: one client, its database and model, test or live. */
export type CrmMatchContext = Pick<PackToolContext, "tenantId" | "db" | "llm" | "mode">;

/** Every module the area keys (Zoho's), the ones a row is matched in when it names none. */
export const CRM_MODULES: readonly string[] = [
  ...new Set(Object.values(CRM_MAPPERS).flatMap((m) => Object.keys(m.modules))),
];

export const CRM_RECORDS_PROFILE: steps.MatchProfile = steps.MatchProfile.parse({
  id: "crm-records",
  name: "CRM records",
  area: "sales",
  record: "crm_record",
  // DECISION: the raw copies of the client's CRM (Zoho's, the one CRM the area keys), all four of
  // its modules; a row narrows them with `module`.
  source: { kind: "raw", connector: ZOHO_CONNECTOR, entity: "Leads, Contacts, Accounts, Deals" },
  input: [
    { name: "email", type: "text", required: false },
    { name: "phone", type: "text", required: false },
    { name: "website", type: "text", required: false },
    { name: "company", type: "text", required: false },
    { name: "name", type: "text", required: false, about: "A person's whole name" },
    { name: "firstName", type: "text", required: false },
    { name: "lastName", type: "text", required: false },
    { name: "deal", type: "text", required: false },
    {
      name: "module",
      type: "text",
      required: false,
      about: "Only records of this kind: Leads, Contacts, Accounts or Deals",
    },
  ],
  keys: [
    { id: "email", name: "Email", field: "email" },
    { id: "phone", name: "Phone", field: "phone" },
    { id: "website", name: "Website", field: "website" },
  ],
  semantic: { text: ["name", "company", "deal"] },
  types: ["exact", "semantic", "hybrid"],
  neverSame: [
    { id: "email", words: "Two different emails" },
    { id: "phone", words: "Two different phones" },
  ],
  learns: true,
});

const text = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim()
    ? v.trim().slice(0, 500)
    : typeof v === "number"
      ? String(v)
      : undefined;

/** A row's normalised keys, from the profile's input fields. */
export function crmItemKeys(item: Readonly<Record<string, unknown>>): CrmKeys {
  const values: Record<string, string> = {};
  for (const f of [
    "email",
    "phone",
    "website",
    "company",
    "name",
    "firstName",
    "lastName",
    "deal",
  ]) {
    const v = text(item[f]);
    if (v !== undefined) values[f] = v;
  }
  return rowKeys(values);
}

const KEY_FIELD: Readonly<Record<string, "email" | "phone" | "domain">> = {
  email: "email",
  phone: "phone",
  website: "domain",
};

/**
 * The records a key settles for a row: the area's rules rest on that key and reach the threshold
 * (an email does; a phone or a website only when the names don't disagree), no hard rule broken.
 */
export function crmKeyHits<R extends { keys: CrmKeys; module: string }>(
  row: CrmKeys,
  key: Pick<steps.MatchKey, "id">,
  records: readonly R[],
): R[] {
  const field = KEY_FIELD[key.id];
  if (!field || !row[field]) return [];
  return records.filter((r) => {
    if (r.keys[field] !== row[field]) return false;
    const pair = scorePair(row, r.keys, { kind: kindOf(r.module) });
    return pair.vetoed === null && pair.key === field && pair.score >= MATCH_THRESHOLD;
  });
}

/** The hard rule a row and a record break: two different emails, or phones; null when none. */
export function crmNeverSame(
  row: CrmKeys,
  record: { keys: CrmKeys; module: string },
): string | null {
  return scorePair(row, record.keys, { kind: kindOf(record.module) }).vetoed;
}

function crmRecord(row: KeyRow): ProfileRecord {
  return {
    id: row.id,
    label:
      row.display.name ??
      row.display.company ??
      row.display.deal ??
      Object.values(row.display)[0] ??
      row.externalId,
    values: { module: row.module, ...row.display },
    sources: [row.id, row.rawRecordId],
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The CRM records' store for one call. */
export function crmRecordsStore(ctx: CrmMatchContext): ProfileStore {
  const rows = new Map<string, KeyRow>();
  const read = <T>(work: (tx: Tx) => Promise<T>) => withTenant(ctx.db, ctx.tenantId, work);
  const modulesOf = (item: Readonly<Record<string, unknown>>) => {
    const m = text(item.module);
    return m ? CRM_MODULES.filter((x) => x.toLowerCase() === m.toLowerCase()) : [...CRM_MODULES];
  };
  const keep = (found: readonly KeyRow[]) => {
    for (const r of found) rows.set(r.id, r);
    return found;
  };
  const row = async (id: string) => {
    if (!UUID.test(id)) return null;
    const seen = rows.get(id);
    if (seen) return seen;
    const [r] = await read((tx) => keyRowsByIds(tx, ctx.tenantId, [id], { live: true }));
    return r ? (keep([r])[0] ?? null) : null;
  };
  return {
    async get(id) {
      const r = await row(id);
      return r ? crmRecord(r) : null;
    },
    async byKey(key, item) {
      const keys = crmItemKeys(item);
      const field = KEY_FIELD[key.id];
      const value = field ? keys[field] : undefined;
      if (!field || !value) return [];
      const found = keep(
        await read((tx) =>
          exactCandidates(tx, ctx.tenantId, modulesOf(item), {
            emails: field === "email" ? [value] : [],
            phones: field === "phone" ? [value] : [],
            domains: field === "domain" ? [value] : [],
          }),
        ),
      );
      return crmKeyHits(keys, key, found).map(crmRecord);
    },
    async learned(item) {
      const keys = crmItemKeys(item);
      if (Object.keys(keys).length === 0) return [];
      const hash = await keysHash(keys);
      const found = await read((tx) => aliasesFor(tx, ctx.tenantId, modulesOf(item), [hash]));
      return keep((found.get(hash) ?? []).map((a) => a.row)).map((r) => ({
        ...crmRecord(r),
        sources: [r.id, r.rawRecordId, ...(found.get(hash) ?? []).map((a) => a.aliasId)],
      }));
    },
    async shortlist(item, limit) {
      const keys = crmItemKeys(item);
      const modules = modulesOf(item);
      if (Object.keys(keys).length === 0 || modules.length === 0) return [];
      const settings = await read((tx) => clientMatchSettings(tx, ctx.tenantId));
      const matchText = matchTextOf(keys, settings.textFields);
      const out = new Map<string, ProfileCandidate>();
      const add = (r: KeyRow, similarity: number) => {
        keep([r]);
        const rules = scorePair(keys, r.keys, { kind: kindOf(r.module) }).score;
        const score = Math.max(rules, similarity);
        const at = out.get(r.id);
        if (!at || at.score < score) out.set(r.id, { ...crmRecord(r), score });
      };
      const texts = await read((tx) =>
        textCandidates(tx, ctx.tenantId, modules, [matchText], limit),
      );
      for (const t of texts.get(0) ?? []) add(t.row, t.similarity);
      // The row's meaning, between transactions; none without a model or when the client's
      // compliance mode refuses the embedding vendor (the names still give a shortlist).
      if (ctx.llm && matchText) {
        try {
          const { vectors, refused } = await embedTexts(ctx.llm, [matchText], "match:crm-records");
          const vector = refused ? null : (vectors[0] ?? null);
          if (vector) {
            const near = await read((tx) =>
              meaningCandidates(tx, ctx.tenantId, modules, vector, limit),
            );
            for (const m of near) add(m.row, m.similarity);
          }
        } catch {
          // DECISION: a failed embedding is no failure of the match (as the vendor search).
        }
      }
      return [...out.values()]
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .slice(0, limit);
    },
    async neverSame(item, record) {
      const r = await row(record.id);
      return r ? crmNeverSame(crmItemKeys(item), r) : null;
    },
    async learn(item, recordId, by) {
      const keys = crmItemKeys(item);
      if (Object.keys(keys).length === 0) return false;
      const r = await row(recordId);
      if (!r) return false;
      // A test run writes nothing: it answers what it would have learned.
      if (ctx.mode === "test") return true;
      const hash = await keysHash(keys);
      await read(async (tx) => {
        // The person's decision, recorded as theirs (invariant 10), then the name it teaches.
        const [made] = await tx
          .insert(crmMatch)
          .values({
            tenantId: ctx.tenantId,
            batchId: uuidv7(),
            runId: by.runId ?? null,
            step: by.stepId ?? null,
            rowIndex: 0,
            keys,
            decision: "matched",
            method: "human",
            recordKeyId: r.id,
            connectionId: r.connectionId,
            module: r.module,
            externalId: r.externalId,
            score: "1.000",
            sources: [r.rawRecordId, r.id],
            decidedByUserId: by.personId,
          })
          .returning({ id: crmMatch.id });
        if (!made) throw new Error("the decision wasn't recorded");
        await tx
          .insert(crmAlias)
          .values({
            tenantId: ctx.tenantId,
            connectionId: r.connectionId,
            module: r.module,
            keyHash: hash,
            keys,
            recordKeyId: r.id,
            externalId: r.externalId,
            matchId: made.id,
            createdByUserId: by.personId,
          })
          .onConflictDoUpdate({
            target: [crmAlias.tenantId, crmAlias.connectionId, crmAlias.module, crmAlias.keyHash],
            set: {
              recordKeyId: r.id,
              externalId: r.externalId,
              matchId: made.id,
              createdByUserId: by.personId,
              updatedAt: sql`now()`,
            },
          });
      });
      return true;
    },
  };
}

export const CRM_RECORDS_MATCHER: ProfileMatcher<CrmMatchContext> = {
  profile: CRM_RECORDS_PROFILE,
  store: crmRecordsStore,
};

/** The Sales area's tools the CRM records profile (or the sync) does for new steps (§10e). */
// DECISION: kept registered for stored v4 steps until v4 goes (wave 4), as Materials' are.
export const SALES_RETIRED_TOOLS: Readonly<Record<string, string>> = {
  "sales.match_records": "Match step, CRM records profile",
  "sales.keys.refresh": "The sync keeps every record's keys up to date",
};
