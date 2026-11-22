// Your call at /ops/call (docs/plan.md §1.124.3; docs/cases-plan.md T1; the prototype's
// `yourCall()`): one list for everything in the back office that needs a person. Yours as compact
// cards that open a side sheet with Reggie's read, plan, why, draft, options and the decisions;
// Reggie's and the clients' as tables; and what Reggie did on its own today. KPIs over it, then a
// sticky bar with the lists, the kind chips and search. J and K move, S does it, E edits the draft,
// O (or Enter) opens the sheet.
import {
  CALL_KIND_LABELS,
  CALL_KINDS,
  CALL_UNDO_MS,
  type CallKind,
  type TodoView,
  type WorkKpi,
  YOUR_CALL_WORDS,
} from "@countersign/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiRoutes } from "../../../api/routes";
import { useApi, useApiClient } from "../../../api/useApi";
import { ErrorNotice } from "../../../ui/ErrorState";
import { Page } from "../../../ui/page";
import { cx, EmptyState, Loading, PageHeader } from "../../../ui/primitives";
import { FilterChips, HoldBanner, Kpis, todayIso } from "../parts";
import { CallCard, CallSheet } from "./CallCard";
import { DoneToday } from "./DoneToday";
import { TheirList } from "./TheirList";

const W = YOUR_CALL_WORDS;
type Tab = "you" | "reggie" | "client" | "done";

const matches = (t: TodoView, kind: CallKind, q: string) => {
  if (kind !== "all" && t.kind !== kind) return false;
  const needle = q.trim().toLowerCase();
  return (
    !needle ||
    [t.title, t.read ?? "", t.detail, t.client?.name ?? "", t.tag]
      .join(" ")
      .toLowerCase()
      .includes(needle)
  );
};

const typing = (el: EventTarget | null) =>
  el instanceof HTMLElement &&
  (el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT" ||
    el.isContentEditable);

/** A control that answers Enter itself (a link, a button): Enter there is not "open". */
const control = (el: EventTarget | null) =>
  el instanceof HTMLElement && el.closest("a, button, input, select, textarea, summary") !== null;

export function YourCallScreen() {
  const api = useApiClient();
  const navigate = useNavigate();
  const today = todayIso();
  const [tab, setTab] = useState<Tab>("you");
  const [kind, setKind] = useState<CallKind>("all");
  const [q, setQ] = useState("");
  const [mine, setMine] = useState(false);
  const owner = tab === "reggie" ? "reggie" : tab === "client" ? "client" : "operator";
  // Staging QA (2026-11-22): a change of list (Yours, Reggie's, the clients') or of "Only mine" is
  // a view of the one to-do list, so the page keeps what it shows (the counts, the rows, dimmed)
  // while the other view loads, instead of emptying to a spinner: counts read 0 and the page
  // jumped back to the top.
  const query = { owner, mine: mine ? "true" : "false" } as const;
  const list = useApi(apiRoutes.opsTodos, { query, keep: true });
  const queryKey = `${query.owner}:${query.mine}`;
  const answered = useRef(queryKey);
  if (list.data && !list.refreshing) answered.current = queryKey;
  // Dimmed only while another view's rows show, never for a refresh behind the same rows.
  const dimmed = list.refreshing === true && answered.current !== queryKey;
  const counts = list.data?.counts;
  const all = list.data?.items ?? [];
  const shown = useMemo(() => all.filter((t) => matches(t, kind, q)), [all, kind, q]);

  const [focus, setFocus] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [options, setOptions] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const draftOf = (t: TodoView) => drafts[t.id] ?? t.draft?.text ?? "";
  // The sheet shows the opened item while it is on the list; once it is done or snoozed and the
  // list reloads without it, the sheet closes by itself.
  const sheetItem = opened ? shown.find((t) => t.id === opened) : undefined;
  const openSheet = useCallback((t: TodoView, edit = false) => {
    setOpened(t.id);
    if (edit) setEditing(t.id);
  }, []);
  const closeSheet = useCallback(() => {
    setOpened(null);
    setEditing(null);
  }, []);
  const open = useCallback(
    (t: TodoView) => {
      if (t.about?.href) navigate(t.about.href);
    },
    [navigate],
  );

  const run = useCallback(
    async (id: string, work: () => Promise<{ done?: string; href?: string | null } | unknown>) => {
      setBusy(id);
      setError(null);
      try {
        const out = (await work()) as { done?: string } | undefined;
        if (out?.done) setToast(out.done);
        setEditing(null);
        // Done with it: its sheet closes (another item's sheet opened meanwhile stays).
        setOpened((o) => (o === id ? null : o));
        list.reload();
      } catch (e) {
        setError(e);
      } finally {
        setBusy(null);
      }
    },
    [list],
  );

  const act = useCallback(
    (t: TodoView) => {
      if (!t.editable || !t.primary || t.primary.kind === "open") return open(t);
      const draftText = t.draft ? (drafts[t.id] ?? t.draft.text) : undefined;
      const body = {
        ...(draftText && draftText !== t.draft?.text ? { draftText } : {}),
        ...(t.options?.length ? { option: options[t.id] ?? 0 } : {}),
      };
      const send = () =>
        run(t.id, () => api.call(apiRoutes.opsTodoAct, { params: { id: t.id }, body }));
      if (!t.draft) return void send();
      // DECISION: the 5-second undo before a draft goes is the page's: it waits before asking,
      // so nothing is sent or stored until the time is up (owner's design, "Undo").
      setPending(t.id);
      timer.current = setTimeout(() => {
        setPending(null);
        void send();
      }, CALL_UNDO_MS);
    },
    [api, open, options, run, drafts],
  );
  const undo = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setPending(null);
  };
  const later = (t: TodoView) =>
    run(t.id, async () => {
      await api.call(apiRoutes.opsTodoSnooze, { params: { id: t.id }, body: {} });
      return { done: W.snoozed };
    });
  const done = (t: TodoView) =>
    run(t.id, async () => {
      await api.call(apiRoutes.opsTodoDone, { params: { id: t.id } });
      return { done: "Done." };
    });

  // The keys: J and K move (the sheet follows when it is open), S does it, E edits (in the sheet),
  // O or Enter opens the sheet. With the sheet open they act on the item in it.
  useEffect(() => {
    if (tab !== "you") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      const at = sheetItem ? shown.indexOf(sheetItem) : focus;
      const t = shown[at];
      const move = (by: number) => {
        const next = Math.min(Math.max(at + by, 0), Math.max(shown.length - 1, 0));
        setFocus(next);
        const n = shown[next];
        if (!n) return;
        if (sheetItem) setOpened(n.id);
        // Focus follows the card, so Enter on it opens that one and Tab goes on from it.
        else
          listRef.current
            ?.querySelector<HTMLElement>(`[data-testid="call-${n.id}"] [data-testid="call-open"]`)
            ?.focus();
      };
      if (e.key === "j") move(1);
      else if (e.key === "k") move(-1);
      else if (e.key === "s" && t) act(t);
      else if (e.key === "e" && t?.draft && t.editable) openSheet(t, true);
      else if ((e.key === "o" || (e.key === "Enter" && !control(e.target))) && t && !sheetItem)
        openSheet(t);
      else return;
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [tab, shown, focus, act, openSheet, sheetItem]);

  const firstHold = list.data?.holds[0];
  const kpis: WorkKpi[] = counts
    ? [
        {
          label: W.kpi.needYou,
          value: String(counts.yours),
          note: `${counts.dueToday} due today`,
          tone: "signal",
          href: null,
        },
        {
          label: W.kpi.critical,
          value: String(counts.criticalHeld),
          note: firstHold ? `${firstHold.client.name}` : "None held",
          tone: counts.criticalHeld ? "risk" : null,
          href: firstHold ? `/ops/issues/${firstHold.issueId}` : null,
        },
        {
          label: W.kpi.reggie,
          value: String(counts.reggie),
          note: `${counts.doneToday} done today`,
          tone: null,
          href: null,
        },
        {
          label: W.kpi.clients,
          value: String(counts.client),
          note: `${counts.lateClient} overdue`,
          tone: null,
          href: null,
        },
        {
          label: W.kpi.questions,
          value: String(counts.questionsWeek),
          note:
            counts.medianAnswerMinutes == null
              ? "No answers to time yet"
              : `Median answer ${counts.medianAnswerMinutes} min`,
          tone: null,
          href: null,
        },
      ]
    : [];

  const segs: [Tab, string, number | undefined][] = [
    ["you", W.tabs.you, counts?.yours],
    ["reggie", W.tabs.reggie, counts?.reggie],
    ["client", W.tabs.client, counts?.client],
    ["done", W.tabs.done, counts?.doneToday],
  ];
  const clear = () => {
    setKind("all");
    setQ("");
  };
  const reggieCount = counts?.reggie ?? 0;

  return (
    <Page testId="ops-call">
      <HoldBanner holds={list.data?.holds ?? []} />
      <PageHeader
        title={W.title}
        subtitle={W.lede}
        actions={<span className="hidden text-xs text-ink-muted md:inline">{W.keys}</span>}
      />
      {list.error ? <ErrorNotice error={list.error} onRetry={list.reload} /> : null}
      {list.loading && !list.data ? <Loading /> : null}
      {counts ? <Kpis items={kpis} /> : null}
      <div
        className="sticky top-0 z-10 mt-4 flex flex-wrap items-center gap-3 border-b border-line bg-surface py-3"
        data-testid="call-bar"
      >
        <fieldset className="ds-seg" aria-label="Lists">
          {segs.map(([key, label, n]) => (
            <button
              key={key}
              type="button"
              aria-pressed={tab === key}
              onClick={() => {
                setTab(key);
                setFocus(0);
              }}
              data-testid={`call-tab-${key}`}
            >
              {label}
              {n !== undefined ? ` (${n})` : ""}
            </button>
          ))}
        </fieldset>
        {tab !== "done" ? (
          <>
            <FilterChips
              wrap
              chips={CALL_KINDS.map((k) => ({
                key: k,
                label: CALL_KIND_LABELS[k],
                count: all.filter((t) => matches(t, k, "")).length,
              }))}
              value={kind}
              onChange={setKind}
            />
            <input
              className="ds-input dt-search"
              placeholder="Search"
              aria-label="Search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            {tab === "you" ? (
              <label className="flex items-center gap-1.5 text-sm text-ink-muted">
                <input
                  type="checkbox"
                  checked={mine}
                  onChange={(e) => setMine(e.target.checked)}
                  data-testid="call-mine"
                />
                {W.mine}
              </label>
            ) : null}
          </>
        ) : null}
      </div>
      {error ? <ErrorNotice error={error} /> : null}
      <div
        className={cx("mt-4 transition-opacity", dimmed && "opacity-60")}
        aria-busy={dimmed || undefined}
        inert={dimmed || undefined}
        data-testid="call-results"
      >
        {tab === "done" ? (
          <DoneToday />
        ) : !list.data ? null : tab === "you" ? (
          all.length === 0 ? (
            <EmptyState
              tone="done"
              title={W.clear}
              line={W.emptyNote(reggieCount)}
              action={
                reggieCount
                  ? {
                      label: W.seeReggie(reggieCount),
                      onClick: () => setTab("reggie"),
                      testId: "call-see-reggie",
                    }
                  : undefined
              }
              testId="call-empty"
            />
          ) : shown.length === 0 ? (
            // DECISION (owner, 2026-11-20): an empty filter says what is empty and where the work
            // is (Reggie's and the clients' counts), and offers every one of yours back.
            <EmptyState
              icon={q.trim() ? "search" : "filter"}
              title={q.trim() ? W.noSearchMatch(q.trim()) : W.noneOfKind[kind]}
              line={W.elsewhere(reggieCount, counts?.client ?? 0)}
              action={{ label: W.showAll(all.length), onClick: clear, testId: "call-show-all" }}
              testId="call-nomatch"
            />
          ) : (
            <div className="flex flex-col gap-2" data-testid="call-list" ref={listRef}>
              {shown.map((t, i) => (
                <CallCard
                  key={`${t.source}:${t.id}`}
                  item={t}
                  focused={i === focus}
                  busy={busy === t.id}
                  pending={pending === t.id}
                  today={today}
                  onOpen={() => {
                    setFocus(i);
                    openSheet(t);
                  }}
                  onAct={() => act(t)}
                  onDone={() => void done(t)}
                  onUndo={undo}
                  onFocus={() => setFocus(i)}
                />
              ))}
            </div>
          )
        ) : (
          <TheirList
            who={tab}
            items={shown}
            today={today}
            onChanged={list.reload}
            onToast={setToast}
            onClear={clear}
          />
        )}
      </div>
      {tab === "you" && sheetItem ? (
        <CallSheet
          key={sheetItem.id}
          item={sheetItem}
          editing={editing === sheetItem.id}
          draft={draftOf(sheetItem)}
          option={options[sheetItem.id] ?? 0}
          busy={busy === sheetItem.id}
          pending={pending === sheetItem.id}
          today={today}
          onDraft={(text) => setDrafts((d) => ({ ...d, [sheetItem.id]: text }))}
          onOption={(n) => setOptions((o) => ({ ...o, [sheetItem.id]: n }))}
          onEdit={() => setEditing(editing === sheetItem.id ? null : sheetItem.id)}
          onAct={() => act(sheetItem)}
          onLater={() => void later(sheetItem)}
          onDone={() => void done(sheetItem)}
          onUndo={undo}
          onClose={closeSheet}
          notice={error ? <ErrorNotice error={error} /> : null}
        />
      ) : null}
      {toast ? (
        <div
          role="status"
          className="ds-card fixed right-4 bottom-4 z-20 px-4 py-3 text-sm"
          data-testid="call-toast"
        >
          {toast}
        </div>
      ) : null}
    </Page>
  );
}
