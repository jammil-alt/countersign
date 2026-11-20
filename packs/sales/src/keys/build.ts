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

/** The text a record or a row is searched by: its chosen keys, in a fixed order, `|` between. */
export function matchTextOf(keys: CrmKeys, fields: readonly MatchTextField[]): string {
  const parts: string[] = [];
  for (const f of MATCH_TEXT_FIELDS) {
    if (!fields.includes(f)) continue;
    const v = keys[f];
    if (v) parts.push(v);
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
export function matchTextFieldsFrom(settings: unknown): MatchTextField[] {
  const raw = (settings as { sales?: { matchText?: unknown } } | null | undefined)?.sales
    ?.matchText;
  if (!Array.isArray(raw)) return [...DEFAULT_MATCH_TEXT_FIELDS];
  const picked = MATCH_TEXT_FIELDS.filter((f) => raw.includes(f));
  return picked.length > 0 ? picked : [...DEFAULT_MATCH_TEXT_FIELDS];
}
