// Business hours and a person's hours (R8, docs/plan.md §1.86; ARCHITECTURE §10.14 "Business
// hours"): one week editor (several stretches a day, closed days), closed dates and away dates,
// and their read-only summaries. The portal's Business hours page, Team and Contacts, and the back
// office's client settings all use these; the words go through t() (English in the back office).
//
// The client's week, zone and closed dates are the client admin's (`PUT /api/settings/business-
// hours`); the zone is the client's own and is only shown here. A person's hours are their own week
// or the client's, plus away dates; who may change them is the route's (a person their own, the
// client admin anyone's).
import {
  type BusinessHoursBody,
  type ClientBusinessHours,
  type PersonHoursView,
  processes,
} from "@countersign/core";
import { type ReactNode, useId, useState } from "react";
import { useI18n } from "../i18n/i18n";
import { Field, TextInput } from "../ui/forms";
import { Badge, Button, Card, ErrorNotice } from "../ui/primitives";
import {
  type AwayRange,
  awayNow,
  awayText,
  cleanWeek,
  dateText,
  dayName,
  nextStretch,
  type Stretch,
  sameWeek,
  WEEKDAYS,
  type Week,
  type Weekday,
  weekLines,
  weekProblem,
} from "./format";

const MAX_STRETCHES = 4;
const MAX_CLOSED = 366;
const MAX_AWAY = 50;
const NINE_TO_SIX: Stretch = { from: "08:00", to: "18:00" };

// ── Read-only ────────────────────────────────────────────────────────────────────────────────────

/** A week as a few lines: "Mon to Fri · 8:00 AM to 6:00 PM", "Sat to Sun · Closed". */
export function WeekSummary({ week, testId }: { week: Week; testId?: string }) {
  const i18n = useI18n();
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm" data-testid={testId}>
      {weekLines(week, i18n).map((line) => (
        <div key={line.days} className="contents">
          <dt className="text-ink-muted">{line.days}</dt>
          <dd className={line.closed ? "text-ink-muted" : "text-ink"}>{line.hours}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The client's hours, read-only: the week, the zone, US holidays and closed dates. */
export function BusinessHoursSummary({
  data,
  testId = "business-hours-summary",
}: {
  data: ClientBusinessHours;
  testId?: string;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const { hours } = data;
  return (
    <div className="flex flex-col gap-4" data-testid={testId}>
      <WeekSummary week={hours.week} testId={`${testId}-week`} />
      <p className="text-sm text-ink-muted" data-testid={`${testId}-zone`}>
        {t("hours.zone", { zone: hours.tz })}
      </p>
      <p className="text-sm text-ink" data-testid={`${testId}-holidays`}>
        {hours.usHolidays ? t("hours.usHolidaysOn") : t("hours.usHolidaysOff")}
      </p>
      <div>
        <h4 className="eyebrow mb-1 text-ink-muted">{t("hours.closedDates")}</h4>
        {hours.closed.length === 0 ? (
          <p className="text-sm text-ink-muted">{t("hours.closedDatesNone")}</p>
        ) : (
          <p className="text-sm text-ink" data-testid={`${testId}-closed`}>
            {hours.closed.map((d) => dateText(d, i18n.intl)).join(", ")}
          </p>
        )}
      </div>
    </div>
  );
}

/** "Business hours" or "Own hours", and "Away until …" when the person is away today. */
export function PersonHoursLine({
  hours,
  testId,
}: {
  hours: processes.PersonHours | null;
  testId?: string;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const away = awayNow(hours?.away ?? []);
  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-sm" data-testid={testId}>
      <span className="text-ink-muted">
        {hours?.hours ? t("hours.person.ownShort") : t("hours.person.businessShort")}
      </span>
      {away ? (
        <Badge {...(testId ? { testId: `${testId}-away` } : {})}>
          {t("hours.awayUntil", { date: dateText(away.to, i18n.intl) })}
        </Badge>
      ) : null}
    </span>
  );
}

/** A person's hours and away dates, read-only. */
export function PersonHoursSummary({
  hours,
  testId,
}: {
  hours: processes.PersonHours | null;
  testId?: string;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const away = hours?.away ?? [];
  return (
    <div className="flex flex-col gap-3" data-testid={testId}>
      {hours?.hours ? (
        <div className="flex flex-col gap-1">
          <p className="text-sm text-ink">{t("hours.person.own")}</p>
          <WeekSummary week={hours.hours.week} />
        </div>
      ) : (
        <p className="text-sm text-ink">{t("hours.person.usesBusiness")}</p>
      )}
      <div>
        <h4 className="eyebrow mb-1 text-ink-muted">{t("hours.away")}</h4>
        {away.length === 0 ? (
          <p className="text-sm text-ink-muted">{t("hours.awayNone")}</p>
        ) : (
          <ul className="flex flex-col gap-0.5 text-sm text-ink">
            {away.map((r) => (
              <li key={`${r.from}:${r.to}`}>{awayText(r, i18n)}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ── Editors ──────────────────────────────────────────────────────────────────────────────────────

/** The week, a day a row: open or closed, and up to four stretches on an open day. */
export function WeekEditor({
  week,
  onChange,
  disabled,
  testId = "week",
}: {
  week: Week;
  onChange: (next: Week) => void;
  disabled?: boolean;
  testId?: string;
}) {
  const i18n = useI18n();
  const { t } = i18n;

  function setDay(day: Weekday, stretches: Stretch[]) {
    const next: Week = { ...week };
    if (stretches.length > 0) next[day] = stretches;
    else delete next[day];
    onChange(next);
  }

  /** A day opened: the hours of the nearest open day before it, else 8 to 6. */
  function opening(day: Weekday): Stretch[] {
    const index = WEEKDAYS.indexOf(day);
    for (let k = index - 1; k >= 0; k--) {
      const before = week[WEEKDAYS[k] as Weekday];
      if (before && before.length > 0) return before.map((s) => ({ ...s }));
    }
    return [{ ...NINE_TO_SIX }];
  }

  return (
    <ul className="flex flex-col" data-testid={testId}>
      {WEEKDAYS.map((day) => {
        const stretches = week[day] ?? [];
        const open = stretches.length > 0;
        const name = dayName(day, i18n.intl, "long");
        const next = nextStretch(stretches, NINE_TO_SIX);
        return (
          <li
            key={day}
            data-testid={`${testId}-${day}`}
            className="flex flex-wrap items-start gap-x-4 gap-y-2 border-b border-line py-3 last:border-b-0"
          >
            <label className="flex w-36 shrink-0 items-center gap-2 pt-2">
              <input
                type="checkbox"
                className="size-4 accent-slate"
                checked={open}
                disabled={disabled}
                onChange={(e) => setDay(day, e.target.checked ? opening(day) : [])}
                data-testid={`${testId}-${day}-open`}
              />
              <span className="font-medium text-ink">{name}</span>
            </label>
            {open ? (
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                {stretches.map((s, k) => (
                  <div
                    // biome-ignore lint/suspicious/noArrayIndexKey: stretches have no id; their place is who they are.
                    key={k}
                    className="flex flex-wrap items-center gap-2"
                    data-testid={`${testId}-${day}-${k}`}
                  >
                    <TextInput
                      type="time"
                      className="w-32"
                      value={s.from}
                      disabled={disabled}
                      aria-label={t("hours.opensOn", { day: name })}
                      onChange={(e) =>
                        setDay(
                          day,
                          stretches.map((x, i) => (i === k ? { ...x, from: e.target.value } : x)),
                        )
                      }
                      data-testid={`${testId}-${day}-${k}-from`}
                    />
                    <span className="text-sm text-ink-muted">{t("hours.to")}</span>
                    <TextInput
                      type="time"
                      className="w-32"
                      value={s.to}
                      disabled={disabled}
                      aria-label={t("hours.closesOn", { day: name })}
                      onChange={(e) =>
                        setDay(
                          day,
                          stretches.map((x, i) => (i === k ? { ...x, to: e.target.value } : x)),
                        )
                      }
                      data-testid={`${testId}-${day}-${k}-to`}
                    />
                    {stretches.length > 1 ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={disabled}
                        onClick={() =>
                          setDay(
                            day,
                            stretches.filter((_, i) => i !== k),
                          )
                        }
                        data-testid={`${testId}-${day}-${k}-remove`}
                      >
                        {t("hours.removeStretch")}
                      </Button>
                    ) : null}
                  </div>
                ))}
                {stretches.length < MAX_STRETCHES ? (
                  <div>
                    <Button
                      size="sm"
                      variant="ghost"
                      // DECISION: a new stretch starts an hour after the last one ends, so it
                      // never overlaps by default; late in the day see `nextStretch`.
                      disabled={disabled || next === null}
                      onClick={() => {
                        if (next) setDay(day, [...stretches, next]);
                      }}
                      data-testid={`${testId}-${day}-add`}
                    >
                      {t("hours.addStretch")}
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : (
              <span className="pt-2 text-sm text-ink-muted">{t("hours.closed")}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** A list of dates with an Add: the client's closed dates. */
export function DateListEditor({
  dates,
  onChange,
  disabled,
  testId = "closed-dates",
}: {
  dates: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  testId?: string;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const [draft, setDraft] = useState("");
  const full = dates.length >= MAX_CLOSED;
  return (
    <div className="flex flex-col gap-3" data-testid={testId}>
      {dates.length === 0 ? (
        <p className="text-sm text-ink-muted">{t("hours.closedDatesNone")}</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {dates.map((d) => (
            <li key={d} className="ds-tag flex items-center gap-1" data-testid={`${testId}-${d}`}>
              <span>{dateText(d, i18n.intl)}</span>
              <button
                type="button"
                className="text-ink-muted hover:text-ink"
                disabled={disabled}
                aria-label={t("hours.removeDate", { date: dateText(d, i18n.intl) })}
                onClick={() => onChange(dates.filter((x) => x !== d))}
                data-testid={`${testId}-${d}-remove`}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <TextInput
          type="date"
          className="w-44"
          value={draft}
          disabled={disabled || full}
          aria-label={t("hours.date")}
          onChange={(e) => setDraft(e.target.value)}
          data-testid={`${testId}-input`}
        />
        <Button
          size="sm"
          disabled={disabled || full || !processes.IsoDate.safeParse(draft).success}
          onClick={() => {
            if (!dates.includes(draft)) onChange([...dates, draft].sort());
            setDraft("");
          }}
          data-testid={`${testId}-add`}
        >
          {t("hours.addDate")}
        </Button>
      </div>
    </div>
  );
}

/** Away dates: ranges, each with Remove, and a From and To to add another. */
export function AwayEditor({
  away,
  onChange,
  disabled,
  testId = "away",
}: {
  away: AwayRange[];
  onChange: (next: AwayRange[]) => void;
  disabled?: boolean;
  testId?: string;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const valid =
    processes.IsoDate.safeParse(from).success &&
    (to === "" || processes.IsoDate.safeParse(to).success);
  const backwards = valid && to !== "" && to < from;
  return (
    <div className="flex flex-col gap-3" data-testid={testId}>
      {away.length === 0 ? (
        <p className="text-sm text-ink-muted">{t("hours.awayNone")}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {away.map((r) => (
            <li
              key={`${r.from}:${r.to}`}
              className="flex items-center justify-between gap-3 text-sm text-ink"
              data-testid={`${testId}-${r.from}`}
            >
              <span>{awayText(r, i18n)}</span>
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={() => onChange(away.filter((x) => x !== r))}
                data-testid={`${testId}-${r.from}-remove`}
              >
                {t("hours.removeStretch")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <Field label={t("hours.awayFrom")}>
          <TextInput
            type="date"
            className="w-44"
            value={from}
            disabled={disabled || away.length >= MAX_AWAY}
            onChange={(e) => setFrom(e.target.value)}
            data-testid={`${testId}-from`}
          />
        </Field>
        <Field label={t("hours.awayTo")}>
          <TextInput
            type="date"
            className="w-44"
            value={to}
            min={from || undefined}
            disabled={disabled || away.length >= MAX_AWAY}
            onChange={(e) => setTo(e.target.value)}
            data-testid={`${testId}-to`}
          />
        </Field>
        <Button
          size="sm"
          disabled={disabled || !valid || backwards || away.length >= MAX_AWAY}
          onClick={() => {
            const range = { from, to: to || from };
            if (!away.some((r) => r.from === range.from && r.to === range.to)) {
              onChange(
                [...away, range].sort(
                  (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
                ),
              );
            }
            setFrom("");
            setTo("");
          }}
          data-testid={`${testId}-add`}
        >
          {t("hours.awayAdd")}
        </Button>
      </div>
      {backwards ? (
        <p className="ds-error text-sm" role="alert">
          {t("hours.problem.away")}
        </p>
      ) : (
        <p className="text-sm text-ink-muted">{t("hours.awayHelp")}</p>
      )}
    </div>
  );
}

/** Save, "Saved." and the error, under an editor. */
function SaveRow({
  changed,
  busy,
  problem,
  saved,
  error,
  onSave,
  extra,
  testId,
}: {
  changed: boolean;
  busy: boolean;
  problem: string | null;
  saved: boolean;
  error: unknown;
  onSave: () => void;
  extra?: ReactNode;
  testId: string;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-2">
      {problem ? (
        <p className="ds-error text-sm" role="alert" data-testid={`${testId}-problem`}>
          {problem}
        </p>
      ) : null}
      {error ? <ErrorNotice error={error} /> : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          disabled={!changed || busy || problem !== null}
          onClick={onSave}
          data-testid={`${testId}-save`}
        >
          {busy ? t("hours.saving") : t("common.save")}
        </Button>
        {extra}
        {saved && !changed ? (
          <span role="status" className="text-sm text-ink-muted">
            {t("settings.saved")}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The client's business hours: an editor for the client admin, else the summary. The zone is
 * shown, never edited here (it is the client's, set with its details).
 */
export function BusinessHoursCard({
  data,
  onSave,
  zoneNote,
  title,
  testId = "business-hours",
}: {
  data: ClientBusinessHours;
  /** Absent: read-only. */
  onSave?: (body: BusinessHoursBody) => Promise<ClientBusinessHours>;
  /** The card's title; default "Your week". */
  title?: string;
  /** Under the zone: where it is changed. */
  zoneNote?: ReactNode;
  testId?: string;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const [saved, setSaved] = useState<ClientBusinessHours>(data);
  const [week, setWeek] = useState<Week>(data.hours.week);
  const [usHolidays, setUsHolidays] = useState(data.hours.usHolidays);
  const [closed, setClosed] = useState<string[]>(data.hours.closed);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const holidaysId = useId();

  const meta = saved.isDefault ? (
    <Badge testId={`${testId}-default`}>{t("hours.default")}</Badge>
  ) : null;

  if (!onSave) {
    return (
      <Card title={title ?? t("hours.week")} meta={meta} pad testId={testId}>
        <BusinessHoursSummary data={data} testId={`${testId}-summary`} />
        {zoneNote ? <div className="mt-2 text-sm text-ink-muted">{zoneNote}</div> : null}
      </Card>
    );
  }

  const changed =
    !sameWeek(week, saved.hours.week) ||
    usHolidays !== saved.hours.usHolidays ||
    closed.join(",") !== saved.hours.closed.join(",");
  const problem = weekProblem(week, i18n);
  const defaultWeek = processes.defaultBusinessHours(saved.hours.tz).week;

  async function save() {
    if (!onSave) return;
    setBusy(true);
    setError(null);
    try {
      const next = await onSave({ week: cleanWeek(week), usHolidays, closed });
      setSaved(next);
      setWeek(next.hours.week);
      setUsHolidays(next.hours.usHolidays);
      setClosed(next.hours.closed);
      setDone(true);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={title ?? t("hours.week")} meta={meta} testId={testId}>
      <div className="ui-card__body flex flex-col gap-5">
        <div>
          <p className="text-sm text-ink" data-testid={`${testId}-zone`}>
            {t("hours.zone", { zone: saved.hours.tz })}
          </p>
          {zoneNote ? <div className="text-sm text-ink-muted">{zoneNote}</div> : null}
        </div>
        <WeekEditor
          week={week}
          disabled={busy}
          onChange={(next) => {
            setDone(false);
            setWeek(next);
          }}
          testId={`${testId}-week`}
        />
        {!sameWeek(week, defaultWeek) ? (
          <div>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setDone(false);
                setWeek(defaultWeek);
              }}
              data-testid={`${testId}-use-default`}
            >
              {t("hours.useDefault")}
            </Button>
          </div>
        ) : null}
        <label htmlFor={holidaysId} className="flex items-start gap-3">
          <input
            id={holidaysId}
            type="checkbox"
            className="mt-1 size-4 accent-slate"
            checked={usHolidays}
            disabled={busy}
            onChange={(e) => {
              setDone(false);
              setUsHolidays(e.target.checked);
            }}
            data-testid={`${testId}-us-holidays`}
          />
          <span>
            <span className="block font-medium text-ink">{t("hours.usHolidays")}</span>
            <span className="block text-sm text-ink-muted">{t("hours.usHolidaysHelp")}</span>
          </span>
        </label>
        <div className="flex flex-col gap-2">
          <h4 className="eyebrow text-ink-muted">{t("hours.closedDates")}</h4>
          <p className="text-sm text-ink-muted">{t("hours.closedDatesHelp")}</p>
          <DateListEditor
            dates={closed}
            disabled={busy}
            onChange={(next) => {
              setDone(false);
              setClosed(next);
            }}
            testId={`${testId}-closed`}
          />
        </div>
        <SaveRow
          changed={changed}
          busy={busy}
          problem={problem}
          saved={done}
          error={error}
          onSave={() => void save()}
          testId={testId}
        />
      </div>
    </Card>
  );
}

/**
 * A person's hours: their own week or the business's, and away dates. Read-only without
 * `onSave`; with it, a Change button opens the editor. Saving the business's hours with no away
 * dates clears them (null), as the route asks.
 */
export function PersonHoursEditor({
  person,
  business,
  onSave,
  testId = "person-hours",
}: {
  person: Pick<PersonHoursView, "hours">;
  business: processes.BusinessHours;
  onSave?: (hours: processes.PersonHours | null) => Promise<void>;
  testId?: string;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const stored = person.hours;
  const [editing, setEditing] = useState(false);
  const [own, setOwn] = useState(stored?.hours !== undefined);
  const [week, setWeek] = useState<Week>(stored?.hours?.week ?? business.week);
  const [away, setAway] = useState<AwayRange[]>(stored?.away ?? []);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>(null);

  function reset() {
    setOwn(stored?.hours !== undefined);
    setWeek(stored?.hours?.week ?? business.week);
    setAway(stored?.away ?? []);
    setError(null);
  }

  const changed =
    own !== (stored?.hours !== undefined) ||
    (own && !sameWeek(week, stored?.hours?.week ?? {})) ||
    JSON.stringify(away) !== JSON.stringify(stored?.away ?? []);
  const problem = own ? weekProblem(week, i18n) : null;

  async function save() {
    if (!onSave) return;
    setBusy(true);
    setError(null);
    try {
      // DECISION: a person's own week keeps the zone and holidays they had, else the business's
      // (the route takes any zone; choosing a person's own zone is not on this screen yet).
      const base = stored?.hours ?? { ...business, closed: [] };
      const next: processes.PersonHours | null =
        !own && away.length === 0
          ? null
          : own
            ? { hours: { ...base, week: cleanWeek(week) }, away }
            : { away };
      await onSave(next);
      setDone(true);
      setEditing(false);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3" data-testid={testId}>
      {!editing ? (
        <>
          <PersonHoursSummary hours={stored} testId={`${testId}-summary`} />
          {onSave ? (
            <div className="flex items-center gap-3">
              <Button
                size="sm"
                onClick={() => {
                  reset();
                  setDone(false);
                  setEditing(true);
                }}
                data-testid={`${testId}-edit`}
              >
                {t("hours.change")}
              </Button>
              {done ? (
                <span role="status" className="text-sm text-ink-muted">
                  {t("settings.saved")}
                </span>
              ) : null}
            </div>
          ) : null}
        </>
      ) : (
        <div className="flex flex-col gap-4">
          <div role="radiogroup" aria-label={t("hours.title")} className="flex flex-col gap-2">
            {([false, true] as const).map((choice) => (
              // biome-ignore lint/a11y/useSemanticElements: the design system's Radio is a button with role=radio.
              <button
                key={String(choice)}
                type="button"
                role="radio"
                aria-checked={own === choice}
                disabled={busy}
                className="ds-choice items-start text-left"
                onClick={() => {
                  setOwn(choice);
                  if (choice && !stored?.hours) setWeek(business.week);
                }}
                data-testid={`${testId}-${choice ? "own" : "business"}`}
              >
                <span className="ds-radio mt-0.5" />
                <span>
                  <span className="block text-ink">
                    {choice ? t("hours.person.own") : t("hours.person.usesBusiness")}
                  </span>
                  <span className="block text-sm text-ink-muted">
                    {choice ? t("hours.person.ownHelp") : t("hours.person.businessHelp")}
                  </span>
                </span>
              </button>
            ))}
          </div>
          {own ? (
            <WeekEditor week={week} onChange={setWeek} disabled={busy} testId={`${testId}-week`} />
          ) : null}
          <div className="flex flex-col gap-2">
            <h4 className="eyebrow text-ink-muted">{t("hours.away")}</h4>
            <AwayEditor away={away} onChange={setAway} disabled={busy} testId={`${testId}-away`} />
          </div>
          <SaveRow
            changed={changed}
            busy={busy}
            problem={problem}
            saved={false}
            error={error}
            onSave={() => void save()}
            extra={
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  reset();
                  setEditing(false);
                }}
                data-testid={`${testId}-cancel`}
              >
                {t("common.cancel")}
              </Button>
            }
            testId={testId}
          />
        </div>
      )}
    </div>
  );
}
