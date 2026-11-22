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
  UNRECORDED_MODEL,
} from "@countersign/core";
import { agent, type Tx, tenant } from "@countersign/db";
import { and, inArray } from "drizzle-orm";
import { isBackOffice, spendLines } from "./usage-spend";

/** A model's provider; empty for the steps' usage no call record names a model for. */
const providerOf = (model: string) => (model === UNRECORDED_MODEL ? "" : modelProvider(model));

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

/** Whether the query asks for an action: none named, or this one. */
const wants = (query: TokenQuery, action: TokenAction) => !query.action || query.action === action;

// DECISION: counted on read from model_call, doc_extraction and message_translation, not rolled up
// into a table: the rows are the ledger already (insert only, one per call), grouped per client
// over an indexed (tenant_id, created_at), so the tally is always exact and needs no sweep. Days
// are UTC, as the usage rollup's are. A report narrowed to an agent or a template leaves out the
// background use, which is no agent's, as /api/ops/usage does.
// DECISION (QA usage costs): read through `spendLines`, the one ledger /api/ops/usage sums too, so
// a client's tokens and cost here are its row there. A step's usage beyond its recorded calls is
// its agent's `unrecorded` line (no model). The back office's spend (Reggie, the Builder) records
// no tokens and is no client's: it is in the usage report, not here.
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
  const scope = [...tenantIds];
  const raws: Raw[] = [];
  const merged = new Map<string, Raw>();
  for (const l of await spendLines(tx, scope, query)) {
    if (isBackOffice(l) || !l.tenantId || !l.action) continue;
    if (query.model !== undefined && l.model !== query.model) continue;
    if (!wants(query, l.action)) continue;
    // One row per client, agent, model and action over the whole range.
    const key = `${l.tenantId}:${l.agentId ?? ""}:${l.model}:${l.action}`;
    const r = merged.get(key) ?? {
      tenantId: l.tenantId,
      agentId: l.agentId,
      model: l.model,
      action: l.action,
      s: zero(),
    };
    add(r.s, { calls: l.calls, tokensIn: l.tokensIn, tokensOut: l.tokensOut, cost: l.cost });
    merged.set(key, r);
  }
  raws.push(...merged.values());
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
