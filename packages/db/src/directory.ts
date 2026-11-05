// Reading a client's directory (docs/plan.md §1.27): people (contacts with their organization) and
// organizations, filtered in SQL and ranked by core's search. Used by apps/api's screens and by
// the agent tools' port in packages/agents (`directory.search`, `directory.get`). Every query runs
// in the caller's client-scoped transaction and also filters by tenant_id (invariant 1).

import {
  clientLanguage,
  type DirectoryGetInput,
  type DirectoryGetOutput,
  type DirectoryOrganizationHit,
  type DirectoryPersonHit,
  type DirectorySearchInput,
  type DirectorySearchOutput,
  languageFor,
  type OrganizationKind,
  type Relationship,
  rankEntries,
} from "@countersign/core";
import { and, asc, count, eq, inArray, type SQL, sql } from "drizzle-orm";
import type { Tx } from "./client";
import { contact, organization, tenant, vendor } from "./schema";

export type ContactRow = typeof contact.$inferSelect;
export type OrganizationRow = typeof organization.$inferSelect;

/** The most rows one client's directory is read with; search ranks within them. */
// DECISION: a client's directory is read whole (up to 5000 people and 5000 organizations) and
// ranked in code with core's search, the same for agents and screens. Directories are hundreds
// of entries; a database index for words can come when one isn't.
export const DIRECTORY_READ_MAX = 5000;

export interface DirectoryFilters {
  relationship?: Relationship | undefined;
  role?: string | undefined;
  organizationId?: string | undefined;
  kind?: OrganizationKind | undefined;
  ids?: string[] | undefined;
}

export interface PersonWithOrganization {
  person: ContactRow;
  organization: { id: string; name: string; language: string | null } | null;
}

/** The client's default language (`tenant.settings.language`), or null. */
export async function clientLanguageOf(tx: Tx, tenantId: string): Promise<string | null> {
  const [t] = await tx
    .select({ settings: tenant.settings })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  return clientLanguage(t?.settings as Record<string, unknown> | null) ?? null;
}

/** The language to write to a person in (core's `languageFor`): theirs, their organization's, the client's. */
export function personLanguageOf(p: PersonWithOrganization, client: string | null) {
  return languageFor({
    person: p.person.language,
    organization: p.organization,
    client,
  });
}

export async function directoryPeople(
  tx: Tx,
  tenantId: string,
  filters: DirectoryFilters = {},
): Promise<PersonWithOrganization[]> {
  const where: SQL[] = [eq(contact.tenantId, tenantId)];
  if (filters.relationship) where.push(eq(contact.relationship, filters.relationship));
  if (filters.organizationId) where.push(eq(contact.organizationId, filters.organizationId));
  if (filters.role) where.push(sql`${contact.roles} ? ${filters.role}`);
  if (filters.ids) {
    if (filters.ids.length === 0) return [];
    where.push(inArray(contact.id, filters.ids));
  }
  if (filters.kind) {
    where.push(sql`${organization.kinds} @> array[${filters.kind}]::text[]`);
  }
  const rows = await tx
    .select({
      person: contact,
      orgId: organization.id,
      orgName: organization.name,
      orgLanguage: organization.language,
    })
    .from(contact)
    .leftJoin(
      organization,
      and(eq(organization.id, contact.organizationId), eq(organization.tenantId, contact.tenantId)),
    )
    .where(and(...where))
    .orderBy(asc(contact.name), asc(contact.id))
    .limit(DIRECTORY_READ_MAX);
  return rows.map((r) => ({
    person: r.person,
    organization:
      r.orgId && r.orgName ? { id: r.orgId, name: r.orgName, language: r.orgLanguage } : null,
  }));
}

export interface OrganizationWithCounts {
  organization: OrganizationRow;
  vendor: { id: string; name: string } | null;
  people: number;
}

export async function directoryOrganizations(
  tx: Tx,
  tenantId: string,
  filters: Pick<DirectoryFilters, "kind"> & { ids?: string[] } = {},
): Promise<OrganizationWithCounts[]> {
  const where: SQL[] = [eq(organization.tenantId, tenantId)];
  if (filters.kind) where.push(sql`${organization.kinds} @> array[${filters.kind}]::text[]`);
  if (filters.ids) {
    if (filters.ids.length === 0) return [];
    where.push(inArray(organization.id, filters.ids));
  }
  const rows = await tx
    .select({ organization, vendorName: vendor.name })
    .from(organization)
    .leftJoin(
      vendor,
      and(eq(vendor.id, organization.vendorId), eq(vendor.tenantId, organization.tenantId)),
    )
    .where(and(...where))
    .orderBy(asc(organization.name), asc(organization.id))
    .limit(DIRECTORY_READ_MAX);
  const counts = await tx
    .select({ id: contact.organizationId, n: count() })
    .from(contact)
    .where(and(eq(contact.tenantId, tenantId), sql`${contact.organizationId} is not null`))
    .groupBy(contact.organizationId);
  const byOrg = new Map(counts.map((c) => [c.id, Number(c.n)]));
  return rows.map((r) => ({
    organization: r.organization,
    vendor:
      r.organization.vendorId && r.vendorName
        ? { id: r.organization.vendorId, name: r.vendorName }
        : null,
    people: byOrg.get(r.organization.id) ?? 0,
  }));
}

/** What search looks at in a person. */
export function personSearchable(p: PersonWithOrganization) {
  return {
    name: p.person.name,
    email: p.person.email,
    phones: [p.person.phone, p.person.whatsapp],
    title: p.person.title,
    organization: p.organization?.name ?? null,
    roles: p.person.roles ?? [],
  };
}

export function organizationSearchable(o: OrganizationWithCounts) {
  return {
    name: o.organization.name,
    email: o.organization.email,
    phones: [o.organization.phone],
    website: o.organization.website,
    roles: o.organization.kinds,
  };
}

/** People ranked by the query, best first. */
export function rankPeople(
  people: readonly PersonWithOrganization[],
  query: string | undefined,
  limit: number,
): { item: PersonWithOrganization; score: number }[] {
  return rankEntries(
    people.map((p) => ({ ...personSearchable(p), item: p })),
    query,
    limit,
  ).map((r) => ({ item: r.entry.item, score: r.score }));
}

export function rankOrganizations(
  orgs: readonly OrganizationWithCounts[],
  query: string | undefined,
  limit: number,
): { item: OrganizationWithCounts; score: number }[] {
  return rankEntries(
    orgs.map((o) => ({ ...organizationSearchable(o), item: o })),
    query,
    limit,
  ).map((r) => ({ item: r.entry.item, score: r.score }));
}

export function personHit(
  p: PersonWithOrganization,
  score: number,
  client: string | null,
): DirectoryPersonHit {
  const c = p.person;
  const used = personLanguageOf(p, client);
  return {
    type: "person",
    id: c.id,
    name: c.name,
    title: c.title,
    relationship: c.relationship ?? null,
    organization: p.organization,
    email: c.email,
    phone: c.phone,
    whatsapp: c.whatsapp,
    roles: c.roles ?? [],
    language: used.language,
    languageFrom: used.from,
    optedOut: c.optedOutAt !== null,
    score,
  };
}

export function organizationHit(
  o: OrganizationWithCounts,
  score: number,
): DirectoryOrganizationHit {
  const r = o.organization;
  return {
    type: "organization",
    id: r.id,
    name: r.name,
    kinds: r.kinds ?? [],
    website: r.website,
    email: r.email,
    phone: r.phone,
    language: r.language,
    vendorId: r.vendorId,
    people: o.people,
    score,
  };
}

/** `directory.search`: people and organizations that match, best first, with their ids. */
export async function searchDirectory(
  tx: Tx,
  tenantId: string,
  input: DirectorySearchInput,
): Promise<DirectorySearchOutput> {
  const wantPeople = input.type !== "organization";
  const client = await clientLanguageOf(tx, tenantId);
  // A relationship, role or organization filter is about people only.
  const wantOrgs =
    input.type !== "person" &&
    input.relationship === undefined &&
    input.role === undefined &&
    input.organizationId === undefined;
  const people = wantPeople
    ? rankPeople(
        await directoryPeople(tx, tenantId, {
          relationship: input.relationship,
          role: input.role,
          organizationId: input.organizationId,
          kind: input.kind,
        }),
        input.query,
        input.limit,
      ).map((r) => personHit(r.item, r.score, client))
    : [];
  const orgs = wantOrgs
    ? rankOrganizations(
        await directoryOrganizations(tx, tenantId, { kind: input.kind }),
        input.query,
        input.limit,
      ).map((r) => organizationHit(r.item, r.score))
    : [];
  const results = [...people, ...orgs]
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, input.limit);
  return {
    query: input.query ?? "",
    count: results.length,
    results,
    sources: results.map((r) => r.id),
  };
}

/** `directory.get`: one person, or one organization with its people. */
export async function getDirectoryEntry(
  tx: Tx,
  tenantId: string,
  input: DirectoryGetInput,
): Promise<DirectoryGetOutput> {
  const none: DirectoryGetOutput = { found: false, person: null, organization: null, sources: [] };
  const client = await clientLanguageOf(tx, tenantId);
  if (input.type === "person") {
    const [found] = await directoryPeople(tx, tenantId, { ids: [input.id] });
    if (!found) return none;
    const { score: _s, ...hit } = personHit(found, 0, client);
    return {
      found: true,
      person: {
        ...hit,
        notes: found.person.notes,
        timezone: found.person.timezone,
        preferredChannels: found.person.preferredChannels ?? [],
      },
      organization: null,
      sources: [found.person.id],
    };
  }
  const [org] = await directoryOrganizations(tx, tenantId, { ids: [input.id] });
  if (!org) return none;
  const people = await directoryPeople(tx, tenantId, { organizationId: org.organization.id });
  const { score: _s, people: _n, ...hit } = organizationHit(org, 0);
  return {
    found: true,
    person: null,
    organization: {
      ...hit,
      notes: org.organization.notes,
      address: org.organization.address ?? null,
      people: people.map((p) => {
        const { score: _ps, ...ph } = personHit(p, 0, client);
        return ph;
      }),
    },
    sources: [org.organization.id, ...people.map((p) => p.person.id)],
  };
}
