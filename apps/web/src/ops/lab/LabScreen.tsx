// O2 Agent lab (docs/design/prototype.html `#O2-Lab`; docs/ui-plan.md): build an agent for one
// client, then turn it into a template the next client starts from. A gallery (the owner's review:
// "start with the templates and then open them to a full page"): templates first, then drafts,
// client-only agents or all of them, as cards or a list, with a status filter and a search that
// reads plain words ("behind", "failing", a client's name). Each opens its own full page, where its
// workflow, client copies, test bench and Assign to a client live (../agents, ./TemplateParts).
import type { LabResponse, LabTemplate } from "@countersign/core";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { type AgentSummary, apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { AgentBadge } from "../../ui/badges";
import { Clamp } from "../../ui/Clamp";
import { TextInput } from "../../ui/forms";
import { Loaded, Page } from "../../ui/page";
import { buttonClass, Card, cx, EmptyState, PageHeader, Tag } from "../../ui/primitives";
import { type ChipState, StatusChip } from "../../ui/status";
import { plural, Select } from "../agents/ui";
import { TableCard } from "../screens/business";
import { rememberLabQuery } from "./back";
import { handOver } from "./TemplateParts";

export { useSlow } from "./TemplateParts";

type Tab = "templates" | "drafts" | "client" | "all";
const TABS: readonly Tab[] = ["templates", "drafts", "client", "all"];

type Status = "any" | "current" | "behind" | "unused" | "changes" | "failing";
const STATUSES: readonly (readonly [Status, string])[] = [
  ["any", "Any status"],
  ["current", "Up to date"],
  ["behind", "Clients behind"],
  ["unused", "No clients yet"],
  ["changes", "Unpublished changes"],
  ["failing", "Tests failing"],
];

type View = "cards" | "list";
const VIEW_KEY = "mezonas.lab.view";

/** One agent in the gallery, whatever it is: a template, a draft or a client-only agent. */
type Item = {
  id: string;
  slug: string;
  name: string;
  role: string | null;
  kind: Exclude<Tab, "all">;
  live: number | null;
  latest: number | null;
  /** Client copies, and how many of them are behind its live version (templates). */
  clients: number | null;
  behind: number;
  tests: { passed: number; total: number; cases: number } | null;
  client: { id: string; name: string } | null;
  to: string;
};

function fromTemplate(t: LabTemplate, kind: "templates" | "drafts", role: string | null): Item {
  const run = t.tests.latest;
  return {
    id: t.agent.id,
    slug: t.agent.slug,
    name: t.agent.name,
    role,
    kind,
    live: t.agent.liveVersion,
    latest: t.agent.latestVersion,
    clients: t.clients,
    behind: t.behind,
    tests: run
      ? { passed: run.passed, total: run.total, cases: t.tests.cases }
      : t.tests.cases > 0
        ? { passed: 0, total: 0, cases: t.tests.cases }
        : null,
    client: null,
    to: `/ops/templates/${t.agent.slug}`,
  };
}

function items(data: LabResponse, roles: Map<string, string | null>): Item[] {
  return [
    ...data.published.map((t) => fromTemplate(t, "templates", roles.get(t.agent.id) ?? null)),
    ...data.drafts.map((t) => fromTemplate(t, "drafts", roles.get(t.agent.id) ?? null)),
    ...data.clientOnly.map(
      ({ agent, client }): Item => ({
        id: agent.id,
        slug: agent.slug,
        name: agent.name,
        role: roles.get(agent.id) ?? null,
        kind: "client",
        live: agent.liveVersion,
        latest: agent.latestVersion,
        clients: null,
        behind: 0,
        tests: null,
        client,
        to: `/ops/clients/${client.id}/agents/${agent.slug}`,
      }),
    ),
  ];
}

const hasChanges = (i: Item) => i.latest !== null && i.latest !== i.live;
const failing = (i: Item) =>
  i.tests ? i.tests.total > 0 && i.tests.passed < i.tests.total : false;

/** Its state in a word, the one that needs us first: tests failing, clients behind, then the rest. */
function itemState(i: Item): { state: ChipState; words: string } {
  if (failing(i)) return { state: "failed", words: "Tests failing" };
  if (i.kind === "drafts") return { state: "setup", words: "Draft" };
  if (i.kind === "client")
    return i.live === null ? { state: "setup", words: "Draft" } : { state: "done", words: "Live" };
  if (i.behind > 0) return { state: "waiting", words: `${i.behind} behind` };
  if (i.clients === 0) return { state: "idle", words: "No clients yet" };
  return { state: "done", words: "Up to date" };
}

function matchesStatus(i: Item, s: Status): boolean {
  switch (s) {
    case "any":
      return true;
    case "current":
      return i.kind === "templates" && i.behind === 0 && (i.clients ?? 0) > 0;
    case "behind":
      return i.behind > 0;
    case "unused":
      return i.kind !== "client" && (i.clients ?? 0) === 0;
    case "changes":
      return hasChanges(i);
    case "failing":
      return failing(i);
  }
}

const KIND_WORDS: Record<Item["kind"], string> = {
  templates: "template",
  drafts: "draft",
  client: "client-only",
};

/**
 * Smart search: every word must match something about the agent, so "bill harbor" or "behind"
 * or "failing v2" narrow it down. Matches its name, job, slug, kind, client, state and versions.
 */
export function matchesSearch(i: Item, q: string): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = [
    i.name,
    i.role ?? "",
    i.slug,
    KIND_WORDS[i.kind],
    i.client?.name ?? "",
    itemState(i).words,
    i.behind > 0 ? "behind outdated update" : "",
    hasChanges(i) ? "unpublished changes draft" : "",
    failing(i) ? "failing failed tests" : "",
    (i.clients ?? 0) === 0 && i.kind !== "client" ? "unused no clients" : "",
    i.live !== null ? `v${i.live} live published` : "",
    i.latest !== null ? `v${i.latest}` : "",
  ]
    .join(" ")
    .toLowerCase();
  return words.every((w) => hay.includes(w));
}

function useLabView(): [View, (v: View) => void] {
  const [view, setView] = useState<View>(() => {
    try {
      return window.localStorage.getItem(VIEW_KEY) === "list" ? "list" : "cards";
    } catch {
      return "cards";
    }
  });
  const choose = (v: View) => {
    setView(v);
    try {
      window.localStorage.setItem(VIEW_KEY, v);
    } catch {
      // Storage blocked: the choice lasts for this visit.
    }
  };
  return [view, choose];
}

export function LabScreen() {
  const lab = useApi(apiRoutes.opsLab);
  // Each template's role and status; discarded drafts too, so they can be found and restored.
  const templates = useApi(apiRoutes.opsTemplates, { query: { include: "discarded" } });
  const [params, setParams] = useSearchParams();
  const tabParam = params.get("tab");
  const tab: Tab = TABS.includes(tabParam as Tab) ? (tabParam as Tab) : "templates";
  const statusParam = params.get("status");
  const status: Status = STATUSES.some(([s]) => s === statusParam)
    ? (statusParam as Status)
    : "any";
  const q = params.get("q") ?? "";
  const [view, setView] = useLabView();
  // What "All agents" returns to is the view shown, not the address as typed: a tab or status the
  // lab doesn't know (QA: `?status=%00`) falls back above and isn't remembered.
  const shown = new URLSearchParams();
  if (tab !== "templates") shown.set("tab", tab);
  if (status !== "any") shown.set("status", status);
  const search = q.replace(/\p{Cc}/gu, "").trim();
  if (search) shown.set("q", search);
  const remembered = shown.toString();
  useEffect(() => rememberLabQuery(remembered), [remembered]);

  function set(next: { tab?: Tab; status?: Status; q?: string }) {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v === undefined) continue;
      if (v === "" || v === "any" || (k === "tab" && v === "templates")) p.delete(k);
      else p.set(k, v);
    }
    setParams(p, { replace: true });
  }

  const roles = useMemo(
    () => new Map((templates.data?.templates ?? []).map((t) => [t.id, t.role] as const)),
    [templates.data],
  );
  const discarded = (templates.data?.templates ?? []).filter((t) => t.status === "disabled");

  return (
    <Page testId="ops-lab">
      <PageHeader
        title="Agent lab"
        subtitle="Build an agent for one client, then turn it into a template the next client starts from."
        actions={
          <Link to="/ops/templates/new" className={buttonClass("primary")} data-testid="lab-new">
            New template
          </Link>
        }
      />
      <Loaded state={lab}>
        {(data) => {
          const all = items(data, roles);
          const inTab = tab === "all" ? all : all.filter((i) => i.kind === tab);
          const shown = inTab.filter((i) => matchesStatus(i, status) && matchesSearch(i, q));
          const filtered = status !== "any" || q.trim() !== "";
          return (
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center gap-3">
                <LabTabs
                  data={data}
                  total={all.length}
                  tab={tab}
                  onChoose={(t) => set({ tab: t })}
                />
                <Select
                  aria-label="Status"
                  className="h-9 w-48"
                  data-testid="lab-status"
                  value={status}
                  onChange={(e) => set({ status: e.target.value as Status })}
                >
                  {STATUSES.map(([v, label]) => (
                    <option key={v} value={v}>
                      {label}
                    </option>
                  ))}
                </Select>
                <div className="w-full sm:w-72">
                  <TextInput
                    type="search"
                    aria-label="Search agents"
                    placeholder="Search a name, client or “behind”"
                    data-testid="lab-search"
                    value={q}
                    onChange={(e) => set({ q: e.target.value })}
                  />
                </div>
                <fieldset className="ds-seg m-0 sm:ml-auto" data-testid="lab-view">
                  <legend className="sr-only">View as</legend>
                  {(
                    [
                      ["cards", "Cards"],
                      ["list", "List"],
                    ] as const
                  ).map(([v, text]) => (
                    <button
                      key={v}
                      type="button"
                      aria-pressed={view === v}
                      data-testid={`lab-view-${v}`}
                      onClick={() => setView(v)}
                      className="hover:text-ink"
                    >
                      {text}
                    </button>
                  ))}
                </fieldset>
              </div>

              {shown.length === 0 ? (
                filtered ? (
                  <EmptyState
                    icon="search"
                    title="No agent matches"
                    line="Try other words, or another status."
                    action={{
                      label: "Clear search and status",
                      onClick: () => set({ q: "", status: "any" }),
                      testId: "lab-clear",
                    }}
                  />
                ) : (
                  <EmptyState
                    icon="team"
                    title={
                      tab === "drafts"
                        ? "No drafts"
                        : tab === "client"
                          ? "No client-only agents"
                          : "No templates yet"
                    }
                    line={
                      tab === "drafts"
                        ? "A new template starts as a draft until its first publish."
                        : tab === "client"
                          ? "Every client agent comes from a template."
                          : "Publish a draft, or promote a client agent's changes into one."
                    }
                    action={
                      tab === "client"
                        ? undefined
                        : { label: "New template", to: "/ops/templates/new" }
                    }
                  />
                )
              ) : view === "cards" ? (
                <div className="ui-labgrid" data-testid="lab-cards">
                  {shown.map((i) => (
                    <AgentCard key={i.id} item={i} />
                  ))}
                </div>
              ) : (
                <AgentTable items={shown} />
              )}

              {tab === "drafts" && discarded.length > 0 ? (
                <DiscardedList agents={discarded} />
              ) : null}
            </div>
          );
        }}
      </Loaded>
    </Page>
  );
}

function LabTabs({
  data,
  total,
  tab,
  onChoose,
}: {
  data: LabResponse;
  total: number;
  tab: Tab;
  onChoose(tab: Tab): void;
}) {
  const tabs: { id: Tab; label: string }[] = [
    { id: "templates", label: `Templates · ${data.published.length}` },
    { id: "drafts", label: `Drafts · ${data.drafts.length}` },
    { id: "client", label: `Client-only · ${data.clientOnly.length}` },
    { id: "all", label: `All · ${total}` },
  ];
  return (
    <div className="ds-seg" data-testid="lab-tabs">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          aria-pressed={tab === t.id}
          data-testid={`lab-tab-${t.id}`}
          onClick={() => onChoose(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function versionWords(i: Item): string {
  if (i.live === null) return i.latest !== null ? `Draft v${i.latest}` : "Draft";
  return hasChanges(i) ? `v${i.live} · draft v${i.latest}` : `v${i.live}`;
}

function testsWords(i: Item): string {
  if (!i.tests) return "—";
  if (i.tests.total === 0) return `${i.tests.cases} not run`;
  return `${i.tests.passed}/${i.tests.total}`;
}

/** What it is, in a word, over its name: "Template", "Draft", "Client-only · Harbor Millwork". */
function kindLine(i: Item): string {
  if (i.kind === "client") return `Client-only · ${i.client?.name ?? ""}`;
  return i.kind === "drafts" ? "Draft template" : "Template";
}

function testId(i: Item): string {
  return i.kind === "client" ? `lab-client-only-${i.slug}` : `lab-template-${i.slug}`;
}

function AgentCard({ item: i }: { item: Item }) {
  const st = itemState(i);
  return (
    <Link
      to={i.to}
      state={handOver(i.id)}
      data-testid={testId(i)}
      className={cx(
        "ds-card flex flex-col overflow-hidden text-left transition-colors hover:border-slate",
        "focus-visible:outline-2 focus-visible:outline-slate",
        i.kind !== "templates" && "border-dashed",
      )}
    >
      <span className="flex flex-1 flex-col gap-2.5 px-5 pt-4 pb-4">
        <span className="flex items-center gap-3">
          <AgentBadge name={i.name} seed={i.id} size="sm" />
          <span className="flex min-w-0 flex-1 flex-col">
            <b className="truncate font-medium text-ink">{i.name}</b>
            <span className="truncate text-xs text-ink-muted">{kindLine(i)}</span>
          </span>
          <span className="reference shrink-0 text-ink-muted">{versionWords(i)}</span>
        </span>
        {i.role ? (
          <Clamp lines={2} className="text-sm text-ink-muted">
            {i.role}
          </Clamp>
        ) : (
          <span className="text-sm text-ink-muted">No job description yet.</span>
        )}
        <span className="mt-auto flex flex-wrap gap-1.5 pt-1">
          <StatusChip state={st.state} testId={`${testId(i)}-state`}>
            {st.words}
          </StatusChip>
          {hasChanges(i) && i.live !== null ? <Tag>Unpublished changes</Tag> : null}
        </span>
      </span>
      {i.kind === "client" ? null : (
        <span className="grid grid-cols-3 gap-2 border-t border-line bg-surface-subtle px-5 py-3">
          <Figure label="Clients" value={String(i.clients ?? 0)} strong={(i.clients ?? 0) > 0} />
          <Figure
            label="Behind"
            value={String(i.behind)}
            tone={i.behind > 0 ? "text-signal-ink" : undefined}
          />
          <Figure label="Tests" value={testsWords(i)} tone={failing(i) ? "text-risk" : undefined} />
        </span>
      )}
    </Link>
  );
}

function Figure({
  label,
  value,
  strong = false,
  tone,
}: {
  label: string;
  value: string;
  strong?: boolean;
  tone?: string | undefined;
}) {
  return (
    <span className="flex flex-col gap-0.5">
      <span className="eyebrow text-ink-muted">{label}</span>
      <span className={cx("figures font-medium", tone ?? (strong ? "text-slate" : "text-ink"))}>
        {value}
      </span>
    </span>
  );
}

function AgentTable({ items: rows }: { items: Item[] }) {
  const navigate = useNavigate();
  return (
    <TableCard title={plural(rows.length, "agent")} testId="lab-table">
      <table>
        <thead>
          <tr className="dt-cols">
            <th>Agent</th>
            <th>Kind</th>
            <th>Status</th>
            <th className="text-right">Clients</th>
            <th className="text-right">Behind</th>
            <th className="text-right">Tests</th>
            <th>Version</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((i) => {
            const st = itemState(i);
            return (
              <tr
                key={i.id}
                data-testid={`${testId(i)}-row`}
                className="cursor-pointer hover:bg-surface-subtle"
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest("a, button")) return;
                  navigate(i.to, { state: handOver(i.id) });
                }}
              >
                <td>
                  <span className="flex min-w-[16rem] items-center gap-3 py-1">
                    <AgentBadge name={i.name} seed={i.id} size="sm" />
                    <span className="flex min-w-0 flex-col">
                      <Link
                        to={i.to}
                        state={handOver(i.id)}
                        className="font-medium text-ink hover:underline"
                      >
                        {i.name}
                      </Link>
                      {i.role ? (
                        <Clamp lines={1} className="text-xs text-ink-muted">
                          {i.role}
                        </Clamp>
                      ) : null}
                    </span>
                  </span>
                </td>
                <td className="text-sm">{kindLine(i)}</td>
                <td>
                  <StatusChip state={st.state}>{st.words}</StatusChip>
                </td>
                <td className="n">{i.clients ?? "—"}</td>
                <td className={cx("n", i.behind > 0 && "text-signal-ink")}>
                  {i.kind === "client" ? "—" : i.behind}
                </td>
                <td className={cx("n", failing(i) && "text-risk")}>{testsWords(i)}</td>
                <td className="reference text-sm text-ink-muted">{versionWords(i)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableCard>
  );
}

function DiscardedList({ agents }: { agents: AgentSummary[] }) {
  return (
    <Card titleAbove title="Discarded drafts" testId="lab-discarded">
      <ul className="flex flex-col divide-y divide-line">
        {agents.map((a) => (
          <li key={a.id} className="px-6 py-2.5">
            <Link
              to={`/ops/templates/${a.slug}`}
              state={handOver(a.id)}
              className="text-sm text-link hover:underline"
            >
              {a.name}
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}
