// `/runs` (C9, docs/ui-plan.md): every time an agent worked for the client, newest first
// (ARCHITECTURE §10.6, §10.10, §15). Live runs only, never cost. A segmented status filter, the
// agent and how a run started, and a question in plain words (`/api/runs/ask`) that answers as the
// list's own filter, shown back as chips. Runs per day draw from the same filter. Polls while a
// run on the list is still going. Its columns sort, and a whole row opens its run.
import { type AskChip, RUN_STARTED_BY, type RunStartedBy, shortRunId } from "@countersign/core";
import { type FormEvent, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import type { PlainKey, Translate } from "../../i18n/catalog";
import { useI18n } from "../../i18n/i18n";
import { StatusFilter } from "../../inbox/StatusFilter";
import { shortTime } from "../../runs/format";
import { subjectTitle } from "../../runs/subject";
import { usePoll } from "../../runs/usePoll";
import { AgentBadge } from "../../ui/badges";
import { Select } from "../../ui/forms";
import { Icon } from "../../ui/icons";
import { Loaded, Page } from "../../ui/page";
import { Button, Card, cx, EmptyState, ErrorNotice, PageHeader } from "../../ui/primitives";
import { useRowLink } from "../../ui/rows";
import { SkeletonBlock, SkeletonRows } from "../../ui/skeleton";
import { StatusChip } from "../../ui/status";
import { useRememberRuns } from "../known";
import { PORTAL_PATHS } from "../paths";
import { runChip, runOpen, runState, runStateWords, workedMs } from "../status";
import { RunsPerDayChart, TookCell } from "./runsParts";

/** The status tabs: each one a `statuses` filter on the list. */
const TABS = {
  all: null,
  going: "queued,running",
  waiting: "waiting",
  done: "succeeded",
  notFinished: "failed,cancelled",
} as const;
type Tab = keyof typeof TABS;

const TAB_WORDS: Record<Tab, PlainKey> = {
  all: "runsPage.tab.all",
  going: "runsPage.tab.going",
  waiting: "runsPage.tab.waiting",
  done: "runsPage.tab.done",
  notFinished: "runsPage.tab.notFinished",
};

export const STARTED_BY_WORDS: Record<RunStartedBy, PlainKey> = {
  schedule: "runsPage.startedBy.schedule",
  event: "runsPage.startedBy.event",
  webhook: "runsPage.startedBy.webhook",
  manual: "runsPage.startedBy.manual",
  message: "runsPage.startedBy.message",
  handoff: "runsPage.startedBy.handoff",
  person: "runsPage.startedBy.person",
};

const CHIP_WORDS: Record<string, PlainKey> = {
  agents: "runsPage.chip.agents",
  statuses: "runsPage.chip.statuses",
  startedBy: "runsPage.chip.startedBy",
  changedConnector: "runsPage.chip.changedConnector",
  since: "runsPage.chip.since",
  until: "runsPage.chip.until",
  attemptsOver: "runsPage.chip.attemptsOver",
  amount: "runsPage.chip.amount",
  text: "runsPage.chip.text",
};

/** A run status (a filter's, a chip's) in the client's words: "Waiting on you", "Stopped". */
export function runWords(status: string, t: Translate): string {
  const known = ["queued", "running", "waiting", "succeeded", "failed", "cancelled"];
  return known.includes(status) ? runStateWords(runState({ status }), t) : status;
}

interface Asked {
  question: string;
  chips: AskChip[];
  leftOut: string[];
  query: Record<string, string>;
}

export function PortalRunsScreen() {
  const i18n = useI18n();
  const { t } = i18n;
  const api = useApiClient();
  const [tab, setTab] = useState<Tab>("all");
  const [agent, setAgent] = useState("");
  const [startedBy, setStartedBy] = useState("");
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<unknown>(null);
  const [notUnderstood, setNotUnderstood] = useState(false);
  const [asked, setAsked] = useState<Asked | null>(null);
  const overview = useApi(apiRoutes.portalOverview);

  // An answered question is the list's filter; the tabs and pickers apply when there is none.
  const statuses = TABS[tab];
  const query = asked
    ? { ...asked.query, limit: 100, perDay: true }
    : {
        limit: 100,
        perDay: true,
        ...(statuses ? { statuses } : {}),
        ...(agent ? { agents: agent } : {}),
        ...(startedBy ? { startedBy } : {}),
      };
  // A filter of this one list keeps its last rows, dimmed, while the new ones load (1.8).
  // DECISION (review of #259): not when the agent changes: a query naming another agent shows
  // nothing of the last one (docs/plan.md §1.91, 5); a change of status or start keeps the rows.
  const agentsKey = JSON.stringify(query.agents ?? null);
  const answeredAgents = useRef(agentsKey);
  const runs = useApi(apiRoutes.portalRuns, { query, keep: answeredAgents.current === agentsKey });
  if (runs.data && !runs.refreshing) answeredAgents.current = agentsKey;
  usePoll(runs.reload, runs.data?.runs.some((r) => runOpen(r)) ?? false, 5_000, runs.loading);
  useRememberRuns(runs.data?.runs);
  const queryKey = JSON.stringify(query);
  const answered = useRef(queryKey);
  if (runs.data && !runs.refreshing) answered.current = queryKey;
  // Dimmed only while another filter's rows show, never for a refresh behind the same rows.
  const dimmed = runs.refreshing === true && answered.current !== queryKey;

  async function ask(e: FormEvent) {
    e.preventDefault();
    const text = question.trim();
    if (text.length < 3) return;
    setAsking(true);
    setAskError(null);
    setNotUnderstood(false);
    try {
      const answer = await api.call(apiRoutes.portalRunsAsk, { body: { text } });
      if (answer.understood) {
        setAsked({
          question: text,
          chips: answer.chips,
          leftOut: answer.leftOut,
          query: answer.query,
        });
      } else {
        setNotUnderstood(true);
      }
    } catch (err) {
      setAskError(err);
    } finally {
      setAsking(false);
    }
  }

  function clearAsk() {
    setAsked(null);
    setQuestion("");
    setNotUnderstood(false);
  }

  const chipValue = (c: AskChip) => {
    if ((c.key === "since" || c.key === "until") && !Number.isNaN(Date.parse(c.value))) {
      return i18n.fmt.date(c.value);
    }
    if (c.key === "statuses") {
      return c.value
        .split(", ")
        .map((s) => runWords(s, t))
        .join(", ");
    }
    if (c.key === "startedBy") {
      return c.value
        .split(", ")
        .map((s) =>
          Object.hasOwn(STARTED_BY_WORDS, s) ? t(STARTED_BY_WORDS[s as RunStartedBy]) : s,
        )
        .join(", ");
    }
    return c.value;
  };

  return (
    <Page testId="portal-runs-page">
      <PageHeader title={t("runs.title")} subtitle={t("runsPage.subtitle")} />

      <form onSubmit={(e) => void ask(e)} className="ds-card ui-ask" data-testid="portal-runs-ask">
        <Icon name="search" className="text-ink-muted" />
        {asked
          ? asked.chips.map((c) => (
              <span key={`${c.key}:${c.value}`} className="ds-tag" data-testid="portal-runs-chip">
                {Object.hasOwn(CHIP_WORDS, c.key) ? t(CHIP_WORDS[c.key] as PlainKey) : c.key}{" "}
                <span className="figures">{chipValue(c)}</span>
              </span>
            ))
          : null}
        <input
          aria-label={t("runsPage.ask.label")}
          data-testid="portal-runs-ask-input"
          value={question}
          maxLength={500}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder={t("runsPage.ask.placeholder")}
          className="ui-ask__input"
        />
        {asked ? (
          <Button size="sm" variant="ghost" onClick={clearAsk} data-testid="portal-runs-ask-clear">
            {t("runsPage.ask.clear")}
          </Button>
        ) : null}
        <Button
          size="sm"
          type="submit"
          disabled={asking || question.trim().length < 3}
          data-testid="portal-runs-ask-send"
        >
          {asking ? t("runsPage.ask.asking") : t("runsPage.ask.send")}
        </Button>
      </form>
      {askError ? <ErrorNotice error={askError} /> : null}
      {notUnderstood ? (
        <p className="text-sm text-ink-muted" role="status" data-testid="portal-runs-ask-unclear">
          {t("runsPage.ask.unclear")}
        </p>
      ) : null}
      {asked && asked.leftOut.length > 0 ? (
        <p className="text-sm text-ink-muted" data-testid="portal-runs-ask-leftout">
          {t("runsPage.ask.leftOut", { parts: asked.leftOut.join(", ") })}
        </p>
      ) : null}

      {asked ? null : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <StatusFilter
            value={tab}
            onChange={setTab}
            area="portal-runs"
            options={(Object.keys(TABS) as Tab[]).map((k) => [k, t(TAB_WORDS[k])])}
          />
          <div className="flex flex-wrap gap-2">
            <Select
              aria-label={t("runsPage.filter.agent")}
              data-testid="portal-runs-agent"
              className="w-auto"
              value={agent}
              onChange={(e) => setAgent(e.target.value)}
            >
              <option value="">{t("runsPage.filter.anyAgent")}</option>
              {(overview.data?.services ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
            <Select
              aria-label={t("runsPage.filter.startedBy")}
              data-testid="portal-runs-started-by"
              className="w-auto"
              value={startedBy}
              onChange={(e) => setStartedBy(e.target.value)}
            >
              <option value="">{t("runsPage.filter.anyStart")}</option>
              {RUN_STARTED_BY.map((s) => (
                <option key={s} value={s}>
                  {t(STARTED_BY_WORDS[s])}
                </option>
              ))}
            </Select>
          </div>
        </div>
      )}

      <Loaded
        state={runs}
        skeleton={
          <div className="flex flex-col gap-6">
            <SkeletonBlock height={160} />
            <SkeletonRows rows={8} columns={5} />
          </div>
        }
      >
        {(data) => (
          <div
            className={cx("flex flex-col gap-8 transition-opacity", dimmed && "opacity-60")}
            aria-busy={dimmed || undefined}
            data-testid="portal-runs-results"
          >
            {data.perDay && data.perDay.length > 0 ? (
              <RunsPerDayChart days={data.perDay} testId="portal-runs-per-day" />
            ) : null}
            {data.runs.length === 0 ? (
              <EmptyState>
                {asked || tab !== "all" || agent || startedBy
                  ? t("runsPage.noMatch")
                  : t("runs.empty")}
              </EmptyState>
            ) : (
              <Card>
                <RunsTable runs={data.runs} />
              </Card>
            )}
          </div>
        )}
      </Loaded>
    </Page>
  );
}

type Run = ResponseOf<typeof apiRoutes.portalRuns>["runs"][number];

/** The columns the runs list sorts by (in the browser, over the runs loaded). */
type SortKey = "run" | "agent" | "started" | "took" | "status";
/** Words sort A to Z first; times and durations largest first. */
const TEXT_KEYS = new Set<SortKey>(["run", "agent", "status"]);

/**
 * The runs, newest first until a column head is picked; a second pick turns the order round.
 * A whole row opens its run, as in the back office.
 */
function RunsTable({ runs }: { runs: Run[] }) {
  const i18n = useI18n();
  const { t } = i18n;
  const rowLink = useRowLink();
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "started",
    dir: "desc",
  });
  const sorted = useMemo(() => {
    const value = (r: Run): string | number => {
      switch (sort.key) {
        case "run":
          return subjectTitle(r.subject, i18n) ?? shortRunId(r.id);
        case "agent":
          return r.service.name;
        case "status":
          return runChip(r, i18n.t).label;
        case "started":
          return r.startedAt ? new Date(r.startedAt).getTime() : 0;
        case "took":
          return workedMs(r) ?? -1;
      }
    };
    const sign = sort.dir === "asc" ? 1 : -1;
    const words = new Intl.Collator(i18n.intl, { sensitivity: "base", numeric: true });
    return [...runs].sort((a, b) => {
      const x = value(a);
      const y = value(b);
      const c =
        typeof x === "string" && typeof y === "string"
          ? words.compare(x, y)
          : x < y
            ? -1
            : x > y
              ? 1
              : 0;
      return c * sign;
    });
  }, [runs, sort, i18n]);
  const head = (key: SortKey, label: string) => (
    <th aria-sort={sort.key === key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
      <button
        type="button"
        className="dt-sort"
        data-testid={`portal-runs-sort-${key}`}
        onClick={() =>
          setSort((old) =>
            old.key === key
              ? { key, dir: old.dir === "asc" ? "desc" : "asc" }
              : { key, dir: TEXT_KEYS.has(key) ? "asc" : "desc" },
          )
        }
      >
        {label}
      </button>
    </th>
  );
  return (
    <div className="dt dt-ana overflow-x-auto">
      <table data-testid="portal-runs">
        <thead>
          <tr className="dt-cols">
            {head("run", t("runsPage.col.run"))}
            {head("agent", t("runsPage.col.agent"))}
            {head("started", t("runs.col.started"))}
            {head("took", t("runs.col.took"))}
            {head("status", t("runs.col.status"))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const title = subjectTitle(r.subject, i18n);
            const chip = runChip(r, t);
            return (
              <tr
                key={r.id}
                data-testid={`portal-run-row-${r.id}`}
                // The whole row asks for its run on hover (1.6), as its link does.
                data-intent={`${PORTAL_PATHS.runs}/${r.id}`}
                {...rowLink(`${PORTAL_PATHS.runs}/${r.id}`)}
              >
                <td>
                  {/* Titled by what the run is about: its invoice or its change. */}
                  <Link
                    to={`${PORTAL_PATHS.runs}/${r.id}`}
                    data-testid={`portal-run-${r.id}-open`}
                    className={cx("text-link hover:underline", !title && "font-mono text-sm")}
                  >
                    {title ?? shortRunId(r.id)}
                  </Link>
                  {title ? (
                    <span className="block font-mono text-xs text-ink-muted">
                      {shortRunId(r.id)}
                    </span>
                  ) : null}
                </td>
                <td>
                  <span className="flex items-center gap-2.5 text-ink">
                    <AgentBadge name={r.service.name} seed={r.service.id} size="sm" />
                    {r.service.name}
                  </span>
                </td>
                <td className="text-ink figures">{shortTime(r.startedAt, undefined, i18n)}</td>
                <td className="text-ink figures" data-testid={`portal-run-took-${r.id}`}>
                  <TookCell run={r} />
                </td>
                <td>
                  <StatusChip state={chip.state} testId={`portal-run-state-${r.id}`}>
                    {chip.label}
                  </StatusChip>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
