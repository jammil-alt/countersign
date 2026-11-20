// A synced record's (or a row's) keys and match text (docs/plan.md §1.164 "The Sales area, first
// tables"). Key building takes a mapper per connector: Zoho CRM first (./zoho.ts); another CRM adds
// its own mapper and nothing else changes. Pure: no I/O.

import { canonicalJson, sha256Hex } from "@countersign/core";
import type { RecordKind } from "../match/score";
import type { CrmKeys } from "../schema";
import {
  companyDomain,
  normalizeCompany,
  normalizeCrmPhone,
  normalizeDeal,
  normalizeEmail,
  normalizePerson,
  words,
} from "./normalize";

/** A record's fields as its connector names them, read into the keys' plain parts. */
export interface RecordFields {
  email?: unknown;
  phone?: unknown;
  website?: unknown;
  company?: unknown;
  /** A person's whole name, or its parts. */
  name?: unknown;
  firstName?: unknown;
  lastName?: unknown;
  deal?: unknown;
}

/** What a connector's mapper reads from one synced record. */
export interface MappedRecord {
  fields: RecordFields;
  /** The record's values as written in the client's tool, for people (never for matching). */
  display: Record<string, string>;
}

/** Reads a connector's synced records into keys: which modules, what each is, and its fields. */
export interface CrmRecordMapper {
  /** The connector's manifest id (`zoho_crm`). */
  connector: string;
  /** The modules it reads, and what each module's records are. */
  modules: Readonly<Record<string, RecordKind>>;
  /** One raw record's payload; null when it can't be read. */
  map(module: string, payload: unknown): MappedRecord | null;
  /**
   * One field of a raw record's payload as text, by the connector's own field name (a custom field
   * a connection syncs, e.g. Zoho's `Region`); undefined when it has none.
   */
  field(payload: unknown, name: string): string | undefined;
}

/** The fields a match text is built from, in this order. */
export const MATCH_TEXT_FIELDS = ["name", "company", "deal", "email", "phone", "domain"] as const;
export type MatchTextField = (typeof MATCH_TEXT_FIELDS)[number];

/** The client's default: the names, which the exact keys don't cover. */
// DECISION: names only (a person's, a company's, a deal's): emails, phones and domains are matched
// exactly in step 1, and in the text they would only pull unrelated records with the same domain
// closer by trigrams and by meaning.
export const DEFAULT_MATCH_TEXT_FIELDS: readonly MatchTextField[] = ["name", "company", "deal"];

/** The longest match text kept (the column's limit). */
const MATCH_TEXT_MAX = 2000;

/** Normalised keys from plain fields: the same for a record and a row. */
export function keysOf(fields: RecordFields): CrmKeys {
  const keys: CrmKeys = {};
  const email = normalizeEmail(fields.email);
  if (email) keys.email = email;
  const phone = normalizeCrmPhone(fields.phone);
  if (phone) keys.phone = phone;
  const domain = companyDomain({ website: fields.website, email: fields.email });
  if (domain) keys.domain = domain;
  const company = normalizeCompany(fields.company);
  if (company) keys.company = company;
  const name = normalizePerson(fields.name, { first: fields.firstName, last: fields.lastName });
  if (name) keys.name = name;
  const deal = normalizeDeal(fields.deal);
  if (deal) keys.deal = deal;
  return keys;
}

/**
 * The text a record or a row is searched by: its chosen keys in a fixed order, then the values of
 * the client's own match fields (as words), `|` between.
 */
export function matchTextOf(
  keys: CrmKeys,
  fields: readonly MatchTextField[],
  extra: readonly (string | undefined)[] = [],
): string {
  const parts: string[] = [];
  for (const f of MATCH_TEXT_FIELDS) {
    if (!fields.includes(f)) continue;
    const v = keys[f];
    if (v) parts.push(v);
  }
  for (const v of extra) {
    const w = v ? words(v) : "";
    if (w) parts.push(w);
  }
  const text = parts.join(" | ");
  return text.length > MATCH_TEXT_MAX ? text.slice(0, MATCH_TEXT_MAX) : text;
}

/** The match text's hash, to know when its embedding is out of date. */
export function textHash(text: string): Promise<string> {
  return sha256Hex(text);
}

/** The hash of a row's keys, which an alias is found by. */
export function keysHash(keys: CrmKeys): Promise<string> {
  return sha256Hex(canonicalJson(keys));
}

/** `tenant.settings.sales.matchText`: the fields a client's match text is built from. */
// DECISION: the Sales area's one setting per client lives in `tenant.settings.sales` (no table for
// a few field names); absent or unreadable, the default. A change applies to a record when it next
// syncs, or to all of them on `sales.keys.refresh` with `rebuild`.
/** At most this many of the client's own fields per module go into the match text. */
export const MATCH_FIELDS_MAX = 10;

/**
 * `tenant.settings.sales.matchFields`: the client's own CRM fields its match text also holds, per
 * module, by the connector's field names (`{ "Leads": ["Region"] }`). A connection syncs them as
 * extra fields (`connection.config.syncFields`); they reach the keys from the raw payload, read by
 * name, never from a fixed list.
 */
// DECISION: these fields go into the match text (trigrams and meaning) and the record's display,
// not into the rules' score: their meaning is the client's, so the rules can't weigh them; the
// text search, the model and the person can.
export function matchFieldsFrom(settings: unknown): Record<string, string[]> {
  const raw = (settings as { sales?: { matchFields?: unknown } } | null | undefined)?.sales
    ?.matchFields;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string[]> = {};
  for (const [module, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(module) || !Array.isArray(list)) continue;
    const names = list
      .filter((f): f is string => typeof f === "string" && /^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(f))
      .slice(0, MATCH_FIELDS_MAX);
    if (names.length > 0) out[module] = [...new Set(names)];
  }
  return out;
}

export function matchTextFieldsFrom(settings: unknown): MatchTextField[] {
  const raw = (settings as { sales?: { matchText?: unknown } } | null | undefined)?.sales
    ?.matchText;
  if (!Array.isArray(raw)) return [...DEFAULT_MATCH_TEXT_FIELDS];
  const picked = MATCH_TEXT_FIELDS.filter((f) => raw.includes(f));
  return picked.length > 0 ? picked : [...DEFAULT_MATCH_TEXT_FIELDS];
}
