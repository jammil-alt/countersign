// Built-in sources (upload, with email forwarding through the same connection): every client has
// one, nobody signs in to it and nothing syncs, so "last synced" and "bound agents" said nothing
// true about it ("never synced", "No agent uses it", while it starts the Bill clerk). What it does
// is bring documents, and agents use it through their triggers on document events.

import { UPLOAD_CONNECTOR_ID } from "@countersign/connectors";
import { type AnyAgentBundle, allTriggers } from "@countersign/core";
import { agent, agentVersion, type connection, document, type Tx } from "@countersign/db";
import { and, eq, inArray, isNotNull, max, ne } from "drizzle-orm";

type ConnectionRow = typeof connection.$inferSelect;

/** Connectors that are built-in sources of documents. */
export const BUILT_IN_SOURCES: ReadonlySet<string> = new Set([UPLOAD_CONNECTOR_ID]);

export function isBuiltInSource(connector: string): boolean {
  return BUILT_IN_SOURCES.has(connector);
}

/** Whether a bundle has an enabled workflow that starts on a document event. */
// DECISION: an agent uses a built-in source when one of its enabled workflows (its live version)
// starts on a `document.*` event: uploaded and forwarded documents are what emit them.
export function startsOnDocuments(bundle: AnyAgentBundle): boolean {
  return bundle.workflows.some(
    (w) =>
      w.enabled !== false &&
      allTriggers(w.workflow).some(
        (t) => t.on.type === "event" && t.on.event.startsWith("document."),
      ),
  );
}

export interface SourceActivity {
  /** When the last document came through each built-in source connection, by connection id. */
  lastDocumentAt: Map<string, Date>;
  /** The client's agents (not retired, not test copies) whose live version starts on documents. */
  documentAgents: { id: string; name: string }[];
}

/** What the built-in sources among a client's connections did, and which agents they start. */
export async function sourceActivity(
  tx: Tx,
  tenantId: string,
  rows: readonly Pick<ConnectionRow, "id" | "connector">[],
): Promise<SourceActivity> {
  const sources = rows.filter((r) => isBuiltInSource(r.connector)).map((r) => r.id);
  if (sources.length === 0) return { lastDocumentAt: new Map(), documentAgents: [] };
  const [last, live] = await Promise.all([
    tx
      .select({ connectionId: document.connectionId, at: max(document.receivedAt) })
      .from(document)
      .where(and(eq(document.tenantId, tenantId), inArray(document.connectionId, sources)))
      .groupBy(document.connectionId),
    tx
      .select({
        id: agent.id,
        name: agent.name,
        serviceName: agent.serviceName,
        bundle: agentVersion.bundle,
      })
      .from(agent)
      .innerJoin(
        agentVersion,
        and(eq(agentVersion.id, agent.liveVersionId), eq(agentVersion.tenantId, agent.tenantId)),
      )
      .where(
        and(
          eq(agent.tenantId, tenantId),
          eq(agent.kind, "client"),
          eq(agent.status, "active"),
          eq(agent.testCopy, false),
          isNotNull(agent.liveVersionId),
          ne(agent.runStatus, "retired"),
        ),
      ),
  ]);
  const lastDocumentAt = new Map<string, Date>();
  for (const r of last) {
    if (r.connectionId && r.at) lastDocumentAt.set(r.connectionId, new Date(r.at));
  }
  return {
    lastDocumentAt,
    documentAgents: live
      .filter((a) => startsOnDocuments(a.bundle))
      .map((a) => ({ id: a.id, name: a.serviceName ?? a.name })),
  };
}

/** Agents using a connection: those bound to it, plus, for a built-in source, document agents. */
export function usedByWith(
  c: Pick<ConnectionRow, "id" | "connector">,
  bound: { id: string; name: string }[],
  activity: SourceActivity,
): { id: string; name: string }[] {
  if (!isBuiltInSource(c.connector)) return bound;
  const out = [...bound];
  for (const a of activity.documentAgents) if (!out.some((b) => b.id === a.id)) out.push(a);
  return out;
}

/** A connection's last activity: its last sync, or, for a built-in source, its last document. */
export function lastActivityOf(
  c: Pick<ConnectionRow, "id" | "connector" | "lastSyncAt">,
  activity: SourceActivity,
): Date | null {
  if (isBuiltInSource(c.connector)) return activity.lastDocumentAt.get(c.id) ?? null;
  return c.lastSyncAt ?? null;
}
