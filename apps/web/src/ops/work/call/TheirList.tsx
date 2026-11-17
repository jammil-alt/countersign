// Reggie's and the clients' lists on Your call (docs/plan.md §1.124.3; the prototype's
// `theirList()`): a table with the columns used everywhere else (What, Client, Kind, Due), sorted
// by due date; "Take it" moves one of Reggie's to you; "Remind" asks Reggie to chase the client
// (its route is Reggie's stream's, §1.124.4).
import { type RouteSpec, type TodoView, YOUR_CALL_WORDS } from "@countersign/core";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiRoutes } from "../../../api/routes";
import { useApiClient } from "../../../api/useApi";
import { ErrorNotice } from "../../../ui/ErrorState";
import { Due } from "../parts";

type Col = "what" | "client" | "kind" | "due";

/** Reggie's chase route (§1.124.4). */
export const remindRoute: RouteSpec | undefined = apiRoutes.opsTodoRemind;

export function TheirList({
  who,
  items,
  today,
  onChanged,
  onToast,
  onClear,
}: {
  who: "reggie" | "client";
  items: TodoView[];
  today: string;
  onChanged(): void;
  onToast(text: string): void;
  onClear(): void;
}) {
  const api = useApiClient();
  const navigate = useNavigate();
  const [sort, setSort] = useState<{ col: Col; dir: 1 | -1 }>({ col: "due", dir: 1 });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const value = (t: TodoView, col: Col) =>
    col === "due"
      ? (t.dueAt ?? "9999")
      : col === "what"
        ? t.title
        : col === "client"
          ? (t.client?.name ?? "")
          : t.tag;
  const rows = [...items].sort(
    (a, b) => value(a, sort.col).localeCompare(value(b, sort.col)) * sort.dir,
  );
  const th = (col: Col, label: string) => (
    <th aria-sort={sort.col === col ? (sort.dir === 1 ? "ascending" : "descending") : undefined}>
      <button
        type="button"
        className="dt-sort"
        onClick={() => setSort((s) => ({ col, dir: s.col === col ? (s.dir === 1 ? -1 : 1) : 1 }))}
      >
        {label}
      </button>
    </th>
  );
  const run = async (id: string, work: () => Promise<unknown>, toast: string) => {
    setBusy(id);
    setError(null);
    try {
      await work();
      onToast(toast);
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <p className="mt-0 text-sm text-ink-muted">
        {who === "reggie" ? YOUR_CALL_WORDS.reggieIntro : YOUR_CALL_WORDS.clientIntro}
      </p>
      {error ? <ErrorNotice error={error} /> : null}
      <div className="dt" data-testid={`call-${who}`}>
        <div className="dt-wrap">
          <table className="dt-ana">
            <thead>
              <tr>
                {th("what", "What")}
                {th("client", "Client")}
                {th("kind", "Kind")}
                {th("due", "Due")}
                <th>
                  <span className="sr-only">Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.length ? (
                rows.map((t) => {
                  const href = t.about?.href ?? null;
                  return (
                    <tr
                      key={`${t.source}:${t.id}`}
                      className={href ? "cursor-pointer" : undefined}
                      onClick={() => (href ? navigate(href) : undefined)}
                    >
                      <td>
                        <span className="dt-title">{t.title}</span>
                      </td>
                      <td>{t.client?.name ?? ""}</td>
                      <td>
                        <span className="ds-pill ds-pill--neutral ds-pill--sm">{t.tag}</span>
                      </td>
                      <td>
                        <Due iso={t.dueAt} today={today} />
                      </td>
                      <td className="text-right">
                        {who === "reggie" && t.editable ? (
                          <button
                            type="button"
                            className="ds-btn ds-btn--link text-sm"
                            disabled={busy === t.id}
                            onClick={(e) => {
                              e.stopPropagation();
                              void run(
                                t.id,
                                () => api.call(apiRoutes.opsTodoTake, { params: { id: t.id } }),
                                YOUR_CALL_WORDS.taken,
                              );
                            }}
                            data-testid={`call-take-${t.id}`}
                          >
                            {YOUR_CALL_WORDS.take}
                          </button>
                        ) : who === "client" && t.editable && remindRoute ? (
                          <button
                            type="button"
                            className="ds-btn ds-btn--link text-sm"
                            disabled={busy === t.id}
                            onClick={(e) => {
                              e.stopPropagation();
                              const spec = remindRoute;
                              void run(
                                t.id,
                                () => api.call(spec, { params: { id: t.id } } as never),
                                "Reggie sends a reminder now.",
                              );
                            }}
                          >
                            {YOUR_CALL_WORDS.remind}
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={5}>
                    <div className="dt-empty">
                      {YOUR_CALL_WORDS.noMatch}{" "}
                      <button
                        type="button"
                        className="ds-btn ds-btn--link text-sm"
                        onClick={onClear}
                      >
                        {YOUR_CALL_WORDS.clearFilters}
                      </button>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
