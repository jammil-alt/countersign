// Done today on Your call (docs/plan.md §1.124.3; the prototype's `handledList()`): everything
// Reggie did on its own today, by flow, each Sent (a client or a lead saw it) or Internal; Flag
// puts one on its play's record.
import { YOUR_CALL_WORDS } from "@countersign/core";
import { useState } from "react";
import { Link } from "react-router-dom";
import { apiRoutes } from "../../../api/routes";
import { useApi, useApiClient } from "../../../api/useApi";
import { EN } from "../../../i18n/i18n";
import { ErrorNotice } from "../../../ui/ErrorState";
import { Loading } from "../../../ui/primitives";

const time = (iso: string) => EN.fmt.clock(iso);

export function DoneToday() {
  const api = useApiClient();
  const list = useApi(apiRoutes.opsTodosDoneToday, {});
  const [error, setError] = useState<unknown>(null);
  const flag = async (id: string) => {
    setError(null);
    try {
      await api.call(apiRoutes.opsFlagPlay, { params: { id }, body: {} });
      list.reload();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <div data-testid="call-done-today">
      <p className="mt-0 text-sm text-ink-muted">{YOUR_CALL_WORDS.doneIntro}</p>
      {list.error ? <ErrorNotice error={list.error} onRetry={list.reload} /> : null}
      {error ? <ErrorNotice error={error} /> : null}
      {list.loading && !list.data ? <Loading /> : null}
      {list.data && list.data.groups.length === 0 ? (
        <p className="text-sm text-ink-muted">Nothing yet today.</p>
      ) : null}
      {list.data?.groups.map((g) => (
        <section key={g.flow} className="mb-4">
          <div className="eyebrow mb-1 text-ink-muted">{g.name}</div>
          <div className="ds-card">
            {g.rows.map((r) => (
              <div
                key={r.id}
                className="grid grid-cols-[4rem_minmax(0,1fr)_auto_auto] items-center gap-3 border-b border-line px-4 py-2 text-sm last:border-b-0"
              >
                <span className="text-ink-muted tabular-nums">{time(r.at)}</span>
                <span>
                  {r.summary}
                  {r.client ? <span className="text-ink-muted"> · {r.client.name}</span> : null}
                </span>
                <span>
                  {r.sent ? (
                    <span className="ds-pill ds-pill--neutral ds-pill--sm">
                      {YOUR_CALL_WORDS.sent}
                    </span>
                  ) : (
                    <span className="mz-agentline">{YOUR_CALL_WORDS.internal}</span>
                  )}
                </span>
                <span className="flex items-center gap-3">
                  {r.href ? <Link to={r.href}>Open</Link> : null}
                  {r.flagged ? (
                    <span className="ds-pill ds-pill--risk ds-pill--sm">
                      {YOUR_CALL_WORDS.flagged}
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="ds-btn ds-btn--link text-sm"
                      onClick={() => void flag(r.id)}
                      data-testid={`call-flag-${r.id}`}
                    >
                      {YOUR_CALL_WORDS.flag}
                    </button>
                  )}
                </span>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
