// Which language the app reads in (docs/plan.md §1.18): a signed-in session's (the user's choice,
// else the client's default, else the browser's, as the API resolved it); before a session, the
// browser's (navigator.languages), else English. Operator sessions are English; the back office
// also wraps itself in English (OpsApp).
import { browserLocale, DEFAULT_LOCALE } from "@countersign/core";
import type { ReactNode } from "react";
import { useSessionState } from "../session/session";
import { browserLanguages, I18nProvider } from "./i18n";

export function SessionLanguage({ children }: { children: ReactNode }) {
  const { state } = useSessionState();
  const locale =
    state.status === "signed_in"
      ? state.session.language.effective
      : (browserLocale(browserLanguages()) ?? DEFAULT_LOCALE);
  return <I18nProvider locale={locale}>{children}</I18nProvider>;
}
