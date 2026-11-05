// Organizations in a client's directory (docs/plan.md §1.27), inside the caller's client-scoped
// transaction. The client admin and the operator edit them alike; every change goes in
// `organization_change` with who made it. A vendor organization links to its `vendor` record (made
// from its name if there is none) so matching and the directory share one entry.

import { findOrCreateVendor } from "@countersign/connectors";
import {
  normalizePhone,
  type Organization,
  type OrganizationAddress,
  type OrganizationCreateInput,
  type OrganizationKind,
  type OrganizationPatchInput,
} from "@countersign/core";
import {
  directoryOrganizations,
  type OrganizationRow,
  type OrganizationWithCounts,
  organization,
  organizationChange,
  type Tx,
} from "@countersign/db";
import { and, eq, ne, sql } from "drizzle-orm";
import { HttpError, notFound } from "../http";

export function organizationView(o: OrganizationWithCounts): Organization {
  const r = o.organization;
  return {
    id: r.id,
    name: r.name,
    kinds: r.kinds ?? [],
    website: r.website,
    email: r.email,
    phone: r.phone,
    address: (r.address as OrganizationAddress | null) ?? null,
    notes: r.notes,
    externalRefs: r.externalRefs ?? {},
    vendor: o.vendor,
    source: r.source,
    people: o.people,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export async function organizationOut(tx: Tx, tenantId: string, id: string): Promise<Organization> {
  const [o] = await directoryOrganizations(tx, tenantId, { ids: [id] });
  if (!o) throw notFound("organization");
  return organizationView(o);
}

export async function getOrganization(
  tx: Tx,
  tenantId: string,
  id: string,
): Promise<OrganizationRow> {
  const [row] = await tx
    .select()
    .from(organization)
    .where(and(eq(organization.id, id), eq(organization.tenantId, tenantId)));
  if (!row) throw notFound("organization");
  return row;
}

export async function logOrganization(
  tx: Tx,
  tenantId: string,
  organizationId: string,
  actorId: string | null,
  change: Record<string, unknown>,
): Promise<void> {
  await tx.insert(organizationChange).values({ tenantId, organizationId, actorId, change });
}

/** An organization's phone: international form when it reads as one, else as written. */
// DECISION: unlike a person's, an organization's phone is never dialled by an agent, so a number
// without its country code is kept as written rather than refused.
function orgPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return normalizePhone(raw) ?? raw.trim();
}

/** Another organization of this client with the same name (case aside), if any. */
export async function sameName(
  tx: Tx,
  tenantId: string,
  name: string,
  except?: string,
): Promise<{ id: string; name: string } | null> {
  const [row] = await tx
    .select({ id: organization.id, name: organization.name })
    .from(organization)
    .where(
      and(
        eq(organization.tenantId, tenantId),
        sql`lower(${organization.name}) = lower(${name.trim()})`,
        ...(except ? [ne(organization.id, except)] : []),
      ),
    )
    .limit(1);
  return row ?? null;
}

export interface OrganizationOrigin {
  source?: string;
  externalRefs?: Record<string, string>;
  log?: Record<string, unknown>;
}

export async function createOrganization(
  tx: Tx,
  tenantId: string,
  input: OrganizationCreateInput,
  actorId: string | null,
  origin: OrganizationOrigin = {},
): Promise<OrganizationRow> {
  const name = input.name.trim();
  // DECISION: one organization per name (case aside) in a client's directory, so imports and
  // agents' suggestions find it rather than add a second.
  const taken = await sameName(tx, tenantId, name);
  if (taken) {
    throw new HttpError(409, "organization_exists", `${taken.name} is already in the directory`);
  }
  const [row] = await tx
    .insert(organization)
    .values({
      tenantId,
      name,
      kinds: [...new Set(input.kinds ?? [])],
      website: input.website ?? null,
      email: input.email ?? null,
      phone: orgPhone(input.phone),
      address: input.address ?? null,
      notes: input.notes?.trim() || null,
      externalRefs: origin.externalRefs ?? {},
      source: origin.source ?? "manual",
      createdBy: actorId,
    })
    .returning();
  if (!row) throw new Error("organization insert returned nothing");
  await logOrganization(tx, tenantId, row.id, actorId, {
    kind: "created",
    from: row.source,
    ...(origin.log ?? {}),
  });
  return row;
}

export async function updateOrganization(
  tx: Tx,
  tenantId: string,
  id: string,
  patch: OrganizationPatchInput,
  actorId: string | null,
  extra: { log?: Record<string, unknown>; externalRefs?: Record<string, string> } = {},
): Promise<OrganizationRow> {
  const row = await getOrganization(tx, tenantId, id);
  const next = {
    name: patch.name?.trim() ?? row.name,
    kinds: patch.kinds === undefined ? row.kinds : [...new Set(patch.kinds)],
    website: patch.website === undefined ? row.website : patch.website,
    email: patch.email === undefined ? row.email : patch.email,
    phone: patch.phone === undefined ? row.phone : orgPhone(patch.phone),
    address: patch.address === undefined ? row.address : patch.address,
    notes: patch.notes === undefined ? row.notes : patch.notes?.trim() || null,
    externalRefs:
      extra.externalRefs === undefined
        ? row.externalRefs
        : { ...(row.externalRefs ?? {}), ...extra.externalRefs },
  };
  if (next.name !== row.name) {
    const taken = await sameName(tx, tenantId, next.name, id);
    if (taken) {
      throw new HttpError(409, "organization_exists", `${taken.name} is already in the directory`);
    }
  }
  // A linked vendor organization stays a vendor.
  if (row.vendorId && !next.kinds.includes("vendor")) {
    next.kinds = [...next.kinds, "vendor" as OrganizationKind];
  }
  const changed: Record<string, { before: unknown; after: unknown }> = {};
  for (const k of Object.keys(next) as (keyof typeof next)[]) {
    if (JSON.stringify(row[k] ?? null) !== JSON.stringify(next[k] ?? null)) {
      changed[k] = { before: row[k] ?? null, after: next[k] ?? null };
    }
  }
  if (Object.keys(changed).length === 0) return row;
  const [updated] = await tx
    .update(organization)
    .set(next)
    .where(and(eq(organization.id, id), eq(organization.tenantId, tenantId)))
    .returning();
  if (!updated) throw notFound("organization");
  await logOrganization(tx, tenantId, id, actorId, {
    kind: "edited",
    changed,
    ...(extra.log ?? {}),
  });
  return updated;
}

const UNIQUE_VIOLATION = "23505";

/**
 * Links the organization to its vendor record: the client's vendor with its name (or alias), made
 * when there is none. One organization per vendor: a vendor already linked elsewhere is refused.
 */
export async function linkVendor(
  tx: Tx,
  tenantId: string,
  id: string,
  actorId: string | null,
): Promise<OrganizationRow> {
  const row = await getOrganization(tx, tenantId, id);
  if (row.vendorId) return row;
  const v = await findOrCreateVendor(tx, tenantId, row.name);
  if (!v) {
    throw new HttpError(
      422,
      "invalid_name",
      "this name can't be a vendor's: add letters or digits",
    );
  }
  const [other] = await tx
    .select({ id: organization.id, name: organization.name })
    .from(organization)
    .where(and(eq(organization.tenantId, tenantId), eq(organization.vendorId, v.id)));
  if (other) {
    throw new HttpError(
      409,
      "vendor_linked",
      `${other.name} is already this vendor's entry in the directory`,
    );
  }
  let updated: OrganizationRow | undefined;
  try {
    [updated] = await tx
      .update(organization)
      .set({
        vendorId: v.id,
        kinds: [...new Set([...(row.kinds ?? []), "vendor" as const])],
      })
      .where(and(eq(organization.id, id), eq(organization.tenantId, tenantId)))
      .returning();
  } catch (error) {
    const code = (error as { code?: string; cause?: { code?: string } }).code;
    if ((code ?? (error as { cause?: { code?: string } }).cause?.code) === UNIQUE_VIOLATION) {
      throw new HttpError(409, "vendor_linked", "another organization is already this vendor's");
    }
    throw error;
  }
  if (!updated) throw notFound("organization");
  await logOrganization(tx, tenantId, id, actorId, {
    kind: "vendor_linked",
    vendorId: v.id,
    vendorName: v.name,
  });
  return updated;
}

export async function unlinkVendor(
  tx: Tx,
  tenantId: string,
  id: string,
  actorId: string | null,
): Promise<OrganizationRow> {
  const row = await getOrganization(tx, tenantId, id);
  if (!row.vendorId) return row;
  const [updated] = await tx
    .update(organization)
    .set({ vendorId: null })
    .where(and(eq(organization.id, id), eq(organization.tenantId, tenantId)))
    .returning();
  if (!updated) throw notFound("organization");
  await logOrganization(tx, tenantId, id, actorId, {
    kind: "vendor_unlinked",
    vendorId: row.vendorId,
  });
  return updated;
}
