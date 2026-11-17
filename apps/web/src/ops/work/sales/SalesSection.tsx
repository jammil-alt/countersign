// `/ops/sales` and `/ops/sales/:tab` (docs/plan.md §1.124.2; docs/design/pipelines.html
// `section('sales', …)`): New accounts and Expansion under one sidebar item. All deals is one
// sortable list; each pipeline opens on its board, with the stage heads' totals (deals, agents,
// value a month), and a list beside it. KPIs scroll away; the toolbar and the column heads stay.
import {
  DEAL_FILTER_WORDS,
  DEAL_FILTERS,
  type DealFilter,
  type DealStage,
  type DealSummary,
  dealKindOf,
  dealPasses,
  dealStageIndex,
  dec,
  SALES_PIPELINES,
  SALES_TAB_WORDS,
  SALES_TABS,
  SALES_WORDS,
  type SalesKpis,
  type SalesTab,
  wholeMoney,
} from "@countersign/core";
import { type CSSProperties, type DragEvent, useMemo, useState } from "react";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { apiRoutes } from "../../../api/routes";
import { useApi, useApiClient } from "../../../api/useApi";
import { ErrorNotice } from "../../../ui/ErrorState";
import { Icon } from "../../../ui/icons";
import { Page } from "../../../ui/page";
import { Button, buttonClass, Loading, PageHeader } from "../../../ui/primitives";
import { OPS_PATHS } from "../../paths";
import { SignUpNowSheet } from "../onboarding/SignUpNow";
import { StartsSheet } from "../onboarding/StartsSheet";
import { NewDeal } from "./NewDeal";
import {
  Due,
  FilterChips,
  Kpi,
  Kpis,
  monthValue,
  PageTabs,
  plural,
  type Sort,
  SortHead,
  Standing,
} from "./parts";

/** Autopilot's page (§1.124.4); its route comes with Reggie's stream. */
const AUTOPILOT = "/ops/autopilot";

type Col = "client" | "deal" | "pipe" | "stage" | "status" | "agents" | "mrr" | "due";
const STANDING_ORDER = { you: 0, stalled: 1, agent: 2, client: 3, done: 4 } as const;

const who = (d: DealSummary) => d.client?.name ?? d.company ?? "";

function sortKey(col: Col, d: DealSummary): string | number {
  switch (col) {
    case "client":
      return who(d);
    case "deal":
      return d.title;
    case "pipe":
      return d.kind;
    case "stage":
      return (d.kind === "expansion" ? 10 : 0) + dealStageIndex(d.kind, d.stage);
    case "status":
      return STANDING_ORDER[d.standing];
    case "agents":
      return d.agentCount;
    case "mrr":
      return 0;
    default:
      return d.standing === "done" ? "9999-z" : (d.nextDueOn ?? "9999");
  }
}

function sorted(deals: DealSummary[], sort: Sort<Col>): DealSummary[] {
  return [...deals].sort((a, b) => {
    // Money compares as decimals (invariant 6).
    if (sort.col === "mrr") return dec(a.mrr).comparedTo(b.mrr) * sort.dir;
    const x = sortKey(sort.col, a);
    const y = sortKey(sort.col, b);
    return (
      (typeof x === "number" && typeof y === "number"
        ? x - y
        : String(x).localeCompare(String(y))) * sort.dir
    );
  });
}

const sumMoney = (ds: DealSummary[], pick: (d: DealSummary) => string) =>
  wholeMoney(ds.reduce((n, d) => n.plus(pick(d)), dec("0")).toFixed(4));

function SalesKpiRow({ kpis }: { kpis: SalesKpis }) {
  return (
    <Kpis testId="sales-kpis">
      <Kpi
        label="Potential a month"
        value={wholeMoney(kpis.potential)}
        note={`${wholeMoney(kpis.weighted)} weighted by stage`}
      />
      <Kpi
        label="Open deals"
        value={kpis.open}
        note={`${kpis.openNew} new · ${kpis.openExpansion} expansion`}
      />
      <Kpi label="Agents in play" value={kpis.agentsInPlay} note="Sold or offered, not live" />
      <Kpi
        label="Need you"
        value={kpis.needYou}
        note="Prices, terms and first replies"
        tone="signal"
      />
      <Kpi
        label="Late or stuck"
        value={kpis.lateOrStuck}
        note="Quiet, held or past due"
        tone={kpis.late > 0 ? "risk" : undefined}
      />
      <Kpi
        label="Won this month"
        value={wholeMoney(kpis.wonThisMonth)}
        note={plural(kpis.wonCount, "deal")}
        tone="positive"
      />
    </Kpis>
  );
}

export function SalesScreen() {
  const { tab: raw } = useParams();
  const tab = (raw ?? "all") as SalesTab;
  if (!(SALES_TABS as readonly string[]).includes(tab))
    return <Navigate to={OPS_PATHS.sales} replace />;
  return <SalesSection key={tab} tab={tab} />;
}

function SalesSection({ tab }: { tab: SalesTab }) {
  const all = useApi(apiRoutes.opsDeals, { query: { tab: "all" } });
  const api = useApiClient();
  const [params] = useSearchParams();
  // An enhancement Build decided to sell arrives as `?from=enhancement:<id>` (§1.124.1).
  const from = params.get("from");
  const [starting, setStarting] = useState(from !== null);
  const [filter, setFilter] = useState<DealFilter>("open");
  const [q, setQ] = useState("");
  const [view, setView] = useState<"board" | "list">(tab === "all" ? "list" : "board");
  const [sort, setSort] = useState<Sort<Col>>({ col: "due", dir: 1 });
  const [moveError, setMoveError] = useState<unknown>(null);
  // §1.125: Sign up now and the saved starts open as side panels from the header.
  const [panel, setPanel] = useState<"signup" | "starts" | null>(null);

  const today = all.data?.today ?? new Date().toISOString().slice(0, 10);
  const everything = all.data?.deals ?? [];
  const inTab = useMemo(
    () => (tab === "all" ? everything : everything.filter((d) => d.kind === dealKindOf(tab))),
    [everything, tab],
  );
  const term = q.trim().toLowerCase();
  const shown = inTab
    .filter((d) => dealPasses(filter, d, today))
    .filter(
      (d) =>
        !term ||
        [d.title, d.description, who(d), d.statusText, d.stageName]
          .join(" ")
          .toLowerCase()
          .includes(term),
    );
  const openCount = (t: SalesTab) =>
    everything.filter((d) => (t === "all" || d.kind === dealKindOf(t)) && d.standing !== "done")
      .length;
  const canBoard = tab !== "all";
  const showing = canBoard ? view : "list";

  async function move(id: string, stage: DealStage) {
    setMoveError(null);
    try {
      await api.call(apiRoutes.opsUpdateDeal, { params: { id }, body: { stage } });
      all.reload();
    } catch (e) {
      setMoveError(e);
    }
  }

  return (
    <Page testId="sales">
      <PageHeader
        title={SALES_WORDS.title}
        subtitle={SALES_WORDS.subtitle}
        actions={
          <>
            <Link
              className={buttonClass("ghost", undefined, "sm")}
              to={`${AUTOPILOT}/${tab === "all" ? "new" : tab}`}
            >
              <Icon name="settings" />
              {SALES_WORDS.autopilot}
            </Link>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setPanel("starts")}
              data-testid="sales-starts"
            >
              Starts
            </Button>
            <Button size="sm" onClick={() => setPanel("signup")} data-testid="sales-signup">
              Sign up now
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => setStarting((s) => !s)}
              data-testid="sales-new"
            >
              <Icon name="add" />
              {SALES_WORDS.newDeal}
            </Button>
          </>
        }
      />
      <PageTabs
        label="Sales"
        tabs={SALES_TABS.map((t) => ({
          to: OPS_PATHS.salesTab(t),
          label: SALES_TAB_WORDS[t],
          count: openCount(t),
          current: t === tab,
        }))}
      />
      {panel === "signup" ? (
        <SignUpNowSheet onClose={() => setPanel(null)} onSent={() => all.reload()} />
      ) : null}
      {panel === "starts" ? <StartsSheet onClose={() => setPanel(null)} /> : null}
      {starting ? (
        <NewDeal
          kind={tab === "grow" || from?.startsWith("enhancement:") ? "expansion" : "new"}
          from={from}
          onCancel={() => setStarting(false)}
        />
      ) : null}
      {all.error ? <ErrorNotice error={all.error} onRetry={all.reload} /> : null}
      {moveError ? <ErrorNotice error={moveError} /> : null}
      {all.loading && !all.data ? <Loading /> : null}
      {all.data ? (
        <div className="flex flex-col gap-4">
          <SalesKpiRow kpis={all.data.kpis} />
          <div className="dt dt--page">
            <div className="ds-datahead">
              <div className="dt-bar">
                <FilterChips<DealFilter>
                  testId="sales-filters"
                  value={filter}
                  onChange={setFilter}
                  filters={DEAL_FILTERS.map((k) => ({
                    key: k,
                    label: DEAL_FILTER_WORDS[k],
                    count: inTab.filter((d) => dealPasses(k, d, today)).length,
                  }))}
                />
                <input
                  className="ds-input dt-search"
                  placeholder={`Search ${SALES_TAB_WORDS[tab].toLowerCase()}`}
                  aria-label="Search"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  data-testid="sales-search"
                />
                {canBoard ? (
                  <fieldset className="ds-seg" aria-label="View">
                    {(["board", "list"] as const).map((v) => (
                      <button
                        key={v}
                        type="button"
                        aria-pressed={showing === v}
                        onClick={() => setView(v)}
                        data-testid={`sales-view-${v}`}
                      >
                        {v === "board" ? "Board" : "List"}
                      </button>
                    ))}
                  </fieldset>
                ) : null}
              </div>
              {showing === "board" && canBoard ? (
                <BoardHeads pipe={tab as "new" | "grow"} deals={shown} />
              ) : null}
            </div>
            {showing === "board" && canBoard ? (
              <BoardBody
                pipe={tab as "new" | "grow"}
                deals={shown}
                today={today}
                onMove={(id, stage) => void move(id, stage)}
              />
            ) : (
              <SalesTable
                deals={sorted(shown, sort)}
                tab={tab}
                today={today}
                sort={sort}
                onSort={setSort}
                onClear={() => {
                  setFilter("open");
                  setQ("");
                }}
              />
            )}
            <StatusLine deals={shown} />
          </div>
          {everything.length === 0 ? (
            <p className="text-sm text-ink-muted">{SALES_WORDS.noDeals}</p>
          ) : null}
        </div>
      ) : null}
    </Page>
  );
}

function StatusLine({ deals }: { deals: DealSummary[] }) {
  const open = deals.filter((d) => d.standing !== "done");
  return (
    <div className="dt-status" data-testid="sales-status">
      <span>
        <b>{deals.length}</b> shown
      </span>
      <span>
        <b>{open.reduce((n, d) => n + d.agentCount, 0)}</b> agents
      </span>
      <span>
        <b>{sumMoney(open, (d) => d.mrr)}</b> a month open
      </span>
      <span>
        <b>{sumMoney(open, (d) => d.weighted)}</b> weighted
      </span>
    </div>
  );
}

function SalesTable({
  deals,
  tab,
  today,
  sort,
  onSort,
  onClear,
}: {
  deals: DealSummary[];
  tab: SalesTab;
  today: string;
  sort: Sort<Col>;
  onSort(s: Sort<Col>): void;
  onClear(): void;
}) {
  const navigate = useNavigate();
  const head = { sort, onSort };
  return (
    <div className="dt-ana overflow-x-auto">
      <table data-testid="sales-table">
        <thead>
          <tr>
            <SortHead col="client" label="Client" {...head} />
            <SortHead col="deal" label="Deal" {...head} />
            {tab === "all" ? <SortHead col="pipe" label="Kind" {...head} /> : null}
            <SortHead col="stage" label="Stage" {...head} />
            <SortHead col="status" label="Where it stands" {...head} />
            <SortHead col="agents" label="Agents" numeric {...head} />
            <SortHead col="mrr" label="A month" numeric {...head} />
            <SortHead col="due" label="Next step due" {...head} />
          </tr>
        </thead>
        <tbody>
          {deals.length > 0 ? (
            deals.map((d) => (
              <tr
                key={d.id}
                data-testid={`sales-row-${d.id}`}
                className={d.standing === "done" ? "text-ink-muted" : "cursor-pointer"}
                onClick={() => navigate(OPS_PATHS.deal(d.id))}
              >
                <td className="py-2.5">
                  <span className="flex flex-col gap-0.5">
                    {d.client ? (
                      <Link
                        to={OPS_PATHS.client(d.client.id)}
                        className="font-medium text-ink hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {d.client.name}
                      </Link>
                    ) : (
                      <span className="font-medium text-ink">{d.company}</span>
                    )}
                    <span className="text-xs text-ink-muted">{d.client ? "Client" : "Lead"}</span>
                  </span>
                </td>
                <td className="py-2.5">
                  <span className="flex flex-col gap-0.5">
                    <Link
                      to={OPS_PATHS.deal(d.id)}
                      className="text-ink hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {d.title}
                    </Link>
                    {d.description ? (
                      <span className="max-w-md text-xs text-ink-muted">{d.description}</span>
                    ) : null}
                  </span>
                </td>
                {tab === "all" ? (
                  <td>
                    <span className="ds-tag">{d.kind === "new" ? "New" : "Expansion"}</span>
                  </td>
                ) : null}
                <td>
                  <span className="flex flex-col gap-0.5">
                    {d.stageName}
                    <small className="text-xs text-ink-muted">
                      {Math.round(Number(d.likelihood) * 100)}% likely
                    </small>
                  </span>
                </td>
                <td>
                  <Standing standing={d.standing} text={d.statusText} />
                </td>
                <td className="n">{d.agentCount || "–"}</td>
                <td className="n">{monthValue(d)}</td>
                <td>
                  <Due on={d.nextDueOn} today={today} done={d.standing === "done"} />
                </td>
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={8}>
                <div className="dt-empty" data-testid="sales-empty">
                  {SALES_WORDS.empty}{" "}
                  <button type="button" className="ds-btn ds-btn--link" onClick={onClear}>
                    {SALES_WORDS.clear}
                  </button>
                </div>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function BoardHeads({ pipe, deals }: { pipe: "new" | "grow"; deals: DealSummary[] }) {
  const stages = SALES_PIPELINES[pipe].stages;
  return (
    <div
      className="mz-board__heads"
      style={{ "--stages": stages.length } as CSSProperties}
      data-testid="sales-board-heads"
    >
      {stages.map((s) => {
        const here = deals.filter((d) => d.stage === s.id);
        const agents = here.reduce((n, d) => n + d.agentCount, 0);
        return (
          <div className="mz-stagehead" key={s.id} data-testid={`sales-head-${s.id}`}>
            <div className="mz-stagehead__name">
              <span>{s.name}</span>
              <span>{here.length}</span>
            </div>
            <div className="mz-stagehead__totals">
              <span>
                <b>{here.length}</b> deal{here.length === 1 ? "" : "s"}
              </span>
              <span>
                <b>{agents}</b> agent{agents === 1 ? "" : "s"}
              </span>
              <span>
                <b>{sumMoney(here, (d) => d.mrr)}</b>/mo
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function BoardBody({
  pipe,
  deals,
  today,
  onMove,
}: {
  pipe: "new" | "grow";
  deals: DealSummary[];
  today: string;
  onMove(id: string, stage: DealStage): void;
}) {
  const stages = SALES_PIPELINES[pipe].stages;
  const [over, setOver] = useState<string | null>(null);
  const drop = (stage: DealStage) => (e: DragEvent) => {
    e.preventDefault();
    setOver(null);
    const id = e.dataTransfer.getData("text/plain");
    const d = deals.find((x) => x.id === id);
    if (d && d.stage !== stage && d.standing !== "done") onMove(id, stage);
  };
  return (
    <div
      className="mz-board__body"
      style={{ "--stages": stages.length } as CSSProperties}
      data-testid="sales-board"
    >
      {stages.map((s) => (
        <section
          key={s.id}
          className={over === s.id ? "mz-board__col is-drop" : "mz-board__col"}
          aria-label={s.name}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(s.id);
          }}
          onDragLeave={() => setOver((o) => (o === s.id ? null : o))}
          onDrop={drop(s.id)}
        >
          <div className="mz-board__auto">{s.auto}</div>
          {deals
            .filter((d) => d.stage === s.id)
            .sort((a, b) => (a.nextDueOn ?? "9999").localeCompare(b.nextDueOn ?? "9999"))
            .map((d) => (
              <KCard key={d.id} deal={d} today={today} />
            ))}
        </section>
      ))}
    </div>
  );
}

function KCard({ deal: d, today }: { deal: DealSummary; today: string }) {
  return (
    <Link
      to={OPS_PATHS.deal(d.id)}
      className={d.standing === "you" ? "mz-kcard mz-kcard--you" : "mz-kcard"}
      draggable={d.standing !== "done"}
      onDragStart={(e) => e.dataTransfer.setData("text/plain", d.id)}
      data-testid={`sales-card-${d.id}`}
    >
      <div className="mz-kcard__top">
        <span className="mz-kcard__title">{who(d)}</span>
      </div>
      <div className="mz-kcard__desc">{d.title}</div>
      <div className="mz-kcard__foot">
        <Standing standing={d.standing} text={d.statusText} />
      </div>
      <div className="mz-kcard__foot">
        <Due on={d.nextDueOn} today={today} done={d.standing === "done"} />
        <span className="mz-kcard__fig">
          {d.agentCount ? `${plural(d.agentCount, "agent")} · ` : ""}
          {monthValue(d)}/mo
        </span>
      </div>
    </Link>
  );
}
