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
import { agent, agentVersion, type Tx, tenantPack } from "@countersign/db";
import { and, eq, isNull } from "drizzle-orm";
import { computeKpis } from "./compute";

type AgentRow = typeof agent.$inferSelect;

/** The client view of an agent's live version, checked at the boundary; null when it has none. */
export async function liveClientView(
  tx: Tx,
  a: Pick<AgentRow, "liveVersionId" | "tenantId">,
): Promise<{ versionId: string; view: ClientView | null } | null> {
  if (!a.liveVersionId) return null;
  const [v] = await tx
    .select({ bundle: agentVersion.bundle })
    .from(agentVersion)
    .where(
      and(
        eq(agentVersion.id, a.liveVersionId),
        a.tenantId === null ? isNull(agentVersion.tenantId) : eq(agentVersion.tenantId, a.tenantId),
      ),
    );
  if (!v) return null;
  const raw = (v.bundle.definition as { clientView?: unknown }).clientView;
  if (raw === undefined) return { versionId: a.liveVersionId, view: null };
  const parsed = ClientView.safeParse(raw);
  if (!parsed.success) {
    console.error(`agent version ${a.liveVersionId} has an unreadable client view`);
    return { versionId: a.liveVersionId, view: null };
  }
  return { versionId: a.liveVersionId, view: parsed.data };
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
  const live = await liveClientView(tx, a);
  const view = live?.view;
  if (!view) return { service: { id: a.id, name: input.name }, kpis: [], panels: [] };
  const enabled = new Set(
    (
      await tx
        .select({ pack: tenantPack.pack })
        .from(tenantPack)
        .where(eq(tenantPack.tenantId, a.tenantId as string))
    ).map((p) => p.pack),
  );
  return {
    service: { id: a.id, name: input.name },
    kpis: await agentKpisNow(tx, a, view, input),
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
  const out = new Map<string, WeekKpi[]>();
  for (const a of agents) {
    const view = (await liveClientView(tx, a))?.view;
    if (!view || view.kpis.length === 0) continue;
    const values = await computeKpis(
      tx,
      { tenantId: a.tenantId as string, agentId: a.id },
      view.kpis,
      { locale: input.locale, boundsOf: () => input.bounds },
    );
    out.set(
      a.id,
      values.flatMap((v) =>
        v.display === null
          ? []
          : [{ key: v.id, label: v.label, value: v.display, sources: v.sources }],
      ),
    );
  }
  return out;
}
