// The evidence export and the rollup (docs/agent-assurance-plan.md §5, A4; §1.231.3): the stored
// security check results over a period, per agent and client, as a printable page and CSV, and per
// register control how many agents' checks were verified, across the clients the operator serves.
// Operator only; every request goes through mount(), which writes its audit row (invariant 14), and
// reads only the clients in the session's scope (`withTenants()`, invariant 1).

import {
  type AssuranceEvidence,
  assuranceRollup,
  assuranceRoutes,
  EVIDENCE_CSV_COLUMNS,
  EVIDENCE_ROWS_MAX,
  evidenceCsvValues,
  evidencePeriod,
  evidenceRow,
  type StoredCheckRow,
} from "@countersign/core";
import { agent, agentVersion, controlCheck, type Tx, tenant } from "@countersign/db";
import { and, asc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { csvFile } from "../exports/csv";
import { type AppEnv, HttpError, mount, mountFile, notFound } from "../http";

type Query = {
  from?: string | undefined;
  to?: string | undefined;
  client?: string | undefined;
  agent?: string | undefined;
};

function periodOf(q: Query, now: Date) {
  const p = evidencePeriod(q, now);
  if (!p) {
    throw new HttpError(
      400,
      "bad_period",
      "The period must start before it ends and be at most a year long",
    );
  }
  return p;
}

/** The clients to read: those served, narrowed to `client` when given (one not served: 404). */
function clientsOf(tenantIds: readonly string[], q: Query): string[] {
  if (q.client && !tenantIds.includes(q.client)) throw notFound("client");
  return q.client ? [q.client] : [...tenantIds];
}

async function storedRows(
  tx: Tx,
  clients: readonly string[],
  period: { start: Date; end: Date },
  agentId: string | undefined,
  limit: number,
): Promise<StoredCheckRow[]> {
  if (clients.length === 0) return [];
  const rows = await tx
    .select({
      c: controlCheck,
      clientName: tenant.name,
      agentName: sql<string>`coalesce(${agent.serviceName}, ${agent.name})`,
      version: agentVersion.version,
    })
    .from(controlCheck)
    .innerJoin(tenant, eq(tenant.id, controlCheck.tenantId))
    .innerJoin(
      agent,
      and(eq(agent.id, controlCheck.agentId), eq(agent.tenantId, controlCheck.tenantId)),
    )
    .leftJoin(agentVersion, eq(agentVersion.id, controlCheck.agentVersionId))
    .where(
      and(
        inArray(controlCheck.tenantId, [...clients]),
        ...(agentId ? [eq(controlCheck.agentId, agentId)] : []),
        gte(controlCheck.checkedAt, period.start),
        lt(controlCheck.checkedAt, period.end),
      ),
    )
    .orderBy(asc(tenant.name), asc(agent.name), asc(controlCheck.checkedAt), asc(controlCheck.id))
    .limit(limit);
  return rows.map(({ c, clientName, agentName, version }) => ({
    id: c.id,
    tenantId: c.tenantId as string,
    clientName,
    agentId: c.agentId,
    agentName,
    version: version ?? null,
    checkId: c.checkId,
    kind: c.kind,
    controls: c.controls,
    result: c.result,
    found: c.found,
    evidence: c.evidence,
    periodStart: c.periodStart,
    periodEnd: c.periodEnd,
    checkedAt: c.checkedAt,
    trigger: c.trigger,
    issueId: c.issueId,
  }));
}

async function evidence(
  tx: Tx,
  tenantIds: readonly string[],
  q: Query,
): Promise<AssuranceEvidence> {
  const now = new Date();
  const period = periodOf(q, now);
  const rows = await storedRows(
    tx,
    clientsOf(tenantIds, q),
    period,
    q.agent,
    EVIDENCE_ROWS_MAX + 1,
  );
  return {
    period: { start: period.start.toISOString(), end: period.end.toISOString() },
    rows: rows.slice(0, EVIDENCE_ROWS_MAX).map(evidenceRow),
    truncated: rows.length > EVIDENCE_ROWS_MAX,
    generatedAt: now.toISOString(),
  };
}

export function assuranceEvidenceRouteHandlers(app: Hono<AppEnv>): void {
  mount(app, assuranceRoutes.opsAssuranceEvidence, ({ tx, tenantIds, query }) =>
    evidence(tx, tenantIds, query),
  );

  mountFile(app, assuranceRoutes.opsAssuranceEvidenceCsv, async ({ tx, tenantIds, query }) => {
    const out = await evidence(tx, tenantIds, query);
    const bytes = csvFile(
      [...EVIDENCE_CSV_COLUMNS],
      out.rows.map((r) => evidenceCsvValues(r)),
    );
    const from = out.period.start.slice(0, 10);
    const to = new Date(new Date(out.period.end).getTime() - 1).toISOString().slice(0, 10);
    return {
      filename: `mezonas-security-evidence-${from}-to-${to}.csv`,
      contentType: "text/csv; charset=utf-8" as const,
      bytes,
    };
  });

  mount(app, assuranceRoutes.opsAssuranceRollup, async ({ tx, tenantIds, query }) => {
    const now = new Date();
    const period = periodOf(query, now);
    // Every result of the period counts toward the rollup; it reads only the three columns it needs.
    const rows =
      tenantIds.length === 0
        ? []
        : await tx
            .select({
              tenantId: controlCheck.tenantId,
              agentId: controlCheck.agentId,
              controls: controlCheck.controls,
              result: controlCheck.result,
            })
            .from(controlCheck)
            .where(
              and(
                inArray(controlCheck.tenantId, [...tenantIds]),
                gte(controlCheck.checkedAt, period.start),
                lt(controlCheck.checkedAt, period.end),
              ),
            );
    return {
      period: { start: period.start.toISOString(), end: period.end.toISOString() },
      clients: new Set(rows.map((r) => r.tenantId)).size,
      agents: new Set(rows.map((r) => r.agentId)).size,
      controls: assuranceRollup(rows),
      generatedAt: now.toISOString(),
    };
  });
}
