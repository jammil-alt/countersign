// The runtime's reads over the database (RuntimeStore): each one short transaction scoped to one
// client (withTenant), so a run sees its own client's rows and nothing else (invariant 1).

import type { ConnectionRef } from "@countersign/connectors";
import { autonomyFor, readApproverRuleSet, readAutonomy } from "@countersign/core";
import {
  agent,
  agentVersion,
  connection,
  contact,
  type Db,
  membership,
  memoryNote,
  run,
  type Tx,
  tenant,
  withTenant,
} from "@countersign/db";
import { and, desc, eq, gte, inArray, like, not, sql } from "drizzle-orm";
import { notFound } from "../errors";
import type {
  ApprovalRouting,
  MemoryNoteRecord,
  PinnedAgent,
  RuntimeStore,
} from "../runtime/ports";
import { MEMORY_TEST_SCOPE_PREFIX } from "../tools/platform";
import { grantOf } from "./grants";
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

// P-6: the same routing read in the caller's transaction (docs/plan.md §1.68).
/**
 * Who approves what at one client, read in the caller's transaction: the approver rules, the
 * client's default and the client people who sign (the runtime store's `approvalRouting`).
 */
export async function approvalRoutingTx(tx: Tx, tenantId: string): Promise<ApprovalRouting> {
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
        // v0.12 W1-D: a viewer is never an approver: a rule naming one routes to the client
        // admin, like a rule naming someone who left (ARCHITECTURE §4).
        eq(membership.canSign, true),
      ),
    );
  return {
    rules: set.rules,
    revision: set.revision,
    clientDefault: clientApproverSetting(settings),
    members: new Set(people.map((p) => p.userId)),
  };
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
          // v0.14 W4-A
          channels: row.a.channels,
          approver: row.a.approver,
        };
      });
    },

    resolveCustomSkill(tenantId, ref) {
      return withTenant(db, tenantId, (tx) => resolveCustomSkill(tx, { tenantId, ref }));
    },

    memoryNotes(tenantId, agentId, limit, scope = "agent"): Promise<MemoryNoteRecord[]> {
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
              // v0.16: one scope: the agent's own (`agent`, as knowledge search reads it), or one
              // the runtime keeps for itself (`browse`), which the model never gets as memory.
              eq(memoryNote.scope, scope),
              // Notes written by test runs are tagged and never read back.
              not(like(memoryNote.scope, `${MEMORY_TEST_SCOPE_PREFIX}%`)),
            ),
          )
          .orderBy(desc(memoryNote.createdAt), desc(memoryNote.id))
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

    grant(tenantId, agentId, connectionId) {
      return withTenant(
        db,
        tenantId,
        async (tx) => (await grantOf(tx, { tenantId, agentId, connectionId }))?.limits ?? null,
      );
    },

    // v0.12 W1-G: the recipient's autonomy for the channel (docs/plan.md §1.42).
    contactAutonomy(tenantId, recipient) {
      return withTenant(db, tenantId, async (tx) => {
        const column =
          recipient.channel === "email"
            ? contact.email
            : recipient.channel === "whatsapp"
              ? contact.whatsapp
              : contact.phone;
        const [row] = await tx
          .select({ autonomy: contact.autonomy })
          .from(contact)
          .where(and(eq(contact.tenantId, tenantId), eq(column, recipient.to)));
        return row ? autonomyFor(readAutonomy(row.autonomy), recipient.channel) : null;
      });
    },

    // v0.12 W1-A: go-live stages
    agentStage(tenantId, agentId) {
      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .select({ stage: agent.stage })
          .from(agent)
          .where(and(eq(agent.id, agentId), eq(agent.tenantId, tenantId)));
        return row?.stage ?? null;
      });
    },

    approvalRouting(tenantId) {
      return withTenant(db, tenantId, (tx) => approvalRoutingTx(tx, tenantId));
    },

    askTarget(tenantId, agentId) {
      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .select()
          .from(agent)
          .where(
            and(
              eq(agent.id, agentId),
              // Only this client's own agents: RLS and this filter both (invariant 1).
              eq(agent.tenantId, tenantId),
              eq(agent.kind, "client"),
              eq(agent.status, "active"),
              eq(agent.testCopy, false),
            ),
          );
        if (!row?.liveVersionId || row.runStatus === "retired") return null;
        return {
          agentId: row.id,
          agentVersionId: row.liveVersionId,
          name: row.serviceName ?? row.name,
        };
      });
    },

    // §1.77: a client agent's spend since the start of the month (the monthly cap).
    agentCostSince(tenantId, agentId, since) {
      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .select({ total: sql<string>`coalesce(sum(${run.costUsd}), 0)::text` })
          .from(run)
          .where(
            and(eq(run.tenantId, tenantId), eq(run.agentId, agentId), gte(run.createdAt, since)),
          );
        return row?.total ?? "0";
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
