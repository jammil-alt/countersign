// The portal's message catalog (docs/plan.md §1.18): one file per language under ./messages, with
// English (en.ts) as the source. Keys and their `{placeholders}` are typed from en.ts, so a missing
// key, an extra key or a missing parameter fails the typecheck; plurals pick their form with
// Intl.PluralRules in the reader's language.
// DECISION: a small catalog of our own, no library: typed keys, `{name}` placeholders and
// Intl.PluralRules are all the portal needs, and every language ships in the bundle (a few KB each).
import type { Locale } from "@countersign/core";
import { de } from "./messages/de";
import { en } from "./messages/en";
import { es } from "./messages/es";
import { fr } from "./messages/fr";
import { it } from "./messages/it";
import { ptBR } from "./messages/pt-BR";

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

export const CATALOGS: Record<Locale, Messages> = {
  en,
  es,
  fr,
  "pt-BR": ptBR,
  it,
  de,
};

/** A translator for one language; numbers in parameters are formatted with `intl`'s conventions. */
export function createTranslator(locale: Locale, intl: string = locale): Translate {
  const messages = CATALOGS[locale];
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
