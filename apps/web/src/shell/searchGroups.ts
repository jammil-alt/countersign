// The API's search hits as groups of links, one function per surface (packages/core/src/api/search.ts).
// Pure, so the links each hit opens are tested on their own.
import {
  type OpsSearchResult,
  type PortalSearchResult,
  recordHitSubjectKind,
  SALES_PIPELINES,
} from "@countersign/core";
import type { Translate } from "../i18n/catalog";
import { EN, type I18n } from "../i18n/i18n";
import { plural, runChip } from "../ops/run/words";
import { money } from "../runs/format";
import { opsRunTitle, subjectTitle } from "../runs/subject";
import type { SearchGroup, SearchHit } from "./Search";

const dot = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(" · ");

/**
 * R2 (docs/plan.md §1.193): after a record or document some runs were about, a hit that says how
 * many and opens the runs list filtered to them (`about=vendor:<id>`).
 */
function runsAboutHit(
  hit: { id: string; runs?: number | undefined },
  kind: string,
  runsPath: string,
  title: (count: number) => string,
): SearchHit[] {
  const count = hit.runs ?? 0;
  if (count === 0) return [];
  const about = encodeURIComponent(`${kind}:${hit.id}`);
  return [{ key: `ra:${hit.id}`, href: `${runsPath}?about=${about}`, title: title(count) }];
}

const RUN_STATUS = {
  queued: "run.status.queued",
  running: "run.status.running",
  waiting: "run.status.waiting",
  succeeded: "run.status.succeeded",
  failed: "run.status.failed",
  cancelled: "run.status.cancelled",
} as const;

function runStatus(t: Translate, status: string): string {
  return Object.hasOwn(RUN_STATUS, status)
    ? t(RUN_STATUS[status as keyof typeof RUN_STATUS])
    : status;
}

const GOING = new Set(["queued", "running", "waiting"]);

/** An agent's status in words (the back office). */
const AGENT_STATUS_WORDS: Record<string, string> = {
  active: "Active",
  paused: "Paused",
  draft: "Draft",
  testing: "Testing",
  retired: "Retired",
};

/** The portal: its own client's hits. Receivables have no page of their own yet: their list. */
export function portalSearchGroups(
  r: PortalSearchResult,
  t: Translate,
  /** The reader's formats and language, for amounts and run titles. */
  i18n: Pick<I18n, "fmt" | "locale"> = EN,
): SearchGroup[] {
  const amount = (x: { amount: string | null; currency: string | null }) =>
    x.amount ? money(x.amount, x.currency ?? "USD", i18n) : null;
  return [
    {
      label: t("search.group.agents"),
      hits: r.services.map((s) => ({ key: `s:${s.id}`, href: `/agents/${s.id}`, title: s.name })),
    },
    {
      label: t("search.group.runs"),
      hits: r.runs.map((x) => ({
        key: `r:${x.id}`,
        href: `/runs/${x.id}`,
        // Titled by what the run is about ("Northline Panel Supply · Invoice 20418").
        title: dot(subjectTitle(x.subject, { t, locale: i18n.locale }), x.shortId, x.service.name),
        // A run waiting on the client reads as it does on Runs (UI cleanup, stream A).
        meta:
          x.waitingOnYou && GOING.has(x.status) ? t("common.waitingOnYou") : runStatus(t, x.status),
      })),
    },
    {
      label: t("search.group.records"),
      hits: r.records.flatMap((x) => [
        {
          key: `rec:${x.id}`,
          href: x.kind === "receivable" ? "/records?kind=receivables" : `/records/${x.id}`,
          title: x.label,
          meta: dot(x.number, x.date, amount(x)),
        },
        ...runsAboutHit(x, recordHitSubjectKind(x.kind), "/runs", (count) =>
          t("search.runsAbout", { count, name: x.label }),
        ),
      ]),
    },
    {
      label: t("search.group.people"),
      hits: [
        ...r.people.map((p) => ({
          key: `p:${p.id}`,
          href: `/contacts?person=${encodeURIComponent(p.id)}`,
          title: p.name,
          meta: dot(p.title, p.organization?.name, p.email),
        })),
        ...r.organizations.map((o) => ({
          key: `o:${o.id}`,
          href: "/contacts?show=organizations",
          title: o.name,
          meta: o.website ?? undefined,
        })),
      ],
    },
    {
      label: t("search.group.documents"),
      hits: r.documents.flatMap((d) => [
        {
          key: `d:${d.id}`,
          href: `/documents/${d.id}`,
          title: d.filename,
          meta: dot(d.vendor, d.number),
        },
        ...runsAboutHit(d, "document", "/runs", (count) =>
          t("search.runsAbout", { count, name: d.filename }),
        ),
      ]),
    },
  ];
}

/**
 * The back office: hits across the clients served, each naming its client. Clients come from the
 * clients list (the search route has none), matched by name here.
 */
/** A deal's stage by its name on the Sales board ("Proposal and contract"). */
const DEAL_STAGE_NAMES = new Map<string, string>(
  [...SALES_PIPELINES.new.stages, ...SALES_PIPELINES.grow.stages].map((s) => [s.id, s.name]),
);
const DEAL_OUTCOME_WORDS: Record<string, string> = {
  won: "Won",
  lost: "Lost",
  not_now: "Not now",
  no: "Closed: no",
};

export function opsSearchGroups(
  r: OpsSearchResult,
  clients: readonly { id: string; name: string }[],
  q: string,
): SearchGroup[] {
  const text = q.trim().toLocaleLowerCase();
  const base = (c: { id: string }) => `/ops/clients/${c.id}`;
  return [
    {
      label: "Clients",
      hits: clients
        .filter((c) => c.name.toLocaleLowerCase().includes(text))
        .slice(0, 5)
        .map((c) => ({ key: `c:${c.id}`, href: base(c), title: c.name })),
    },
    // S6.8 (HM5): deals, by the company or client and what they'd buy.
    {
      label: "Deals",
      hits: (r.deals ?? []).map((d) => ({
        key: `deal:${d.id}`,
        href: `/ops/deals/${d.id}`,
        title: dot(d.company ?? d.client?.name, d.title),
        meta: dot(
          DEAL_STAGE_NAMES.get(d.stage) ?? d.stage,
          d.outcome === "open" ? null : (DEAL_OUTCOME_WORDS[d.outcome] ?? d.outcome),
        ),
      })),
    },
    {
      label: "Agents",
      hits: r.agents.map((a) => ({
        key: `a:${a.id}`,
        // The agent page is addressed by slug; `/ops/agents/:id` finds it.
        href: `/ops/agents/${a.id}`,
        title: a.serviceName && a.serviceName !== a.name ? dot(a.name, a.serviceName) : a.name,
        meta:
          a.kind === "template"
            ? "Template"
            : dot(a.client?.name, a.status ? (AGENT_STATUS_WORDS[a.status] ?? a.status) : null),
      })),
    },
    {
      label: "Runs",
      hits: r.runs.map((x) => ({
        key: `r:${x.id}`,
        href: `/ops/runs/${x.id}`,
        title: dot(x.subject ? opsRunTitle(x.subject) : null, x.shortId, x.service.name),
        // "Waiting for approval · client admin", never "running" (UI cleanup, stream A).
        meta: dot(
          x.client.name,
          runChip({ status: x.status, waiting: x.waiting ?? null }).words,
          x.mode === "live" ? null : "Test run",
          x.summary,
        ),
      })),
    },
    {
      label: "Records",
      hits: r.records.flatMap((x) => [
        {
          key: `rec:${x.id}`,
          href:
            x.kind === "receivable"
              ? `${base(x.client)}/records?kind=receivables`
              : `${base(x.client)}/records/${x.id}`,
          title: x.label,
          meta: dot(
            x.client.name,
            x.number,
            x.date,
            x.amount && money(x.amount, x.currency ?? "USD"),
          ),
        },
        ...runsAboutHit(
          x,
          recordHitSubjectKind(x.kind),
          `${base(x.client)}/runs`,
          (count) => `${plural(count, "run", "runs")} about ${x.label}`,
        ),
      ]),
    },
    {
      label: "People",
      hits: [
        ...r.people.map((p) => ({
          key: `p:${p.id}`,
          href: `${base(p.client)}/directory`,
          title: p.name,
          meta: dot(p.client.name, p.title, p.organization?.name, p.email),
        })),
        ...r.organizations.map((o) => ({
          key: `o:${o.id}`,
          href: `${base(o.client)}/directory`,
          title: o.name,
          meta: dot(o.client.name, o.website),
        })),
      ],
    },
    {
      label: "Documents",
      hits: r.documents.flatMap((d) => [
        {
          key: `d:${d.id}`,
          href: `${base(d.client)}/documents/${d.id}`,
          title: d.filename,
          meta: dot(d.client.name, d.vendor, d.number),
        },
        ...runsAboutHit(
          d,
          "document",
          `${base(d.client)}/runs`,
          (count) => `${plural(count, "run", "runs")} about ${d.filename}`,
        ),
      ]),
    },
  ];
}
