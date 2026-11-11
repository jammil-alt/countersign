// The portal's message catalog (docs/plan.md §1.18): one file per language under ./messages, with
// English (en.ts) as the source. Keys and their `{placeholders}` are typed from en.ts, so a missing
// key, an extra key or a missing parameter fails the typecheck; plurals pick their form with
// Intl.PluralRules in the reader's language.
// DECISION: a small catalog of our own, no library: typed keys, `{name}` placeholders and
// Intl.PluralRules are all the portal needs.
// DECISION: only English ships in the bundle (docs/audit-plan.md 4.1); every other language is its
// own chunk, loaded once the session names it (session/session.tsx waits for it before it shows
// anything signed in or signed out, so no screen reads a language that is not there yet).
import { LOCALES, type Locale } from "@countersign/core";
import { en } from "./messages/en";

/** A message whose words depend on a number. `other` is required; `one` is what English needs. */
export interface PluralForms {
  zero?: string;
  one?: string;
  two?: string;
  few?: string;
  many?: string;
  other: string;
}

type Source = typeof en;
export type MessageKey = keyof Source;

/** What every other language's file must hold: each English key, as text or as plural forms. */
export type Messages = { [K in MessageKey]: Source[K] extends string ? string : PluralForms };

type Vars<S> = S extends `${string}{${infer P}}${infer R}` ? P | Vars<R> : never;
type TextsOf<V> = V extends string ? V : V[keyof V];
type ParamNames<K extends MessageKey> =
  | Vars<TextsOf<Source[K]>>
  | (Source[K] extends string ? never : "count");

/** A message's parameters: its `{placeholders}`, plus `count` (a number) for plurals. */
export type MessageParams<K extends MessageKey> = {
  [P in ParamNames<K>]: P extends "count" ? number : string | number;
};
export type TArgs<K extends MessageKey> = [ParamNames<K>] extends [never]
  ? []
  : [params: MessageParams<K>];

/** Keys that take no parameters: what lookup tables (status → words) hold. */
export type PlainKey = {
  [K in MessageKey]: [ParamNames<K>] extends [never] ? K : never;
}[MessageKey];

/** `t("runs.title")`, `t("run.took", { duration })`, `t("overview.inboxItems", { count: 3 })`. */
export type Translate = <K extends MessageKey>(key: K, ...args: TArgs<K>) => string;

/** Each language other than English, as its own chunk. */
const LOADERS: Record<Exclude<Locale, "en">, () => Promise<Messages>> = {
  es: () => import("./messages/es").then((m) => m.es),
  fr: () => import("./messages/fr").then((m) => m.fr),
  "pt-BR": () => import("./messages/pt-BR").then((m) => m.ptBR),
  it: () => import("./messages/it").then((m) => m.it),
  de: () => import("./messages/de").then((m) => m.de),
};

/** The languages loaded so far: English always. */
const loaded = new Map<Locale, Messages>([["en", en]]);
const loading = new Map<Locale, Promise<Messages>>();

/** The catalog for `locale` if it has loaded; English is always there. */
export function loadedCatalog(locale: Locale): Messages | undefined {
  return loaded.get(locale);
}

/**
 * Loads one language's catalog (once; callers share the request). A language whose chunk can't be
 * fetched reads in English rather than fail the screen: the promise never rejects.
 */
export function loadCatalog(locale: Locale): Promise<Messages> {
  const have = loaded.get(locale);
  if (have) return Promise.resolve(have);
  const pending = loading.get(locale);
  if (pending) return pending;
  const load = LOADERS[locale as Exclude<Locale, "en">];
  const promise = load().then(
    (messages) => {
      loaded.set(locale, messages);
      loading.delete(locale);
      return messages;
    },
    () => {
      // Offline, or a deploy replaced the chunk: English this time, and the next call tries again.
      loading.delete(locale);
      return en as Messages;
    },
  );
  loading.set(locale, promise);
  return promise;
}

/**
 * Every language's catalog by name, as loaded so far (a language not loaded yet reads undefined).
 * For tests that check the catalogs side by side, after `loadAllCatalogs`; screens use
 * `createTranslator`.
 */
export const CATALOGS = Object.defineProperties(
  {},
  Object.fromEntries(
    LOCALES.map((locale) => [locale, { enumerable: true, get: () => loaded.get(locale) }]),
  ),
) as Readonly<Record<Locale, Messages>>;

/** Tests of the lazy path only: back to English alone, as a fresh page starts. */
export function unloadCatalogs(): void {
  for (const locale of [...loaded.keys()]) if (locale !== "en") loaded.delete(locale);
  loading.clear();
}

/** Every language at once: tests that read the words of several languages side by side. */
export async function loadAllCatalogs(): Promise<void> {
  await Promise.all((Object.keys(LOADERS) as Locale[]).map(loadCatalog));
}

/**
 * A translator for one language; numbers in parameters are formatted with `intl`'s conventions.
 * A language that has not loaded yet reads in English (never in keys); the session waits for the
 * language before it shows a screen, so a person does not see that.
 */
export function createTranslator(locale: Locale, intl: string = locale): Translate {
  const messages = loaded.get(locale) ?? (en as Messages);
  const rules = new Intl.PluralRules(locale);
  const numbers = new Intl.NumberFormat(intl);
  return ((key: MessageKey, params?: Record<string, string | number>) => {
    // A language file can't lack a key (the typecheck), but a stale build could: English then.
    const entry: string | PluralForms = messages[key] ?? (en as Messages)[key];
    let text: string;
    if (typeof entry === "string") {
      text = entry;
    } else {
      const n = Number(params?.count ?? 0);
      const form = rules.select(n) as keyof PluralForms;
      text = entry[form] ?? entry.other;
    }
    return text.replace(/\{(\w+)\}/g, (whole, name: string) => {
      const value = params?.[name];
      if (value === undefined) return whole;
      return typeof value === "number" ? numbers.format(value) : value;
    });
  }) as Translate;
}
