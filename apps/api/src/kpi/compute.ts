// KPI computation (ARCHITECTURE §9.9; docs/plan.md §1.50, W2-G): one SQL per measure over a client
// agent's **live** runs in the period, inside the caller's client scope (invariant 1). Values are
// decimal strings end to end (invariant 6): sums are `numeric` in SQL and decimal.js here. Each
// value carries the record ids it counted (invariant 10). Test runs never count.

import {
  Decimal,
  formatKpi,
  KPI_DEFAULT_CURRENCY,
  KPI_SOURCES_MAX,
  type Kpi,
  type KpiBounds,
  type KpiValue,
  type Locale,
  type Measure,
  pickLocalized,
  toNumeric,
} from "@countersign/core";
import type { Tx } from "@countersign/db";
import { type SQL, sql } from "drizzle-orm";

export interface KpiScope {
  tenantId: string;
  agentId: string;
}

export interface MeasureResult {
  /** A decimal string; null when a ratio's denominator is 0 or money mixes currencies. */
  value: string | null;
  sources: string[];
  /** Money sums: the one currency the rows named beside the amount, else null. */
  currency: string | null;
}

type Plain = Exclude<Measure, { kind: "ratio" }>;

interface Row extends Record<string, unknown> {
  v: string | null;
  ids: string[] | null;
  currencies?: string[] | null;
}

const capped = (ids: Iterable<string>) => [...new Set(ids)].slice(0, KPI_SOURCES_MAX);

/** A path as a Postgres text[] literal: `{a,b}`. Segments are identifiers (the schema checks). */
const pathArray = (segments: readonly string[]) => `{${segments.join(",")}}`;

/** The array slice bound, as a literal (a constant, never input). */
const LIMIT = sql.raw(String(KPI_SOURCES_MAX));

/** `numeric` text Postgres reads: digits with an optional sign and fraction. */
const NUMERIC_TEXT = "^-?[0-9]+(\\.[0-9]+)?$";

async function one(tx: Tx, query: SQL): Promise<Row> {
  const rows = [...(await tx.execute<Row>(query))];
  return rows[0] ?? { v: "0", ids: [] };
}

/** The live runs of the agent whose time falls in the period: finished, else created. */
// DECISION: a run belongs to the period it finished in (`finished_at`), or, while it is still
// going, the one it was created in; runs measures with no status count every live run.
function runsQuery(scope: KpiScope, m: Extract<Plain, { kind: "runs" }>, b: KpiBounds): SQL {
  const at = sql`coalesce(r.finished_at, r.created_at)`;
  const status = m.status ?? "any";
  return sql`select count(*)::text as v,
      to_jsonb((array_agg(r.id::text order by ${at} desc))[1:${LIMIT}]) as ids
    from run r
    where r.tenant_id = ${scope.tenantId} and r.agent_id = ${scope.agentId} and r.mode = 'live'
      and ${at} >= ${b.from.toISOString()}::timestamptz and ${at} < ${b.to.toISOString()}::timestamptz
      ${status === "any" ? sql`` : sql`and r.status = ${status}`}
      ${m.workflow ? sql`and r.workflow_slug = ${m.workflow}` : sql``}`;
}

/** Writes done to the client's tools by the agent's live runs, executed in the period. */
function actionsQuery(scope: KpiScope, m: Extract<Plain, { kind: "actions" }>, b: KpiBounds): SQL {
  return sql`select count(*)::text as v,
      to_jsonb((array_agg(ea.id::text order by ea.executed_at desc))[1:${LIMIT}]) as ids
    from external_action ea
    join run r on r.id = ea.run_id and r.tenant_id = ea.tenant_id
    ${m.connector ? sql`join connection c on c.id = ea.connection_id and c.tenant_id = ea.tenant_id` : sql``}
    where ea.tenant_id = ${scope.tenantId} and r.agent_id = ${scope.agentId} and r.mode = 'live'
      and ea.status = ${m.status}
      and ea.executed_at >= ${b.from.toISOString()}::timestamptz
      and ea.executed_at < ${b.to.toISOString()}::timestamptz
      ${m.tool ? sql`and ea.tool = ${m.tool}` : sql``}
      ${m.connector ? sql`and c.connector = ${m.connector}` : sql``}`;
}

/**
 * A step's outputs in the agent's live runs that finished `succeeded` in the period: the sum of
 * the numbers at the path, or how many of the step's rows have a value there.
 */
// DECISION: step measures read only runs that succeeded (a failed run that was retried counts
// once, through its retry, which carries the steps it reused); the step may sit at any depth
// (`<loop>:<i>:<step>` inside a for_each). `sum` adds the values whose text is a number (JSON
// numbers and decimal strings); `count` counts the rows with a non-null value at the path.
function stepQuery(scope: KpiScope, m: Extract<Plain, { kind: "sum" | "count" }>, b: KpiBounds) {
  const segments = m.path.split(".");
  const path = pathArray(segments);
  const value = sql`(s.output #>> ${path}::text[])`;
  const currencyPath = pathArray([...segments.slice(0, -1), "currency"]);
  const currency = sql`(s.output #>> ${currencyPath}::text[])`;
  const measure =
    m.kind === "sum" ? sql`coalesce(sum(${value}::numeric), 0)::text` : sql`count(*)::text`;
  const present =
    m.kind === "sum"
      ? sql`${value} ~ ${NUMERIC_TEXT}`
      : sql`jsonb_typeof(s.output #> ${path}::text[]) is not null and jsonb_typeof(s.output #> ${path}::text[]) <> 'null'`;
  return sql`select ${measure} as v,
      to_jsonb((array_agg(distinct r.id::text))[1:${LIMIT}]) as ids,
      to_jsonb(array_agg(distinct ${currency}) filter (where ${currency} is not null)) as currencies
    from step_run s
    join run r on r.id = s.run_id and r.tenant_id = s.tenant_id
    where s.tenant_id = ${scope.tenantId} and r.agent_id = ${scope.agentId} and r.mode = 'live'
      and r.status = 'succeeded'
      and r.finished_at >= ${b.from.toISOString()}::timestamptz
      and r.finished_at < ${b.to.toISOString()}::timestamptz
      and s.status = 'succeeded'
      and (s.node_id = ${m.step} or right(s.node_id, ${m.step.length + 1}::int) = ${`:${m.step}`})
      and ${present}`;
}

/** One measure's value over the period: plain measures in one SQL each, ratios from two. */
export async function measureValue(
  tx: Tx,
  scope: KpiScope,
  m: Measure,
  b: KpiBounds,
): Promise<MeasureResult> {
  if (m.kind === "ratio") {
    const [num, den] = [
      await measureValue(tx, scope, m.numerator, b),
      await measureValue(tx, scope, m.denominator, b),
    ];
    const sources = capped([...num.sources, ...den.sources]);
    if (num.value === null || den.value === null || new Decimal(den.value).isZero()) {
      return { value: null, sources, currency: null };
    }
    // DECISION: a ratio is kept to 4 decimal places (0.8750), rounded half up.
    const ratio = new Decimal(num.value).div(den.value).toDecimalPlaces(4).toFixed(4);
    return { value: ratio, sources, currency: null };
  }
  const row = await one(
    tx,
    m.kind === "runs"
      ? runsQuery(scope, m, b)
      : m.kind === "actions"
        ? actionsQuery(scope, m, b)
        : stepQuery(scope, m, b),
  );
  const sources = capped(row.ids ?? []);
  const raw = row.v ?? "0";
  if ((m.kind === "sum" || m.kind === "count") && m.money) {
    const currencies = row.currencies ?? [];
    // Amounts in different currencies are never added (invariant 6): no value.
    if (currencies.length > 1) return { value: null, sources, currency: null };
    return { value: toNumeric(raw), sources, currency: currencies[0] ?? null };
  }
  return { value: new Decimal(raw).toFixed(), sources, currency: null };
}

/** Each KPI's label and value in `locale`, every one over the bounds `boundsOf` gives it. */
export async function computeKpis(
  tx: Tx,
  scope: KpiScope,
  kpis: readonly Kpi[],
  input: { locale: Locale; boundsOf: (k: Kpi) => KpiBounds },
): Promise<KpiValue[]> {
  const out: KpiValue[] = [];
  for (const k of kpis) {
    const b = input.boundsOf(k);
    const r = await measureValue(tx, scope, k.measure, b);
    const currency = k.format === "money" ? (r.currency ?? KPI_DEFAULT_CURRENCY) : null;
    out.push({
      id: k.id,
      label: pickLocalized(k.label, input.locale),
      period: k.period,
      format: k.format,
      value: r.value,
      display: formatKpi(r.value, k.format, input.locale, currency ?? undefined),
      currency,
      sources: r.sources,
      from: b.from.toISOString(),
      to: b.to.toISOString(),
    });
  }
  return out;
}
