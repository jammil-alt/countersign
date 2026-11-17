// The client page's work (docs/plan.md §1.123.3; the prototype's `clientPage()`): its figures, its
// open Sales and Build work, its activity read across the tables that keep it (All activity,
// Messages, Questions, Runs, Decisions and changes), and the to-dos for the client (ours, Reggie's
// and the client's) with Add. On top of the Overview tab.
import {
  ACTIVITY_FILTER_LABELS,
  ACTIVITY_FILTERS,
  type ActivityFilter,
  type ActivityItem,
  type WorkCard,
} from "@countersign/core";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { cx } from "../../ui/cx";
import { ErrorNotice } from "../../ui/ErrorState";
import { TodoAdd, TodoRow, useTodoDone } from "../work/call/TodosPanel";
import { Kpis, StandingPill, todayIso, UrgencyPill } from "../work/parts";

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

function Bucket({ name, cards }: { name: string; cards: WorkCard[] }) {
  return (
    <div className="ds-card p-4" data-testid={`client-work-${name.toLowerCase()}`}>
      <div className="eyebrow mb-2 text-ink-muted">{name}</div>
      {cards.length ? (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {cards.map((c) => (
            <li key={c.id}>
              <Link
                to={c.href}
                className="flex flex-wrap items-center justify-between gap-2 text-sm text-ink"
              >
                <span className="inline-flex items-center gap-2">
                  <UrgencyPill urgency={c.urgency} />
                  {c.title}
                </span>
                <StandingPill standing={c.standing} line={c.statusText} />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 text-sm text-ink-muted">Nothing open.</p>
      )}
    </div>
  );
}

function ActivityLine({ item }: { item: ActivityItem }) {
  return (
    <li
      className={cx(
        "ds-card p-3",
        item.kind === "note" && "border-l-2 border-copper",
        item.kind === "sys" && "bg-surface-subtle",
      )}
      data-testid={`activity-${item.kind}`}
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {item.who ? (
          item.agent ? (
            <span className="mz-agentline">{item.who}</span>
          ) : (
            <b className="font-medium">{item.who}</b>
          )
        ) : null}
        {item.kind === "note" ? (
          <span className="ds-pill ds-pill--person ds-pill--sm">Internal note</span>
        ) : item.channel ? (
          <span className="text-ink-muted">{item.channel}</span>
        ) : null}
        <span className="text-ink-muted">{when(item.at)}</span>
        {item.link ? (
          <Link to={item.link.href} className="ml-auto text-xs">
            {item.link.label}
          </Link>
        ) : null}
      </div>
      <p className="m-0 mt-1 whitespace-pre-wrap text-sm">{item.text}</p>
      {item.answer ? <p className="m-0 mt-1 text-xs text-ink-muted">{item.answer}</p> : null}
    </li>
  );
}

function Activity({ clientId }: { clientId: string }) {
  const api = useApiClient();
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const first = useApi(apiRoutes.opsClientActivity, {
    params: { id: clientId },
    query: { filter },
  });
  const [more, setMore] = useState<ActivityItem[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    setMore([]);
    setNext(first.data?.next ?? null);
  }, [first.data]);
  const older = async () => {
    if (!next) return;
    try {
      const page = await api.call(apiRoutes.opsClientActivity, {
        params: { id: clientId },
        query: { filter, before: next },
      });
      setMore((m) => [...m, ...page.items]);
      setNext(page.next);
    } catch (e) {
      setError(e);
    }
  };
  const items = [...(first.data?.items ?? []), ...more];
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="client-activity">
      <div className="ds-filters">
        {ACTIVITY_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            className="ds-filter"
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
          >
            {ACTIVITY_FILTER_LABELS[f]}
          </button>
        ))}
      </div>
      {first.error ? <ErrorNotice error={first.error} onRetry={first.reload} /> : null}
      {error ? <ErrorNotice error={error} /> : null}
      {first.data && items.length === 0 ? (
        <p className="text-sm text-ink-muted">Nothing here yet.</p>
      ) : null}
      <ol className="m-0 flex list-none flex-col gap-2 p-0">
        {items.map((a) => (
          <ActivityLine key={a.id} item={a} />
        ))}
      </ol>
      {next ? (
        <button
          type="button"
          className="ds-btn ds-btn--secondary ds-btn--sm self-start"
          onClick={() => void older()}
        >
          Older
        </button>
      ) : null}
    </div>
  );
}

export function ClientWork({ clientId, clientName }: { clientId: string; clientName: string }) {
  const work = useApi(apiRoutes.opsClientWork, { params: { id: clientId } });
  const [adding, setAdding] = useState(false);
  const today = todayIso();
  const { done, busy, error } = useTodoDone(work.reload);
  const data = work.data;
  return (
    <div className="mb-6 flex flex-col gap-4" data-testid="client-work">
      {work.error ? <ErrorNotice error={work.error} onRetry={work.reload} /> : null}
      {data ? (
        <>
          <Kpis items={data.kpis} compact />
          <div className="grid gap-3 md:grid-cols-2">
            <Bucket name="Sales" cards={data.sales} />
            <Bucket name="Build" cards={data.build} />
          </div>
        </>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Activity clientId={clientId} />
        <aside>
          <section className="ds-card p-4" data-testid="client-todos">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="eyebrow text-ink-muted">To-dos for {clientName}</span>
              {!adding ? (
                <button
                  type="button"
                  className="ds-btn ds-btn--link text-sm"
                  onClick={() => setAdding(true)}
                >
                  Add
                </button>
              ) : null}
            </div>
            {error ? <ErrorNotice error={error} /> : null}
            {data?.todos.length ? (
              data.todos.map((t) => (
                <TodoRow
                  key={`${t.source}:${t.id}`}
                  item={t}
                  today={today}
                  busy={busy === t.id}
                  onDone={() => void done(t.id)}
                />
              ))
            ) : data ? (
              <p className="m-0 text-sm text-ink-muted">None open.</p>
            ) : null}
            {adding ? (
              <div className="mt-3">
                <TodoAdd
                  clientId={clientId}
                  about={{ kind: "client", id: clientId }}
                  onAdded={() => {
                    setAdding(false);
                    work.reload();
                  }}
                  onCancel={() => setAdding(false)}
                />
              </div>
            ) : null}
          </section>
        </aside>
      </div>
    </div>
  );
}
