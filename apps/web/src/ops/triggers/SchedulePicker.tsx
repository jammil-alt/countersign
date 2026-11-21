// A schedule as a person says it (owner, 2026-11-21: "schedule times should use human readable
// time and days and should include things like the first Monday of the month, or every other
// Monday or the third Thursday"; docs/plan.md §1.177). How often, which days, what time and whose
// clock, each picked; the trigger still stores a cron (and `every` for every other week), written
// and read by core's `scheduleOfPlan` and `planOfSchedule`, so the scheduler runs what this says.
// A cron this can't show stays under Custom, as written.
import {
  type MonthWeek,
  planOfSchedule,
  SCHEDULE_HOUR_STEPS,
  type SchedulePlan,
  scheduleOfPlan,
  scheduleText,
  weekStart,
  zoneText,
} from "@countersign/core";
import { type ReactNode, useState } from "react";
import { cx } from "../../ui/primitives";
import { Select, TextInput } from "../agents/ui";

/** What the picker reads and writes: the schedule trigger's own fields. */
export interface ScheduleValue {
  cron: string;
  tz?: string | undefined;
  every?: { weeks: number; from: string } | undefined;
}

type Mode = "hours" | "day" | "weekday" | "week" | "month" | "custom";

const MODES: { mode: Mode; label: string }[] = [
  { mode: "day", label: "Every day" },
  { mode: "weekday", label: "Every weekday (Monday to Friday)" },
  { mode: "week", label: "On days of the week" },
  { mode: "month", label: "Every month" },
  { mode: "hours", label: "Every hour or few hours" },
  { mode: "custom", label: "Custom (cron)" },
];

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** Chips in the order a week is read here: Monday first. */
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const WEEKDAYS = [1, 2, 3, 4, 5];
const MONTH_WEEKS: { value: string; label: string }[] = [
  { value: "day", label: "A day of the month" },
  { value: "1", label: "The first" },
  { value: "2", label: "The second" },
  { value: "3", label: "The third" },
  { value: "4", label: "The fourth" },
  { value: "last", label: "The last" },
];

/** The zones offered by name; any other is typed. */
const ZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "UTC",
];
const OTHER_ZONE = "other";

function modeOf(plan: SchedulePlan): Mode {
  if (plan.kind === "custom") return "custom";
  if (plan.kind === "hours") return "hours";
  if (plan.kind === "month") return "month";
  const days = [...plan.days].sort((a, b) => a - b).join();
  if (plan.weeks <= 1 && plan.days.length === 7) return "day";
  if (plan.weeks <= 1 && days === WEEKDAYS.join()) return "weekday";
  return "week";
}

/** Whether a plan can be shown in a mode the person picked (a week shows any days). */
function fits(mode: Mode, plan: SchedulePlan): boolean {
  if (mode === "custom") return true;
  if (mode === "week") return plan.kind === "days";
  return modeOf(plan) === mode;
}

function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The plan's time of day, or 7:00 where it has none (every hour, a custom cron). */
function timeOf(plan: SchedulePlan): { hour: number; minute: number } {
  return plan.kind === "days" || plan.kind === "month"
    ? { hour: plan.hour, minute: plan.minute }
    : { hour: 7, minute: plan.kind === "hours" ? plan.minute : 0 };
}

/** A plan to start a mode from, keeping the time of day already chosen. */
function startOf(mode: Mode, from: SchedulePlan, cron: string): SchedulePlan {
  const at = timeOf(from);
  switch (mode) {
    case "hours":
      return { kind: "hours", every: 1, minute: 0 };
    case "day":
      return { kind: "days", days: [0, 1, 2, 3, 4, 5, 6], weeks: 1, ...at };
    case "weekday":
      return { kind: "days", days: WEEKDAYS, weeks: 1, ...at };
    case "week":
      return from.kind === "days" ? from : { kind: "days", days: [1], weeks: 1, ...at };
    case "month":
      return { kind: "month", on: { week: 1, weekday: 1 }, ...at };
    case "custom":
      return { kind: "custom", cron };
  }
}

function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is the child passed in.
    <label className="flex min-w-0 flex-col gap-1 text-sm font-medium text-ink">
      {label}
      {children}
    </label>
  );
}

export function SchedulePicker({
  value,
  onChange,
  testId,
  cronTestId,
  tzTestId,
  small = false,
  cronError,
}: {
  value: ScheduleValue;
  onChange(next: ScheduleValue): void;
  /** Prefix of the parts' test ids: `${testId}-repeats`, `-time`, `-day-1`, `-words`. */
  testId: string;
  /** The cron box under Custom, and the typed zone, keep the ids their screens had. */
  cronTestId?: string | undefined;
  tzTestId?: string | undefined;
  /** The builder's smaller fields. */
  small?: boolean | undefined;
  cronError?: ReactNode;
}) {
  const plan = planOfSchedule(value);
  // The mode picked stays while the schedule still fits it: Custom on a cron that reads as
  // "every day", or days of the week that happen to be Monday to Friday.
  const [picked, setPicked] = useState<Mode | null>(null);
  const mode = picked && fits(picked, plan) ? picked : modeOf(plan);
  const [typedZone, setTypedZone] = useState(!!value.tz && !ZONES.includes(value.tz));
  const size = small ? "h-9 text-sm" : undefined;
  const put = (next: SchedulePlan) => {
    const { cron, every } = scheduleOfPlan(next);
    onChange({ cron, ...(value.tz ? { tz: value.tz } : {}), ...(every ? { every } : {}) });
  };
  const setZone = (tz: string) => {
    const { tz: _tz, ...rest } = value;
    onChange(tz ? { ...rest, tz } : rest);
  };
  const at = timeOf(plan);
  const time = (
    <Labelled label="At">
      <TextInput
        type="time"
        className={size}
        data-testid={`${testId}-time`}
        value={`${String(at.hour).padStart(2, "0")}:${String(at.minute).padStart(2, "0")}`}
        onChange={(e) => {
          const m = /^(\d{2}):(\d{2})/.exec(e.target.value);
          if (!m || (plan.kind !== "days" && plan.kind !== "month")) return;
          put({ ...plan, hour: Number(m[1]), minute: Number(m[2]) });
        }}
      />
    </Labelled>
  );
  const zoneValue = typedZone ? OTHER_ZONE : (value.tz ?? "");
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid={testId} data-mode={mode}>
      <Labelled label="Repeats">
        <Select
          className={size}
          data-testid={`${testId}-repeats`}
          value={mode}
          onChange={(e) => {
            const next = e.target.value as Mode;
            setPicked(next);
            if (!fits(next, plan)) put(startOf(next, plan, value.cron));
          }}
        >
          {MODES.map((m) => (
            <option key={m.mode} value={m.mode}>
              {m.label}
            </option>
          ))}
        </Select>
      </Labelled>

      {mode === "hours" && plan.kind === "hours" ? (
        <div className="grid grid-cols-2 gap-3">
          <Labelled label="Every">
            <Select
              className={size}
              data-testid={`${testId}-hours`}
              value={String(plan.every)}
              onChange={(e) => put({ ...plan, every: Number(e.target.value) })}
            >
              {SCHEDULE_HOUR_STEPS.map((n) => (
                <option key={n} value={n}>
                  {n === 1 ? "Hour" : `${n} hours`}
                </option>
              ))}
            </Select>
          </Labelled>
          <Labelled label="Minutes past the hour">
            <Select
              className={size}
              data-testid={`${testId}-minute`}
              value={String(plan.minute)}
              onChange={(e) => put({ ...plan, minute: Number(e.target.value) })}
            >
              {[...new Set([0, 15, 30, 45, plan.minute])]
                .sort((a, b) => a - b)
                .map((n) => (
                  <option key={n} value={n}>
                    {n === 0 ? "On the hour" : `${n} minutes past`}
                  </option>
                ))}
            </Select>
          </Labelled>
        </div>
      ) : null}

      {mode === "week" && plan.kind === "days" ? (
        <>
          <fieldset className="flex min-w-0 flex-col gap-1">
            <legend className="mb-1 text-sm font-medium text-ink">On</legend>
            <div className="flex flex-wrap gap-1">
              {DAY_ORDER.map((d) => {
                const on = plan.days.includes(d);
                return (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={on}
                    title={DAY_NAMES[d]}
                    data-testid={`${testId}-day-${d}`}
                    className={cx(
                      "h-8 min-w-10 rounded-sm border px-2 text-sm",
                      on
                        ? "border-slate bg-slate text-on-slate"
                        : "border-line bg-surface text-ink hover:bg-surface-subtle",
                    )}
                    onClick={() => {
                      const days = on ? plan.days.filter((x) => x !== d) : [...plan.days, d];
                      // A week with no day would never run: the last one stays.
                      if (days.length > 0) put({ ...plan, days });
                    }}
                  >
                    {(DAY_NAMES[d] as string).slice(0, 3)}
                  </button>
                );
              })}
            </div>
          </fieldset>
          <div className="grid grid-cols-2 gap-3">
            <Labelled label="Every">
              <Select
                className={size}
                data-testid={`${testId}-weeks`}
                value={String(plan.weeks)}
                onChange={(e) => {
                  const weeks = Number(e.target.value);
                  const { from: _from, ...rest } = plan;
                  put(
                    weeks > 1
                      ? { ...rest, weeks, from: plan.from ?? weekStart(today()) }
                      : { ...rest, weeks },
                  );
                }}
              >
                {[...new Set([1, 2, 3, 4, plan.weeks])]
                  .sort((a, b) => a - b)
                  .map((n) => (
                    <option key={n} value={n}>
                      {n === 1 ? "Week" : n === 2 ? "Other week" : `${n} weeks`}
                    </option>
                  ))}
              </Select>
            </Labelled>
            {time}
          </div>
          {plan.weeks > 1 ? (
            <Labelled label="Starting the week of">
              <TextInput
                type="date"
                className={size}
                data-testid={`${testId}-from`}
                value={plan.from ?? ""}
                onChange={(e) => {
                  if (e.target.value) put({ ...plan, from: e.target.value });
                }}
              />
              <span className="text-xs font-normal text-ink-muted">
                Weeks are counted from that Sunday: it runs that week, then every{" "}
                {plan.weeks === 2 ? "second" : `${plan.weeks}th`} week.
              </span>
            </Labelled>
          ) : null}
        </>
      ) : null}

      {(mode === "day" || mode === "weekday") && plan.kind === "days" ? time : null}

      {mode === "month" && plan.kind === "month" ? (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Labelled label="On">
              <Select
                className={size}
                data-testid={`${testId}-month-week`}
                value={"day" in plan.on ? "day" : String(plan.on.week)}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "day") {
                    put({ ...plan, on: { day: 1 } });
                    return;
                  }
                  const week = (v === "last" ? "last" : Number(v)) as MonthWeek;
                  put({
                    ...plan,
                    on: { week, weekday: "weekday" in plan.on ? plan.on.weekday : 1 },
                  });
                }}
              >
                {MONTH_WEEKS.map((w) => (
                  <option key={w.value} value={w.value}>
                    {w.label}
                  </option>
                ))}
              </Select>
            </Labelled>
            {"day" in plan.on ? (
              <Labelled label="Day">
                <Select
                  className={size}
                  data-testid={`${testId}-month-day`}
                  value={String(plan.on.day)}
                  onChange={(e) =>
                    put({
                      ...plan,
                      on: { day: e.target.value === "last" ? "last" : Number(e.target.value) },
                    })
                  }
                >
                  {Array.from({ length: 31 }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                  <option value="last">The last day</option>
                </Select>
              </Labelled>
            ) : (
              <Labelled label="Day">
                <Select
                  className={size}
                  data-testid={`${testId}-month-weekday`}
                  value={String(plan.on.weekday)}
                  onChange={(e) => {
                    if ("weekday" in plan.on) {
                      put({ ...plan, on: { ...plan.on, weekday: Number(e.target.value) } });
                    }
                  }}
                >
                  {DAY_ORDER.map((d) => (
                    <option key={d} value={d}>
                      {DAY_NAMES[d]}
                    </option>
                  ))}
                </Select>
              </Labelled>
            )}
          </div>
          {time}
          {"day" in plan.on && typeof plan.on.day === "number" && plan.on.day > 28 ? (
            <p className="text-xs text-ink-muted" data-testid={`${testId}-short-month`}>
              A month with no {plan.on.day}th is skipped. Pick the last day to run every month.
            </p>
          ) : null}
        </>
      ) : null}

      {mode === "custom" ? (
        <Labelled label="Cron">
          <TextInput
            className={cx(size, "font-mono")}
            data-field="on.cron"
            data-testid={cronTestId ?? `${testId}-cron`}
            value={value.cron}
            onChange={(e) => onChange({ ...value, cron: e.target.value })}
          />
          <span className="text-xs font-normal text-ink-muted">
            {cronError ??
              "Five fields: minute, hour, day of the month, month, day of the week. 0 7 * * 1-5 is weekdays at 7:00 AM."}
          </span>
        </Labelled>
      ) : null}

      <Labelled label="Time zone">
        <Select
          className={size}
          data-testid={`${testId}-zone`}
          value={zoneValue}
          onChange={(e) => {
            const v = e.target.value;
            setTypedZone(v === OTHER_ZONE);
            if (v !== OTHER_ZONE) setZone(v);
          }}
        >
          <option value="">The client's time zone</option>
          {ZONES.map((z) => (
            <option key={z} value={z}>
              {zoneText(z)}
              {z === "America/Phoenix" ? " (Arizona)" : ""}
            </option>
          ))}
          <option value={OTHER_ZONE}>Another zone</option>
        </Select>
        {typedZone ? (
          <TextInput
            className={size}
            data-field="on.tz"
            data-testid={tzTestId ?? `${testId}-tz`}
            aria-label="Time zone, as its IANA name"
            placeholder="Europe/London"
            value={value.tz ?? ""}
            onChange={(e) => setZone(e.target.value)}
          />
        ) : null}
      </Labelled>

      <p className="text-sm text-ink-muted" data-testid={`${testId}-words`}>
        {mode === "custom" && plan.kind === "custom"
          ? "Runs on this cron line."
          : `Runs: ${scheduleText(value)}.`}
      </p>
    </div>
  );
}
