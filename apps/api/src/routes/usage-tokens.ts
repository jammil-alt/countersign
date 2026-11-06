// Tokens by client, agent, model and action (owner, 2026-11-06; docs/plan.md §1.62). Every model
// call a client's agents make is a `model_call` row (Sloan's conversation and portal questions
// included), with its model and what it was for (`action`); reading no agent asked for is on its
// `doc_extraction` row. This report counts them from those rows for the back office: the
// account-level tally per client, and the same calls by agent, by model and by action. Operator
// only, like all cost (invariant 11); the portal never sees tokens.

import {
  ACCOUNT_AGENT_SLUG,
  Decimal,
  type TokenAction,
  type TokenFigures,
  type TokenReport,
  toNumeric,
} from "@countersign/core";
import { agent, docExtraction, modelCall, run, type Tx, tenant } from "@countersign/db";
import { providerOf } from "@countersign/llm";
import { and, eq, gte, inArray, isNull, lt, type SQL, sql } from "drizzle-orm";

export interface TokenQuery {
  client?: string | undefined;
  agent?: string | undefined;
  model?: string | undefined;
  action?: TokenAction | undefined;
  /** Inclusive UTC days. */
  from: string;
  to: string;
}

interface Sum {
  calls: number;
  tokensIn: number;
  tokensOut: number;
  cost: Decimal;
}

const zero = (): Sum => ({ calls: 0, tokensIn: 0, tokensOut: 0, cost: new Decimal(0) });

function add(into: Sum, x: Sum): void {
  into.calls += x.calls;
  into.tokensIn += x.tokensIn;
  into.tokensOut += x.tokensOut;
  into.cost = into.cost.plus(x.cost);
}

const figures = (s: Sum): TokenFigures => ({
  calls: s.calls,
  tokensIn: s.tokensIn,
  tokensOut: s.tokensOut,
  costUsd: toNumeric(s.cost),
});

/** Highest cost first, then most tokens, then by name. */
function byCost<T extends { s: Sum; name: string }>(a: T, b: T): number {
  return (
    b.s.cost.comparedTo(a.s.cost) ||
    b.s.tokensIn + b.s.tokensOut - (a.s.tokensIn + a.s.tokensOut) ||
    a.name.localeCompare(b.name)
  );
}

/** One grouped row from either source, before names are joined. */
interface Raw {
  tenantId: string;
  agentId: string | null;
  model: string;
  action: TokenAction;
  s: Sum;
}

const sumOf = (r: {
  calls: string;
  tokensIn: string | null;
  tokensOut: string | null;
  cost: string | null;
}): Sum => ({
  calls: Number(r.calls),
  tokensIn: Number(r.tokensIn ?? 0),
  tokensOut: Number(r.tokensOut ?? 0),
  cost: new Decimal(r.cost ?? "0"),
});

/** The day after `day`, as midnight UTC: ranges are inclusive days, compared as instants. */
function endOf(day: string): Date {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

// DECISION: counted on read from model_call and doc_extraction, not rolled up into a table: the
// rows are the ledger already (insert only, one per call), grouped per client over an indexed
// (tenant_id, created_at), so the tally is always exact and needs no sweep. Days are UTC, as the
// usage rollup's are.
export async function tokenReport(
  tx: Tx,
  tenantIds: readonly string[],
  query: TokenQuery,
): Promise<TokenReport> {
  const empty: TokenReport = {
    from: query.from,
    to: query.to,
    total: figures(zero()),
    rows: [],
    byClient: [],
    byAgent: [],
    byModel: [],
    byAction: [],
  };
  if (tenantIds.length === 0) return empty;
  const start = new Date(`${query.from}T00:00:00.000Z`);
  const end = endOf(query.to);
  const raws: Raw[] = [];

  // Model calls, each with its run's agent. RLS holds the scope; the query says it too.
  if (query.action !== "background_read") {
    const where: SQL[] = [
      inArray(modelCall.tenantId, [...tenantIds]),
      gte(modelCall.createdAt, start),
      lt(modelCall.createdAt, end),
    ];
    if (query.client) where.push(eq(modelCall.tenantId, query.client));
    if (query.agent) where.push(eq(run.agentId, query.agent));
    if (query.model) where.push(eq(modelCall.model, query.model));
    if (query.action) where.push(eq(modelCall.action, query.action));
    const rows = await tx
      .select({
        tenantId: modelCall.tenantId,
        agentId: run.agentId,
        model: modelCall.model,
        action: modelCall.action,
        calls: sql<string>`count(*)::text`,
        tokensIn: sql<string>`sum(${modelCall.tokensIn})::text`,
        tokensOut: sql<string>`sum(${modelCall.tokensOut})::text`,
        cost: sql<string>`sum(${modelCall.costUsd})::text`,
      })
      .from(modelCall)
      .innerJoin(run, and(eq(run.id, modelCall.runId), eq(run.tenantId, modelCall.tenantId)))
      .where(and(...where))
      .groupBy(modelCall.tenantId, run.agentId, modelCall.model, modelCall.action);
    for (const r of rows) {
      raws.push({
        tenantId: r.tenantId,
        agentId: r.agentId,
        model: r.model,
        action: r.action as TokenAction,
        s: sumOf(r),
      });
    }
  }

  // Reading no agent asked for: no agent's, but the client's (plan §1.43).
  if (!query.agent && (!query.action || query.action === "background_read")) {
    const where: SQL[] = [
      inArray(docExtraction.tenantId, [...tenantIds]),
      isNull(docExtraction.agentVersionId),
      gte(docExtraction.createdAt, start),
      lt(docExtraction.createdAt, end),
    ];
    if (query.client) where.push(eq(docExtraction.tenantId, query.client));
    if (query.model) where.push(eq(docExtraction.model, query.model));
    const rows = await tx
      .select({
        tenantId: docExtraction.tenantId,
        model: docExtraction.model,
        calls: sql<string>`count(*)::text`,
        tokensIn: sql<string>`sum(${docExtraction.tokensIn})::text`,
        tokensOut: sql<string>`sum(${docExtraction.tokensOut})::text`,
        cost: sql<string>`sum(${docExtraction.costUsd})::text`,
      })
      .from(docExtraction)
      .where(and(...where))
      .groupBy(docExtraction.tenantId, docExtraction.model);
    for (const r of rows) {
      raws.push({
        tenantId: r.tenantId,
        agentId: null,
        model: r.model,
        action: "background_read",
        s: sumOf(r),
      });
    }
  }
  if (raws.length === 0) return empty;

  const clientIds = [...new Set(raws.map((r) => r.tenantId))];
  const agentIds = [...new Set(raws.flatMap((r) => (r.agentId ? [r.agentId] : [])))];
  const clients = await tx
    .select({ id: tenant.id, name: tenant.name })
    .from(tenant)
    .where(inArray(tenant.id, clientIds));
  const agents =
    agentIds.length > 0
      ? await tx
          .select({ id: agent.id, slug: agent.slug, name: agent.name })
          .from(agent)
          .where(and(inArray(agent.id, agentIds), inArray(agent.tenantId, [...tenantIds])))
      : [];
  const clientOf = new Map(clients.map((c) => [c.id, { id: c.id, name: c.name }]));
  const agentOf = new Map(
    agents.map((a) => [
      a.id,
      { id: a.id, slug: a.slug, name: a.name, account: a.slug === ACCOUNT_AGENT_SLUG },
    ]),
  );
  const clientRef = (id: string) => clientOf.get(id) ?? { id, name: "" };
  const agentRef = (id: string | null) =>
    id === null ? null : (agentOf.get(id) ?? { id, slug: "", name: "", account: false });

  const total = zero();
  const byClient = new Map<string, Sum>();
  const byAgent = new Map<string, { tenantId: string; agentId: string | null; s: Sum }>();
  const byModel = new Map<string, Sum>();
  const byAction = new Map<TokenAction, Sum>();
  const bump = <K>(map: Map<K, Sum>, key: K, s: Sum) => {
    const into = map.get(key) ?? zero();
    add(into, s);
    map.set(key, into);
  };
  for (const r of raws) {
    add(total, r.s);
    bump(byClient, r.tenantId, r.s);
    const agentKey = `${r.tenantId}:${r.agentId ?? ""}`;
    const a = byAgent.get(agentKey) ?? { tenantId: r.tenantId, agentId: r.agentId, s: zero() };
    add(a.s, r.s);
    byAgent.set(agentKey, a);
    bump(byModel, r.model, r.s);
    bump(byAction, r.action, r.s);
  }

  return {
    from: query.from,
    to: query.to,
    total: figures(total),
    rows: raws
      .map((r) => ({ r, s: r.s, name: `${clientRef(r.tenantId).name} ${r.model} ${r.action}` }))
      .sort(byCost)
      .map(({ r }) => ({
        client: clientRef(r.tenantId),
        agent: agentRef(r.agentId),
        provider: providerOf(r.model),
        model: r.model,
        action: r.action,
        ...figures(r.s),
      })),
    byClient: [...byClient]
      .map(([id, s]) => ({ id, s, name: clientRef(id).name }))
      .sort(byCost)
      .map(({ id, s }) => ({ ...clientRef(id), ...figures(s) })),
    byAgent: [...byAgent.values()]
      .map((a) => ({ ...a, name: agentRef(a.agentId)?.name ?? "" }))
      .sort(byCost)
      .map((a) => ({
        client: clientRef(a.tenantId),
        agent: agentRef(a.agentId),
        ...figures(a.s),
      })),
    byModel: [...byModel]
      .map(([model, s]) => ({ model, s, name: model }))
      .sort(byCost)
      .map(({ model, s }) => ({ provider: providerOf(model), model, ...figures(s) })),
    byAction: [...byAction]
      .map(([action, s]) => ({ action, s, name: action }))
      .sort(byCost)
      .map(({ action, s }) => ({ action, ...figures(s) })),
  };
}
