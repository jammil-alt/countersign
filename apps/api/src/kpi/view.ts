// A client agent's view (ARCHITECTURE §9.9; docs/plan.md §1.50, W2-G): the KPIs and panels its live
// version declares, computed over its live runs. The portal's service view, the back office's
// client view, the Table and the Weekly Table all read KPIs through here, so they agree.

import {
  ClientView,
  clientLanguage,
  type KpiBounds,
  type KpiValue,
  kpiBounds,
  type Locale,
  type ServiceView,
  userLanguage,
} from "@countersign/core";
import { type agent, agentVersion, type Tx, tenantPack } from "@countersign/db";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { reportProblem } from "../observability/report";
import { computeKpis, computeKpisMany } from "./compute";

type AgentRow = typeof agent.$inferSelect;

/** What the portal reads from a live bundle: its client view, and whether it starts from documents. */
export interface LiveProjection {
  versionId: string;
  view: ClientView | null;
  readsDocuments: boolean;
}

/** The live bundle's client view, as JSON (a path into the bundle, never the bundle itself). */
export const clientViewSql = sql<unknown>`(${agentVersion.bundle} -> 'definition' -> 'clientView')`;

/**
 * Whether an enabled workflow of the bundle starts on a `document.*` event (its first trigger), as
 * `readsDocuments` (lifecycle/runs.ts) reads it from the whole bundle: v4's `triggers[0]`, else
 * v3's `trigger`.
 */
export const readsDocumentsSql = sql<boolean>`coalesce((select bool_or(
    (w ->> 'enabled')::boolean
    and (case when jsonb_typeof(w -> 'workflow' -> 'triggers') = 'array'
              then w -> 'workflow' -> 'triggers' -> 0
              else w -> 'workflow' -> 'trigger' end) -> 'on' ->> 'type' = 'event'
    and (case when jsonb_typeof(w -> 'workflow' -> 'triggers') = 'array'
              then w -> 'workflow' -> 'triggers' -> 0
              else w -> 'workflow' -> 'trigger' end) -> 'on' ->> 'event' like 'document.%')
  from jsonb_array_elements(case when jsonb_typeof(${agentVersion.bundle} -> 'workflows') = 'array'
                                 then ${agentVersion.bundle} -> 'workflows' else '[]'::jsonb end) w),
  false)`;

/** A client view as stored, checked at the boundary; null when absent or unreadable. */
export function parseClientView(versionId: string, raw: unknown): ClientView | null {
  if (raw === undefined || raw === null) return null;
  const parsed = ClientView.safeParse(raw);
  if (!parsed.success) {
    reportProblem("an agent version has an unreadable client view", { agent_version: versionId });
    return null;
  }
  return parsed.data;
}

/**
 * The live versions' projections of many agents in one query, by agent id: only the client view
 * and the documents flag are read, never the whole bundle. Agents with no live version are absent.
 */
export async function liveProjections(
  tx: Tx,
  agents: readonly Pick<AgentRow, "id" | "liveVersionId" | "tenantId">[],
): Promise<Map<string, LiveProjection>> {
  const out = new Map<string, LiveProjection>();
  const live = agents.filter((a) => a.liveVersionId !== null);
  if (live.length === 0) return out;
  const tenants = [...new Set(live.flatMap((a) => (a.tenantId === null ? [] : [a.tenantId])))];
  const scope = [
    ...(tenants.length > 0 ? [inArray(agentVersion.tenantId, tenants)] : []),
    ...(live.some((a) => a.tenantId === null) ? [isNull(agentVersion.tenantId)] : []),
  ];
  const rows = await tx
    .select({
      id: agentVersion.id,
      tenantId: agentVersion.tenantId,
      view: clientViewSql,
      readsDocuments: readsDocumentsSql,
    })
    .from(agentVersion)
    .where(
      and(
        inArray(
          agentVersion.id,
          live.map((a) => a.liveVersionId as string),
        ),
        or(...scope),
      ),
    );
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const a of live) {
    const r = byId.get(a.liveVersionId as string);
    if (!r || r.tenantId !== a.tenantId) continue;
    out.set(a.id, {
      versionId: r.id,
      view: parseClientView(r.id, r.view),
      readsDocuments: r.readsDocuments === true,
    });
  }
  return out;
}

/** The client view of an agent's live version, checked at the boundary; null when it has none. */
export async function liveClientView(
  tx: Tx,
  a: Pick<AgentRow, "id" | "liveVersionId" | "tenantId">,
): Promise<{ versionId: string; view: ClientView | null } | null> {
  const p = (await liveProjections(tx, [a])).get(a.id);
  return p ? { versionId: p.versionId, view: p.view } : null;
}

/** The language a person reads the portal in: their own, else the client's, else English. */
export function readerLocale(
  t: { settings: Record<string, unknown> },
  userId: string | null,
): Locale {
  return (userId ? userLanguage(t.settings, userId) : null) ?? clientLanguage(t.settings) ?? "en";
}

/** A client agent's KPIs, each over its own period ending now. */
export async function agentKpisNow(
  tx: Tx,
  a: Pick<AgentRow, "id" | "tenantId">,
  view: ClientView,
  input: { locale: Locale; timezone: string; now: Date },
): Promise<KpiValue[]> {
  return computeKpis(tx, { tenantId: a.tenantId as string, agentId: a.id }, view.kpis, {
    locale: input.locale,
    boundsOf: (k) => kpiBounds(k.period, input.now, input.timezone),
  });
}

/** The portal's view of one service: KPI values and the panels (pack panels of enabled packs). */
export async function serviceView(
  tx: Tx,
  a: AgentRow,
  input: { name: string; locale: Locale; timezone: string; now: Date },
): Promise<ServiceView> {
  const view = (await liveClientView(tx, a))?.view;
  if (!view) return { service: { id: a.id, name: input.name }, kpis: [], panels: [] };
  const [packs, kpis] = await Promise.all([
    tx
      .select({ pack: tenantPack.pack })
      .from(tenantPack)
      .where(eq(tenantPack.tenantId, a.tenantId as string)),
    agentKpisNow(tx, a, view, input),
  ]);
  const enabled = new Set(packs.map((p) => p.pack));
  return {
    service: { id: a.id, name: input.name },
    kpis,
    // DECISION: a pack panel shows only while the client has its pack enabled.
    panels: view.panels.filter((p) => p.kind === "kpis" || enabled.has(p.pack)),
  };
}

/** A KPI as the Table and the Weekly Table list it. */
export interface WeekKpi {
  key: string;
  label: string;
  value: string;
  sources: string[];
}

/**
 * Each agent's KPIs over one week (the Table: this week so far; the Weekly Table: the week just
 * ended), whatever period each KPI declares (ARCHITECTURE §11.4: "each agent's KPIs for the week").
 */
// DECISION: the Table and the Weekly Table show every KPI over their week; a KPI with no value
// that week (a ratio over nothing) is left out of their lists rather than shown as a dash.
export async function weekKpis(
  tx: Tx,
  agents: readonly Pick<AgentRow, "id" | "tenantId" | "liveVersionId">[],
  input: { locale: Locale; bounds: KpiBounds },
): Promise<Map<string, WeekKpi[]>> {
  const views = await liveProjections(tx, agents);
  return weekKpisOf(
    tx,
    agents.map((a) => ({ agent: a, view: views.get(a.id)?.view ?? null })),
    input,
  );
}

/** `weekKpis` for agents whose client views the caller already read: one statement for all. */
export async function weekKpisOf(
  tx: Tx,
  items: readonly { agent: Pick<AgentRow, "id" | "tenantId">; view: ClientView | null }[],
  input: { locale: Locale; bounds: KpiBounds },
): Promise<Map<string, WeekKpi[]>> {
  const shown = items.flatMap(({ agent: a, view }) =>
    view && view.kpis.length > 0 ? [{ a, kpis: view.kpis }] : [],
  );
  const values = await computeKpisMany(
    tx,
    shown.map(({ a, kpis }) => ({
      scope: { tenantId: a.tenantId as string, agentId: a.id },
      kpis,
      boundsOf: () => input.bounds,
    })),
    input.locale,
  );
  const out = new Map<string, WeekKpi[]>();
  shown.forEach(({ a }, i) => {
    out.set(
      a.id,
      (values[i] ?? []).flatMap((v) =>
        v.display === null
          ? []
          : [{ key: v.id, label: v.label, value: v.display, sources: v.sources }],
      ),
    );
  });
  return out;
}
