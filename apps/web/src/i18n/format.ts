// Dates, numbers and money in the reader's locale (docs/plan.md §1.18), through Intl. Money stays a
// decimal string end to end (CLAUDE.md invariant 6): Intl.NumberFormat formats the string itself,
// exactly, so no JS float ever holds an amount.
import { DEFAULT_LOCALE, formatAmount, type Locale, matchLocale } from "@countersign/core";

/**
 * The Intl locale a reader's formats come from: their browser's own tag when it is the same
 * language as the one they read (`es-MX` for Spanish, `pt-PT` for Portuguese), else the language.
 */
export function intlLocaleFor(locale: Locale, browser: readonly string[] = []): string {
  for (const tag of browser) {
    if (matchLocale(tag) !== locale) continue;
    try {
      const [canonical] = Intl.getCanonicalLocales(tag);
      if (canonical) return canonical;
    } catch {
      // Not a valid tag: try the next one.
    }
  }
  // DECISION: English without a browser region formats as en-US, as the app did before languages.
  return locale === DEFAULT_LOCALE ? "en-US" : locale;
}

const DECIMAL = /^-?\d+(\.\d+)?$/;

/**
 * Intl.NumberFormat formats numeric strings as exact decimals (ECMA-402 NumberFormat v3): the
 * amount never becomes a float. The ES2022 lib types only allow numbers, hence the cast.
 */
function formatDecimal(nf: Intl.NumberFormat, value: string): string {
  return (nf.format as unknown as (v: string) => string)(value);
}

export interface Formatters {
  /** "07:02" today, "3 Nov, 07:02" otherwise ("3 Nov 2025, 07:02" in another year). */
  time(iso: string | null, now?: Date): string;
  /** "3 Nov, 07:02" always, today too ("3 Nov 2025, 07:02" in another year). */
  dateTime(iso: string | null, now?: Date): string;
  /** "3 Nov 2026". A calendar day ("2026-11-03") is that day wherever the viewer is. */
  date(iso: string): string;
  /** "3 Nov", with the year only when it isn't this year: "3 Nov 2025". */
  day(iso: string, now?: Date): string;
  /** "07:02". */
  clock(iso: string): string;
  /** "Nov 2026". */
  month(iso: string): string;
  /** "5 Nov 2026, 09:14:03": a record's exact time (an audit row), with the year and seconds. */
  stamp(iso: string): string;
  /** A whole number with the locale's grouping: "1,204", "1.204". */
  number(n: number): string;
  /** An amount from its decimal string: "$9,742.35", "9.742,35 $", never via a float. */
  money(amount: string | null | undefined, currency?: string): string;
  /** A unit price as printed, keeping up to 4 places: "$0.0425", "6,85 €". */
  unitPrice(amount: string, currency?: string): string;
  /** A quantity as printed: trailing zeros past 2 places trimmed, "2,000", "1.50". */
  figure(value: string): string;
  /** "12 KB", "1.5 MB". */
  bytes(n: number): string;
}

/** A zone Intl knows, else undefined (the viewer's own): a bad stored zone never breaks a screen. */
export function validZone(timeZone: string | null | undefined): string | undefined {
  if (!timeZone) return undefined;
  try {
    new Intl.DateTimeFormat("en", { timeZone });
    return timeZone;
  } catch {
    return undefined;
  }
}

/** A calendar day with no time ("2026-11-03"): read in UTC, so it is that day everywhere. */
const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The locale dates and times are written in: the house format for English, the reader's own for
 * the other languages.
 */
// DECISION (QA, runs and dates): one house format for dates in the back office and the portal:
// day then month, 24-hour clock ("21 Nov, 08:00", "21 Nov 2026"), in the viewer's time zone, as
// the escalations rows already were. English is written en-GB whatever the browser's region (the
// app showed "Nov 11, 4:40 PM", "21 Nov 08:00" and "11/5/2026" side by side); the other languages
// keep their own locale's order and clock. Numbers and money keep the reader's own locale.
export function dateLocaleFor(intl: string): string {
  return intl === "en" || intl.startsWith("en-") ? "en-GB" : intl;
}

/**
 * The formatters for `intl`. Dates and times are in the viewer's time zone, or in `timeZone` when
 * given (a client's zone, where the client's day is what counts: S5). A calendar day
 * ("2026-11-03") is that day in any zone.
 */
export function createFormatters(intl: string, timeZone?: string): Formatters {
  const dl = dateLocaleFor(intl);
  const zone = validZone(timeZone);
  const inZone = (o: Intl.DateTimeFormatOptions): Intl.DateTimeFormat =>
    new Intl.DateTimeFormat(dl, zone ? { ...o, timeZone: zone } : o);
  const clock = inZone({ hour: "2-digit", minute: "2-digit" });
  const dayMonth = inZone({ month: "short", day: "numeric" });
  const date = inZone({ month: "short", day: "numeric", year: "numeric" });
  const dateUtc = new Intl.DateTimeFormat(dl, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  const dayMonthUtc = new Intl.DateTimeFormat(dl, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  const month = inZone({ month: "short", year: "numeric" });
  const seconds = inZone({
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  // The calendar day an instant falls on, in the zone ("2026-11-03"): for "today" and the year.
  const dayKey = new Intl.DateTimeFormat("en-CA", zone ? { timeZone: zone } : {});
  const calendar = (iso: string) => CALENDAR_DAY.test(iso);
  const parse = (iso: string) => new Date(calendar(iso) ? `${iso}T00:00:00Z` : iso);
  const valid = (d: Date) => !Number.isNaN(d.getTime());
  const yearOf = (d: Date) => dayKey.format(d).slice(0, 4);
  /** "3 Nov", or "3 Nov 2025" when not in `now`'s year. */
  const dayOf = (iso: string, now: Date) => {
    const d = parse(iso);
    if (!valid(d)) return iso;
    const utc = calendar(iso);
    const year = utc ? String(d.getUTCFullYear()) : yearOf(d);
    if (year !== yearOf(now)) return (utc ? dateUtc : date).format(d);
    return (utc ? dayMonthUtc : dayMonth).format(d);
  };
  const dateTime = (d: Date, now: Date) => `${dayOf(d.toISOString(), now)}, ${clock.format(d)}`;
  const integer = new Intl.NumberFormat(intl);
  const oneDecimal = new Intl.NumberFormat(intl, { maximumFractionDigits: 1 });
  const currencies = new Map<string, Intl.NumberFormat>();
  const currency = (code: string, max: number) => {
    const key = `${code}:${max}`;
    let nf = currencies.get(key);
    if (!nf) {
      nf = new Intl.NumberFormat(intl, {
        style: "currency",
        currency: code,
        minimumFractionDigits: 2,
        maximumFractionDigits: max,
      });
      currencies.set(key, nf);
    }
    return nf;
  };

  return {
    time(iso, now = new Date()) {
      if (!iso) return "";
      const d = new Date(iso);
      if (!valid(d)) return iso;
      return dayKey.format(d) === dayKey.format(now) ? clock.format(d) : dateTime(d, now);
    },
    dateTime(iso, now = new Date()) {
      if (!iso) return "";
      const d = new Date(iso);
      return valid(d) ? dateTime(d, now) : iso;
    },
    date(iso) {
      const d = parse(iso);
      if (!valid(d)) return iso;
      return (calendar(iso) ? dateUtc : date).format(d);
    },
    day: (iso, now = new Date()) => dayOf(iso, now),
    clock(iso) {
      const d = new Date(iso);
      return valid(d) ? clock.format(d) : iso;
    },
    month(iso) {
      const d = parse(iso);
      return valid(d) ? month.format(d) : iso;
    },
    stamp(iso) {
      const d = new Date(iso);
      return valid(d) ? `${date.format(d)}, ${seconds.format(d)}` : iso;
    },
    number: (n) => integer.format(n),
    money(amount, code = "USD") {
      if (amount === null || amount === undefined || amount === "") return "–";
      if (!DECIMAL.test(amount)) return amount;
      try {
        return formatDecimal(currency(code, 2), amount);
      } catch {
        // An unknown currency code: the figure, then the code.
        return `${formatAmount(amount, 2)} ${code}`;
      }
    },
    unitPrice(amount, code = "USD") {
      if (!DECIMAL.test(amount)) return amount;
      try {
        return formatDecimal(currency(code, 4), amount);
      } catch {
        return `${amount} ${code}`;
      }
    },
    figure(value) {
      if (!DECIMAL.test(value)) return value;
      const fraction = (value.split(".")[1] ?? "").replace(/0+$/, "");
      const places = fraction.length === 0 ? 0 : Math.max(2, fraction.length);
      return formatDecimal(
        new Intl.NumberFormat(intl, {
          minimumFractionDigits: places,
          maximumFractionDigits: places,
        }),
        value,
      );
    },
    bytes(n) {
      if (n < 1024) return `${integer.format(n)} B`;
      if (n < 1024 * 1024) return `${integer.format(Math.round(n / 1024))} KB`;
      return `${oneDecimal.format(n / (1024 * 1024))} MB`;
    },
  };
}
