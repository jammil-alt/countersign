// The API's search hits as groups of links, one function per surface (packages/core/src/api/search.ts).
// Pure, so the links each hit opens are tested on their own.
import type { OpsSearchResult, PortalSearchResult } from "@countersign/core";
import type { Translate } from "../i18n/catalog";
import type { Formatters } from "../i18n/format";
import { EN } from "../i18n/i18n";
import { runChip } from "../ops/run/words";
import type { SearchGroup } from "./Search";

const dot = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(" · ");

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

/** A record's amount with its currency ("$9,742.35"), never the stored "9742.3500 USD". */
function money(fmt: Pick<Formatters, "money">, amount: string | null, currency: string | null) {
  return amount ? fmt.money(amount, currency ?? undefined) : null;
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
  fmt: Pick<Formatters, "money"> = EN.fmt,
): SearchGroup[] {
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
        title: dot(x.shortId, x.service.name),
        // A run waiting on the client reads as it does on Runs (UI cleanup, stream A).
        meta:
          x.waitingOnYou && GOING.has(x.status) ? t("common.waitingOnYou") : runStatus(t, x.status),
      })),
    },
    {
      label: t("search.group.records"),
      hits: r.records.map((x) => ({
        key: `rec:${x.id}`,
        href: x.kind === "receivable" ? "/records?kind=receivables" : `/records/${x.id}`,
        title: x.label,
        meta: dot(x.number, x.date, money(fmt, x.amount, x.currency)),
      })),
    },
    {
      label: t("search.group.people"),
      hits: [
        ...r.people.map((p) => ({
          key: `p:${p.id}`,
          href: `/people?person=${encodeURIComponent(p.id)}`,
          title: p.name,
          meta: dot(p.title, p.organization?.name, p.email),
        })),
        ...r.organizations.map((o) => ({
          key: `o:${o.id}`,
          href: "/people/organizations",
          title: o.name,
          meta: o.website ?? undefined,
        })),
      ],
    },
    {
      label: t("search.group.documents"),
      hits: r.documents.map((d) => ({
        key: `d:${d.id}`,
        href: `/documents/${d.id}`,
        title: d.filename,
        meta: dot(d.vendor, d.number),
      })),
    },
  ];
}

/**
 * The back office: hits across the clients served, each naming its client. Clients come from the
 * clients list (the search route has none), matched by name here.
 */
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
        title: dot(x.shortId, x.service.name),
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
      hits: r.records.map((x) => ({
        key: `rec:${x.id}`,
        href:
          x.kind === "receivable"
            ? `${base(x.client)}/records?kind=receivables`
            : `${base(x.client)}/records/${x.id}`,
        title: x.label,
        meta: dot(x.client.name, x.number, x.date, money(EN.fmt, x.amount, x.currency)),
      })),
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
      hits: r.documents.map((d) => ({
        key: `d:${d.id}`,
        href: `${base(d.client)}/documents/${d.id}`,
        title: d.filename,
        meta: dot(d.client.name, d.vendor, d.number),
      })),
    },
  ];
}
