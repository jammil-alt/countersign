// Importing into a client's directory (docs/plan.md §1.27): a CSV of people or organizations, or
// the contacts and accounts a connected Zoho CRM or Podio reads. Each is previewed first: what
// every row would do (add, update the entry it matches, nothing, or an error) and what it would
// change. Applying runs the chosen rows, each on its own (a savepoint), with a result per row.
// Rows from a connected tool are suggestions until the client admin or the operator applies them;
// after that they are matched by their id there (`external_refs`).

import { toConnectionRef } from "@countersign/agents";
import {
  CsvError,
  noopLogger,
  PODIO_CONNECTOR_ID,
  PODIO_TOOLS,
  QBO_CONNECTOR_ID,
  type PodioItem,
  parseCsv,
  runReadTool,
  ZOHO_CRM_CONNECTOR_ID,
  ZOHO_TOOLS,
  type ZohoRecord,
} from "@countersign/connectors";
import {
  type ConnectorPreviewBody,
  type ContactPatchInput,
  type DirectoryImportKind,
  directoryRowsFromCsv,
  type ImportApplyBody,
  type ImportPreview,
  type ImportPreviewRow,
  type ImportResult,
  type ImportResultRow,
  type ImportSource,
  normalizePhone,
  type OrganizationImportRow,
  type OrganizationKind,
  type OrganizationPatchInput,
  type ParsedImportRow,
  type PersonImportRow,
  QBO_DIRECTORY_ENTITIES,
  type QboDirectoryEntity,
  type Relationship,
  rowFromPodio,
  rowFromQbo,
  rowFromZoho,
} from "@countersign/core";
import { connection, contact, organization, rawRecord, type Tx } from "@countersign/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { z } from "zod";
import type { Bindings } from "../env";
import { HttpError, notFound } from "../http";
import { type ContactRow, createContact, updateContact } from "../messaging/contacts";
import type { Platform } from "../platform";
import { connectionCredentials } from "../secrets";
import { createOrganization, updateOrganization } from "./organizations";

type OrganizationRow = typeof organization.$inferSelect;
type Row = PersonImportRow | OrganizationImportRow;
type ChangeList = ImportPreviewRow["changes"];

// ── Reading the rows ────────────────────────────────────────────────────────────────────────────

export function rowsFromCsv(kind: DirectoryImportKind, csv: string): ParsedImportRow<Row>[] {
  let cells: string[][];
  try {
    cells = parseCsv(csv);
  } catch (error) {
    if (error instanceof CsvError) throw new HttpError(422, "invalid_csv", error.message);
    throw error;
  }
  const { rows, missing } = directoryRowsFromCsv(cells, kind);
  if (missing.length) {
    throw new HttpError(422, "invalid_csv", `the file needs a column for: ${missing.join(", ")}`);
  }
  if (rows.length === 0) throw new HttpError(422, "invalid_csv", "the file has no rows");
  if (rows.length > 2000) throw new HttpError(422, "invalid_csv", "at most 2000 rows per file");
  return rows;
}

/** The client's connections the directory can import from: Zoho CRM and Podio, connected. */
export async function importSources(tx: Tx, tenantId: string): Promise<ImportSource[]> {
  const rows = await tx
    .select()
    .from(connection)
    .where(
      and(
        eq(connection.tenantId, tenantId),
        inArray(connection.connector, IMPORT_CONNECTORS),
        eq(connection.status, "connected"),
      ),
    );
  return rows.map((r) => {
    const config = (r.config ?? {}) as { orgName?: unknown; companyName?: unknown };
    // v0.12 W1-G: QuickBooks, named by its company.
    if (r.connector === QBO_CONNECTOR_ID) {
      return {
        connectionId: r.id,
        connector: r.connector,
        label:
          typeof config.companyName === "string"
            ? `QuickBooks: ${config.companyName}`
            : "QuickBooks",
        status: r.status,
      };
    }
    const name = r.connector === ZOHO_CRM_CONNECTOR_ID ? "Zoho CRM" : "Podio";
    return {
      connectionId: r.id,
      connector: r.connector,
      label: typeof config.orgName === "string" ? `${name}: ${config.orgName}` : name,
      status: r.status,
    };
  });
}

const CONNECTOR_READ_MAX = 200;

/** Reads people or organizations through the connection's own read tools. */
// DECISION: a person's import reads through the connector's read tools as an agent would, on the
// client's own connection, so its matrix (read off: refused) and the connector's checks apply.
// Zoho CRM is searched by a word (its search needs one), Contacts for people and Accounts for
// organizations; Podio reads one app's items. At most 200 records per import.
export async function rowsFromConnector(
  tx: Tx,
  tenantId: string,
  input: z.output<typeof ConnectorPreviewBody>,
  deps: { platform: Platform; env: Bindings },
): Promise<{ source: string; rows: ParsedImportRow<Row>[]; more: boolean }> {
  const [row] = await tx
    .select()
    .from(connection)
    .where(and(eq(connection.id, input.connectionId), eq(connection.tenantId, tenantId)));
  if (!row) throw notFound("connection");
  // v0.12 W1-G: QuickBooks vendors and customers, from what was synced (docs/plan.md §1.42).
  if (row.connector === QBO_CONNECTOR_ID) {
    if (row.status !== "connected") {
      throw new HttpError(409, "not_connected", "connect it again first");
    }
    return rowsFromQbo(tx, tenantId, row.id, input);
  }
  const connector = deps.platform.connectors.get(row.connector);
  if (!connector || ![ZOHO_CRM_CONNECTOR_ID, PODIO_CONNECTOR_ID].includes(row.connector)) {
    throw new HttpError(
      422,
      "not_importable",
      "the directory imports from Zoho CRM, Podio or QuickBooks",
    );
  }
  if (row.status !== "connected") {
    throw new HttpError(409, "not_connected", "connect it again first");
  }
  const ctx = {
    tenantId,
    connection: toConnectionRef(row),
    credentials: await connectionCredentials(tx, deps.env, row),
    logger: noopLogger,
    now: () => new Date(),
  };
  try {
    if (row.connector === ZOHO_CRM_CONNECTOR_ID) {
      if (!input.query) {
        throw new HttpError(422, "invalid_request", "give a word to search Zoho CRM for");
      }
      const module = input.kind === "people" ? "Contacts" : "Accounts";
      const out = (
        await runReadTool(
          connector,
          ZOHO_TOOLS.search,
          { module, word: input.query, perPage: CONNECTOR_READ_MAX },
          ctx,
        )
      ).output as { records: ZohoRecord[]; moreRecords: boolean };
      return {
        source: ZOHO_CRM_CONNECTOR_ID,
        rows: out.records.map((r, i) => rowFromZoho(r, input.kind, i + 1)),
        more: out.moreRecords,
      };
    }
    if (!input.appId) throw new HttpError(422, "invalid_request", "choose the Podio app");
    const out = (
      await runReadTool(
        connector,
        PODIO_TOOLS.filter,
        { appId: input.appId, limit: 100, offset: 0 },
        ctx,
      )
    ).output as { filtered: number; items: PodioItem[] };
    return {
      source: PODIO_CONNECTOR_ID,
      rows: out.items.map((item, i) => rowFromPodio(item, input.kind, i + 1)),
      more: out.filtered > out.items.length,
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new HttpError(502, "connector_failed", `the connected tool didn't answer: ${message}`);
  }
}

// ── v0.12 W1-G: QuickBooks (docs/plan.md §1.42) ─────────────────────────────────────────────────

const IMPORT_CONNECTORS = [ZOHO_CRM_CONNECTOR_ID, PODIO_CONNECTOR_ID, QBO_CONNECTOR_ID];
const QBO_IMPORT_MAX = 2000;

/**
 * The connection's synced vendors and customers (the latest raw version of each, active and not
 * deleted) as organization rows, optionally those whose name contains `query`. Read from what
 * sync stored, so nothing is asked of QuickBooks and its read permission was already applied.
 */
// DECISION: QuickBooks rows come from synced raw records rather than a live query: sync already
// keeps every vendor (and, after W1-F, every customer), and a preview must not spend the client's
// API limits. Customers appear once W1-F syncs them; until then a QuickBooks import is vendors.
async function rowsFromQbo(
  tx: Tx,
  tenantId: string,
  connectionId: string,
  input: z.output<typeof ConnectorPreviewBody>,
): Promise<{ source: string; rows: ParsedImportRow<Row>[]; more: boolean }> {
  if (input.kind !== "organizations") {
    throw new HttpError(
      422,
      "not_importable",
      "QuickBooks gives vendors and customers: import them as organizations",
    );
  }
  const entities = Object.keys(QBO_DIRECTORY_ENTITIES) as QboDirectoryEntity[];
  const raw = await tx
    .select({
      entityType: rawRecord.entityType,
      externalId: rawRecord.externalId,
      payload: rawRecord.payload,
      isDeleted: rawRecord.isDeleted,
    })
    .from(rawRecord)
    .where(
      and(
        eq(rawRecord.tenantId, tenantId),
        eq(rawRecord.connectionId, connectionId),
        inArray(rawRecord.entityType, entities),
      ),
    )
    .orderBy(rawRecord.entityType, rawRecord.externalId, desc(rawRecord.syncedAt));
  const latest = new Map<string, (typeof raw)[number]>();
  for (const r of raw) {
    const key = `${r.entityType}:${r.externalId}`;
    if (!latest.has(key)) latest.set(key, r);
  }
  const word = input.query?.toLowerCase();
  const kept = [...latest.values()].filter((r) => {
    const p = (r.payload ?? {}) as Record<string, unknown>;
    if (r.isDeleted || p.Active === false) return false;
    if (!word) return true;
    return [p.DisplayName, p.CompanyName].some(
      (v) => typeof v === "string" && v.toLowerCase().includes(word),
    );
  });
  return {
    source: QBO_CONNECTOR_ID,
    rows: kept
      .slice(0, QBO_IMPORT_MAX)
      .map((r, i) =>
        rowFromQbo(
          r.entityType as QboDirectoryEntity,
          (r.payload ?? {}) as Record<string, unknown>,
          i + 1,
        ),
      ),
    more: kept.length > QBO_IMPORT_MAX,
  };
}

// ── Matching ────────────────────────────────────────────────────────────────────────────────────

interface Directory {
  people: ContactRow[];
  organizations: OrganizationRow[];
}

async function loadDirectory(tx: Tx, tenantId: string): Promise<Directory> {
  const [people, organizations] = await Promise.all([
    tx.select().from(contact).where(eq(contact.tenantId, tenantId)),
    tx.select().from(organization).where(eq(organization.tenantId, tenantId)),
  ]);
  return { people, organizations };
}

const lower = (s: string) => s.trim().toLowerCase();

function findPerson(
  dir: Directory,
  source: string,
  row: PersonImportRow,
  phone: string | null,
): { row: ContactRow; by: string } | null {
  if (row.externalId) {
    const m = dir.people.find((p) => p.externalRefs?.[source] === row.externalId);
    if (m) return { row: m, by: "external_id" };
  }
  if (row.email) {
    const m = dir.people.find((p) => p.email === row.email);
    if (m) return { row: m, by: "email" };
  }
  if (phone) {
    const m = dir.people.find((p) => p.phone === phone || p.whatsapp === phone);
    if (m) return { row: m, by: "phone" };
  }
  return null;
}

function findOrganization(
  dir: Directory,
  source: string,
  row: { name: string; externalId?: string | undefined },
): { row: OrganizationRow; by: string } | null {
  if (row.externalId) {
    const m = dir.organizations.find((o) => o.externalRefs?.[source] === row.externalId);
    if (m) return { row: m, by: "external_id" };
  }
  const m = dir.organizations.find((o) => lower(o.name) === lower(row.name));
  return m ? { row: m, by: "name" } : null;
}

/** A relationship's matching organization kind, for an organization a person's row adds. */
const KIND_FOR: Partial<Record<Relationship, OrganizationKind>> = {
  vendor: "vendor",
  customer: "customer",
  partner: "partner",
  employee: "own",
};

interface PlannedRow {
  row: number;
  action: ImportPreviewRow["action"];
  data: Row | null;
  match: { id: string; name: string; by: string } | null;
  changes: ChangeList;
  changesAddress: boolean;
  problems: string[];
  /** For a person: the patch or the new contact's fields. */
  person?: { patch: Record<string, unknown>; phone: string | null; whatsapp: string | null };
  organizationPatch?: Record<string, unknown>;
}

function diff(
  current: Record<string, unknown> | null,
  wanted: Record<string, unknown>,
): { changes: ChangeList; patch: Record<string, unknown> } {
  const changes: ChangeList = [];
  const patch: Record<string, unknown> = {};
  for (const [field, after] of Object.entries(wanted)) {
    if (after === undefined) continue;
    const before = current ? (current[field] ?? null) : null;
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    changes.push({ field, before, after });
    patch[field] = after;
  }
  return { changes, patch };
}

function planPerson(
  dir: Directory,
  source: string,
  parsed: ParsedImportRow<PersonImportRow>,
): PlannedRow {
  const base = {
    row: parsed.row,
    data: parsed.data,
    match: null,
    changes: [],
    changesAddress: false,
  };
  const r = parsed.data;
  if (!r) return { ...base, action: "error", problems: parsed.problems };
  const problems: string[] = [];
  const phone = r.phone ? normalizePhone(r.phone) : null;
  const whatsapp = r.whatsapp ? normalizePhone(r.whatsapp) : null;
  if (r.phone && !phone) problems.push("phone: give it in international form, e.g. +15551234567");
  if (r.whatsapp && !whatsapp) {
    problems.push("whatsapp: give it in international form, e.g. +15551234567");
  }
  if (problems.length) return { ...base, action: "error", problems };
  const found = findPerson(dir, source, r, phone);
  const org = r.organization ? findOrganization(dir, source, { name: r.organization }) : null;
  const wanted: Record<string, unknown> = {
    name: r.name,
    email: r.email,
    phone: phone ?? undefined,
    whatsapp: whatsapp ?? undefined,
    title: r.title,
    relationship: r.relationship,
    language: r.language,
    notes: r.notes,
    roles: r.roles,
  };
  if (!found) {
    if (!r.email && !phone && !whatsapp) {
      return {
        ...base,
        action: "error",
        problems: ["give an email address, a phone or a WhatsApp number"],
      };
    }
    // Another row's address taken by someone else is caught when it is applied.
    const { changes, patch } = diff(null, {
      ...wanted,
      ...(r.organization ? { organization: org ? org.row.name : `${r.organization} (new)` } : {}),
    });
    return {
      ...base,
      action: "add",
      changes,
      problems: [],
      person: { patch, phone, whatsapp },
    };
  }
  const current = found.row as unknown as Record<string, unknown>;
  // Roles are added to, never replaced.
  if (r.roles) wanted.roles = [...new Set([...(found.row.roles ?? []), ...r.roles])];
  const { changes, patch } = diff(current, wanted);
  if (r.organization && (!org || org.row.id !== found.row.organizationId)) {
    changes.push({
      field: "organization",
      before: dir.organizations.find((o) => o.id === found.row.organizationId)?.name ?? null,
      after: org ? org.row.name : `${r.organization} (new)`,
    });
  }
  const changesAddress = ["email", "phone", "whatsapp", "language"].some((f) => f in patch);
  const newRef =
    r.externalId && found.row.externalRefs?.[source] !== r.externalId ? r.externalId : null;
  return {
    ...base,
    action: changes.length ? "update" : newRef ? "update" : "same",
    match: { id: found.row.id, name: found.row.name, by: found.by },
    changes,
    changesAddress,
    problems: [],
    person: { patch, phone, whatsapp },
  };
}

function planOrganization(
  dir: Directory,
  source: string,
  parsed: ParsedImportRow<OrganizationImportRow>,
): PlannedRow {
  const base = { row: parsed.row, data: parsed.data, match: null, changes: [] };
  const r = parsed.data;
  if (!r) return { ...base, action: "error", problems: parsed.problems, changesAddress: false };
  const found = findOrganization(dir, source, r);
  const wanted: Record<string, unknown> = {
    name: r.name,
    website: r.website,
    email: r.email,
    phone: r.phone,
    address: r.address,
    language: r.language,
    notes: r.notes,
  };
  if (!found) {
    const { changes, patch } = diff(null, { ...wanted, kinds: r.kinds });
    return {
      ...base,
      action: "add",
      changes,
      changesAddress: false,
      problems: [],
      organizationPatch: patch,
    };
  }
  // Kinds are added to, never replaced.
  if (r.kinds) wanted.kinds = [...new Set([...(found.row.kinds ?? []), ...r.kinds])];
  const { changes, patch } = diff(found.row as unknown as Record<string, unknown>, wanted);
  const newRef =
    r.externalId && found.row.externalRefs?.[source] !== r.externalId ? r.externalId : null;
  return {
    ...base,
    action: changes.length || newRef ? "update" : "same",
    match: { id: found.row.id, name: found.row.name, by: found.by },
    changes,
    // An organization's language is its people's when they have none of their own.
    changesAddress: "language" in patch,
    problems: [],
    organizationPatch: patch,
  };
}

function plan(
  dir: Directory,
  kind: DirectoryImportKind,
  source: string,
  rows: ParsedImportRow<Row>[],
): PlannedRow[] {
  return rows.map((r) =>
    kind === "people"
      ? planPerson(dir, source, r as ParsedImportRow<PersonImportRow>)
      : planOrganization(dir, source, r as ParsedImportRow<OrganizationImportRow>),
  );
}

export async function preview(
  tx: Tx,
  tenantId: string,
  kind: DirectoryImportKind,
  source: string,
  rows: ParsedImportRow<Row>[],
  more = false,
): Promise<ImportPreview> {
  const planned = plan(await loadDirectory(tx, tenantId), kind, source, rows);
  const counts = { add: 0, update: 0, same: 0, error: 0 };
  for (const p of planned) counts[p.action]++;
  return {
    kind,
    source,
    more,
    counts,
    rows: planned.map((p) => ({
      row: p.row,
      action: p.action,
      data: p.data,
      match: p.match,
      changes: p.changes,
      changesAddress: p.changesAddress,
      problems: p.problems,
    })),
  };
}

// ── Applying ────────────────────────────────────────────────────────────────────────────────────

function problemOf(error: unknown): string {
  if (error instanceof HttpError) return error.message;
  return "this row couldn't be saved";
}

/** The organization a person's row names: found by name, or added (from this import). */
async function organizationFor(
  tx: Tx,
  tenantId: string,
  dir: Directory,
  name: string,
  relationship: Relationship | undefined,
  source: string,
  actorId: string,
): Promise<{ id: string; made: OrganizationRow | null }> {
  const found = dir.organizations.find((o) => lower(o.name) === lower(name));
  if (found) return { id: found.id, made: null };
  const kind = relationship ? KIND_FOR[relationship] : undefined;
  const row = await createOrganization(
    tx,
    tenantId,
    { name, ...(kind ? { kinds: [kind] } : {}) },
    actorId,
    { source },
  );
  return { id: row.id, made: row };
}

/** Runs the chosen rows, each in its own savepoint so one bad row doesn't stop the rest. */
export async function applyImport(
  tx: Tx,
  tenantId: string,
  body: z.output<typeof ImportApplyBody>,
  rows: ParsedImportRow<Row>[],
  source: string,
  actorId: string,
): Promise<ImportResult> {
  const dir = await loadDirectory(tx, tenantId);
  const chosen = body.source === "csv" && body.rows ? new Set(body.rows) : null;
  const planned = plan(dir, body.kind, source, rows);
  const results: ImportResultRow[] = [];
  const now = new Date();
  for (const p of planned) {
    const name = p.data?.name ?? null;
    if (chosen && !chosen.has(p.row)) {
      results.push({ row: p.row, status: "skipped", id: p.match?.id ?? null, name, problem: null });
      continue;
    }
    if (p.action === "error" || !p.data) {
      results.push({
        row: p.row,
        status: "failed",
        id: null,
        name,
        problem: p.problems.join("; ") || "this row couldn't be read",
      });
      continue;
    }
    if (p.action === "same") {
      results.push({
        row: p.row,
        status: "unchanged",
        id: p.match?.id ?? null,
        name,
        problem: null,
      });
      continue;
    }
    const refs = p.data.externalId ? { [source]: p.data.externalId } : undefined;
    const log = { import: source, row: p.row };
    // Entries made in this row join the directory only once the row is saved.
    const madeOrgs: OrganizationRow[] = [];
    try {
      const id = await tx.transaction(async (sp) => {
        if (body.kind === "people") {
          const r = p.data as PersonImportRow;
          const org = r.organization
            ? await organizationFor(
                sp,
                tenantId,
                dir,
                r.organization,
                r.relationship,
                source,
                actorId,
              )
            : null;
          const organizationId = org?.id;
          if (org?.made) madeOrgs.push(org.made);
          const patch = { ...(p.person?.patch ?? {}) };
          delete patch.organization;
          if (p.match) {
            const updated = await updateContact(
              sp,
              tenantId,
              p.match.id,
              {
                ...(patch as ContactPatchInput),
                ...(organizationId ? { organizationId } : {}),
              },
              actorId,
              { log, ...(refs ? { externalRefs: refs } : {}) },
            );
            return updated.id;
          }
          const made = await createContact(
            sp,
            tenantId,
            {
              name: r.name,
              ...(r.email ? { email: r.email } : {}),
              ...(p.person?.phone ? { phone: p.person.phone } : {}),
              ...(p.person?.whatsapp ? { whatsapp: p.person.whatsapp } : {}),
              ...(r.title ? { title: r.title } : {}),
              ...(r.relationship ? { relationship: r.relationship } : {}),
              ...(r.roles ? { roles: r.roles } : {}),
              ...(r.language ? { language: r.language } : {}),
              ...(r.notes ? { notes: r.notes } : {}),
              ...(organizationId ? { organizationId } : {}),
            },
            actorId,
            now,
            { source, ...(refs ? { externalRefs: refs } : {}), log },
          );
          return made.id;
        }
        const r = p.data as OrganizationImportRow;
        if (p.match) {
          const patch = p.organizationPatch ?? {};
          const updated = await updateOrganization(
            sp,
            tenantId,
            p.match.id,
            patch as OrganizationPatchInput,
            actorId,
            {
              log,
              autoLinkVendor: true,
              ...(refs ? { externalRefs: refs } : {}),
            },
          );
          return updated.id;
        }
        const made = await createOrganization(
          sp,
          tenantId,
          {
            name: r.name,
            ...(r.kinds ? { kinds: r.kinds } : {}),
            ...(r.website ? { website: r.website } : {}),
            ...(r.email ? { email: r.email } : {}),
            ...(r.phone ? { phone: r.phone } : {}),
            ...(r.address ? { address: r.address } : {}),
            ...(r.language ? { language: r.language } : {}),
            ...(r.notes ? { notes: r.notes } : {}),
          },
          actorId,
          { source, ...(refs ? { externalRefs: refs } : {}), log },
        );
        madeOrgs.push(made);
        return made.id;
      });
      dir.organizations.push(...madeOrgs);
      results.push({
        row: p.row,
        status: p.match ? "updated" : "added",
        id,
        name,
        problem: null,
      });
    } catch (error) {
      if (!(error instanceof HttpError)) console.warn("directory import row failed", error);
      results.push({ row: p.row, status: "failed", id: null, name, problem: problemOf(error) });
    }
  }
  const counts = { added: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 };
  for (const r of results) counts[r.status]++;
  return { results, counts };
}
