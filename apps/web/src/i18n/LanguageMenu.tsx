// The portal's language picker, in the user menu (docs/plan.md §1.18): the language you read in
// (your own choice, or your team's default), and, for the client admin, the team's default.
// Each choice saves at once and reloads the session, so the whole portal changes language.
import { LOCALE_NAMES, LOCALES, type Locale, parseLocale, resolveLocale } from "@countersign/core";
import { useState } from "react";
import { apiRoutes } from "../api/routes";
import { useApiClient } from "../api/useApi";
import { useSession, useSessionState } from "../session/session";
import { Field, Select } from "../ui/forms";
import { ErrorNotice } from "../ui/primitives";
import { browserLanguages, useI18n } from "./i18n";

export function LanguageMenu() {
  const { t } = useI18n();
  const api = useApiClient();
  const session = useSession();
  const { refresh } = useSessionState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const client =
    session.tenants.find((c) => c.id === session.activeTenantId) ?? session.tenants[0] ?? null;
  const isAdmin = client?.role === "client_admin";
  const { user, client: team } = session.language;
  // What "no choice of your own" reads in: the team's default, else this browser's language.
  const fallback: Locale = team ?? resolveLocale({ browser: browserLanguages() });

  async function save(call: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await call();
      await refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 flex flex-col gap-3 border-t border-line pt-3" data-testid="language-menu">
      <Field label={t("language.label")}>
        <Select
          data-testid="language-mine"
          value={user ?? ""}
          disabled={busy}
          onChange={(e) => {
            const language = parseLocale(e.target.value);
            void save(() => api.call(apiRoutes.portalSetMyLanguage, { body: { language } }));
          }}
        >
          <option value="">
            {team
              ? t("language.followClient", { language: LOCALE_NAMES[fallback] })
              : t("language.followBrowser", { language: LOCALE_NAMES[fallback] })}
          </option>
          {LOCALES.map((l) => (
            <option key={l} value={l} lang={l}>
              {LOCALE_NAMES[l]}
            </option>
          ))}
        </Select>
      </Field>
      {isAdmin && client ? (
        <Field
          label={t("language.clientDefault", { client: client.name })}
          hint={t("language.clientDefaultHint", { client: client.name })}
        >
          <Select
            data-testid="language-team"
            value={team ?? ""}
            disabled={busy}
            onChange={(e) => {
              const language = parseLocale(e.target.value);
              if (!language) return;
              void save(() => api.call(apiRoutes.portalSetClientLanguage, { body: { language } }));
            }}
          >
            {team ? null : (
              <option value="" disabled>
                {t("language.clientDefaultNone")}
              </option>
            )}
            {LOCALES.map((l) => (
              <option key={l} value={l} lang={l}>
                {LOCALE_NAMES[l]}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      {error ? <ErrorNotice error={error} /> : null}
    </div>
  );
}
