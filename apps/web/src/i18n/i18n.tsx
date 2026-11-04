// The reader's language in React (docs/plan.md §1.18). The portal and the sign-in page read in the
// session's language (or the browser's, before a session); the back office always in English.
// Components shared by both surfaces call useI18n(): outside a provider they get English, so the
// back office needs nothing.
import { DEFAULT_LOCALE, type Locale } from "@countersign/core";
import { createContext, type ReactNode, useContext, useEffect, useMemo } from "react";
import { createTranslator, type Translate } from "./catalog";
import { createFormatters, type Formatters, intlLocaleFor } from "./format";

export interface I18n {
  /** The language the words are in. */
  locale: Locale;
  /** The Intl locale formats come from (the reader's region when it matches). */
  intl: string;
  t: Translate;
  fmt: Formatters;
}

export function createI18n(locale: Locale, browser: readonly string[] = []): I18n {
  const intl = intlLocaleFor(locale, browser);
  return { locale, intl, t: createTranslator(locale, intl), fmt: createFormatters(intl) };
}

/** English, as the back office and every shared component outside a provider read it. */
export const EN: I18n = createI18n(DEFAULT_LOCALE);

const I18nContext = createContext<I18n>(EN);

/** The browser's languages, best first (navigator.languages); none outside a browser. */
export function browserLanguages(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  return navigator.languages?.length
    ? navigator.languages
    : navigator.language
      ? [navigator.language]
      : [];
}

export function I18nProvider({
  locale,
  browser,
  children,
}: {
  locale: Locale;
  /** Defaults to navigator.languages. */
  browser?: readonly string[];
  children: ReactNode;
}) {
  const tags = browser ?? browserLanguages();
  const key = tags.join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `tags`' contents.
  const value = useMemo(() => createI18n(locale, tags), [locale, key]);
  useEffect(() => {
    // Screen readers, hyphenation and spell checking follow the page's language.
    document.documentElement.lang = locale;
  }, [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  return useContext(I18nContext);
}
