// `/inbox`, the Inbox (was "Your Desk"; docs/ui-plan.md C3, Review 1; ARCHITECTURE §11.1): what
// the client's agents need from this person, and what they have done. The list on the left by day,
// the open item on the right with its decision and its worksheet. Two views, Waiting and Done;
// questions are in Waiting, and "Not now" (snoozed) items show there when asked for. Who approves
// what and the undo window are in Settings, under Approvals. A client user sees only what is
// theirs (the API filters); a viewer sees and never approves. Every action reloads the shell's
// Inbox count.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { DeskDetail } from "../../desk/DeskDetail";
import { DeskList } from "../../desk/DeskList";
import { type DeskEntry, entriesOf, leadOf } from "../../desk/model";
import { useI18n } from "../../i18n/i18n";
import { usePoll } from "../../runs/usePoll";
import { useSession } from "../../session/session";
import { Select } from "../../ui/forms";
import { Page } from "../../ui/page";
import { buttonClass, Card, EmptyState, ErrorNotice, PageHeader } from "../../ui/primitives";
import { Skeleton, SkeletonText } from "../../ui/skeleton";
import { useRefreshInboxCount } from "../inboxCount";
import { askSloan, PORTAL_PATHS } from "../paths";

const VIEWS = ["waiting", "done"] as const;
type View = (typeof VIEWS)[number];

/**
 * The view an address asks for: `?view=done`, else Waiting. The old views fold in: questions are
 * in Waiting, and `?view=later` is Waiting with "Not now" shown.
 */
export function viewOf(params: URLSearchParams): { view: View; later: boolean } {
  const v = params.get("view");
  return { view: v === "done" ? "done" : "waiting", later: v === "later" || params.has("later") };
}

/** How many of the latest done items show under "Waiting on you" ("Done this week"). */
const DONE_PREVIEW = 5;
/** The most items the API lists (`GET /api/inbox`): a full list may hold fewer than the count. */
const INBOX_LIST_MAX = 200;
const WEEK_MS = 7 * 24 * 60 * 60_000;

export function PortalInboxScreen() {
  const { t } = useI18n();
  const session = useSession();
  const refreshCount = useRefreshInboxCount();
  const [params, setParams] = useSearchParams();
  const { view, later: showLater } = viewOf(params);
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
  // The frame's count is this list's length (open, not put off). The frame asks for it again on a
  // page change only when it is a few seconds old (docs/audit-plan.md 2.1), so a list that says
  // otherwise refreshes it: an item that opened since shows in the count as it shows here.
  const overview = useApi(apiRoutes.portalOverview);
  // Only a list just answered is compared: a stored one refreshing behind may be older than the count.
  const openCount = waiting.refreshing ? undefined : waiting.data?.items.length;
  const countShown = overview.data?.needsYou.inbox;
  useEffect(() => {
    if (openCount === undefined || countShown === undefined) return;
    if (openCount < INBOX_LIST_MAX && openCount !== countShown) refreshCount();
  }, [openCount, countShown, refreshCount]);

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
  const laterEntries = useMemo(() => entriesOf(later.data?.items ?? []), [later.data]);
  const doneEntries = useMemo(() => entriesOf(done.data?.items ?? []), [done.data]);
  const doneThisWeek = doneEntries
    .filter((e) => {
      const at = leadOf(e).resolvedAt;
      return at !== null && now.getTime() - new Date(at).getTime() < WEEK_MS;
    })
    .slice(0, DONE_PREVIEW);
  const shown = byAgent(view === "done" ? doneEntries : waitingEntries);
  const shownLater = view === "waiting" && showLater ? byAgent(laterEntries) : [];
  const state = view === "done" ? done : waiting;

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
    const pick = found ?? (!wanted || loaded ? (shown[0] ?? shownLater[0]) : undefined);
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
    shownLater,
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
        next.delete("later");
        next.delete("item");
        return next;
      },
      { replace: true },
    );
  };

  /** "Not now": the snoozed items, shown under Waiting or not. */
  const toggleLater = () => {
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (next.get("view") === "later") next.delete("view");
        if (showLater) next.delete("later");
        else next.set("later", "1");
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
      label: `${t("common.waiting")}${count(waiting.data ? waitingEntries.length : undefined)}`,
    },
    { view: "done", label: t("desk.view.done") },
  ];

  return (
    <Page testId="portal-inbox">
      <div>
        <PageHeader
          title={t("nav.inbox")}
          subtitle={t("desk.subtitle")}
          actions={
            <>
              {/* DECISION: asking us for something is a question to Sloan, who passes requests to
                  your lead (Review 1: "Requests becomes Ask us"); the list of requests is on
                  Sloan's page. */}
              <Link
                to={askSloan(t("inbox.askUsPrompt"))}
                className={buttonClass("secondary")}
                data-testid="inbox-ask-us"
              >
                {t("inbox.askUs")}
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
        <div className="flex flex-wrap items-center justify-between gap-3">
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
          {view === "waiting" && laterEntries.length > 0 ? (
            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                className="size-4 accent-slate"
                checked={showLater}
                onChange={toggleLater}
                data-testid="desk-show-later"
              />
              {t("inbox.showLater", { count: laterEntries.length })}
            </label>
          ) : null}
        </div>
      </div>

      {/* Phone: the list, then the open item. Wide: the list on the left, the open item on the
          right with most of the width (its before and after tables need it). */}
      <div className="flex flex-col gap-5 lg:grid lg:grid-cols-[minmax(260px,340px)_minmax(0,1fr)] lg:items-start">
        <div className="flex min-w-0 flex-col gap-3">
          <Card testId="desk-list">
            {state.error && !state.data ? (
              <div className="p-4">
                <ErrorNotice error={state.error} onRetry={state.reload} />
              </div>
            ) : !state.data ? (
              <Skeleton>
                <div className="flex flex-col gap-5 p-5">
                  <SkeletonText lines={2} />
                  <SkeletonText lines={2} />
                  <SkeletonText lines={2} />
                </div>
              </Skeleton>
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
                {shownLater.length > 0 ? (
                  <DeskList
                    entries={shownLater}
                    selected={selected?.key ?? null}
                    onSelect={select}
                    now={now}
                    heading={t("desk.view.later")}
                    testId="desk-later"
                  />
                ) : null}
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
          <Link
            to={PORTAL_PATHS.approvals}
            className="self-start text-sm text-link hover:underline"
            data-testid="desk-approval-settings"
          >
            {t("desk.approvalSettings")}
          </Link>
        </div>

        <div ref={detailRef} className="flex min-w-0 flex-col gap-5">
          {selected ? (
            <DeskDetail key={selected.key} entry={selected} canSign={canSign} onChanged={changed} />
          ) : state.data && shown.length > 0 ? (
            <EmptyState>{t("desk.pick")}</EmptyState>
          ) : null}
        </div>
      </div>
    </Page>
  );
}
