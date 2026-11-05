// Agents' suggestions for the directory (docs/plan.md §1.27). `directory.suggest` opens an inbox
// item for the client admin (packages/agents, log/directory-port.ts); this reads them for the
// screens and applies one when it is accepted, through the same contact and organization edits
// people make, logged with the suggestion and the agent. A suggested email or phone applies only
// here, on acceptance; consent follows the contact rules (a new address needs consent again) and
// an opt-out is never touched.

import {
  DIRECTORY_SUGGESTION_SUBJECT,
  type DirectorySuggestion,
  DirectorySuggestionChange,
  isPlainObject,
  suggestionChangesAddress,
} from "@countersign/core";
import { agent, contact, inboxItem, organization, type Tx } from "@countersign/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { HttpError } from "../http";
import { createContact, updateContact } from "../messaging/contacts";
import { createOrganization, updateOrganization } from "./organizations";

type InboxRow = typeof inboxItem.$inferSelect;

interface StoredSuggestion {
  change: DirectorySuggestionChange;
  reason: string;
  sources: string[];
  agentVersionId: string | null;
  runId: string | null;
}

export function isDirectorySuggestion(item: Pick<InboxRow, "subjectType">): boolean {
  return item.subjectType === DIRECTORY_SUGGESTION_SUBJECT;
}

function stored(item: Pick<InboxRow, "payload">): StoredSuggestion | null {
  const p = isPlainObject(item.payload) ? item.payload.directorySuggestion : null;
  if (!isPlainObject(p)) return null;
  const change = DirectorySuggestionChange.safeParse(p.change);
  if (!change.success) return null;
  return {
    change: change.data,
    reason: typeof p.reason === "string" ? p.reason : "",
    sources: Array.isArray(p.sources) ? p.sources.filter((s) => typeof s === "string") : [],
    agentVersionId: typeof p.agentVersionId === "string" ? p.agentVersionId : null,
    runId: typeof p.runId === "string" ? p.runId : null,
  };
}

function statusOf(item: InboxRow): DirectorySuggestion["status"] {
  if (item.status === "open") return "open";
  if (item.status === "expired") return "expired";
  const r = isPlainObject(item.resolution) ? item.resolution : {};
  return r.approved === true ? "accepted" : "declined";
}

/** The person or organization a suggestion names, as it is now. */
type Target = Record<string, unknown> & { id: string; name: string };

async function targets(tx: Tx, tenantId: string, items: StoredSuggestion[]) {
  const people = items.flatMap((s) =>
    s.change.action === "update_person" ? [s.change.contactId] : [],
  );
  const orgs = items.flatMap((s) =>
    s.change.action === "update_organization" ? [s.change.organizationId] : [],
  );
  const map = new Map<string, Target>();
  if (people.length) {
    for (const r of await tx
      .select()
      .from(contact)
      .where(and(eq(contact.tenantId, tenantId), inArray(contact.id, people)))) {
      map.set(r.id, r as unknown as Target);
    }
  }
  if (orgs.length) {
    for (const r of await tx
      .select()
      .from(organization)
      .where(and(eq(organization.tenantId, tenantId), inArray(organization.id, orgs)))) {
      map.set(r.id, r as unknown as Target);
    }
  }
  return map;
}

export async function suggestionViews(
  tx: Tx,
  tenantId: string,
  items: InboxRow[],
): Promise<DirectorySuggestion[]> {
  const parsed = items
    .map((item) => ({ item, s: stored(item) }))
    .filter((x): x is { item: InboxRow; s: StoredSuggestion } => x.s !== null);
  const found = await targets(
    tx,
    tenantId,
    parsed.map((p) => p.s),
  );
  const agentIds = [...new Set(parsed.map((p) => p.item.agentId).filter((a): a is string => !!a))];
  const agents = agentIds.length
    ? await tx
        .select({ id: agent.id, name: agent.name, serviceName: agent.serviceName })
        .from(agent)
        .where(and(eq(agent.tenantId, tenantId), inArray(agent.id, agentIds)))
    : [];
  const agentName = new Map(agents.map((a) => [a.id, a.serviceName ?? a.name]));
  return parsed.map(({ item, s }) => {
    const c = s.change;
    const targetId =
      c.action === "update_person"
        ? c.contactId
        : c.action === "update_organization"
          ? c.organizationId
          : null;
    const target = targetId ? found.get(targetId) : undefined;
    const changes =
      c.action === "update_person" || c.action === "update_organization" ? c.changes : {};
    return {
      id: item.id,
      change: c,
      reason: s.reason,
      sources: s.sources,
      target: target ? { id: target.id, name: target.name } : null,
      diff: Object.entries(changes).map(([field, after]) => ({
        field,
        before: target ? ((target[field] as unknown) ?? null) : null,
        after: after ?? null,
      })),
      changesAddress: suggestionChangesAddress(c),
      agent: item.agentId
        ? { id: item.agentId, name: agentName.get(item.agentId) ?? "Agent" }
        : null,
      status: statusOf(item),
      createdAt: item.createdAt.toISOString(),
    };
  });
}

export async function listSuggestions(
  tx: Tx,
  tenantId: string,
  status: "open" | "all" = "open",
): Promise<DirectorySuggestion[]> {
  const rows = await tx
    .select()
    .from(inboxItem)
    .where(
      and(
        eq(inboxItem.tenantId, tenantId),
        eq(inboxItem.subjectType, DIRECTORY_SUGGESTION_SUBJECT),
        ...(status === "open" ? [eq(inboxItem.status, "open")] : []),
      ),
    )
    .orderBy(desc(inboxItem.createdAt))
    .limit(200);
  return suggestionViews(tx, tenantId, rows);
}

export async function openSuggestionCount(tx: Tx, tenantId: string): Promise<number> {
  const rows = await tx
    .select({ id: inboxItem.id })
    .from(inboxItem)
    .where(
      and(
        eq(inboxItem.tenantId, tenantId),
        eq(inboxItem.subjectType, DIRECTORY_SUGGESTION_SUBJECT),
        eq(inboxItem.status, "open"),
      ),
    )
    .limit(1000);
  return rows.length;
}

/**
 * Applies an accepted suggestion, in the transaction that resolves its inbox item. The directory
 * may have changed since it was made: a change that no longer fits (an address someone else now
 * has, a person since removed) is refused, and the item stays open.
 */
export async function applySuggestion(
  tx: Tx,
  tenantId: string,
  item: InboxRow,
  actorId: string,
): Promise<{ type: "person" | "organization"; id: string }> {
  const s = stored(item);
  if (!s) throw new HttpError(409, "invalid_suggestion", "this suggestion can't be applied");
  const log = { suggestion: item.id, agentId: item.agentId, agentVersionId: s.agentVersionId };
  const c = s.change;
  switch (c.action) {
    case "add_person": {
      const row = await createContact(tx, tenantId, c.person, actorId, new Date(), {
        source: "agent",
        log,
      });
      return { type: "person", id: row.id };
    }
    case "update_person": {
      const row = await updateContact(tx, tenantId, c.contactId, c.changes, actorId, { log });
      return { type: "person", id: row.id };
    }
    case "add_organization": {
      const row = await createOrganization(tx, tenantId, c.organization, actorId, {
        source: "agent",
        log,
      });
      return { type: "organization", id: row.id };
    }
    case "update_organization": {
      const row = await updateOrganization(tx, tenantId, c.organizationId, c.changes, actorId, {
        log,
      });
      return { type: "organization", id: row.id };
    }
  }
}
