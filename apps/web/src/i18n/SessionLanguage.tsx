// Which language the app reads in (docs/plan.md §1.18): a signed-in session's (the user's choice,
// else the client's default, else the browser's, as the API resolved it); before a session, the
// browser's (navigator.languages), else English. Operator sessions are English; the back office
// also wraps itself in English (OpsApp). The session loads the language before it shows a state
// (session/session.tsx), so the words are here when this reads them.
import type { ReactNode } from "react";
import { stateLocale, useSessionState } from "../session/session";
import { I18nProvider } from "./i18n";

export function SessionLanguage({ children }: { children: ReactNode }) {
  const { state } = useSessionState();
  return <I18nProvider locale={stateLocale(state)}>{children}</I18nProvider>;
}
