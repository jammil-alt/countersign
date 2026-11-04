// The runtime's reads over the database (RuntimeStore): each one short transaction scoped to one
// client (withTenant), so a run sees its own client's rows and nothing else (invariant 1).

import type { ConnectionRef } from "@countersign/connectors";
import { readApproverRuleSet } from "@countersign/core";
import {
  agent,
  agentVersion,
  connection,
  type Db,
  membership,
  memoryNote,
  run,
  tenant,
  withTenant,
} from "@countersign/db";
import { and, desc, eq, inArray, like, not } from "drizzle-orm";
import { notFound } from "../errors";
import type { MemoryNoteRecord, PinnedAgent, RuntimeStore } from "../runtime/ports";
import { MEMORY_TEST_SCOPE_PREFIX } from "../tools/platform";
import { resolveCustomSkill } from "./skills";

export function toConnectionRef(row: typeof connection.$inferSelect): ConnectionRef {
  return {
    id: row.id,
    tenantId: row.tenantId,
    connector: row.connector,
    status: row.status,
    externalAccountId: row.externalAccountId,
    config: row.config as ConnectionRef["config"],
    permissions: row.permissions,
  };
}

/** `approvals.external_actions` from a client's settings (nested or as a dotted key). */
export function clientApproverSetting(settings: Record<string, unknown>): string | null {
  const nested = (settings.approvals as { external_actions?: unknown } | undefined)
    ?.external_actions;
  const value = nested ?? settings["approvals.external_actions"];
  return typeof value === "string" ? value : null;
}

export function dbRuntimeStore(db: Db): RuntimeStore {
  return {
    loadAgentVersion(tenantId, agentVersionId): Promise<PinnedAgent> {
      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .select({ v: agentVersion, a: agent })
          .from(agentVersion)
          .innerJoin(agent, eq(agent.id, agentVersion.agentId))
          .where(
            and(
              eq(agentVersion.id, agentVersionId),
              eq(agentVersion.tenantId, tenantId),
              eq(agent.kind, "client"),
            ),
          );
        if (!row) throw notFound(`client agent version ${agentVersionId}`);
        return {
          agentId: row.a.id,
          agentVersionId: row.v.id,
          tenantId,
          slug: row.a.slug,
          version: row.v.version,
          bundle: row.v.bundle,
          bindings: row.a.bindings,
          approver: row.a.approver,
        };
      });
    },

    resolveCustomSkill(tenantId, ref) {
      return withTenant(db, tenantId, (tx) => resolveCustomSkill(tx, { tenantId, ref }));
    },

    memoryNotes(tenantId, agentId, limit): Promise<MemoryNoteRecord[]> {
      return withTenant(db, tenantId, (tx) =>
        tx
          .select({
            id: memoryNote.id,
            note: memoryNote.note,
            scope: memoryNote.scope,
            createdAt: memoryNote.createdAt,
          })
          .from(memoryNote)
          .where(
            and(
              eq(memoryNote.tenantId, tenantId),
              eq(memoryNote.agentId, agentId),
              // Notes written by test runs are tagged and never read back.
              not(like(memoryNote.scope, `${MEMORY_TEST_SCOPE_PREFIX}%`)),
            ),
          )
          .orderBy(desc(memoryNote.createdAt))
          .limit(limit),
      );
    },

    connection(tenantId, connectionId) {
      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .select()
          .from(connection)
          .where(and(eq(connection.id, connectionId), eq(connection.tenantId, tenantId)));
        return row ? toConnectionRef(row) : null;
      });
    },

    approvalRouting(tenantId) {
      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .select({ settings: tenant.settings })
          .from(tenant)
          .where(eq(tenant.id, tenantId));
        const settings = row?.settings ?? {};
        const set = readApproverRuleSet(settings);
        const people = await tx
          .select({ userId: membership.userId })
          .from(membership)
          .where(
            and(
              eq(membership.tenantId, tenantId),
              inArray(membership.role, ["client_admin", "client_user"]),
            ),
          );
        return {
          rules: set.rules,
          revision: set.revision,
          clientDefault: clientApproverSetting(settings),
          members: new Set(people.map((p) => p.userId)),
        };
      });
    },

    run(tenantId, runId) {
      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .select({ mode: run.mode, agentId: run.agentId })
          .from(run)
          .where(and(eq(run.id, runId), eq(run.tenantId, tenantId)));
        return row ?? null;
      });
    },
  };
}
