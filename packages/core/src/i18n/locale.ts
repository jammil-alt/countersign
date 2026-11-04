// Languages (docs/plan.md §1.18): the portal and agents' client-facing text in English (the source),
// Spanish, French, Portuguese (Brazil), Italian and German. Translations are shared per language;
// regional formats (es-MX, fr-CA, pt-PT…) come from Intl with the reader's own region. The back
// office stays in English. Right-to-left languages are out.
import { z } from "zod";

export const LOCALES = ["en", "es", "fr", "pt-BR", "it", "de"] as const;
export const Locale = z.enum(LOCALES);
export type Locale = z.infer<typeof Locale>;

/** The source language: every other language falls back to it. */
export const DEFAULT_LOCALE: Locale = "en";

/** Each language's name in itself, for the language picker. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  es: "Español",
  fr: "Français",
  "pt-BR": "Português (Brasil)",
  it: "Italiano",
  de: "Deutsch",
};

/** Each language's name in English, for the agent's instructions (operator-written, trusted). */
export const LOCALE_ENGLISH_NAMES: Record<Locale, string> = {
  en: "English",
  es: "Spanish",
  fr: "French",
  "pt-BR": "Brazilian Portuguese",
  it: "Italian",
  de: "German",
};

/**
 * The language a BCP 47 tag reads in, or null when we don't have it: `es-MX` → `es`, `pt-PT` →
 * `pt-BR`, `de-CH` → `de`. Case and `_` separators are tolerated.
 */
// DECISION: every Portuguese tag (pt, pt-PT, pt-AO…) reads the pt-BR translation: translations are
// shared per language (plan §1.18), and Intl still formats with the reader's own region.
export function matchLocale(tag: string | null | undefined): Locale | null {
  if (!tag) return null;
  const base = tag.trim().replace(/_/g, "-").split("-")[0]?.toLowerCase();
  if (!base) return null;
  if (base === "pt") return "pt-BR";
  return (LOCALES as readonly string[]).includes(base) ? (base as Locale) : null;
}

/** An `Accept-Language` header's tags, best first (`q=0` dropped). */
export function parseAcceptLanguage(header: string | null | undefined): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((part, i) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      const weight = q ? Number(q.slice(2)) : 1;
      return { tag: tag.trim(), weight: Number.isFinite(weight) ? weight : 0, i };
    })
    .filter((x) => x.tag && x.tag !== "*" && x.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.i - b.i)
    .map((x) => x.tag);
}

/** The first of the browser's languages we have, if any. */
export function browserLocale(tags: readonly string[] | null | undefined): Locale | null {
  for (const tag of tags ?? []) {
    const l = matchLocale(tag);
    if (l) return l;
  }
  return null;
}

/**
 * The language a person reads (plan §1.18): their own choice, else their client's default, else
 * their browser's, else English. Values that aren't languages we have are skipped.
 */
export function resolveLocale(input: {
  user?: string | null | undefined;
  client?: string | null | undefined;
  browser?: readonly string[] | null | undefined;
}): Locale {
  return (
    parseLocale(input.user) ??
    parseLocale(input.client) ??
    browserLocale(input.browser) ??
    DEFAULT_LOCALE
  );
}

/** A stored value as a language, or null (invariant 5: settings are checked, never trusted). */
export function parseLocale(value: unknown): Locale | null {
  const r = Locale.safeParse(value);
  return r.success ? r.data : null;
}

// ── Where languages are stored (tenant.settings) ─────────────────────────────────────────────────

/** `tenant.settings.language`: the client's default language. */
export const CLIENT_LANGUAGE_KEY = "language";
/** `tenant.settings.user_languages`: each of the client's users' own choice, by app_user id. */
export const USER_LANGUAGES_KEY = "user_languages";

// DECISION: a user's own language lives in their client's settings (`user_languages[userId]`),
// not in a new app_user column: a client user belongs to exactly one client and reads only its
// portal, operators always read the back office in English, and no migration is needed.
export function clientLanguage(
  settings: Record<string, unknown> | null | undefined,
): Locale | null {
  return parseLocale(settings?.[CLIENT_LANGUAGE_KEY]);
}

export function userLanguage(
  settings: Record<string, unknown> | null | undefined,
  userId: string,
): Locale | null {
  const map = settings?.[USER_LANGUAGES_KEY];
  if (!map || typeof map !== "object" || Array.isArray(map)) return null;
  return parseLocale((map as Record<string, unknown>)[userId]);
}

// ── Text with a version per language ─────────────────────────────────────────────────────────────

/**
 * Text written once per language, English required: `{ en: "Attached {{filename}}", es: "…" }`.
 * The plain-string form is still valid (and means English), so stored versions keep parsing.
 */
export function localizedText<T extends z.ZodType<string>>(text: T) {
  return z.union([
    text,
    z.strictObject({
      en: text,
      es: text.optional(),
      fr: text.optional(),
      "pt-BR": text.optional(),
      it: text.optional(),
      de: text.optional(),
    }),
  ]);
}
export const LocalizedString = localizedText(z.string());
export type LocalizedText = z.output<typeof LocalizedString>;

/** The text in `locale`, falling back to English. */
export function pickLocalized(text: LocalizedText, locale: Locale = DEFAULT_LOCALE): string {
  if (typeof text === "string") return text;
  return text[locale] ?? text.en;
}

/** Every language version of a text (for checks that read each one, such as template typing). */
export function localizedVersions(text: LocalizedText): string[] {
  return typeof text === "string"
    ? [text]
    : Object.values(text).filter((v): v is string => typeof v === "string");
}
