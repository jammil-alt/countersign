// Parts the runs list, a run's page and an agent's page share: runs per day as bars, from the
// list's own `perDay` answer (`GET /api/runs?perDay=1`), each run on the client's day it started
// and drawn in its state's colour (done, running, waiting on you, failed, stopped), each bar with
// its words; and a run's times (worked, and waited on you apart).
import type { RunsPerDay } from "@countersign/core";
import { useI18n } from "../../i18n/i18n";
import { duration, shortTime } from "../../runs/format";
import { Card } from "../../ui/primitives";
import { type RunState, runStateWords, workedMs } from "../status";

/** The most recent days drawn: about a month. */
const DAYS_SHOWN = 30;

/** Bottom to top: finished work at the base, what still needs someone on top. */
const STACK: RunState[] = ["done", "failed", "stopped", "running", "waiting"];

/** A day's runs by state. Older answers have only `runs` and `failed`: the rest counts as done. */
export function dayStates(d: RunsPerDay[number]): Record<RunState, number> {
  if (d.done === undefined) {
    return {
      done: Math.max(0, d.runs - d.failed),
      failed: d.failed,
      stopped: 0,
      running: 0,
      waiting: 0,
    };
  }
  return {
    done: d.done,
    failed: d.failed,
    stopped: d.stopped ?? 0,
    running: d.going ?? 0,
    waiting: d.waiting ?? 0,
  };
}

export function RunsPerDayChart({ days, testId }: { days: RunsPerDay; testId: string }) {
  const { t, fmt } = useI18n();
  const shown = days
    .slice(-DAYS_SHOWN)
    .map((d) => ({ day: d.day, runs: d.runs, by: dayStates(d) }));
  const top = Math.max(1, ...shown.map((d) => d.runs));
  const present = STACK.filter((s) => shown.some((d) => d.by[s] > 0));
  const first = shown[0];
  const last = shown[shown.length - 1];
  const dayText = (day: string) => fmt.date(`${day}T12:00:00Z`);
  return (
    <Card
      title={t("runsPage.perDay")}
      meta={
        <span className="flex flex-wrap items-center gap-4 text-sm">
          {present.map((s) => (
            <span key={s} className="flex items-center gap-1.5">
              <i aria-hidden className={`ui-legend ui-legend--${s}`} />
              {runStateWords(s, t)}
            </span>
          ))}
        </span>
      }
      testId={testId}
    >
      <div className="ui-card__body">
        <ol className="ui-daybars" aria-label={t("runsPage.perDay")}>
          {shown.map((d) => (
            <li
              key={d.day}
              className="ui-daybars__day"
              data-testid={`${testId}-${d.day}`}
              aria-label={t("runsPage.perDay.day", {
                day: dayText(d.day),
                parts: STACK.filter((s) => d.by[s] > 0)
                  .map((s) => `${runStateWords(s, t)}: ${fmt.number(d.by[s])}`)
                  .join(", "),
              })}
            >
              {[...STACK]
                .reverse()
                .filter((s) => d.by[s] > 0)
                .map((s) => (
                  <i
                    key={s}
                    data-state={s}
                    className={`ui-daybars__seg ui-daybars__seg--${s}`}
                    style={{ height: `${Math.round((d.by[s] / top) * 100)}%` }}
                  />
                ))}
            </li>
          ))}
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

/**
 * How long a run worked, without the time it waited on you, and that wait apart: "Took 1 h ·
 * Waited 21 h on you". While it hasn't finished: when it started, and the wait so far.
 */
export function RunTimes({
  run,
}: {
  run: { startedAt: string | null; finishedAt: string | null; waitedMs?: number | undefined };
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const worked = workedMs(run);
  const waited = run.waitedMs ?? 0;
  return (
    <>
      {worked !== null
        ? t("agent.took", { duration: msDuration(worked, i18n) })
        : t("table.started", { time: shortTime(run.startedAt, undefined, i18n) })}
      {waited >= 60_000 ? (
        <span className="text-ink-muted" data-testid="run-waited">
          {" · "}
          {t("runs.waitedOnYou", { duration: msDuration(waited, i18n) })}
        </span>
      ) : null}
    </>
  );
}

/** A length of time in words ("21 h"), from milliseconds. */
export function msDuration(ms: number, i18n: Parameters<typeof duration>[3]): string {
  return duration(new Date(0).toISOString(), new Date(ms).toISOString(), undefined, i18n);
}

/**
 * "Took": the time the run worked, without the time it waited on you, or "—" until it has
 * finished; the wait shows apart beneath ("Waited 21 h on you").
 */
export function TookCell({
  run,
}: {
  run: { startedAt: string | null; finishedAt: string | null; waitedMs?: number | undefined };
}) {
  const i18n = useI18n();
  const worked = workedMs(run);
  const waited = run.waitedMs ?? 0;
  return (
    <span className="flex flex-col">
      <span>{worked === null ? "—" : msDuration(worked, i18n)}</span>
      {waited >= 60_000 ? (
        <span className="text-sm text-ink-muted" data-testid="run-waited">
          {i18n.t("runs.waitedOnYou", { duration: msDuration(waited, i18n) })}
        </span>
      ) : null}
    </span>
  );
}
