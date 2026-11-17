// The client page's work (docs/plan.md §1.123.3; the prototype's `clientPage()`): its figures,
// its open Sales and Build work, and its to-dos (ours, Reggie's and the client's), read from the
// lists Sales and Build already keep. Operator only, in the operator's transaction.

import {
  type ClientWork,
  dec,
  toNumeric,
  type WorkCard,
  type WorkKpi,
  wholeMoney,
} from "@countersign/core";
import { deal, type Tx } from "@countersign/db";
import { eq } from "drizzle-orm";
import { salesToday, summariesOf } from "./deals";
import { listFor, questionFigures } from "./todos";
import { workList } from "./work-list";

const kpi = (
  label: string,
  value: string | number,
  note: string,
  tone: WorkKpi["tone"] = null,
  href: string | null = null,
): WorkKpi => ({ label, value: String(value), note, tone, href });

const sum = (xs: string[]) => toNumeric(xs.reduce((n, x) => n.plus(dec(x)), dec("0")));

export async function clientWork(
  tx: Tx,
  tenantIds: readonly string[],
  clientId: string,
  userId: string,
  now = new Date(),
): Promise<ClientWork> {
  const work = await workList(tx, tenantIds, { tab: "all", client: clientId }, now);
  const dealRows = await tx.select().from(deal).where(eq(deal.clientId, clientId));
  const deals = await summariesOf(tx, dealRows, salesToday(now));
  const open = work.items.filter((i) => i.standing !== "done");
  const issues = open.filter((i) => i.kind === "issue");
  const builds = open.filter((i) => i.kind === "build");
  const critical = issues.filter((i) => i.urgency === "critical");
  const won = deals.filter((d) => d.outcome === "won");
  const growOpen = deals.filter((d) => d.outcome === "open" && d.kind === "expansion");
  const salesOpen = deals.filter((d) => d.outcome === "open");
  // DECISION: "A month" is the won deals' agreed price (else their value), by hand until billing
  // reads the contract (owner, 2026-11-17: contracts stay by hand).
  const month = sum(won.map((d) => d.agreedMrr ?? d.mrr));
  const q = await questionFigures(tx, [clientId], new Date(now.getTime() - 30 * 86_400_000));
  const held = work.holds.filter((h) => h.client.id === clientId);

  const kpis: WorkKpi[] = [
    kpi(
      "A month",
      wholeMoney(month),
      won.length ? `${won.length} deal${won.length === 1 ? "" : "s"} won` : "No deal won yet",
    ),
    kpi(
      "Open issues",
      issues.length,
      critical.length
        ? `${critical.length} critical${held.length ? ", held" : ""}`
        : "None critical",
      critical.length ? "risk" : null,
      `/ops/build/issues?client=${clientId}`,
    ),
    kpi("Builds", builds.length, "In progress", null, `/ops/build/builds?client=${clientId}`),
    kpi(
      "Sales open",
      wholeMoney(sum(growOpen.map((d) => d.mrr))),
      "A month, expansion",
      null,
      `/ops/sales/grow?client=${clientId}`,
    ),
    kpi(
      "Questions",
      q.asked,
      q.medianMinutes == null ? "Last 30 days" : `Last 30 days · median ${q.medianMinutes} min`,
    ),
  ];

  const sales: WorkCard[] = salesOpen.map((d) => ({
    kind: "deal",
    id: d.id,
    title: d.title,
    href: `/ops/deals/${d.id}`,
    urgency: null,
    standing: d.standing,
    statusText: d.statusText,
  }));
  const build: WorkCard[] = open
    .filter((i) => i.kind !== "enhancement" || i.asks > 0)
    .map((i) => ({
      kind: i.kind,
      id: i.id,
      title: i.number ? `#${i.number} ${i.title}` : i.title,
      href:
        i.kind === "issue"
          ? `/ops/issues/${i.id}`
          : i.kind === "build"
            ? `/ops/builds/${i.id}`
            : `/ops/enhancements/${i.id}`,
      urgency: i.urgency,
      standing: i.standing,
      statusText: i.statusLine || i.stageName,
    }));

  const todos = [];
  for (const owner of ["operator", "reggie", "client"] as const) {
    todos.push(
      ...(await listFor(tx, tenantIds, userId, { owner, client: clientId, mine: false }, now)),
    );
  }
  return { kpis, sales, build, todos };
}
