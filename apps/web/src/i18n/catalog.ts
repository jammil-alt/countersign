// The portal's message catalog (docs/plan.md §1.18): one file per language under ./messages, with
// English (en.ts) as the source. Keys and their `{placeholders}` are typed from en.ts, so a missing
// key, an extra key or a missing parameter fails the typecheck; plurals pick their form with
// Intl.PluralRules in the reader's language.
// DECISION: a small catalog of our own, no library: typed keys, `{name}` placeholders and
// Intl.PluralRules are all the portal needs.
// DECISION: no language ships in the first load (docs/audit-plan.md 4.1; English too since
// docs/plan.md §1.208): each is its own chunk, loaded once the session names it
// (session/session.tsx waits for it before it shows anything signed in or signed out, so no screen
// reads a language that is not there yet), and English also with the back office (App.tsx), which
// always reads in English.
import { LOCALES, type Locale } from "@countersign/core";
import type { en } from "./messages/en";

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

/**
 * What the still frame says to a screen reader (`common.loading`) before any language has loaded:
 * the session's language is fetched with or after the session call, and the frame shows meanwhile.
 */
const BEFORE_ANY: Partial<Record<MessageKey, string>> = { "common.loading": "Loading…" };

/** Each language, English included, as its own chunk. */
const LOADERS: Record<Locale, () => Promise<Messages>> = {
  en: () => import("./messages/en").then((m) => m.en as Messages),
  es: () => import("./messages/es").then((m) => m.es),
  fr: () => import("./messages/fr").then((m) => m.fr),
  "pt-BR": () => import("./messages/pt-BR").then((m) => m.ptBR),
  it: () => import("./messages/it").then((m) => m.it),
  de: () => import("./messages/de").then((m) => m.de),
};

/** The languages loaded so far: none on a fresh page. */
const loaded = new Map<Locale, Messages>();
const loading = new Map<Locale, Promise<Messages>>();

/** The catalog for `locale` if it has loaded. */
export function loadedCatalog(locale: Locale): Messages | undefined {
  return loaded.get(locale);
}

/**
 * Loads one language's catalog (once; callers share the request). A language whose chunk can't be
 * fetched reads in English rather than fail the screen, and English that can't be fetched reads
 * nothing (the translator then shows the still frame's word or the key): the promise never rejects.
 */
export function loadCatalog(locale: Locale): Promise<Messages> {
  const have = loaded.get(locale);
  if (have) return Promise.resolve(have);
  const pending = loading.get(locale);
  if (pending) return pending;
  const promise = LOADERS[locale]().then(
    (messages) => {
      loaded.set(locale, messages);
      loading.delete(locale);
      return messages;
    },
    () => {
      // Offline, or a deploy replaced the chunk: English this time, and the next call tries again.
      // (A deploy usually reloads the page first: shell/stale-build.ts.)
      loading.delete(locale);
      return locale === "en" ? ({} as Messages) : loadCatalog("en");
    },
  );
  loading.set(locale, promise);
  return promise;
}

/** Where this browser keeps the language its last session read in. */
const LAST_LANGUAGE = "mezonas.language";

/** Remembers the language a session read in, for `startLanguageEarly` on the next visit. */
export function rememberLanguage(locale: Locale): void {
  try {
    window.localStorage.setItem(LAST_LANGUAGE, locale);
  } catch {
    // Storage blocked: the next visit loads its language after the session call, as a first one does.
  }
}

/**
 * Starts loading the language this browser's last session read in, beside the session call, so a
 * returning person's first screen doesn't wait for its words after the session answers. Called once
 * by `main.tsx`.
 */
// DECISION (§1.208): the last session's language, not the browser's: it is the one the session
// will most likely name. A wrong guess costs one language's chunk; a first visit guesses nothing.
export function startLanguageEarly(): void {
  let last: string | null = null;
  try {
    last = window.localStorage.getItem(LAST_LANGUAGE);
  } catch {
    return;
  }
  const locale = LOCALES.find((l) => l === last);
  if (locale) void loadCatalog(locale);
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

/** Tests of the lazy path only: back to no language, as a fresh page starts. */
export function unloadCatalogs(): void {
  loaded.clear();
  loading.clear();
}

/** Every language at once: tests that read the words of several languages side by side. */
export async function loadAllCatalogs(): Promise<void> {
  await Promise.all((Object.keys(LOADERS) as Locale[]).map(loadCatalog));
}

/**
 * A translator for one language; numbers in parameters are formatted with `intl`'s conventions.
 * A language that has not loaded yet reads in English if English has; the session waits for the
 * language before it shows a screen, so a person does not see that. The catalog is looked up on
 * each call, not when the translator is made, so one made before its language arrived (the back
 * office's `EN`) reads it once it has.
 */
export function createTranslator(locale: Locale, intl: string = locale): Translate {
  const rules = new Intl.PluralRules(locale);
  const numbers = new Intl.NumberFormat(intl);
  return ((key: MessageKey, params?: Record<string, string | number>) => {
    // A language file can't lack a key (the typecheck), but a stale build could: English then.
    // DECISION (§1.208): with no language loaded yet, the still frame's one word (BEFORE_ANY), else
    // the key: only the still frame renders before the session's language is here.
    const entry: string | PluralForms | undefined =
      loaded.get(locale)?.[key] ?? loaded.get("en")?.[key] ?? BEFORE_ANY[key];
    if (entry === undefined) return key;
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
