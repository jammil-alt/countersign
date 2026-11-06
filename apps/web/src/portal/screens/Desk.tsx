// `/desk`, Your Desk (docs/ui-plan.md C3; docs/design/prototype.html `#C3-Desk`; ARCHITECTURE
// §11.1): what the client's agents need from this person, and what they have done. The list on
// the left by day, the open item on the right with its decision and its worksheet. Views: waiting
// on you, questions, not now (snoozed), done. A client user sees only what is theirs (the API
// filters); a viewer sees and never signs. Every action reloads the shell's Desk count.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { DeskDetail } from "../../desk/DeskDetail";
import { DeskList } from "../../desk/DeskList";
import { DeskTeam } from "../../desk/DeskTeam";
import { type DeskEntry, entriesOf, leadOf, needOf } from "../../desk/model";
import { useI18n } from "../../i18n/i18n";
import { usePoll } from "../../runs/usePoll";
import { useSession } from "../../session/session";
import { Select } from "../../ui/forms";
import { Page } from "../../ui/page";
import {
  buttonClass,
  Card,
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
} from "../../ui/primitives";
import { useRefreshInboxCount } from "../inboxCount";
import { PORTAL_PATHS } from "../paths";

const VIEWS = ["waiting", "questions", "later", "done"] as const;
type View = (typeof VIEWS)[number];

/** How many of the latest done items show under "Waiting on you" ("Done this week"). */
const DONE_PREVIEW = 5;
const WEEK_MS = 7 * 24 * 60 * 60_000;

export function PortalDeskScreen() {
  const { t } = useI18n();
  const session = useSession();
  const refreshCount = useRefreshInboxCount();
  const [params, setParams] = useSearchParams();
  const view: View = (VIEWS as readonly string[]).includes(params.get("view") ?? "")
    ? (params.get("view") as View)
    : "waiting";
  const wanted = params.get("item");
  const [agentFilter, setAgentFilter] = useState("");
  // The open entry belongs to the view it was opened in: a view change (the URL updates after a
  // render) never shows the last view's entry.
  const [picked, setPicked] = useState<{ view: View; agent: string; entry: DeskEntry } | null>(
    null,
  );
  const detailRef = useRef<HTMLDivElement>(null);
  const selected =
    picked && picked.view === view && picked.agent === agentFilter ? picked.entry : null;
  const setSelected = (entry: DeskEntry | null) =>
    setPicked(entry ? { view, agent: agentFilter, entry } : null);

  const waiting = useApi(apiRoutes.portalInbox, { query: { status: "open" } });
  const later = useApi(apiRoutes.portalInbox, { query: { status: "open", view: "snoozed" } });
  const done = useApi(apiRoutes.portalInbox, { query: { status: "resolved" } });
  const team = useApi(apiRoutes.portalTeam);
  usePoll(waiting.reload, true, 20_000, waiting.loading);

  const client = session.tenants.find((c) => c.id === session.activeTenantId) ?? null;
  const isAdmin = client?.role === "client_admin";
  // A viewer (`canSign` false) sees the Desk without its buttons; until the team loads, the API
  // is the judge.
  const me = team.data?.members.find((m) => m.userId === session.user.id);
  const canSign = me ? me.canSign : true;

  const now = new Date();
  const byAgent = useCallback(
    (entries: DeskEntry[]) =>
      agentFilter ? entries.filter((e) => leadOf(e).service?.id === agentFilter) : entries,
    [agentFilter],
  );
  const waitingEntries = useMemo(() => entriesOf(waiting.data?.items ?? []), [waiting.data]);
  const questionEntries = waitingEntries.filter((e) => needOf(leadOf(e)) === "answer");
  const laterEntries = useMemo(() => entriesOf(later.data?.items ?? []), [later.data]);
  const doneEntries = useMemo(() => entriesOf(done.data?.items ?? []), [done.data]);
  const doneThisWeek = doneEntries
    .filter((e) => {
      const at = leadOf(e).resolvedAt;
      return at !== null && now.getTime() - new Date(at).getTime() < WEEK_MS;
    })
    .slice(0, DONE_PREVIEW);
  const shown = byAgent(
    view === "waiting"
      ? waitingEntries
      : view === "questions"
        ? questionEntries
        : view === "later"
          ? laterEntries
          : doneEntries,
  );
  const state = view === "later" ? later : view === "done" ? done : waiting;

  // The agents the items come from, for the "All agents" filter.
  const agents = useMemo(() => {
    const out = new Map<string, string>();
    for (const list of [waiting.data, later.data, done.data]) {
      for (const i of list?.items ?? []) if (i.service) out.set(i.service.id, i.service.name);
    }
    return [...out.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [waiting.data, later.data, done.data]);

  // The first entry opens by itself; `?item=` opens that one (a link from the Table or a text).
  useEffect(() => {
    if (selected) return;
    const all = [...waitingEntries, ...laterEntries, ...doneEntries];
    const loaded = !!(waiting.data && later.data && done.data);
    const found = wanted ? all.find((e) => e.items.some((i) => i.id === wanted)) : undefined;
    const pick = found ?? (!wanted || loaded ? shown[0] : undefined);
    if (pick) setPicked({ view, agent: agentFilter, entry: pick });
  }, [
    selected,
    view,
    agentFilter,
    wanted,
    waitingEntries,
    laterEntries,
    doneEntries,
    shown,
    waiting.data,
    later.data,
    done.data,
  ]);

  const select = (entry: DeskEntry) => {
    setSelected(entry);
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        next.set("item", leadOf(entry).id);
        return next;
      },
      { replace: true },
    );
    // At phone width the card is below the list: bring it into view.
    if (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(max-width: 900px)").matches
    ) {
      detailRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    }
  };

  const setView = (v: View) => {
    setSelected(null);
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (v === "waiting") next.delete("view");
        else next.set("view", v);
        next.delete("item");
        return next;
      },
      { replace: true },
    );
  };

  const changed = () => {
    waiting.reload();
    later.reload();
    done.reload();
    refreshCount();
  };

  const count = (n: number | undefined) => (n === undefined ? "" : ` · ${n}`);
  const tabs: { view: View; label: string }[] = [
    {
      view: "waiting",
      label: `${t("common.waitingOnYou")}${count(waiting.data ? waitingEntries.length : undefined)}`,
    },
    {
      view: "questions",
      label: `${t("desk.view.questions")}${count(waiting.data ? questionEntries.length : undefined)}`,
    },
    {
      view: "later",
      label: `${t("desk.view.later")}${count(later.data ? laterEntries.length : undefined)}`,
    },
    { view: "done", label: t("desk.view.done") },
  ];

  return (
    <Page testId="portal-desk">
      <div>
        <PageHeader
          title={t("desk.title")}
          subtitle={t("desk.subtitle")}
          actions={
            <>
              {/* DECISION: requests (the client's own asks of us) open from the Desk's header;
                  where they finally live is open for the owner (docs/ui-plan.md, question 1). */}
              <Link
                to={PORTAL_PATHS.requests}
                className={buttonClass("secondary")}
                data-testid="desk-requests"
              >
                {t("nav.requests")}
              </Link>
              {agents.length > 1 ? (
                <Select
                  aria-label={t("desk.filter.agent")}
                  data-testid="desk-agent-filter"
                  value={agentFilter}
                  onChange={(e) => {
                    setAgentFilter(e.target.value);
                    setSelected(null);
                  }}
                  className="w-48"
                >
                  <option value="">{t("desk.filter.allAgents")}</option>
                  {agents.map(([id, name]) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
                </Select>
              ) : null}
            </>
          }
        />
        <fieldset className="ds-seg min-w-0 max-w-full overflow-x-auto" data-testid="desk-views">
          <legend className="sr-only">{t("desk.view.label")}</legend>
          {tabs.map((tab) => (
            <button
              key={tab.view}
              type="button"
              aria-pressed={view === tab.view}
              data-testid={`desk-view-${tab.view}`}
              className="whitespace-nowrap"
              onClick={() => setView(tab.view)}
            >
              {tab.label}
            </button>
          ))}
        </fieldset>
      </div>

      {/* Phone: the list, the open item, then who signs. Wide: the list and who signs on the
          left, the open item on the right. */}
      <div className="flex flex-col gap-5 lg:grid lg:grid-cols-[minmax(320px,420px)_minmax(0,1fr)] lg:grid-rows-[auto_1fr] lg:items-start">
        <div className="flex min-w-0 flex-col gap-5 lg:col-start-1 lg:row-start-1">
          <Card testId="desk-list">
            {state.error && !state.data ? (
              <div className="p-4">
                <ErrorNotice error={state.error} onRetry={state.reload} />
              </div>
            ) : !state.data ? (
              <div className="px-5">
                <Loading />
              </div>
            ) : (
              <>
                <DeskList
                  entries={shown}
                  selected={selected?.key ?? null}
                  onSelect={select}
                  now={now}
                  empty={t(`desk.empty.${view}`)}
                  testId="desk-entries"
                />
                {view === "waiting" && !agentFilter && doneThisWeek.length > 0 ? (
                  <DeskList
                    entries={doneThisWeek}
                    selected={selected?.key ?? null}
                    onSelect={select}
                    now={now}
                    heading={t("desk.day.doneThisWeek")}
                    testId="desk-done-week"
                  />
                ) : null}
              </>
            )}
          </Card>
        </div>

        <div
          ref={detailRef}
          className="flex min-w-0 flex-col gap-5 lg:col-start-2 lg:row-span-2 lg:row-start-1"
        >
          {selected ? (
            <DeskDetail key={selected.key} entry={selected} canSign={canSign} onChanged={changed} />
          ) : state.data ? (
            <EmptyState>{t("desk.pick")}</EmptyState>
          ) : null}
        </div>

        {team.data ? (
          <div className="min-w-0 lg:col-start-1 lg:row-start-2">
            <DeskTeam team={team.data} isAdmin={isAdmin} onSaved={team.reload} />
          </div>
        ) : null}
      </div>
    </Page>
  );
}
