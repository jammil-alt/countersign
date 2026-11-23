// Snoozed on Your call (S4.3, QA2 HM2): our to-dos put off with Later, soonest back first, each
// with when it comes back; "Bring back now" puts one on Yours at once.
import { YOUR_CALL_WORDS } from "@countersign/core";
import { useState } from "react";
import { Link } from "react-router-dom";
import { apiRoutes } from "../../../api/routes";
import { useApi, useApiClient } from "../../../api/useApi";
import { EN } from "../../../i18n/i18n";
import { ErrorNotice } from "../../../ui/ErrorState";
import { EmptyState, Loading } from "../../../ui/primitives";

const W = YOUR_CALL_WORDS;

export function SnoozedList({
  mine,
  onChanged,
  onToast,
}: {
  mine: boolean;
  /** A to-do came back: Yours and the header's count are asked again. */
  onChanged: () => void;
  onToast: (text: string) => void;
}) {
  const api = useApiClient();
  const list = useApi(apiRoutes.opsTodosSnoozed, { query: { mine: mine ? "true" : "false" } });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const wake = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      await api.call(apiRoutes.opsTodoWake, { params: { id } });
      list.reload();
      onChanged();
      onToast(W.woken);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  const items = list.data?.items ?? [];
  return (
    <div data-testid="call-snoozed">
      <p className="mt-0 text-sm text-ink-muted">{W.snoozedIntro}</p>
      {list.error ? <ErrorNotice error={list.error} onRetry={list.reload} /> : null}
      {error ? <ErrorNotice error={error} /> : null}
      {list.loading && !list.data ? <Loading /> : null}
      {list.data && items.length === 0 ? (
        <EmptyState tone="done" title={W.snoozedEmpty} testId="call-snoozed-empty" />
      ) : null}
      {items.length ? (
        <div className="ds-card">
          {items.map((t) => (
            <div
              key={t.id}
              className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 border-b border-line px-4 py-2 text-sm last:border-b-0"
              data-testid={`call-snoozed-${t.id}`}
            >
              <span className="min-w-0">
                <span className="font-medium text-ink">{t.title}</span>
                {t.client ? <span className="text-ink-muted"> · {t.client.name}</span> : null}
              </span>
              <span className="text-ink-muted tabular-nums">
                {t.snoozedUntil ? `${W.backAt} ${EN.fmt.dateTime(t.snoozedUntil)}` : null}
              </span>
              <span className="flex items-center gap-3">
                {t.about?.href ? <Link to={t.about.href}>Open</Link> : null}
                <button
                  type="button"
                  className="ds-btn ds-btn--link text-sm"
                  disabled={busy === t.id}
                  onClick={() => void wake(t.id)}
                  data-testid={`call-wake-${t.id}`}
                >
                  {W.wake}
                </button>
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
