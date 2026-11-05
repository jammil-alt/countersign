// Import rows for the directory (docs/plan.md §1.27): a CSV of people or organizations, and the
// contacts and accounts that Zoho CRM and Podio read, turned into the same rows. Each row is
// checked with the row schemas; a row that fails keeps its problems and is never applied. Pure:
// the CSV text is split by the upload connector's reader in apps/api, and the connectors' records
// come from their read tools.

import type { z } from "zod";
import { normalizeHeader } from "../mappers/upload";
import type { ORGANIZATION_KINDS, Relationship } from "./kinds";
import {
  type DirectoryImportKind,
  type OrganizationAddress,
  OrganizationImportRow,
  PersonImportRow,
} from "./schemas";

export interface ParsedImportRow<T> {
  row: number;
  data: T | null;
  problems: string[];
}

export type PersonRowDraft = Record<string, unknown>;

/** Zod's issues as short sentences, by field. */
function problemsOf(error: z.ZodError): string[] {
  return error.issues.map((i) => {
    const field = i.path.filter((p) => typeof p === "string").join(".");
    return field ? `${field}: ${i.message}` : i.message;
  });
}

function check<T>(
  schema: z.ZodType<T>,
  row: number,
  draft: Record<string, unknown>,
  problems: string[] = [],
): ParsedImportRow<T> {
  const clean = Object.fromEntries(
    Object.entries(draft).filter(([, v]) => v !== undefined && v !== null && v !== ""),
  );
  const parsed = schema.safeParse(clean);
  const all = [...problems, ...(parsed.success ? [] : problemsOf(parsed.error))];
  return { row, data: parsed.success && all.length === 0 ? parsed.data : null, problems: all };
}

// ── Words people use ────────────────────────────────────────────────────────────────────────────

const RELATIONSHIP_WORDS: Record<string, Relationship> = {
  employee: "employee",
  staff: "employee",
  "team member": "employee",
  contractor: "contractor",
  subcontractor: "contractor",
  freelancer: "contractor",
  customer: "customer",
  client: "customer",
  vendor: "vendor",
  supplier: "vendor",
  partner: "partner",
  other: "other",
};

/** A relationship from a word people use ("supplier" is a vendor), or null when we don't know it. */
export function relationshipFrom(text: string | undefined | null): Relationship | null {
  if (!text) return null;
  return RELATIONSHIP_WORDS[text.trim().toLowerCase()] ?? null;
}

const KIND_WORDS: Record<string, (typeof ORGANIZATION_KINDS)[number]> = {
  vendor: "vendor",
  supplier: "vendor",
  customer: "customer",
  client: "customer",
  partner: "partner",
  reseller: "partner",
  own: "own",
  us: "own",
  other: "other",
};

/** Kinds from a cell like "Vendor; Customer". Unknown words are returned apart. */
export function kindsFrom(text: string | undefined | null): {
  kinds: (typeof ORGANIZATION_KINDS)[number][];
  unknown: string[];
} {
  const kinds = new Set<(typeof ORGANIZATION_KINDS)[number]>();
  const unknown: string[] = [];
  for (const word of (text ?? "").split(/[,;/|]+/)) {
    const w = word.trim().toLowerCase();
    if (!w) continue;
    const k = KIND_WORDS[w];
    if (k) kinds.add(k);
    else unknown.push(word.trim());
  }
  return { kinds: [...kinds], unknown };
}

/** Roles from a cell like "Purchaser, Owner": lower case, as reach out names them. */
export function rolesFrom(text: string | undefined | null): string[] {
  return [
    ...new Set(
      (text ?? "")
        .split(/[,;|]+/)
        .map((r) => r.trim().toLowerCase().replace(/\s+/g, " "))
        .filter(Boolean),
    ),
  ];
}

// ── CSV ─────────────────────────────────────────────────────────────────────────────────────────

// DECISION: like the purchases CSV, columns are found by common header names; other columns are
// ignored. A person needs a name (or first and last name); an organization needs a name.
const PEOPLE_COLUMNS = {
  name: ["name", "full name", "contact", "contact name", "person"],
  first: ["first name", "first", "given name"],
  last: ["last name", "last", "surname", "family name"],
  email: ["email", "e-mail", "email address", "work email"],
  phone: ["phone", "phone number", "mobile", "cell", "mobile phone", "work phone", "telephone"],
  whatsapp: ["whatsapp", "whatsapp number"],
  title: ["title", "job title", "position"],
  relationship: ["relationship", "relation", "type", "category"],
  organization: ["organization", "organisation", "company", "account", "account name", "employer"],
  roles: ["roles", "role", "tags"],
  language: ["language", "lang"],
  notes: ["notes", "note", "comments"],
} as const;

const ORGANIZATION_COLUMNS = {
  name: ["name", "organization", "organisation", "company", "account name", "account"],
  kinds: ["kind", "kinds", "type", "category"],
  website: ["website", "web", "url", "site", "web site"],
  email: ["email", "e-mail", "email address"],
  phone: ["phone", "phone number", "telephone", "main phone"],
  line1: ["address", "street", "address line 1", "line 1", "street address"],
  line2: ["address line 2", "line 2"],
  city: ["city", "town"],
  region: ["state", "region", "province", "county"],
  postalCode: ["zip", "zip code", "postal code", "postcode"],
  country: ["country"],
  notes: ["notes", "note", "comments", "description"],
} as const;

function columnIndex(headers: readonly string[], names: readonly string[]): number {
  const normalized = headers.map(normalizeHeader);
  for (const n of names) {
    const i = normalized.indexOf(n);
    if (i >= 0) return i;
  }
  return -1;
}

type Columns<K extends string> = Record<K, number>;

function columnsOf<K extends string>(
  headers: readonly string[],
  spec: Record<K, readonly string[]>,
): Columns<K> {
  const out = {} as Columns<K>;
  for (const key of Object.keys(spec) as K[]) out[key] = columnIndex(headers, spec[key]);
  return out;
}

function cell(row: readonly string[], i: number): string | undefined {
  if (i < 0) return undefined;
  const v = row[i]?.trim();
  return v ? v : undefined;
}

export interface CsvRows<T> {
  rows: ParsedImportRow<T>[];
  /** Columns the file needs and lacks (then no row is read). */
  missing: string[];
}

/** A CSV's rows (header first, as the upload connector's reader splits them) as import rows. */
export function directoryRowsFromCsv(
  cells: readonly (readonly string[])[],
  kind: DirectoryImportKind,
): CsvRows<PersonImportRow | OrganizationImportRow> {
  const [headers, ...data] = cells;
  if (!headers) return { rows: [], missing: ["name"] };
  if (kind === "people") {
    const c = columnsOf(headers, PEOPLE_COLUMNS);
    if (c.name < 0 && c.first < 0 && c.last < 0) return { rows: [], missing: ["name"] };
    return {
      missing: [],
      rows: data.map((r, i) => {
        const problems: string[] = [];
        const name =
          cell(r, c.name) ?? [cell(r, c.first), cell(r, c.last)].filter(Boolean).join(" ");
        const relText = cell(r, c.relationship);
        const relationship = relationshipFrom(relText);
        if (relText && !relationship) problems.push(`relationship: we don't know "${relText}"`);
        const roles = rolesFrom(cell(r, c.roles));
        return check(
          PersonImportRow,
          i + 1,
          {
            name,
            email: cell(r, c.email)?.toLowerCase(),
            phone: cell(r, c.phone),
            whatsapp: cell(r, c.whatsapp),
            title: cell(r, c.title),
            relationship: relationship ?? undefined,
            organization: cell(r, c.organization),
            roles: roles.length ? roles : undefined,
            language: cell(r, c.language),
            notes: cell(r, c.notes),
          },
          problems,
        );
      }),
    };
  }
  const c = columnsOf(headers, ORGANIZATION_COLUMNS);
  if (c.name < 0) return { rows: [], missing: ["name"] };
  return {
    missing: [],
    rows: data.map((r, i) => {
      const problems: string[] = [];
      const k = kindsFrom(cell(r, c.kinds));
      if (k.unknown.length) problems.push(`kinds: we don't know "${k.unknown.join(", ")}"`);
      const address: OrganizationAddress = {};
      for (const key of ["line1", "line2", "city", "region", "postalCode", "country"] as const) {
        const v = cell(r, c[key]);
        if (v) address[key] = v;
      }
      return check(
        OrganizationImportRow,
        i + 1,
        {
          name: cell(r, c.name),
          kinds: k.kinds.length ? k.kinds : undefined,
          website: cell(r, c.website),
          email: cell(r, c.email)?.toLowerCase(),
          phone: cell(r, c.phone),
          address: Object.keys(address).length ? address : undefined,
          notes: cell(r, c.notes),
        },
        problems,
      );
    }),
  };
}

// ── Connected tools ─────────────────────────────────────────────────────────────────────────────

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : undefined;
/** Rich text from Podio or Zoho as plain text. */
const plain = (v: unknown): string | undefined =>
  str(v)
    ?.replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2000) || undefined;
const lookupName = (v: unknown): string | undefined =>
  str(v) ?? (v && typeof v === "object" ? str((v as { name?: unknown }).name) : undefined);

/** A Zoho CRM record (as `zoho_crm.record.search` returns it) as an import row. */
export function rowFromZoho(
  record: { id: string; module: string; fields: Record<string, unknown> },
  kind: DirectoryImportKind,
  row: number,
): ParsedImportRow<PersonImportRow | OrganizationImportRow> {
  const f = record.fields;
  if (kind === "people") {
    const name =
      str(f.Full_Name) ?? [str(f.First_Name), str(f.Last_Name)].filter(Boolean).join(" ");
    return check(PersonImportRow, row, {
      name,
      email: str(f.Email)?.toLowerCase(),
      phone: str(f.Mobile) ?? str(f.Phone),
      title: str(f.Title) ?? str(f.Designation),
      organization: lookupName(f.Account_Name) ?? str(f.Company),
      relationship: record.module === "Leads" ? "customer" : undefined,
      notes: plain(f.Description),
      externalId: record.id,
    });
  }
  const k = kindsFrom(str(f.Account_Type));
  const address: OrganizationAddress = {};
  const parts = {
    line1: str(f.Billing_Street),
    city: str(f.Billing_City),
    region: str(f.Billing_State),
    postalCode: str(f.Billing_Code),
    country: str(f.Billing_Country),
  };
  for (const [key, v] of Object.entries(parts)) if (v) address[key as keyof typeof parts] = v;
  return check(OrganizationImportRow, row, {
    name: str(f.Account_Name) ?? lookupName(f.Account_Name),
    kinds: k.kinds.length ? k.kinds : undefined,
    website: str(f.Website),
    phone: str(f.Phone),
    address: Object.keys(address).length ? address : undefined,
    notes: plain(f.Description),
    externalId: record.id,
  });
}

function podioField(fields: Record<string, unknown>, test: (key: string) => boolean): unknown {
  const key = Object.keys(fields).find(test);
  return key === undefined ? undefined : fields[key];
}
/** The first value of a Podio field: lists (email, phone, app, category) give their first. */
const firstOf = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v);
const podioText = (v: unknown): string | undefined => {
  const one = firstOf(v);
  if (one && typeof one === "object") {
    const o = one as { title?: unknown; name?: unknown };
    return str(o.title) ?? str(o.name);
  }
  return plain(one);
};

/** A Podio item (as `podio.item.filter` returns it) as an import row, by its fields' names. */
// DECISION: Podio apps have no fixed contact fields, so fields are found by external id: one
// containing "email", one containing "phone" or "mobile", "company"/"organization"/"account",
// "title"/"position", "notes". The name is a `name` field, else the item's title.
export function rowFromPodio(
  item: { itemId: number; title: string | null; fields: Record<string, unknown> },
  kind: DirectoryImportKind,
  row: number,
): ParsedImportRow<PersonImportRow | OrganizationImportRow> {
  const f = item.fields;
  const has =
    (...words: string[]) =>
    (key: string) =>
      words.some((w) => key.includes(w));
  const email = podioText(podioField(f, has("email")))?.toLowerCase();
  const phone = podioText(podioField(f, has("phone", "mobile")));
  const notes = podioText(podioField(f, has("notes", "note", "description")));
  const external = String(item.itemId);
  if (kind === "people") {
    return check(PersonImportRow, row, {
      name:
        podioText(podioField(f, (k) => k === "name" || k === "full-name")) ??
        str(item.title) ??
        undefined,
      email,
      phone,
      title: podioText(podioField(f, (k) => k === "job-title" || k === "position")),
      organization: podioText(podioField(f, has("company", "organization", "organisation"))),
      notes,
      externalId: external,
    });
  }
  const k = kindsFrom(podioText(podioField(f, has("type", "kind", "category"))));
  return check(OrganizationImportRow, row, {
    name:
      podioText(podioField(f, (key) => key === "name" || key === "company-name")) ??
      str(item.title),
    kinds: k.kinds.length ? k.kinds : undefined,
    website: podioText(podioField(f, has("website", "url"))),
    email,
    phone,
    notes,
    externalId: external,
  });
}
