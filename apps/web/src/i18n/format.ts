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
  /** "7:02" today, "Nov 3, 7:02" otherwise; in the viewer's time zone. */
  time(iso: string | null, now?: Date): string;
  /** "Nov 3, 2026". */
  date(iso: string): string;
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

export function createFormatters(intl: string): Formatters {
  const time = new Intl.DateTimeFormat(intl, { hour: "numeric", minute: "2-digit" });
  const day = new Intl.DateTimeFormat(intl, { month: "short", day: "numeric" });
  const date = new Intl.DateTimeFormat(intl, { month: "short", day: "numeric", year: "numeric" });
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
      const t = time.format(d);
      return d.toDateString() === now.toDateString() ? t : `${day.format(d)}, ${t}`;
    },
    date: (iso) => date.format(new Date(iso)),
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
