// Build (docs/plan.md §1.124.1; docs/design/pipelines.html `section('build')`): issues, agent
// builds and enhancements in one order. All work is the work order as a list, with the reason each
// item is where it is; each kind's tab opens on its board, stage by stage. KPIs over it scroll
// away; the filter chips, search and column heads stay.
import {
  type BuildTab,
  isLate,
  PIPELINES,
  passesFilter,
  STANDING_ORDER,
  WORK_FILTERS,
  WORK_SECTIONS,
  WORK_WORDS,
  type WorkFilterKey,
  type WorkItem,
} from "@countersign/core";
import { type DragEvent, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { apiRoutes } from "../../../api/routes";
import { useApi, useApiClient } from "../../../api/useApi";
import { ErrorNotice } from "../../../ui/ErrorState";
import { Page } from "../../../ui/page";
import { Loading, PageHeader } from "../../../ui/primitives";
import { OPS_PATHS } from "../../paths";
import {
  Due,
  FilterChips,
  HoldBanner,
  Kpis,
  PageTabs,
  StandingPill,
  todayIso,
  UrgencyPill,
} from "../parts";

const TAB_PIPE = { issues: "issues", builds: "builds", enh: "enh" } as const;
const KIND_PIPE = { issue: "issues", build: "builds", enhancement: "enh" } as const;
const URG_ORDER = { critical: 0, high: 1, normal: 2, low: 3 } as const;

export function hrefOf(item: Pick<WorkItem, "kind" | "id">): string {
  if (item.kind === "issue") return OPS_PATHS.issue(item.id);
  if (item.kind === "build") return OPS_PATHS.build(item.id);
  return OPS_PATHS.enhancement(item.id);
}

function isTab(v: string | undefined): v is BuildTab {
  return v === "all" || v === "issues" || v === "builds" || v === "enh";
}

type SortKey = "rank" | "what" | "client" | "kind" | "stage" | "status" | "urg" | "due";

export function BuildSection() {
  const { tab: raw } = useParams();
  const tab: BuildTab = isTab(raw) ? raw : "all";
  const list = useApi(apiRoutes.opsWork, { query: { tab } });
  const today = todayIso();
  const [filter, setFilter] = useState<WorkFilterKey>("open");
  const [q, setQ] = useState("");
  const [view, setView] = useState<"board" | "list">(tab === "all" ? "list" : "board");
  const [sort, setSort] = useState<{ col: SortKey; dir: 1 | -1 }>({ col: "rank", dir: 1 });
  const all = list.data?.items ?? [];
  const filters = WORK_FILTERS.filter((f) => !f.issuesOnly || tab === "all" || tab === "issues");
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all
      .filter((i) => passesFilter(filter, i, today))
      .filter(
        (i) =>
          !needle ||
          [i.title, i.description, i.client?.name ?? "", i.statusLine, i.stageName]
            .join(" ")
            .toLowerCase()
            .includes(needle),
      );
  }, [all, filter, q, today]);
  const board = tab !== "all" && view === "board";
  const counts = list.data?.counts;
  const sectionTabs = WORK_SECTIONS.build.tabs.map(([t, label]) => ({
    to: t === "all" ? OPS_PATHS.buildWork : OPS_PATHS.buildTab(t),
    label,
    count: counts?.[t as BuildTab],
    current: t === tab,
  }));
  return (
    <Page testId="ops-build">
      <HoldBanner holds={list.data?.holds ?? []} />
      <PageHeader
        title={WORK_WORDS.build.title}
        subtitle={WORK_WORDS.build.lede}
        actions={
          <>
            <Link className="ds-btn ds-btn--ghost ds-btn--sm" to={OPS_PATHS.builds}>
              {WORK_WORDS.build.builderBoard}
            </Link>
            <NewIssueLink />
          </>
        }
      />
      <PageTabs label="Build" tabs={sectionTabs} />
      {list.error ? <ErrorNotice error={list.error} onRetry={list.reload} /> : null}
      {list.loading && !list.data ? <Loading /> : null}
      {list.data ? (
        <>
          <Kpis items={list.data.kpis} />
          <div className="dt dt--page mt-4" data-testid="work-table">
            <div className="ds-datahead">
              <div className="dt-bar">
                <FilterChips
                  chips={filters.map((f) => ({
                    key: f.key,
                    label: f.label,
                    count: all.filter((i) => passesFilter(f.key, i, today)).length,
                  }))}
                  value={filter}
                  onChange={setFilter}
                />
                <input
                  className="ds-input dt-search"
                  placeholder={`Search ${tab === "all" ? "build" : PIPELINES[TAB_PIPE[tab]].name.toLowerCase()}`}
                  aria-label="Search"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                />
                {tab !== "all" ? (
                  <fieldset className="ds-seg" aria-label="View">
                    <button
                      type="button"
                      aria-pressed={view === "board"}
                      onClick={() => setView("board")}
                    >
                      Board
                    </button>
                    <button
                      type="button"
                      aria-pressed={view === "list"}
                      onClick={() => setView("list")}
                    >
                      List
                    </button>
                  </fieldset>
                ) : null}
              </div>
              {board ? (
                <BoardHeads tab={tab as Exclude<BuildTab, "all">} items={shown} today={today} />
              ) : null}
            </div>
            {board ? (
              <BoardBody
                tab={tab as Exclude<BuildTab, "all">}
                items={shown}
                today={today}
                onMoved={list.reload}
              />
            ) : (
              <WorkTable
                tab={tab}
                items={shown}
                today={today}
                sort={sort}
                onSort={(col) =>
                  setSort((s) => ({ col, dir: s.col === col ? (s.dir === 1 ? -1 : 1) : 1 }))
                }
                onClear={() => {
                  setFilter("open");
                  setQ("");
                }}
              />
            )}
            <div className="dt-status" data-testid="work-status">
              <span>
                <b>{shown.length}</b> shown
              </span>
              <span>
                <b>{shown.filter((i) => i.standing === "you").length}</b> need you
              </span>
              <span>
                <b>{shown.filter((i) => isLate(i.due, i.standing, today)).length}</b> late
              </span>
            </div>
          </div>
        </>
      ) : null}
    </Page>
  );
}

function NewIssueLink() {
  return (
    <Link className="ds-btn ds-btn--primary ds-btn--sm" to={OPS_PATHS.newIssue}>
      {WORK_WORDS.build.newItem}
    </Link>
  );
}

function sortValue(i: WorkItem, col: SortKey): string | number {
  switch (col) {
    case "rank":
      return i.rank ?? 10_000;
    case "what":
      return i.title;
    case "client":
      return i.client?.name ?? "";
    case "kind":
      return i.kind;
    case "stage":
      return PIPELINES[KIND_PIPE[i.kind]].stages.findIndex((s) => s.id === i.stage);
    case "status":
      return STANDING_ORDER[i.standing];
    case "urg":
      return i.urgency ? URG_ORDER[i.urgency] : 9;
    case "due":
      return i.standing === "done" ? "9999-z" : (i.due ?? "9999");
  }
}

function WorkTable({
  tab,
  items,
  today,
  sort,
  onSort,
  onClear,
}: {
  tab: BuildTab;
  items: WorkItem[];
  today: string;
  sort: { col: SortKey; dir: 1 | -1 };
  onSort: (col: SortKey) => void;
  onClear: () => void;
}) {
  const navigate = useNavigate();
  const rows = [...items].sort((a, b) => {
    const x = sortValue(a, sort.col);
    const y = sortValue(b, sort.col);
    return (
      (typeof x === "number" && typeof y === "number"
        ? x - y
        : String(x).localeCompare(String(y))) * sort.dir
    );
  });
  const th = (col: SortKey, label: string) => (
    <th aria-sort={sort.col === col ? (sort.dir === 1 ? "ascending" : "descending") : undefined}>
      <button type="button" className="dt-sort" onClick={() => onSort(col)}>
        {label}
      </button>
    </th>
  );
  const urgent = tab === "all" || tab === "issues";
  const due = tab === "all" ? "Due" : PIPELINES[TAB_PIPE[tab]].due;
  return (
    <div className="dt-wrap">
      <table>
        <thead>
          <tr>
            {th("rank", "#")}
            {th("what", tab === "all" ? "What" : PIPELINES[TAB_PIPE[tab]].short)}
            {th("client", "Client")}
            {tab === "all" ? th("kind", "Kind") : null}
            {th("stage", "Stage")}
            {th("status", "Where it stands")}
            {urgent ? th("urg", "Urgency") : null}
            {th("due", due)}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={8}>
                <div className="dt-empty">
                  {WORK_WORDS.empty}{" "}
                  <button type="button" className="ds-btn ds-btn--link small" onClick={onClear}>
                    {WORK_WORDS.clear}
                  </button>
                </div>
              </td>
            </tr>
          ) : (
            rows.map((i) => (
              <tr
                key={`${i.kind}:${i.id}`}
                className={[i.moved ? "is-moved" : "", i.standing === "done" ? "is-done" : ""].join(
                  " ",
                )}
                data-testid={`work-row-${i.id}`}
                onClick={() => navigate(hrefOf(i))}
              >
                <td>
                  <span className="rank">
                    {i.standing === "done" || i.rank === null ? "–" : i.rank}
                  </span>
                </td>
                <td>
                  <Link className="cell-title" to={hrefOf(i)} onClick={(e) => e.stopPropagation()}>
                    {i.number ? `#${i.number} ` : ""}
                    {i.title}
                  </Link>
                  {i.description ? <span className="cell-desc">{i.description}</span> : null}
                  {tab === "all" && i.why ? (
                    <span className="cell-why" data-testid="work-why">
                      {i.moved ? (
                        <span className="ds-ai">
                          <i />
                          {WORK_WORDS.movedByReggie}
                        </span>
                      ) : null}{" "}
                      {i.why}
                    </span>
                  ) : null}
                </td>
                <td>
                  {i.client ? (
                    <Link to={OPS_PATHS.client(i.client.id)} onClick={(e) => e.stopPropagation()}>
                      {i.client.name}
                    </Link>
                  ) : i.asks ? (
                    `${i.asks} client${i.asks === 1 ? "" : "s"}`
                  ) : (
                    ""
                  )}
                </td>
                {tab === "all" ? (
                  <td>
                    <span className="src-tag">{PIPELINES[KIND_PIPE[i.kind]].short}</span>
                  </td>
                ) : null}
                <td className="stage-mini">{i.stageName}</td>
                <td>
                  <StandingPill standing={i.standing} line={i.statusLine} />
                </td>
                {urgent ? (
                  <td>
                    <UrgencyPill urgency={i.urgency} />
                  </td>
                ) : null}
                <td>
                  <Due iso={i.due} done={i.standing === "done"} today={today} />
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function stagesOf(tab: Exclude<BuildTab, "all">) {
  return PIPELINES[TAB_PIPE[tab]].stages;
}

function BoardHeads({
  tab,
  items,
  today,
}: {
  tab: Exclude<BuildTab, "all">;
  items: WorkItem[];
  today: string;
}) {
  const stages = stagesOf(tab);
  return (
    <div className="mz-board__heads" style={{ ["--stages" as string]: stages.length }}>
      {stages.map((s) => {
        const here = items.filter((i) => i.stage === s.id);
        return (
          <div key={s.id} className="mz-stagehead" data-testid={`work-stage-${s.id}`}>
            <div className="mz-stagehead__name">
              <span>{s.name}</span>
              <span>{here.length}</span>
            </div>
            <div className="mz-stagehead__totals">
              <span>
                <b>{here.filter((i) => i.standing === "you").length}</b> need you
              </span>
              <span>
                <b>{here.filter((i) => isLate(i.due, i.standing, today)).length}</b> late
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function BoardBody({
  tab,
  items,
  today,
  onMoved,
}: {
  tab: Exclude<BuildTab, "all">;
  items: WorkItem[];
  today: string;
  onMoved: () => void;
}) {
  const api = useApiClient();
  const [drop, setDrop] = useState<string | null>(null);
  const stages = stagesOf(tab);
  // Dragging a card to another stage moves it there (issues and enhancements; a build's stage
  // follows its own work).
  const movable = tab === "issues" || tab === "enh";
  const onDrop = async (e: DragEvent, stage: string) => {
    e.preventDefault();
    setDrop(null);
    const id = e.dataTransfer.getData("text/plain");
    if (!id || !movable) return;
    if (tab === "issues" && stage !== "closed") {
      await api.call(apiRoutes.opsUpdateIssue, {
        params: { id },
        body: { stage: stage as "reported" },
      });
    } else if (tab === "enh" && stage !== "shipped") {
      await api.call(apiRoutes.opsUpdateEnhancement, {
        params: { id },
        body: { stage: stage as "captured" },
      });
    }
    onMoved();
  };
  return (
    <div
      className="mz-board__body"
      style={{ ["--stages" as string]: stages.length }}
      data-testid="work-board"
    >
      {stages.map((s) => (
        <section
          key={s.id}
          className={`mz-board__col${drop === s.id ? " is-drop" : ""}`}
          aria-label={s.name}
          onDragOver={(e) => {
            if (!movable) return;
            e.preventDefault();
            setDrop(s.id);
          }}
          onDragLeave={() => setDrop(null)}
          onDrop={(e) => void onDrop(e, s.id)}
        >
          <div className="mz-board__auto">{s.auto}</div>
          {items
            .filter((i) => i.stage === s.id)
            .sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"))
            .map((i) => (
              <Link
                key={i.id}
                to={hrefOf(i)}
                draggable={movable}
                onDragStart={(e) => e.dataTransfer.setData("text/plain", i.id)}
                className={`mz-kcard${i.standing === "you" ? " mz-kcard--you" : ""}${i.urgency === "critical" ? " mz-kcard--critical" : ""}`}
                data-testid={`work-card-${i.id}`}
              >
                <div className="mz-kcard__top">
                  <span className="mz-kcard__title">{i.title}</span>
                  <UrgencyPill urgency={i.urgency} />
                </div>
                <div className="mz-kcard__desc">
                  {i.client?.name ?? (i.asks ? `${i.asks} client${i.asks === 1 ? "" : "s"}` : "")}
                </div>
                <div className="mz-kcard__foot">
                  <StandingPill standing={i.standing} line={i.statusLine} />
                </div>
                <div className="mz-kcard__foot">
                  <Due iso={i.due} done={i.standing === "done"} today={today} />
                </div>
              </Link>
            ))}
        </section>
      ))}
    </div>
  );
}
