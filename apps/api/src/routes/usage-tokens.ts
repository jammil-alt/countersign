// Tokens by client, agent, model and action (owner, 2026-11-06, kept 2026-11-16; docs/plan.md
// §1.115). Every model call a client's agents make in a run is a `model_call` row (Sloan's
// conversation and portal questions included), with its model and what it was for (`action`); the
// client's own model use no agent asked for is on its `doc_extraction` (background reading) and
// `message_translation` (background translation) rows. This report counts them from those rows for
// the back office: the account-level tally per client, and the same calls by agent, by model and by
// action. Operator only, like all cost (invariant 11); the portal never sees tokens.

import {
  ACCOUNT_AGENT_SLUG,
  Decimal,
  modelProvider,
  type TokenAction,
  type TokenFigures,
  type TokenReport,
  toNumeric,
} from "@countersign/core";
import {
  agent,
  docExtraction,
  messageTranslation,
  modelCall,
  run,
  type Tx,
  tenant,
} from "@countersign/db";
import { and, eq, gte, inArray, isNotNull, isNull, lt, type SQL, sql } from "drizzle-orm";

export interface TokenQuery {
  client?: string | undefined;
  agent?: string | undefined;
  template?: string | undefined;
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

/** One grouped row from any source, before names are joined. */
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

/** Whether the query asks for an action: none named, or this one. */
const wants = (query: TokenQuery, action: TokenAction) => !query.action || query.action === action;

// DECISION: counted on read from model_call, doc_extraction and message_translation, not rolled up
// into a table: the rows are the ledger already (insert only, one per call), grouped per client
// over an indexed (tenant_id, created_at), so the tally is always exact and needs no sweep. Days
// are UTC, as the usage rollup's are. A report narrowed to an agent or a template leaves out the
// background use, which is no agent's, as /api/ops/usage does.
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
  const lo = sql`((${query.from})::date)::timestamp at time zone 'UTC'`;
  const hi = sql`((${query.to})::date + 1)::timestamp at time zone 'UTC'`;
  const scope = [...tenantIds];
  const narrowed = Boolean(query.agent || query.template);
  const raws: Raw[] = [];

  // A run's model calls, each with its run's agent. RLS holds the scope; the query says it too.
  if (query.action !== "background_read" && query.action !== "background_translation") {
    const where: SQL[] = [
      inArray(modelCall.tenantId, scope),
      gte(modelCall.createdAt, lo),
      lt(modelCall.createdAt, hi),
    ];
    if (query.client) where.push(eq(modelCall.tenantId, query.client));
    if (query.agent) where.push(eq(run.agentId, query.agent));
    if (query.template) where.push(eq(agent.templateId, query.template));
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
      .innerJoin(agent, and(eq(agent.id, run.agentId), eq(agent.tenantId, run.tenantId)))
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

  // Reading no agent asked for (uploads, forwarded mail): no agent's, but the client's (§1.43).
  if (!narrowed && wants(query, "background_read")) {
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
      .where(
        and(
          inArray(docExtraction.tenantId, scope),
          isNull(docExtraction.agentVersionId),
          gte(docExtraction.createdAt, lo),
          lt(docExtraction.createdAt, hi),
          ...(query.client ? [eq(docExtraction.tenantId, query.client)] : []),
          ...(query.model ? [eq(docExtraction.model, query.model)] : []),
        ),
      )
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

  // P-7: translations no agent made (the background job, a person's own text) that called a
  // model; an agent's are its step's `tool_call` rows above (§1.69).
  if (!narrowed && wants(query, "background_translation")) {
    const rows = await tx
      .select({
        tenantId: messageTranslation.tenantId,
        model: sql<string>`${messageTranslation.model}`,
        calls: sql<string>`count(*)::text`,
        tokensIn: sql<string>`sum(${messageTranslation.tokensIn})::text`,
        tokensOut: sql<string>`sum(${messageTranslation.tokensOut})::text`,
        cost: sql<string>`sum(${messageTranslation.costUsd})::text`,
      })
      .from(messageTranslation)
      .where(
        and(
          inArray(messageTranslation.tenantId, scope),
          isNull(messageTranslation.agentVersionId),
          isNotNull(messageTranslation.model),
          gte(messageTranslation.createdAt, lo),
          lt(messageTranslation.createdAt, hi),
          ...(query.client ? [eq(messageTranslation.tenantId, query.client)] : []),
          ...(query.model ? [eq(messageTranslation.model, query.model)] : []),
        ),
      )
      .groupBy(messageTranslation.tenantId, messageTranslation.model);
    for (const r of rows) {
      raws.push({
        tenantId: r.tenantId,
        agentId: null,
        model: r.model,
        action: "background_translation",
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
          .where(and(inArray(agent.id, agentIds), inArray(agent.tenantId, scope)))
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
  // Background reading and translation are both no agent's: one line per client in "by agent".
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
        provider: modelProvider(r.model),
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
      .map(({ model, s }) => ({ provider: modelProvider(model), model, ...figures(s) })),
    byAction: [...byAction]
      .map(([action, s]) => ({ action, s, name: action }))
      .sort(byCost)
      .map(({ action, s }) => ({ action, ...figures(s) })),
  };
}
