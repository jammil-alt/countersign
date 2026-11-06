// Parts the runs list and a run's page share: runs per day as bars (done in slate, didn't finish in
// risk), from the list's own `perDay` answer (`GET /api/runs?perDay=1`), each bar with its words.
import type { RunsPerDay } from "@countersign/core";
import { useI18n } from "../../i18n/i18n";
import { Card } from "../../ui/primitives";

/** The most recent days drawn: about a month. */
const DAYS_SHOWN = 30;

export function RunsPerDayChart({ days, testId }: { days: RunsPerDay; testId: string }) {
  const { t, fmt } = useI18n();
  const shown = days.slice(-DAYS_SHOWN);
  const top = Math.max(1, ...shown.map((d) => d.runs));
  const first = shown[0];
  const last = shown[shown.length - 1];
  const dayText = (day: string) => fmt.date(`${day}T12:00:00Z`);
  return (
    <Card
      title={t("runsPage.perDay")}
      meta={
        <span className="flex items-center gap-4 text-sm">
          <span className="flex items-center gap-1.5">
            <i aria-hidden className="ui-legend ui-legend--done" />
            {t("runsPage.perDay.done")}
          </span>
          <span className="flex items-center gap-1.5">
            <i aria-hidden className="ui-legend ui-legend--failed" />
            {t("runsPage.perDay.failed")}
          </span>
        </span>
      }
      testId={testId}
    >
      <div className="ui-card__body">
        <ol className="ui-daybars" aria-label={t("runsPage.perDay")}>
          {shown.map((d) => {
            const done = Math.max(0, d.runs - d.failed);
            return (
              <li
                key={d.day}
                className="ui-daybars__day"
                aria-label={t("runsPage.perDay.bar", {
                  day: dayText(d.day),
                  runs: d.runs,
                  failed: d.failed,
                })}
              >
                <i
                  className="ui-daybars__failed"
                  style={{ height: `${Math.round((d.failed / top) * 100)}%` }}
                />
                <i
                  className="ui-daybars__done"
                  style={{ height: `${Math.round((done / top) * 100)}%` }}
                />
              </li>
            );
          })}
        </ol>
        {first && last ? (
          <div className="mt-2 flex justify-between font-mono text-xs text-ink-muted">
            <span>{dayText(first.day)}</span>
            {last !== first ? <span>{dayText(last.day)}</span> : null}
          </div>
        ) : null}
      </div>
    </Card>
  );
}
