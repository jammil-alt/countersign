// QA (usage costs, 2026-11-22): the one ledger of model spend the back office reads. The owner
// found Usage's figures disagreeing ($36.42 model cost against $0.71 by vendor and by model; a
// client at $0.90 in one table and $0.68 in another; Home at $0.00 after a talk with Reggie):
// the total came from the usage_daily rollup (step rows, swept hourly) plus usage_platform_daily
// (which also holds providers' fees), By model from the model_call rows, tokens from model_call,
// doc_extraction and message_translation, and Home from the step rows; Reggie's and the
// Builder's calls were in none of them. Every cost and token figure of /api/ops/usage, its
// tokens report and Home's spend today now sums from the lines below, over the same UTC days and
// the same filters, so they agree.
//
// The lines, each grouped by client, agent, model, action and UTC day:
// - `run`: a run's model calls (`model_call`), test runs included (they cost the same);
// - `unrecorded`: a step's tokens and cost beyond its recorded calls (steps from before call
//   records, or a call whose row was not written; run-controls' `unrecordedUsage`), on the day
//   the step started, so nothing a step spent is lost and nothing is counted twice;
// - `background_read` and `background_translation`: the clients' own reading and translation no
//   agent asked for (`doc_extraction`, `message_translation` with no agent version);
// - `reggie`, `builder` and `build`: the back office's calls outside any run (Reggie's answers,
//   the Builder's turns, the build flow's answers), which record a cost but no tokens.
// Providers' fees passed on to a client (A2P registration) are money, not model spend: they are
// read on their own (`providerFees`) for the vendor split.

import {
  type BackOfficeSpend,
  Decimal,
  PROVIDER_FEE_ENTITY,
  type TokenAction,
} from "@countersign/core";
import {
  agent,
  build,
  builderTurn,
  buildMessage,
  docExtraction,
  messageTranslation,
  modelCall,
  rawRecord,
  reggieConversation,
  reggieMessage,
  run,
  type Tx,
} from "@countersign/db";
import {
  and,
  type Column,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  type SQL,
  sql,
} from "drizzle-orm";

export type SpendSource =
  | "run"
  | "unrecorded"
  | "background_read"
  | "background_translation"
  | BackOfficeSpend;

export const BACK_OFFICE_SOURCES: readonly SpendSource[] = ["reggie", "builder", "build"];

/** One grouped line of model spend. */
export interface SpendLine {
  source: SpendSource;
  /** Null for back-office spend on no client. */
  tenantId: string | null;
  /** The run's agent; null for the clients' own use and the back office's. */
  agentId: string | null;
  /** The model; empty when no record names one (`unrecorded`, some back-office answers). */
  model: string;
  /** The token report's action; null for the back office's. */
  action: TokenAction | null;
  /** `YYYY-MM-DD`, UTC. */
  day: string;
  calls: number;
  /** Calls that used tokens but were recorded at no cost (a model with no price). */
  unpricedCalls: number;
  tokensIn: number;
  tokensOut: number;
  cost: Decimal;
}

export interface SpendQuery {
  client?: string | undefined;
  agent?: string | undefined;
  template?: string | undefined;
  /** Inclusive UTC days. */
  from: string;
  to: string;
}

export const isBackOffice = (l: Pick<SpendLine, "source">) =>
  BACK_OFFICE_SOURCES.includes(l.source);

const utcDay = (c: Column | SQL) => sql<string>`to_char(${c} at time zone 'UTC', 'YYYY-MM-DD')`;

const bounds = (q: SpendQuery) => ({
  lo: sql`((${q.from})::date)::timestamp at time zone 'UTC'`,
  hi: sql`((${q.to})::date + 1)::timestamp at time zone 'UTC'`,
});

/** A cost kept in a jsonb `meta`, when it is a decimal string. */
const metaCost = (meta: Column) =>
  sql`case when jsonb_typeof(${meta} -> 'costUsd') = 'string'
            and ${meta} ->> 'costUsd' ~ '^[0-9]+(\\.[0-9]+)?$'
           then (${meta} ->> 'costUsd')::numeric end`;

const n = (v: string | number | null | undefined) => Number(v ?? 0);
const d = (v: string | null | undefined) => new Decimal(v ?? "0");

/**
 * Every line of model spend in the range, for the clients in `tenantIds` (RLS holds the scope;
 * the queries say it too, invariant 1). Narrowed to an agent or a template, only that agent's
 * runs: the clients' own use and the back office's are no agent's. Narrowed to a client, the back
 * office's spend opened on that client (a Reggie conversation, a Builder session or a build of
 * it).
 */
// DECISION: counted on read from the call-level rows, as the tokens report already was: they are
// the ledger (insert only, one per call or step), always exact, with no sweep to wait for. The
// rollups keep the counts (runs, steps, documents, changes) and billing.
// DECISION: the back office's spend has no client in the report (it is ours, never a client's),
// even when opened on one; narrowed to that client it shows as the back office's own line.
export async function spendLines(
  tx: Tx,
  tenantIds: readonly string[],
  query: SpendQuery,
): Promise<SpendLine[]> {
  if (tenantIds.length === 0) return [];
  const scope = [...tenantIds];
  const { lo, hi } = bounds(query);
  const narrowed = Boolean(query.agent || query.template);
  const lines: SpendLine[] = [];

  // A run's model calls, each with its run's agent.
  {
    const day = utcDay(modelCall.createdAt);
    const where: SQL[] = [
      inArray(modelCall.tenantId, scope),
      gte(modelCall.createdAt, lo),
      lt(modelCall.createdAt, hi),
    ];
    if (query.client) where.push(eq(modelCall.tenantId, query.client));
    if (query.agent) where.push(eq(run.agentId, query.agent));
    if (query.template) where.push(eq(agent.templateId, query.template));
    const rows = await tx
      .select({
        tenantId: modelCall.tenantId,
        agentId: run.agentId,
        model: modelCall.model,
        action: modelCall.action,
        day,
        calls: sql<string>`count(*)::text`,
        unpriced: sql<string>`(count(*) filter (where ${modelCall.costUsd} = 0 and ${modelCall.tokensIn} + ${modelCall.tokensOut} > 0))::text`,
        tokensIn: sql<string>`sum(${modelCall.tokensIn})::text`,
        tokensOut: sql<string>`sum(${modelCall.tokensOut})::text`,
        cost: sql<string>`sum(${modelCall.costUsd})::text`,
      })
      .from(modelCall)
      .innerJoin(run, and(eq(run.id, modelCall.runId), eq(run.tenantId, modelCall.tenantId)))
      .innerJoin(agent, and(eq(agent.id, run.agentId), eq(agent.tenantId, run.tenantId)))
      .where(and(...where))
      .groupBy(modelCall.tenantId, run.agentId, modelCall.model, modelCall.action, day);
    for (const r of rows) {
      lines.push({
        source: "run",
        tenantId: r.tenantId,
        agentId: r.agentId,
        model: r.model,
        action: r.action as TokenAction,
        day: r.day,
        calls: n(r.calls),
        unpricedCalls: n(r.unpriced),
        tokensIn: n(r.tokensIn),
        tokensOut: n(r.tokensOut),
        cost: d(r.cost),
      });
    }
  }

  // A step's usage beyond its recorded calls, on the day the step started. Its calls are summed
  // whenever they were made (a call comes after its step starts, hence `>= lo`).
  {
    const ids = sql.join(
      scope.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    const at = sql`coalesce(sr.started_at, r.created_at)`;
    const rows = await tx.execute<{
      tenant_id: string;
      agent_id: string;
      day: string;
      steps: string;
      tokens_in: string;
      tokens_out: string;
      cost: string;
    }>(sql`
      with calls as (
        select mc.step_run_id, mc.tenant_id,
               sum(mc.tokens_in) as tokens_in, sum(mc.tokens_out) as tokens_out,
               sum(mc.cost_usd) as cost
          from model_call mc
         where mc.tenant_id in (${ids}) and mc.created_at >= ${lo}
         group by mc.step_run_id, mc.tenant_id
      ),
      gaps as (
        select r.tenant_id, r.agent_id, to_char(${at} at time zone 'UTC', 'YYYY-MM-DD') as day,
               greatest(sr.tokens_in - coalesce(c.tokens_in, 0), 0) as tokens_in,
               greatest(sr.tokens_out - coalesce(c.tokens_out, 0), 0) as tokens_out,
               greatest(sr.cost_usd - coalesce(c.cost, 0), 0) as cost
          from step_run sr
          join run r on r.id = sr.run_id and r.tenant_id = sr.tenant_id
          join agent a on a.id = r.agent_id and a.tenant_id = r.tenant_id
          left join calls c on c.step_run_id = sr.id and c.tenant_id = sr.tenant_id
         where sr.tenant_id in (${ids}) and ${at} >= ${lo} and ${at} < ${hi}
           ${query.client ? sql`and sr.tenant_id = ${query.client}::uuid` : sql``}
           ${query.agent ? sql`and r.agent_id = ${query.agent}::uuid` : sql``}
           ${query.template ? sql`and a.template_id = ${query.template}::uuid` : sql``}
      )
      select tenant_id, agent_id, day, count(*)::text as steps,
             sum(tokens_in)::text as tokens_in, sum(tokens_out)::text as tokens_out,
             sum(cost)::text as cost
        from gaps
       where tokens_in > 0 or tokens_out > 0 or cost > 0
       group by tenant_id, agent_id, day
    `);
    for (const r of rows) {
      lines.push({
        source: "unrecorded",
        tenantId: r.tenant_id,
        agentId: r.agent_id,
        model: "",
        action: "unrecorded",
        day: r.day,
        calls: 0,
        unpricedCalls: 0,
        tokensIn: n(r.tokens_in),
        tokensOut: n(r.tokens_out),
        cost: d(r.cost),
      });
    }
  }
  if (narrowed) return lines;

  // Reading no agent asked for (uploads, forwarded mail): the client's own (§1.43).
  {
    const day = utcDay(docExtraction.createdAt);
    const rows = await tx
      .select({
        tenantId: docExtraction.tenantId,
        model: docExtraction.model,
        day,
        calls: sql<string>`count(*)::text`,
        unpriced: sql<string>`(count(*) filter (where ${docExtraction.costUsd} = 0 and ${docExtraction.tokensIn} + ${docExtraction.tokensOut} > 0))::text`,
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
        ),
      )
      .groupBy(docExtraction.tenantId, docExtraction.model, day);
    for (const r of rows) {
      lines.push({
        source: "background_read",
        tenantId: r.tenantId,
        agentId: null,
        model: r.model,
        action: "background_read",
        day: r.day,
        calls: n(r.calls),
        unpricedCalls: n(r.unpriced),
        tokensIn: n(r.tokensIn),
        tokensOut: n(r.tokensOut),
        cost: d(r.cost),
      });
    }
  }

  // P-7: translations no agent made that called a model; an agent's are its step's (§1.69).
  {
    const day = utcDay(messageTranslation.createdAt);
    const rows = await tx
      .select({
        tenantId: messageTranslation.tenantId,
        model: sql<string>`${messageTranslation.model}`,
        day,
        calls: sql<string>`count(*)::text`,
        unpriced: sql<string>`(count(*) filter (where ${messageTranslation.costUsd} = 0 and ${messageTranslation.tokensIn} + ${messageTranslation.tokensOut} > 0))::text`,
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
        ),
      )
      .groupBy(messageTranslation.tenantId, messageTranslation.model, day);
    for (const r of rows) {
      lines.push({
        source: "background_translation",
        tenantId: r.tenantId,
        agentId: null,
        model: r.model,
        action: "background_translation",
        day: r.day,
        calls: n(r.calls),
        unpricedCalls: n(r.unpriced),
        tokensIn: n(r.tokensIn),
        tokensOut: n(r.tokensOut),
        cost: d(r.cost),
      });
    }
  }

  lines.push(...(await backOfficeLines(tx, scope, query)));
  return lines;
}

/** The back office's model spend outside runs: Reggie, the Builder and builds. */
async function backOfficeLines(tx: Tx, scope: string[], query: SpendQuery): Promise<SpendLine[]> {
  const { lo, hi } = bounds(query);
  /** A row's client: none, or one this session serves (RLS holds it; the query says it too). */
  const clientOf = (c: Column) =>
    query.client ? eq(c, query.client) : (or(isNull(c), inArray(c, scope)) as SQL);
  const out: SpendLine[] = [];
  const push = (
    source: BackOfficeSpend,
    rows: { tenantId: string | null; model: string | null; day: string; n: string; cost: string }[],
  ) => {
    for (const r of rows) {
      out.push({
        source,
        tenantId: r.tenantId,
        agentId: null,
        model: r.model ?? "",
        action: null,
        day: r.day,
        calls: n(r.n),
        unpricedCalls: 0,
        tokensIn: 0,
        tokensOut: 0,
        cost: d(r.cost),
      });
    }
  };

  // Reggie's answers: each holds what its model calls cost (`meta.costUsd`) and the model.
  {
    const day = utcDay(reggieMessage.createdAt);
    const cost = metaCost(reggieMessage.meta);
    const model = sql<string | null>`${reggieMessage.meta} ->> 'model'`;
    push(
      "reggie",
      await tx
        .select({
          tenantId: reggieConversation.clientId,
          model,
          day,
          n: sql<string>`count(*)::text`,
          cost: sql<string>`sum(${cost})::text`,
        })
        .from(reggieMessage)
        .innerJoin(reggieConversation, eq(reggieConversation.id, reggieMessage.conversationId))
        .where(
          and(
            eq(reggieMessage.role, "reggie"),
            sql`${cost} > 0`,
            gte(reggieMessage.createdAt, lo),
            lt(reggieMessage.createdAt, hi),
            clientOf(reggieConversation.clientId),
          ),
        )
        .groupBy(reggieConversation.clientId, model, day),
    );
  }

  // The Builder's turns on an agent or a skill (a template's, or a client's).
  {
    const day = utcDay(builderTurn.createdAt);
    const model = sql<string | null>`${builderTurn.meta} ->> 'model'`;
    push(
      "builder",
      await tx
        .select({
          tenantId: builderTurn.tenantId,
          model,
          day,
          n: sql<string>`count(*)::text`,
          cost: sql<string>`sum(${builderTurn.costUsd})::text`,
        })
        .from(builderTurn)
        .where(
          and(
            sql`${builderTurn.costUsd} > 0`,
            gte(builderTurn.createdAt, lo),
            lt(builderTurn.createdAt, hi),
            clientOf(builderTurn.tenantId),
          ),
        )
        .groupBy(builderTurn.tenantId, model, day),
    );
  }

  // The build flow's answers (`build_message.meta.costUsd`).
  {
    const day = utcDay(buildMessage.createdAt);
    const cost = metaCost(buildMessage.meta);
    const model = sql<string | null>`${buildMessage.meta} ->> 'model'`;
    push(
      "build",
      await tx
        .select({
          tenantId: build.clientId,
          model,
          day,
          n: sql<string>`count(*)::text`,
          cost: sql<string>`sum(${cost})::text`,
        })
        .from(buildMessage)
        .innerJoin(build, eq(build.id, buildMessage.buildId))
        .where(
          and(
            sql`${cost} > 0`,
            gte(buildMessage.createdAt, lo),
            lt(buildMessage.createdAt, hi),
            clientOf(build.clientId),
          ),
        )
        .groupBy(build.clientId, model, day),
    );
  }
  return out;
}

/** Providers' fees passed on to a client (P-8 `ProviderFee` raw records), by client and day. */
export async function providerFees(
  tx: Tx,
  tenantIds: readonly string[],
  query: SpendQuery,
): Promise<{ tenantId: string; day: string; fees: number; cost: Decimal }[]> {
  if (tenantIds.length === 0 || query.agent || query.template) return [];
  const { lo, hi } = bounds(query);
  const day = utcDay(rawRecord.syncedAt);
  const rows = await tx
    .select({
      tenantId: rawRecord.tenantId,
      day,
      fees: sql<string>`count(*)::text`,
      cost: sql<string>`coalesce(sum((${rawRecord.payload} ->> 'amountUsd')::numeric), 0)::text`,
    })
    .from(rawRecord)
    .where(
      and(
        inArray(rawRecord.tenantId, [...tenantIds]),
        eq(rawRecord.entityType, PROVIDER_FEE_ENTITY),
        gte(rawRecord.syncedAt, lo),
        lt(rawRecord.syncedAt, hi),
        ...(query.client ? [eq(rawRecord.tenantId, query.client)] : []),
      ),
    )
    .groupBy(rawRecord.tenantId, day);
  return rows.map((r) => ({ tenantId: r.tenantId, day: r.day, fees: n(r.fees), cost: d(r.cost) }));
}
