// docs/plan.md §1.164 step 3, "Zoho's fields": what the back office and the builder read of a Zoho
// connection's field list (kept beside its cursor, ./sync.ts `refreshZohoFields`): the back
// office's view of it with the extra fields the sync reads, the builder's typed write inputs, and
// the check of a setup that adds sync fields.

import {
  readZohoFieldCache,
  readZohoSyncFieldsConfig,
  ZOHO_CRM_CONNECTOR_ID,
  ZOHO_MAX_FIELDS_PER_CALL,
  ZOHO_SYNC_FIELDS,
  ZOHO_SYNC_FIELDS_KEY,
  ZOHO_SYNCED_MODULES,
  ZOHO_TOOLS,
  type ZohoFieldCache,
  zohoStandardFieldCount,
  zohoSyncFieldsProblems,
  zohoToolInputs,
} from "@countersign/connectors";
import {
  deepEqual,
  isPlainObject,
  type ToolInputVariants,
  type ZohoFieldsView,
} from "@countersign/core";
import { connection, type Tx } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { HttpError } from "../http";
import type { Platform } from "../platform";

type ConnectionRow = typeof connection.$inferSelect;

/** The back office's view of a connection's fields and the extra fields its sync reads. */
export function zohoFieldsView(
  row: Pick<ConnectionRow, "config" | "status">,
  cache: ZohoFieldCache | null,
): ZohoFieldsView {
  const extra = readZohoSyncFieldsConfig(row.config);
  return {
    status: cache ? cache.status : "not_read",
    readAt: cache?.at ?? null,
    modules: ZOHO_SYNCED_MODULES.map((module) => ({
      module,
      fields: cache?.modules[module] ?? [],
      standard: [...ZOHO_SYNC_FIELDS[module]],
      room: Math.max(0, ZOHO_MAX_FIELDS_PER_CALL - zohoStandardFieldCount(module)),
    })),
    syncFields: Object.fromEntries(
      ZOHO_SYNCED_MODULES.flatMap((m) => (extra[m] ? [[m, extra[m]]] : [])),
    ),
  };
}

/**
 * A client agent's tool inputs typed from its client's Zoho (the builder's catalog and Reshape's
 * proposer): the connection bound to the agent, else the client's one connected Zoho; none for a
 * template or when the field list hasn't been read.
 */
// DECISION (docs/plan.md §1.164): typed from the kept field list only, never a call to Zoho while
// the builder opens; the cron reads it daily and the back office's "Read the fields again" at once.
export async function zohoToolInputsFor(
  tx: Tx,
  platform: Platform,
  agent: { tenantId: string | null; bindings: Record<string, string> | null },
): Promise<Record<string, ToolInputVariants>> {
  if (!agent.tenantId) return {};
  const specs = platform.tools.specs();
  const create = specs[ZOHO_TOOLS.create];
  const update = specs[ZOHO_TOOLS.update];
  if (!create || !update) return {};
  const rows = await tx
    .select({ id: connection.id, syncCursor: connection.syncCursor })
    .from(connection)
    .where(
      and(
        eq(connection.tenantId, agent.tenantId),
        eq(connection.connector, ZOHO_CRM_CONNECTOR_ID),
        eq(connection.status, "connected"),
      ),
    );
  const bound = agent.bindings?.[ZOHO_CRM_CONNECTOR_ID];
  const row = rows.find((r) => r.id === bound) ?? (rows.length === 1 ? rows[0] : undefined);
  if (!row) return {};
  return zohoToolInputs(readZohoFieldCache(row.syncCursor), { create, update });
}

/**
 * Refuses (422) a Zoho connection's new setup whose added sync fields aren't in its field list or
 * don't fit one call. Fields taken away, and any other setup, pass.
 */
export function checkZohoSetup(
  row: Pick<ConnectionRow, "connector" | "config" | "syncCursor">,
  config: Record<string, unknown>,
): void {
  if (row.connector !== ZOHO_CRM_CONNECTOR_ID) return;
  const before = isPlainObject(row.config) ? row.config[ZOHO_SYNC_FIELDS_KEY] : undefined;
  const after = config[ZOHO_SYNC_FIELDS_KEY];
  if (deepEqual(before, after)) return;
  const problems = zohoSyncFieldsProblems(
    after,
    readZohoFieldCache(row.syncCursor),
    zohoStandardFieldCount,
    before,
  );
  if (problems.length > 0) {
    throw new HttpError(422, "invalid_config", problems.map((p) => p.message).join("; "));
  }
}
