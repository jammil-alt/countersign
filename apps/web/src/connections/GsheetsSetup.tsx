// v0.14 W4-D: the client admin's Google Sheets card (ARCHITECTURE §6.11 row 7, docs/plan.md §1.52):
// the sheets agents may use, each removable, and "Choose sheets", which opens the picking page.
// That page loads Google's Picker, so it is opened as a page of its own (a full load): only it
// gets the Content-Security-Policy that lets Google's script and frame in (apps/web/public/_headers).
import { useState } from "react";
import { apiRoutes } from "../api/routes";
import { useApi, useApiClient } from "../api/useApi";
import { useI18n } from "../i18n/i18n";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Loading,
  SectionLabel,
} from "../ui/primitives";

/** The portal's picking page; loaded as a document, never by client-side navigation. */
export const GSHEETS_PICK_PATH = "/connections/gsheets/pick";

export function GsheetsSetup() {
  const api = useApiClient();
  const { t } = useI18n();
  const { data, error, loading, reload } = useApi(apiRoutes.portalGsheetsPicker);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);

  async function remove(id: string) {
    if (!data) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.call(apiRoutes.portalGsheetsSheets, {
        body: { sheetIds: data.sheets.filter((s) => s.usable && s.id !== id).map((s) => s.id) },
      });
      reload();
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section data-testid="gsheets-setup">
      <SectionLabel>{t("gsheets.section")}</SectionLabel>
      {loading && !data ? <Loading /> : null}
      {error ? <ErrorNotice error={error} onRetry={reload} /> : null}
      {actionError ? (
        <div className="mb-3">
          <ErrorNotice error={actionError} />
        </div>
      ) : null}
      {data ? (
        <Card className="flex flex-col gap-3 p-4">
          <p className="text-sm text-ink-muted">{t("gsheets.help")}</p>
          {data.sheets.length === 0 ? (
            <EmptyState>{t("gsheets.none")}</EmptyState>
          ) : (
            <ul data-testid="gsheets-sheets" className="flex flex-col gap-2 text-sm">
              {data.sheets.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0">
                    {s.url ? (
                      <a
                        className="text-ink underline"
                        href={s.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {s.name}
                      </a>
                    ) : (
                      <span className="text-ink">{s.name}</span>
                    )}
                    {s.usable ? null : (
                      <Badge tone="warning" className="ml-2">
                        {t("gsheets.otherAccount")}
                      </Badge>
                    )}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    data-testid="gsheets-remove"
                    disabled={busy}
                    onClick={() => void remove(s.id)}
                  >
                    {t("gsheets.remove")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div>
            {data.available ? (
              <Button
                variant="primary"
                data-testid="gsheets-choose"
                disabled={busy}
                // A full load, so the page gets its own Content-Security-Policy.
                onClick={() => window.location.assign(GSHEETS_PICK_PATH)}
              >
                {t("gsheets.choose")}
              </Button>
            ) : (
              <p className="text-sm text-ink-muted">{t("gsheets.notSetUp")}</p>
            )}
          </div>
        </Card>
      ) : null}
    </section>
  );
}
