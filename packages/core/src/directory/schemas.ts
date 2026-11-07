// The directory (docs/plan.md §1.27): one per client, of the people and organizations its agents
// work with. People are the client's contacts (§1.22, §1.25) with an organization, a title and a
// relationship; organizations are new. These are the shapes the API, the agent tools and the
// screens share: organizations, search, an agent's suggestion, and import rows (CSV, Zoho CRM,
// Podio). Everything in them that people or connected tools wrote is data, never instructions.

import { z } from "zod";
import { EmailAddress } from "../api/messaging";
import { Locale } from "../i18n/locale";
import { isUuid } from "../ids";
import { RoleName } from "../reach/rules";
import {
  DIRECTORY_TITLE_MAX,
  DirectorySource,
  ORGANIZATION_KINDS,
  ORGANIZATION_NAME_MAX,
  OrganizationKind,
  Relationship,
} from "./kinds";
import { LanguageSource, LanguageUsed } from "./language";

const Id = z.string().refine((v) => isUuid(v), "not an id");

export const ORGANIZATION_NOTES_MAX = 2000;
export const PERSON_NAME_MAX = 120;
export const DIRECTORY_QUERY_MAX = 200;
export const DIRECTORY_LIMIT_MAX = 50;
export const SUGGESTION_REASON_MAX = 500;

/** A website as typed; `https://` is added when no scheme is given. */
export const Website = z
  .string()
  .trim()
  .min(3)
  .max(300)
  .transform((v) => (/^https?:\/\//i.test(v) ? v : `https://${v}`))
  .refine(
    (v) => /^https?:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{1,5})?([/?#]\S*)?$/i.test(v),
    "a website like example.com",
  );

export const OrganizationAddress = z.strictObject({
  line1: z.string().trim().max(200).optional(),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().max(100).optional(),
  region: z.string().trim().max(100).optional(),
  postalCode: z.string().trim().max(20).optional(),
  country: z.string().trim().max(100).optional(),
});
export type OrganizationAddress = z.infer<typeof OrganizationAddress>;

/** A phone as typed; people's phones must be E.164, an organization's may stay as written. */
const PhoneText = z.string().trim().min(3).max(40);
const Kinds = z.array(OrganizationKind).max(ORGANIZATION_KINDS.length);
/** Ids in connected tools, by connector: `{ zoho_crm: "4150868000000224005" }`. */
export const ExternalRefs = z.record(
  z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  z.string().min(1).max(100),
);
export type ExternalRefs = z.infer<typeof ExternalRefs>;

// ── Organizations ───────────────────────────────────────────────────────────────────────────────

export const OrganizationCreate = z.strictObject({
  name: z.string().trim().min(1).max(ORGANIZATION_NAME_MAX),
  kinds: Kinds.optional(),
  website: Website.optional(),
  email: EmailAddress.optional(),
  phone: PhoneText.optional(),
  address: OrganizationAddress.optional(),
  /** The language to write to its people in when they have none of their own. */
  language: Locale.optional(),
  notes: z.string().trim().max(ORGANIZATION_NOTES_MAX).optional(),
});
export type OrganizationCreateInput = z.input<typeof OrganizationCreate>;

export const OrganizationPatch = z
  .strictObject({
    name: z.string().trim().min(1).max(ORGANIZATION_NAME_MAX).optional(),
    kinds: Kinds.optional(),
    website: Website.nullable().optional(),
    email: EmailAddress.nullable().optional(),
    phone: PhoneText.nullable().optional(),
    address: OrganizationAddress.nullable().optional(),
    language: Locale.nullable().optional(),
    notes: z.string().trim().max(ORGANIZATION_NOTES_MAX).nullable().optional(),
  })
  .refine((p) => Object.keys(p).length > 0, "change at least one field");
export type OrganizationPatchInput = z.input<typeof OrganizationPatch>;

export const Organization = z.object({
  id: z.string(),
  name: z.string(),
  kinds: z.array(OrganizationKind),
  website: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  address: OrganizationAddress.nullable(),
  /** Its own language, or null. */
  language: z.string().nullable(),
  /** What its people without a language of their own get: its own, else yours. */
  languageUsed: LanguageUsed,
  notes: z.string().nullable(),
  externalRefs: ExternalRefs,
  /** The `vendor` record this organization is, with its name. */
  vendor: z.object({ id: z.string(), name: z.string() }).nullable(),
  source: z.string(),
  /** How many people of the directory belong to it. */
  people: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Organization = z.infer<typeof Organization>;

// ── Search ──────────────────────────────────────────────────────────────────────────────────────

export const DirectoryEntryType = z.enum(["person", "organization"]);
export type DirectoryEntryType = z.infer<typeof DirectoryEntryType>;

/**
 * What to look for: words matched against names, email addresses, phone numbers (by digits),
 * titles, organizations and roles; and filters. Both agents (`directory.search`) and the screens
 * use it.
 */
export const DirectorySearchInput = z.object({
  query: z.string().trim().max(DIRECTORY_QUERY_MAX).optional(),
  type: DirectoryEntryType.optional(),
  relationship: Relationship.optional(),
  kind: OrganizationKind.optional(),
  role: RoleName.optional(),
  organizationId: Id.optional(),
  limit: z.number().int().min(1).max(DIRECTORY_LIMIT_MAX).default(10),
});
export type DirectorySearchInput = z.infer<typeof DirectorySearchInput>;
export type DirectorySearchInputIn = z.input<typeof DirectorySearchInput>;

/** A person as an agent reads them: who they are and how to reach them, never consent details. */
export const DirectoryPersonHit = z.object({
  type: z.literal("person"),
  /** The contact id: what reach out's `to: { contactId }` takes. */
  id: z.string(),
  name: z.string(),
  title: z.string().nullable(),
  relationship: Relationship.nullable(),
  organization: z
    .object({ id: z.string(), name: z.string(), language: z.string().nullable() })
    .nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  whatsapp: z.string().nullable(),
  roles: z.array(z.string()),
  /** The language to write to them in: theirs, else their organization's, else the client's. */
  language: Locale,
  /** Where that language came from. */
  languageFrom: LanguageSource,
  /** Opted out of every channel: never reached, whatever an agent wants. */
  optedOut: z.boolean(),
  score: z.number(),
});
export type DirectoryPersonHit = z.infer<typeof DirectoryPersonHit>;

export const DirectoryOrganizationHit = z.object({
  type: z.literal("organization"),
  id: z.string(),
  name: z.string(),
  kinds: z.array(OrganizationKind),
  website: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  /** Its own language, or null (its people then get the client's). */
  language: z.string().nullable(),
  vendorId: z.string().nullable(),
  people: z.number().int(),
  score: z.number(),
});
export type DirectoryOrganizationHit = z.infer<typeof DirectoryOrganizationHit>;

export const DirectoryHit = z.discriminatedUnion("type", [
  DirectoryPersonHit,
  DirectoryOrganizationHit,
]);
export type DirectoryHit = z.infer<typeof DirectoryHit>;

export const DirectorySearchOutput = z.object({
  query: z.string(),
  count: z.number().int(),
  results: z.array(DirectoryHit),
  /** The record ids found (contacts and organizations), for steps that cite their evidence. */
  sources: z.array(z.string()),
});
export type DirectorySearchOutput = z.infer<typeof DirectorySearchOutput>;

export const DirectoryGetInput = z.object({
  type: DirectoryEntryType,
  id: Id,
});
export type DirectoryGetInput = z.infer<typeof DirectoryGetInput>;

/** One entry in full: a person with notes, or an organization with its people. */
export const DirectoryGetOutput = z.object({
  found: z.boolean(),
  person: DirectoryPersonHit.omit({ score: true })
    .extend({
      notes: z.string().nullable(),
      timezone: z.string().nullable(),
      preferredChannels: z.array(z.string()),
    })
    .nullable(),
  organization: DirectoryOrganizationHit.omit({ score: true })
    .extend({
      notes: z.string().nullable(),
      address: OrganizationAddress.nullable(),
      people: z.array(DirectoryPersonHit.omit({ score: true })),
    })
    .nullable(),
  sources: z.array(z.string()),
});
export type DirectoryGetOutput = z.infer<typeof DirectoryGetOutput>;

// ── Suggestions (agents propose, the client admin decides) ──────────────────────────────────────

/** A person's fields an agent may propose. Never consent or opt-outs: those stay as §1.22 says. */
export const SuggestedPerson = z.strictObject({
  name: z.string().trim().min(1).max(PERSON_NAME_MAX),
  email: EmailAddress.optional(),
  phone: PhoneText.optional(),
  whatsapp: PhoneText.optional(),
  title: z.string().trim().min(1).max(DIRECTORY_TITLE_MAX).optional(),
  relationship: Relationship.optional(),
  /** An organization already in the directory. */
  organizationId: Id.optional(),
  roles: z.array(RoleName).max(10).optional(),
  language: Locale.optional(),
  notes: z.string().trim().max(2000).optional(),
});
export type SuggestedPerson = z.infer<typeof SuggestedPerson>;

export const SuggestedOrganization = z.strictObject({
  name: z.string().trim().min(1).max(ORGANIZATION_NAME_MAX),
  kinds: Kinds.optional(),
  website: Website.optional(),
  email: EmailAddress.optional(),
  phone: PhoneText.optional(),
  language: Locale.optional(),
  notes: z.string().trim().max(ORGANIZATION_NOTES_MAX).optional(),
});
export type SuggestedOrganization = z.infer<typeof SuggestedOrganization>;

const nonEmpty = (v: Record<string, unknown>) => Object.keys(v).length > 0;

export const DirectorySuggestionChange = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("add_person"), person: SuggestedPerson }),
  z.strictObject({
    action: z.literal("update_person"),
    contactId: Id,
    changes: SuggestedPerson.partial().refine(nonEmpty, "suggest at least one change"),
  }),
  z.strictObject({ action: z.literal("add_organization"), organization: SuggestedOrganization }),
  z.strictObject({
    action: z.literal("update_organization"),
    organizationId: Id,
    changes: SuggestedOrganization.partial().refine(nonEmpty, "suggest at least one change"),
  }),
]);
export type DirectorySuggestionChange = z.infer<typeof DirectorySuggestionChange>;

/** What `directory.suggest` takes: one change, why, and the records that show it. */
export const DirectorySuggestInput = z.object({
  suggestion: DirectorySuggestionChange,
  reason: z.string().trim().min(1).max(SUGGESTION_REASON_MAX),
  sources: z.array(z.string().min(1).max(100)).max(20).default([]),
});
export type DirectorySuggestInput = z.infer<typeof DirectorySuggestInput>;
export type DirectorySuggestInputIn = z.input<typeof DirectorySuggestInput>;

export const DirectorySuggestOutput = z.object({
  /** `suggested`: waiting for the client admin; `duplicate`: the same change is already waiting; `test_run`: nothing made. */
  status: z.enum(["suggested", "duplicate", "test_run"]),
  inboxItemId: z.string().nullable(),
  /** Whether accepting it would change where messages go (an email or a phone). */
  changesAddress: z.boolean(),
});
export type DirectorySuggestOutput = z.infer<typeof DirectorySuggestOutput>;

/**
 * Whether a change would change where or how messages reach people: a person's email, phone,
 * WhatsApp number or language, or an organization's language (its people's, when they have none).
 */
export function suggestionChangesAddress(change: DirectorySuggestionChange): boolean {
  if (change.action === "update_organization") return change.changes.language !== undefined;
  if (change.action !== "update_person") return false;
  return (
    change.changes.email !== undefined ||
    change.changes.phone !== undefined ||
    change.changes.whatsapp !== undefined ||
    change.changes.language !== undefined
  );
}

/** A suggestion as the inbox and the directory's screens show it. */
export const DirectorySuggestion = z.object({
  /** The inbox item's id. */
  id: z.string(),
  change: DirectorySuggestionChange,
  reason: z.string(),
  sources: z.array(z.string()),
  /** The entry it would change, as it is now (names only), or null for an addition. */
  target: z.object({ id: z.string(), name: z.string() }).nullable(),
  /** For an update: each field now and as suggested. */
  diff: z.array(
    z.object({ field: z.string(), before: z.unknown().nullable(), after: z.unknown().nullable() }),
  ),
  changesAddress: z.boolean(),
  agent: z.object({ id: z.string(), name: z.string() }).nullable(),
  status: z.enum(["open", "accepted", "declined", "expired"]),
  createdAt: z.string(),
});
export type DirectorySuggestion = z.infer<typeof DirectorySuggestion>;

/** The inbox item subject that marks a directory suggestion. */
export const DIRECTORY_SUGGESTION_SUBJECT = "directory_suggestion";

// ── Import (CSV, Zoho CRM, Podio) ───────────────────────────────────────────────────────────────

export const DirectoryImportKind = z.enum(["people", "organizations"]);
export type DirectoryImportKind = z.infer<typeof DirectoryImportKind>;

/** One person to import, as read from a file or a connected tool. */
export const PersonImportRow = z.strictObject({
  name: z.string().trim().min(1).max(PERSON_NAME_MAX),
  email: EmailAddress.optional(),
  phone: PhoneText.optional(),
  whatsapp: PhoneText.optional(),
  title: z.string().trim().min(1).max(DIRECTORY_TITLE_MAX).optional(),
  relationship: Relationship.optional(),
  /** The organization by name: found in the directory, or added. */
  organization: z.string().trim().min(1).max(ORGANIZATION_NAME_MAX).optional(),
  roles: z.array(RoleName).max(10).optional(),
  language: Locale.optional(),
  notes: z.string().trim().max(2000).optional(),
  /** The id in the connected tool it came from. */
  externalId: z.string().min(1).max(100).optional(),
});
export type PersonImportRow = z.infer<typeof PersonImportRow>;

export const OrganizationImportRow = z.strictObject({
  name: z.string().trim().min(1).max(ORGANIZATION_NAME_MAX),
  kinds: Kinds.optional(),
  website: Website.optional(),
  email: EmailAddress.optional(),
  phone: PhoneText.optional(),
  address: OrganizationAddress.optional(),
  language: Locale.optional(),
  notes: z.string().trim().max(ORGANIZATION_NOTES_MAX).optional(),
  externalId: z.string().min(1).max(100).optional(),
});
export type OrganizationImportRow = z.infer<typeof OrganizationImportRow>;

export const DIRECTORY_IMPORT_ROWS_MAX = 2000;
export const DIRECTORY_CSV_MAX = 1_000_000;

/** What applying a row would do: add an entry, update the one it matches, or nothing. */
export const ImportAction = z.enum(["add", "update", "same", "error"]);
export type ImportAction = z.infer<typeof ImportAction>;

export const ImportPreviewRow = z.object({
  /** 1-based, as the file numbers its data rows (the header is row 0). */
  row: z.number().int().min(1),
  action: ImportAction,
  /** The parsed row; absent when the row couldn't be read. */
  data: z.union([PersonImportRow, OrganizationImportRow]).nullable(),
  /** The entry it matches, by external id, email, phone or name. */
  match: z.object({ id: z.string(), name: z.string(), by: z.string() }).nullable(),
  /** For an update: the fields that would change. */
  changes: z.array(
    z.object({ field: z.string(), before: z.unknown().nullable(), after: z.unknown().nullable() }),
  ),
  /** Whether it would change an existing person's email, phone or language. */
  changesAddress: z.boolean(),
  problems: z.array(z.string()),
});
export type ImportPreviewRow = z.infer<typeof ImportPreviewRow>;

export const ImportPreview = z.object({
  kind: DirectoryImportKind,
  source: DirectorySource,
  rows: z.array(ImportPreviewRow),
  counts: z.object({
    add: z.number().int(),
    update: z.number().int(),
    same: z.number().int(),
    error: z.number().int(),
  }),
  /** For a connected tool: there were more records than one import reads. */
  more: z.boolean(),
});
export type ImportPreview = z.infer<typeof ImportPreview>;

export const CsvPreviewBody = z.strictObject({
  kind: DirectoryImportKind,
  csv: z.string().min(1).max(DIRECTORY_CSV_MAX),
});
export type CsvPreviewBody = z.input<typeof CsvPreviewBody>;

/** Read people or organizations from a connected Zoho CRM or Podio, as suggestions to accept. */
export const ConnectorPreviewBody = z.strictObject({
  connectionId: Id,
  kind: DirectoryImportKind,
  /** Zoho CRM: the word to search for (a name or company), at least two letters. */
  query: z.string().trim().min(2).max(200).optional(),
  /** Podio: the app whose items are people or organizations. */
  appId: z.number().int().positive().optional(),
});
export type ConnectorPreviewBody = z.input<typeof ConnectorPreviewBody>;

/** Apply chosen rows: CSV rows by number from the same file, or rows a connector preview gave. */
export const ImportApplyBody = z.discriminatedUnion("source", [
  z.strictObject({
    source: z.literal("csv"),
    kind: DirectoryImportKind,
    csv: z.string().min(1).max(DIRECTORY_CSV_MAX),
    /** The rows to apply; absent: every row that would add or update. */
    rows: z.array(z.number().int().min(1)).max(DIRECTORY_IMPORT_ROWS_MAX).optional(),
  }),
  z.strictObject({
    source: z.literal("connector"),
    kind: DirectoryImportKind,
    connectionId: Id,
    people: z.array(PersonImportRow).max(DIRECTORY_IMPORT_ROWS_MAX).optional(),
    organizations: z.array(OrganizationImportRow).max(DIRECTORY_IMPORT_ROWS_MAX).optional(),
  }),
]);
export type ImportApplyBody = z.input<typeof ImportApplyBody>;

export const ImportResultRow = z.object({
  row: z.number().int().min(1),
  status: z.enum(["added", "updated", "unchanged", "skipped", "failed"]),
  id: z.string().nullable(),
  name: z.string().nullable(),
  problem: z.string().nullable(),
});
export type ImportResultRow = z.infer<typeof ImportResultRow>;

export const ImportResult = z.object({
  results: z.array(ImportResultRow),
  counts: z.object({
    added: z.number().int(),
    updated: z.number().int(),
    unchanged: z.number().int(),
    skipped: z.number().int(),
    failed: z.number().int(),
  }),
});
export type ImportResult = z.infer<typeof ImportResult>;

/** A connection the directory can import from. */
export const ImportSource = z.object({
  connectionId: z.string(),
  connector: z.string(),
  label: z.string(),
  status: z.string(),
});
export type ImportSource = z.infer<typeof ImportSource>;
