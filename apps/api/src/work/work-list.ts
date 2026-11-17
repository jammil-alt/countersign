// Build's lists (docs/plan.md §1.123.1; docs/cases-plan.md §3.2): issues, agent builds and
// enhancements of the clients served, in the work order with the reason for each, the KPIs over
// them, and the holds. Open items plus those done in the last 30 days.

import {
  type BuildTab,
  buildPipelineStage,
  type HoldView,
  isLate,
  readHold,
  readRequirements,
  requirementsProgress,
  type Standing,
  stageName,
  standingOf,
  type WorkItem,
  type WorkKpi,
  type WorkOrderInput,
  workOrder,
} from "@countersign/core";
import {
  agent,
  build,
  buildItem,
  clientAsk,
  enhancement,
  inboxItem,
  issue,
  type Tx,
  tenant,
} from "@countersign/db";
import { and, eq, gte, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { askCounts, enhancementDone } from "./asks";
import { holdViews } from "./holds";
import { issueDone } from "./issues";

const DAY = 86_400_000;
const DONE_DAYS = 30;

/** Today, as the work order counts days. */
// DECISION: the back office's "today" is the UTC date: the list spans clients in many zones.
export const todayIso = (now = new Date()) => now.toISOString().slice(0, 10);

type BuildRow = typeof build.$inferSelect;

/** What Build needs of each agent build beside the row. */
export interface BuildFacts {
  agentStage: string | null;
  held: boolean;
  openItems: number;
  missingConnections: number;
  /** The requirements request's progress, read from the client's Desk item (null: none sent). */
  requirements: { answered: number; total: number } | null;
}

/** The agent's stage and hold, and the build's open items, per build. */
export async function buildFacts(tx: Tx, rows: BuildRow[]): Promise<Map<string, BuildFacts>> {
  const out = new Map<string, BuildFacts>();
  if (rows.length === 0) return out;
  const agentIds = [
    ...new Set(rows.map((r) => r.agentId ?? r.testAgentId).filter((v): v is string => !!v)),
  ];
  const agents = agentIds.length
    ? await tx
        .select({ id: agent.id, stage: agent.stage, hold: agent.hold })
        .from(agent)
        .where(inArray(agent.id, agentIds))
    : [];
  const counts = await tx
    .select({
      buildId: buildItem.buildId,
      open: sql<number>`count(*) filter (where ${buildItem.state} not in ('done', 'deferred'))::int`,
      missing: sql<number>`count(*) filter (where ${buildItem.state} not in ('done', 'deferred') and ${buildItem.kind} = 'precondition' and ${buildItem.owner} = 'client')::int`,
    })
    .from(buildItem)
    .where(
      inArray(
        buildItem.buildId,
        rows.map((r) => r.id),
      ),
    )
    .groupBy(buildItem.buildId);
  const reqItems = rows
    .map((r) => readRequirements(r.requirements)?.inboxItemId)
    .filter((v): v is string => !!v);
  const desk = reqItems.length
    ? await tx.select().from(inboxItem).where(inArray(inboxItem.id, reqItems))
    : [];
  for (const r of rows) {
    const req = readRequirements(r.requirements);
    const item = req ? desk.find((d) => d.id === req.inboxItemId) : undefined;
    const raw = item
      ? item.status === "resolved"
        ? (item.resolution as { answers?: unknown } | null)?.answers
        : (item.payload as { draft?: unknown } | null)?.draft
      : undefined;
    const answers = Object.fromEntries(
      Object.entries(raw && typeof raw === "object" ? raw : {}).filter(
        (e): e is [string, string] => typeof e[1] === "string",
      ),
    );
    const a = agents.find((x) => x.id === (r.agentId ?? r.testAgentId));
    const c = counts.find((x) => x.buildId === r.id);
    out.set(r.id, {
      agentStage: a?.stage ?? null,
      held: readHold(a?.hold ?? null) !== null,
      openItems: c?.open ?? 0,
      // DECISION: the connections a build still needs are its open client preconditions (the
      // draft's "connections the client hasn't made" become those items).
      missingConnections: c?.missing ?? 0,
      requirements: req ? requirementsProgress(req.fields, answers) : null,
    });
  }
  return out;
}

export function buildDoneish(r: Pick<BuildRow, "status">, f: BuildFacts | undefined): boolean {
  return r.status === "live" || f?.agentStage === "live";
}

export function buildStageOf(r: BuildRow, f: BuildFacts | undefined) {
  return buildPipelineStage({
    status: r.status,
    path: r.path,
    phase: r.phase,
    agentStage: f?.agentStage ?? null,
    requirements: f?.requirements ?? null,
    missingConnections: f?.missingConnections ?? 0,
  });
}

export function buildStanding(r: BuildRow, f: BuildFacts | undefined): Standing {
  return standingOf({
    doneish: buildDoneish(r, f),
    waitingOn: r.waitingOn,
    stuck: r.stuck,
    held: f?.held ?? false,
  });
}

interface Loaded {
  items: WorkItem[];
  holds: HoldView[];
  /** Open and done-lately rows, for the KPIs. */
  closedThisMonth: {
    issues: { closedAt: Date; fixBy: Date | null }[];
    buildsLive: number;
    shipped: number;
  };
  firstReplies: number[];
}

async function load(tx: Tx, tenantIds: readonly string[], now: Date): Promise<Loaded> {
  const since = new Date(now.getTime() - DONE_DAYS * DAY);
  const today = todayIso(now);
  const scope = [...tenantIds];
  const clients = scope.length
    ? await tx
        .select({ id: tenant.id, name: tenant.name })
        .from(tenant)
        .where(inArray(tenant.id, scope))
    : [];
  const clientOf = (id: string | null) => (id ? (clients.find((c) => c.id === id) ?? null) : null);

  const issues = scope.length
    ? await tx
        .select()
        .from(issue)
        .where(
          and(
            inArray(issue.tenantId, scope),
            or(ne(issue.stage, "closed"), gte(issue.closedAt, since)),
          ),
        )
        .limit(1000)
    : [];
  const agentIds = [...new Set(issues.map((i) => i.agentId).filter((v): v is string => !!v))];
  const agents = agentIds.length
    ? await tx
        .select({
          id: agent.id,
          name: agent.name,
          serviceName: agent.serviceName,
          hold: agent.hold,
        })
        .from(agent)
        .where(inArray(agent.id, agentIds))
    : [];

  const builds = scope.length
    ? await tx
        .select()
        .from(build)
        .where(
          and(
            eq(build.kind, "agent"),
            isNotNull(build.clientId),
            inArray(build.clientId, scope),
            ne(build.status, "stopped"),
            or(eq(build.status, "open"), gte(build.updatedAt, since)),
          ),
        )
        .limit(500)
    : [];
  const facts = await buildFacts(tx, builds);

  const enhancements = await tx
    .select()
    .from(enhancement)
    .where(
      or(
        sql`${enhancement.stage} <> 'shipped' and coalesce(${enhancement.decision}, '') <> 'no'`,
        gte(enhancement.updatedAt, since),
      ),
    )
    .limit(500);
  const asks = await askCounts(
    tx,
    enhancements.map((e) => e.id),
    scope,
  );
  // An enhancement with no ask yet is the operator's own idea; one whose asks are all another
  // operator's clients' stays in their list, not this one.
  const anyAsks = enhancements.length
    ? await tx
        .select({ id: clientAsk.enhancementId })
        .from(clientAsk)
        .where(
          inArray(
            clientAsk.enhancementId,
            enhancements.map((e) => e.id),
          ),
        )
    : [];
  const withAsks = new Set(anyAsks.map((a) => a.id));
  const visibleEnh = enhancements.filter((e) => !withAsks.has(e.id) || (asks.get(e.id) ?? 0) > 0);

  const open: WorkOrderInput[] = [];
  const items: Omit<WorkItem, "rank" | "why" | "moved" | "manual">[] = [];
  for (const i of issues) {
    const a = agents.find((x) => x.id === i.agentId);
    const held = !!a && readHold(a.hold)?.issueId === i.id;
    const standing = standingOf({
      doneish: issueDone(i),
      waitingOn: i.waitingOn,
      stuck: i.stuck,
      held,
    });
    if (standing !== "done") {
      open.push({
        kind: "issue",
        id: i.id,
        urgency: i.urgency,
        createdAt: i.createdAt.toISOString(),
        fixBy: i.fixBy?.toISOString() ?? null,
        manualRank: i.manualRank,
      });
    }
    items.push({
      kind: "issue",
      id: i.id,
      number: i.number,
      title: i.title,
      description: i.description,
      client: clientOf(i.tenantId),
      asks: 0,
      agent: a ? { id: a.id, name: a.serviceName ?? a.name } : null,
      stage: i.stage,
      stageName: stageName("issues", i.stage),
      standing,
      statusLine: i.statusLine || (held ? "Hold on · review" : ""),
      urgency: i.urgency,
      due: i.fixBy?.toISOString() ?? null,
      held,
      fromTemplate: false,
      createdAt: i.createdAt.toISOString(),
      updatedAt: i.updatedAt.toISOString(),
    });
  }
  for (const b of builds) {
    const f = facts.get(b.id);
    const standing = buildStanding(b, f);
    const stage = buildStageOf(b, f);
    if (standing !== "done") {
      open.push({
        kind: "build",
        id: b.id,
        promisedOn: b.promisedOn,
        openItems: f?.openItems ?? 0,
        manualRank: b.manualRank,
      });
    }
    items.push({
      kind: "build",
      id: b.id,
      number: null,
      title: b.title,
      description: b.statusLine,
      client: clientOf(b.clientId),
      asks: 0,
      agent: null,
      stage,
      stageName: stageName("builds", stage),
      standing,
      statusLine: b.statusLine || (f?.held ? "Held" : ""),
      urgency: null,
      due: b.promisedOn,
      held: f?.held ?? false,
      fromTemplate: b.path === "template",
      createdAt: b.createdAt.toISOString(),
      updatedAt: b.updatedAt.toISOString(),
    });
  }
  for (const e of visibleEnh) {
    const n = asks.get(e.id) ?? 0;
    const standing = standingOf({
      doneish: enhancementDone(e),
      waitingOn: e.waitingOn,
      stuck: e.stuck,
    });
    if (standing !== "done") {
      open.push({
        kind: "enhancement",
        id: e.id,
        decision: e.decision ?? null,
        asks: n,
        decideBy: e.decideBy,
        manualRank: e.manualRank,
      });
    }
    items.push({
      kind: "enhancement",
      id: e.id,
      number: null,
      title: e.title,
      description: e.description,
      client: null,
      asks: n,
      agent: null,
      stage: e.stage,
      stageName: stageName("enh", e.stage),
      standing,
      statusLine: e.statusLine,
      urgency: null,
      due: e.decideBy,
      held: false,
      fromTemplate: false,
      createdAt: e.createdAt.toISOString(),
      updatedAt: e.updatedAt.toISOString(),
    });
  }
  const order = workOrder(open, today);
  const placed = new Map(order.map((o) => [`${o.kind}:${o.id}`, o]));
  const ranked: WorkItem[] = items
    .map((it) => {
      const o = placed.get(`${it.kind}:${it.id}`);
      return {
        ...it,
        rank: o?.rank ?? null,
        why: o?.why ?? null,
        moved: o?.moved ?? false,
        manual: o?.manual ?? false,
      };
    })
    .sort(
      (a, b) => (a.rank ?? 10_000) - (b.rank ?? 10_000) || b.updatedAt.localeCompare(a.updatedAt),
    );

  const monthStart = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
  return {
    items: ranked,
    holds: await holdViews(tx, scope),
    closedThisMonth: {
      issues: issues
        .filter((i) => i.closedAt && i.closedAt >= monthStart && i.causeKind !== "not_a_bug")
        .map((i) => ({ closedAt: i.closedAt as Date, fixBy: i.fixBy })),
      buildsLive: builds.filter(
        (b) => buildDoneish(b, facts.get(b.id)) && b.updatedAt >= monthStart,
      ).length,
      shipped: enhancements.filter((e) => e.shippedAt && e.shippedAt >= monthStart).length,
    },
    firstReplies: issues
      .filter((i) => i.firstReplyAt && i.createdAt >= since)
      .map((i) => ((i.firstReplyAt as Date).getTime() - i.createdAt.getTime()) / 60_000),
  };
}

const kpi = (
  label: string,
  value: string | number,
  note: string,
  tone: WorkKpi["tone"] = null,
  href: string | null = null,
): WorkKpi => ({
  label,
  value: String(value),
  note,
  tone,
  href,
});

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

function minutes(n: number): string {
  if (n < 60) return `${Math.round(n)} min`;
  const h = n / 60;
  return h < 48 ? `${Math.round(h * 10) / 10} h` : `${Math.round(h / 24)} days`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The KPI boxes over Build's tab (the prototype's `buildKpis`). */
export function buildKpis(l: Loaded, tab: BuildTab, today: string): WorkKpi[] {
  const pipes =
    tab === "all"
      ? (["issue", "build", "enhancement"] as const)
      : ([({ issues: "issue", builds: "build", enh: "enhancement" } as const)[tab]] as const);
  const open = l.items.filter(
    (i) => i.standing !== "done" && (pipes as readonly string[]).includes(i.kind),
  );
  const by = (k: WorkItem["kind"]) => open.filter((i) => i.kind === k);
  const late = open.filter((i) => isLate(i.due, i.standing, today)).length;
  const issues = by("issue");
  const builds = by("build");
  const enh = by("enhancement");
  const critical = issues.filter((i) => i.urgency === "critical");
  const atRisk = builds.filter((b) => b.standing === "stalled" || b.moved);
  const out: WorkKpi[] = [];
  if (tab === "all" || tab === "issues") {
    const first = critical[0];
    out.push(
      kpi(
        "Critical, held",
        critical.length,
        first?.client ? first.client.name : "None open",
        critical.length ? "risk" : null,
        first ? `/ops/issues/${first.id}` : null,
      ),
    );
  }
  if (tab === "all") {
    const top = [...enh].sort((a, b) => b.asks - a.asks)[0];
    out.push(
      kpi(
        "Open issues",
        issues.length,
        `${issues.filter((i) => i.urgency === "high").length} high`,
      ),
      kpi(
        "Builds in progress",
        builds.length,
        `${builds.filter((b) => b.standing === "client").length} waiting on clients`,
      ),
      kpi(
        "Promised dates at risk",
        atRisk.length,
        atRisk[0]?.client?.name ?? "None",
        atRisk.length ? "signal" : null,
      ),
      kpi(
        "Enhancement asks",
        enh.length,
        top ? `Top one: ${plural(top.asks, "client")}` : "None open",
      ),
    );
  }
  if (tab === "issues") {
    const fixed = l.closedThisMonth.issues;
    const inTarget = fixed.filter((i) => !i.fixBy || i.closedAt <= i.fixBy).length;
    const med = median(l.firstReplies);
    out.push(
      kpi("Open", issues.length, `${issues.filter((i) => i.urgency === "high").length} high`),
      kpi("Median first reply", med === null ? "–" : minutes(med), "Target 1 hour"),
      kpi(
        "Fixed within target",
        fixed.length ? `${inTarget} of ${fixed.length}` : "–",
        "This month",
        fixed.length ? "positive" : null,
      ),
    );
  }
  if (tab === "builds") {
    const next = [...builds]
      .filter((b) => b.due)
      .sort((a, b) => (a.due ?? "").localeCompare(b.due ?? ""))[0];
    const fresh = builds.filter((b) => !b.fromTemplate).length;
    out.push(
      kpi("In progress", builds.length, `${plural(fresh, "new agent")}, the rest from templates`),
      kpi(
        "Waiting on clients",
        builds.filter((b) => b.standing === "client").length,
        "Reggie chases every 2 days",
      ),
      kpi(
        "Dates at risk",
        atRisk.length,
        atRisk[0]?.client?.name ?? "None",
        atRisk.length ? "signal" : null,
      ),
      kpi("Next promised", next?.due ?? "–", next?.client?.name ?? "No date set"),
      kpi(
        "Live this month",
        l.closedThisMonth.buildsLive,
        "Agents gone live",
        l.closedThisMonth.buildsLive ? "positive" : null,
      ),
    );
  }
  if (tab === "enh") {
    const top = [...enh].sort((a, b) => b.asks - a.asks)[0];
    out.push(
      kpi(
        "Open asks",
        enh.length,
        `From ${plural(
          enh.reduce((n, e) => n + e.asks, 0),
          "client",
        )}`,
      ),
      kpi("Most asked", top ? plural(top.asks, "client") : "–", top?.title ?? "None open"),
      kpi(
        "Need you",
        enh.filter((e) => e.standing === "you").length,
        "Decide or approve",
        "signal",
      ),
      kpi(
        "Shipped this month",
        l.closedThisMonth.shipped,
        "Everyone who asked was told",
        l.closedThisMonth.shipped ? "positive" : null,
      ),
    );
  }
  out.push(kpi("Late", late, late ? "Past the date we set" : "Nothing late", late ? "risk" : null));
  return out;
}

const TAB_KIND = { issues: "issue", builds: "build", enh: "enhancement" } as const;

/** Build's list for a tab: its items in the work order, the KPIs, the holds and the tab counts. */
export async function workList(
  tx: Tx,
  tenantIds: readonly string[],
  q: { tab: BuildTab; client?: string | undefined },
  now = new Date(),
) {
  const scope = q.client ? tenantIds.filter((t) => t === q.client) : tenantIds;
  const l = await load(tx, scope, now);
  const today = todayIso(now);
  const tab = q.tab;
  const items = tab === "all" ? l.items : l.items.filter((i) => i.kind === TAB_KIND[tab]);
  // A client's list shows its own work; enhancements are everyone's.
  const shown = q.client ? items.filter((i) => i.kind !== "enhancement" || i.asks > 0) : items;
  const openOf = (k?: WorkItem["kind"]) =>
    l.items.filter((i) => i.standing !== "done" && (!k || i.kind === k)).length;
  return {
    items: shown,
    kpis: buildKpis(l, q.tab, today),
    holds: l.holds,
    counts: {
      all: openOf(),
      issues: openOf("issue"),
      builds: openOf("build"),
      enh: openOf("enhancement"),
    },
  };
}
