// The directory behind `directory.*` (DirectoryPort), over packages/db: one client-scoped
// transaction per call, so only that client's people and organizations are visible (invariant 1).
// A suggestion is checked against the directory (the entries it names are this client's, a new
// email or number isn't someone else's) and becomes one inbox item for the client admin; the
// change itself is applied by apps/api only when the item is accepted.

import {
  DIRECTORY_SUGGESTION_SUBJECT,
  type DirectorySuggestInput,
  type DirectorySuggestionChange,
  normalizePhone,
  suggestionChangesAddress,
} from "@countersign/core";
import {
  contact,
  type Db,
  getDirectoryEntry,
  inboxItem,
  organization,
  searchDirectory,
  type Tx,
  transaction,
  vendor,
  withTenant,
} from "@countersign/db";
import { and, eq, gte, ne, sql } from "drizzle-orm";
import type { DirectoryPort } from "../tools/types";

/** A suggestion an agent can't make; the tool call fails with this message. */
export class DirectorySuggestionError extends Error {
  override name = "DirectorySuggestionError";
}

async function personName(tx: Tx, tenantId: string, id: string): Promise<string> {
  const [row] = await tx
    .select({ name: contact.name })
    .from(contact)
    .where(and(eq(contact.id, id), eq(contact.tenantId, tenantId)));
  if (!row) throw new DirectorySuggestionError("there is no such person in this directory");
  return row.name;
}

async function organizationName(tx: Tx, tenantId: string, id: string): Promise<string> {
  const [row] = await tx
    .select({ name: organization.name })
    .from(organization)
    .where(and(eq(organization.id, id), eq(organization.tenantId, tenantId)));
  if (!row) throw new DirectorySuggestionError("there is no such organization in this directory");
  return row.name;
}

/** A new address must be readable and not already someone else's. */
async function checkAddresses(
  tx: Tx,
  tenantId: string,
  person: { email?: string | undefined; phone?: string | undefined; whatsapp?: string | undefined },
  except: string | null,
): Promise<void> {
  const fields = [
    ["email", person.email ?? null, contact.email],
    ["phone", person.phone ? normalizePhone(person.phone) : null, contact.phone],
    ["whatsapp", person.whatsapp ? normalizePhone(person.whatsapp) : null, contact.whatsapp],
  ] as const;
  for (const [field, value, column] of fields) {
    const given = person[field];
    if (given === undefined) continue;
    if (value === null) {
      throw new DirectorySuggestionError(
        `${field}: give the number in international form, e.g. +15551234567`,
      );
    }
    const [taken] = await tx
      .select({ id: contact.id, name: contact.name })
      .from(contact)
      .where(
        and(
          eq(contact.tenantId, tenantId),
          eq(column, value),
          ...(except ? [ne(contact.id, except)] : []),
        ),
      )
      .limit(1);
    if (taken) {
      throw new DirectorySuggestionError(
        `${field}: that is already in the directory (person ${taken.id}); suggest a change to them instead`,
      );
    }
  }
}

/** Checks the change and returns its subject and a title for the inbox. */
async function check(
  tx: Tx,
  tenantId: string,
  change: DirectorySuggestionChange,
): Promise<{ subjectId: string | null; title: string }> {
  switch (change.action) {
    case "add_person": {
      if (!change.person.email && !change.person.phone && !change.person.whatsapp) {
        throw new DirectorySuggestionError(
          "a person needs an email address, a phone or a WhatsApp number",
        );
      }
      if (change.person.organizationId) {
        await organizationName(tx, tenantId, change.person.organizationId);
      }
      await checkAddresses(tx, tenantId, change.person, null);
      return { subjectId: null, title: `Add ${change.person.name} to the directory` };
    }
    case "update_person": {
      const name = await personName(tx, tenantId, change.contactId);
      if (change.changes.organizationId) {
        await organizationName(tx, tenantId, change.changes.organizationId);
      }
      await checkAddresses(tx, tenantId, change.changes, change.contactId);
      return {
        subjectId: change.contactId,
        title: suggestionChangesAddress(change)
          ? `Change how we reach ${name}`
          : `Update ${name} in the directory`,
      };
    }
    case "add_organization": {
      const [same] = await tx
        .select({ id: organization.id })
        .from(organization)
        .where(
          and(
            eq(organization.tenantId, tenantId),
            sql`lower(${organization.name}) = lower(${change.organization.name})`,
          ),
        )
        .limit(1);
      if (same) {
        throw new DirectorySuggestionError(
          `an organization with that name is already in the directory (organization ${same.id})`,
        );
      }
      return { subjectId: null, title: `Add ${change.organization.name} to the directory` };
    }
    case "update_organization": {
      const name = await organizationName(tx, tenantId, change.organizationId);
      return { subjectId: change.organizationId, title: `Update ${name} in the directory` };
    }
  }
}

export function dbDirectoryPort(db: Db): DirectoryPort {
  return {
    search(tenantId, input) {
      return withTenant(db, tenantId, (tx) => searchDirectory(tx, tenantId, input));
    },
    get(tenantId, input) {
      return withTenant(db, tenantId, (tx) => getDirectoryEntry(tx, tenantId, input));
    },
    suggest(tenantId, input) {
      return withTenant(db, tenantId, async (tx) => {
        const s: DirectorySuggestInput = input.suggestion;
        const { subjectId, title } = await check(tx, tenantId, s.suggestion);
        if (input.test) return { status: "test_run" as const, inboxItemId: null };
        // The same change waiting already (from any agent): no second item.
        const [open] = await tx
          .select({ id: inboxItem.id })
          .from(inboxItem)
          .where(
            and(
              eq(inboxItem.tenantId, tenantId),
              eq(inboxItem.subjectType, DIRECTORY_SUGGESTION_SUBJECT),
              eq(inboxItem.status, "open"),
              sql`${inboxItem.payload}->'directorySuggestion'->'change' = ${JSON.stringify(s.suggestion)}::jsonb`,
            ),
          )
          .limit(1);
        if (open) return { status: "duplicate" as const, inboxItemId: open.id };
        const [item] = await tx
          .insert(inboxItem)
          .values({
            tenantId,
            kind: "review",
            agentId: input.agentId,
            // DECISION: the run is kept in the payload, not `run_id`: no run waits for the
            // answer, and a resolved item with a run id would be re-sent to it by the cron.
            subjectType: DIRECTORY_SUGGESTION_SUBJECT,
            subjectId,
            assigneeRole: "client_admin",
            title: title.slice(0, 200),
            payload: {
              directorySuggestion: {
                change: s.suggestion,
                reason: s.reason,
                sources: s.sources,
                agentVersionId: input.agentVersionId,
                runId: input.runId,
                changesAddress: suggestionChangesAddress(s.suggestion),
              },
            },
          })
          .returning({ id: inboxItem.id });
        if (!item) throw new Error("inbox item insert returned nothing");
        return { status: "suggested" as const, inboxItemId: item.id };
      });
    },
    // v0.14 W4-B (docs/plan.md §1.28 "Directory upkeep"): one grouped query, the exclusions in
    // the WHERE clause (no subquery in the select list).
    unlistedVendors(tenantId, input) {
      const since = new Date(input.now.getTime() - input.sinceDays * 24 * 60 * 60 * 1000);
      const suggestedName = sql`lower(${inboxItem.payload}->'directorySuggestion'->'change'->'organization'->>'name')`;
      return withTenant(db, tenantId, async (tx) => {
        const rows = await tx
          .select({
            vendorId: vendor.id,
            name: vendor.name,
            sources: sql<
              string[]
            >`to_jsonb((array_agg(${transaction.id}::text order by ${transaction.createdAt} desc))[1:5])`,
          })
          .from(transaction)
          .innerJoin(
            vendor,
            and(eq(vendor.id, transaction.vendorId), eq(vendor.tenantId, transaction.tenantId)),
          )
          .where(
            and(
              eq(transaction.tenantId, tenantId),
              gte(transaction.createdAt, since),
              sql`not exists (select 1 from ${organization}
                where ${organization.tenantId} = ${vendor.tenantId}
                  and (${organization.vendorId} = ${vendor.id} or lower(${organization.name}) = lower(${vendor.name})))`,
              sql`not exists (select 1 from ${inboxItem}
                where ${inboxItem.tenantId} = ${vendor.tenantId}
                  and ${inboxItem.subjectType} = ${DIRECTORY_SUGGESTION_SUBJECT}
                  and ${inboxItem.payload}->'directorySuggestion'->'change'->>'action' = 'add_organization'
                  and ${suggestedName} = lower(${vendor.name}))`,
            ),
          )
          .groupBy(vendor.id, vendor.name)
          .orderBy(sql`max(${transaction.createdAt}) desc`)
          .limit(input.limit);
        return rows.map((r) => ({ vendorId: r.vendorId, name: r.name, sources: r.sources ?? [] }));
      });
    },
  };
}
