// To-dos beside a record (docs/plan.md §1.123.3): the open to-dos about an issue, a deal, a build
// or an enhancement, or a client's, each with who has it and when it's due; tick one done; add
// one (yours, Reggie's or the client's). The design system's `mz-todo` rows.
import type { TodoAboutKind, TodoOwner, TodoView } from "@countersign/core";
import { type FormEvent, useState } from "react";
import { Link } from "react-router-dom";
import { apiRoutes } from "../../../api/routes";
import { useApi, useApiClient } from "../../../api/useApi";
import { ErrorNotice } from "../../../ui/ErrorState";
import { Due } from "../parts";

export function OwnerChip({ owner }: { owner: TodoOwner }) {
  if (owner === "operator") return <span className="ds-pill ds-pill--person ds-pill--sm">You</span>;
  if (owner === "client")
    return <span className="ds-pill ds-pill--neutral ds-pill--sm">Client</span>;
  return <span className="mz-agentline">Reggie</span>;
}

/** One to-do as a `mz-todo` row; ticking a to-do row marks it done. */
export function TodoRow({
  item,
  today,
  onDone,
  busy,
}: {
  item: TodoView;
  today?: string;
  onDone?: (() => void) | undefined;
  busy?: boolean;
}) {
  const href = item.about?.href ?? null;
  return (
    <div className="mz-todo" data-testid={`todo-${item.id}`}>
      <input
        type="checkbox"
        aria-label={`Done: ${item.title}`}
        disabled={!item.editable || !onDone || busy}
        checked={item.state === "done"}
        onChange={() => onDone?.()}
      />
      <div>
        {href ? (
          <Link to={href} className="text-ink">
            {item.title}
          </Link>
        ) : (
          item.title
        )}
        <small>
          {item.dueAt ? <Due iso={item.dueAt} {...(today ? { today } : {})} /> : "No date"}
        </small>
      </div>
      <OwnerChip owner={item.owner} />
    </div>
  );
}

/** Add a to-do: what, whose, by when. */
export function TodoAdd({
  about,
  clientId,
  onAdded,
  onCancel,
}: {
  about?: { kind: TodoAboutKind; id: string } | undefined;
  clientId?: string | null | undefined;
  onAdded(): void;
  onCancel?: () => void;
}) {
  const api = useApiClient();
  const [title, setTitle] = useState("");
  const [owner, setOwner] = useState<TodoOwner>("operator");
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.call(apiRoutes.opsCreateTodo, {
        body: {
          title: title.trim(),
          owner,
          ...(clientId ? { clientId } : {}),
          ...(about ? { about } : {}),
          // A date is due at the end of that day (UTC, as the lists read "today").
          ...(due ? { dueAt: `${due}T23:59:59.000Z` } : {}),
        },
      });
      setTitle("");
      setDue("");
      onAdded();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="flex flex-col gap-2" onSubmit={(e) => void submit(e)} data-testid="todo-add">
      <input
        className="ds-input"
        placeholder="What needs doing"
        aria-label="To-do"
        value={title}
        maxLength={300}
        onChange={(e) => setTitle(e.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        <select
          className="ds-select"
          aria-label="Whose"
          value={owner}
          onChange={(e) => setOwner(e.target.value as TodoOwner)}
        >
          <option value="operator">Yours</option>
          <option value="reggie">Reggie's</option>
          <option value="client">The client's</option>
        </select>
        <input
          className="ds-input"
          type="date"
          aria-label="Due"
          value={due}
          onChange={(e) => setDue(e.target.value)}
        />
      </div>
      {error ? <ErrorNotice error={error} /> : null}
      <div className="flex gap-2">
        <button
          type="submit"
          className="ds-btn ds-btn--primary ds-btn--sm"
          disabled={busy || !title.trim()}
        >
          Add
        </button>
        {onCancel ? (
          <button type="button" className="ds-btn ds-btn--ghost ds-btn--sm" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}

/** Mark a to-do done, then reload. */
export function useTodoDone(reload: () => void) {
  const api = useApiClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const done = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      await api.call(apiRoutes.opsTodoDone, { params: { id } });
      reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  return { done, busy, error };
}

/** The side panel of a record: its open to-dos, and Add. */
export function TodosPanel({
  about,
  clientId,
  title = "To-dos",
  onChanged,
}: {
  about: { kind: TodoAboutKind; id: string };
  clientId?: string | null | undefined;
  title?: string;
  onChanged?: () => void;
}) {
  const list = useApi(apiRoutes.opsTodos, { query: { about: `${about.kind}:${about.id}` } });
  const [adding, setAdding] = useState(false);
  const reload = () => {
    list.reload();
    onChanged?.();
  };
  const { done, busy, error } = useTodoDone(reload);
  const items = list.data?.items ?? [];
  return (
    <section className="ds-card p-4" data-testid="todos-panel">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="eyebrow text-ink-muted">{title}</span>
        {!adding ? (
          <button
            type="button"
            className="ds-btn ds-btn--link text-sm"
            onClick={() => setAdding(true)}
            data-testid="todos-panel-add"
          >
            Add
          </button>
        ) : null}
      </div>
      {list.error ? <ErrorNotice error={list.error} onRetry={list.reload} /> : null}
      {error ? <ErrorNotice error={error} /> : null}
      {items.length ? (
        items.map((t) => (
          <TodoRow key={t.id} item={t} busy={busy === t.id} onDone={() => void done(t.id)} />
        ))
      ) : list.data ? (
        <p className="m-0 text-sm text-ink-muted">None open.</p>
      ) : null}
      {adding ? (
        <div className="mt-3">
          <TodoAdd
            about={about}
            clientId={clientId}
            onAdded={() => {
              setAdding(false);
              reload();
            }}
            onCancel={() => setAdding(false)}
          />
        </div>
      ) : null}
    </section>
  );
}

/** "Add a to-do" that opens the form in place, for a record's own to-do panel. */
export function TodoAddToggle(props: {
  about: { kind: TodoAboutKind; id: string };
  clientId?: string | null | undefined;
  onAdded(): void;
}) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button
        type="button"
        className="ds-btn ds-btn--link mt-2 text-sm"
        onClick={() => setOpen(true)}
        data-testid="todo-add-open"
      >
        Add a to-do
      </button>
    );
  }
  return (
    <div className="mt-3">
      <TodoAdd
        {...props}
        onAdded={() => {
          setOpen(false);
          props.onAdded();
        }}
        onCancel={() => setOpen(false)}
      />
    </div>
  );
}
