// The health tools' reads (HealthPort, docs/plan.md §1.28) over the database: one client's runs,
// connections, waiting items and agents, each call one client-scoped transaction, so only that
// client's rows are visible (invariant 1). Nothing here writes.

import { BrowserConnectionState, fingerprintOf, isPlainObject } from "@countersign/core";
import {
  agent,
  agentVersion,
  connection,
  connectionChange,
  type Db,
  inboxItem,
  run,
  withTenant,
} from "@countersign/db";
import { and, desc, eq, gte, inArray, ne, or, sql } from "drizzle-orm";
import type { HealthAgent, HealthConnection, HealthPort, HealthRun } from "../tools/types";

export interface HealthPortOptions {
  /** A connector id's display name (apps/api passes the registry's); default the id. */
  connectorName?: (connectorId: string) => string;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function runError(error: unknown): { step: string | null; message: string | null } {
  if (!isPlainObject(error)) return { step: null, message: null };
  const step = typeof error.nodeId === "string" ? error.nodeId : null;
  const message =
    typeof error.reason === "string"
      ? error.reason
      : typeof error.message === "string"
        ? error.message
        : null;
  return { step, message };
}

/** A connection's change log entries that say it needed a person. */
const ATTENTION_KINDS = ["needs_attention", "browser_stopped"];

export function dbHealthPort(db: Db, options: HealthPortOptions = {}): HealthPort {
  const nameOf = options.connectorName ?? ((id: string) => id);
  return {
    runs(tenantId, input) {
      return withTenant(db, tenantId, async (tx) => {
        const since = new Date(Date.now() - input.sinceHours * 3_600_000);
        const rows = await tx
          .select({ r: run, name: agent.name, serviceName: agent.serviceName })
          .from(run)
          .innerJoin(agent, and(eq(agent.id, run.agentId), eq(agent.tenantId, run.tenantId)))
          .where(
            and(
              eq(run.tenantId, tenantId),
              gte(run.createdAt, since),
              input.failedOnly ? eq(run.status, "failed") : undefined,
              input.agentId ? eq(run.agentId, input.agentId) : undefined,
            ),
          )
          .orderBy(desc(run.createdAt))
          .limit(input.limit);
        return rows.map(({ r, name, serviceName }): HealthRun => {
          const e = r.status === "failed" ? runError(r.error) : { step: null, message: null };
          return {
            id: r.id,
            agentId: r.agentId,
            agentName: serviceName ?? name,
            agentVersionId: r.agentVersionId,
            workflowSlug: r.workflowSlug,
            mode: r.mode,
            status: r.status,
            createdAt: r.createdAt.toISOString(),
            finishedAt: iso(r.finishedAt),
            failedStep: e.step,
            error: e.message,
          };
        });
      });
    },

    connections(tenantId) {
      return withTenant(db, tenantId, async (tx) => {
        const rows = await tx
          .select()
          .from(connection)
          .where(eq(connection.tenantId, tenantId))
          .orderBy(connection.connector);
        if (rows.length === 0) return [];
        const agents = await tx
          .select({
            name: agent.name,
            serviceName: agent.serviceName,
            bindings: agent.bindings,
          })
          .from(agent)
          .where(
            and(
              eq(agent.tenantId, tenantId),
              eq(agent.kind, "client"),
              eq(agent.status, "active"),
              eq(agent.testCopy, false),
              or(sql`${agent.runStatus} is null`, ne(agent.runStatus, "retired")),
            ),
          );
        const changes = await tx
          .select({
            connectionId: connectionChange.connectionId,
            change: connectionChange.change,
            createdAt: connectionChange.createdAt,
          })
          .from(connectionChange)
          .where(
            and(
              eq(connectionChange.tenantId, tenantId),
              inArray(
                connectionChange.connectionId,
                rows.map((r) => r.id),
              ),
              inArray(sql<string>`${connectionChange.change}->>'kind'`, ATTENTION_KINDS),
            ),
          )
          .orderBy(desc(connectionChange.createdAt));
        return rows.map((c): HealthConnection => {
          const config = (c.config ?? {}) as Record<string, unknown>;
          const state = BrowserConnectionState.safeParse(config.browserState);
          const last = changes.find((ch) => ch.connectionId === c.id);
          const change = (last?.change ?? {}) as Record<string, unknown>;
          const name = nameOf(c.connector);
          return {
            id: c.id,
            connector: c.connector,
            connectorName: name,
            label: typeof config.site === "string" && config.site ? config.site : name,
            status: c.status,
            lastSyncAt: iso(c.lastSyncAt),
            stopped: state.success ? state.data.stopped : null,
            attention: last
              ? {
                  reason:
                    change.kind === "browser_stopped"
                      ? "login_stopped"
                      : String(change.reason ?? "needs_attention"),
                  at: last.createdAt.toISOString(),
                }
              : null,
            usedBy: agents
              .filter((a) => Object.values(a.bindings).includes(c.id))
              .map((a) => a.serviceName ?? a.name),
          };
        });
      });
    },

    inbox(tenantId, input) {
      return withTenant(db, tenantId, async (tx) => {
        const rows = await tx
          .select()
          .from(inboxItem)
          .where(and(eq(inboxItem.tenantId, tenantId), eq(inboxItem.status, "open")))
          .orderBy(inboxItem.createdAt)
          .limit(500);
        return rows.map((i) => ({
          id: i.id,
          kind: i.kind,
          title: i.title,
          assignee: i.assigneeRole === "operator" ? ("operator" as const) : ("client" as const),
          subjectType: i.subjectType,
          createdAt: i.createdAt.toISOString(),
          waitingHours: Math.max(
            0,
            Math.floor((input.now.getTime() - i.createdAt.getTime()) / 3_600_000),
          ),
          finding: fingerprintOf(i.payload) !== null,
        }));
      });
    },

    agents(tenantId) {
      return withTenant(db, tenantId, async (tx) => {
        const rows = await tx
          .select({ a: agent, version: agentVersion.version })
          .from(agent)
          .leftJoin(
            agentVersion,
            and(
              eq(agentVersion.id, agent.liveVersionId),
              eq(agentVersion.tenantId, agent.tenantId),
            ),
          )
          .where(
            and(
              eq(agent.tenantId, tenantId),
              eq(agent.kind, "client"),
              eq(agent.status, "active"),
              eq(agent.testCopy, false),
            ),
          )
          .orderBy(agent.slug);
        const out: HealthAgent[] = [];
        for (const { a, version } of rows) {
          const last = async (mode: "live" | "test") => {
            const [r] = await tx
              .select({ id: run.id, status: run.status, at: run.createdAt })
              .from(run)
              .where(and(eq(run.tenantId, tenantId), eq(run.agentId, a.id), eq(run.mode, mode)))
              .orderBy(desc(run.createdAt))
              .limit(1);
            return r ? { id: r.id, status: r.status, at: r.at.toISOString() } : null;
          };
          out.push({
            id: a.id,
            slug: a.slug,
            name: a.serviceName ?? a.name,
            runStatus: a.runStatus,
            liveVersionId: a.liveVersionId,
            liveVersion: version ?? null,
            lastRun: await last("live"),
            lastTest: await last("test"),
          });
        }
        return out;
      });
    },
  };
}
