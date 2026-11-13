// §1.97: the client admin's Excel card (docs/plan.md §1.97): the workbooks agents may use, each
// removable, and a search of the connected person's own OneDrive to add more. Microsoft's consent
// screen says "your files"; agents use only the workbooks picked here, and the card says so.
import { type FormEvent, useState } from "react";
import type { ResponseOf } from "../api/client";
import { apiRoutes } from "../api/routes";
import { useApi, useApiClient } from "../api/useApi";
import { useI18n } from "../i18n/i18n";
import { TextInput } from "../ui/forms";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Loading,
  SectionLabel,
} from "../ui/primitives";

type Results = ResponseOf<typeof apiRoutes.portalExcelSearch>["results"];

export function ExcelSetup() {
  const api = useApiClient();
  const { t } = useI18n();
  const { data, error, loading, reload } = useApi(apiRoutes.portalExcelPicker);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Results | null>(null);

  const usableIds = (data?.workbooks ?? []).filter((w) => w.usable).map((w) => w.id);

  async function save(ids: string[]) {
    setBusy(true);
    setActionError(null);
    try {
      await api.call(apiRoutes.portalExcelWorkbooks, { body: { workbookIds: ids } });
      reload();
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(false);
    }
  }

  async function search(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setActionError(null);
    try {
      const found = await api.call(apiRoutes.portalExcelSearch, { query: { q: query } });
      setResults(found.results);
    } catch (err) {
      setActionError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section data-testid="excel-setup">
      <SectionLabel>{t("excel.section")}</SectionLabel>
      {loading && !data ? <Loading /> : null}
      {error ? <ErrorNotice error={error} onRetry={reload} /> : null}
      {actionError ? (
        <div className="mb-3">
          <ErrorNotice error={actionError} />
        </div>
      ) : null}
      {data ? (
        <Card className="flex flex-col gap-3 p-4">
          <p className="text-sm text-ink-muted">{t("excel.help")}</p>
          {data.workbooks.length === 0 ? (
            <EmptyState>{t("excel.none")}</EmptyState>
          ) : (
            <ul data-testid="excel-workbooks" className="flex flex-col gap-2 text-sm">
              {data.workbooks.map((w) => (
                <li key={w.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0">
                    {w.url ? (
                      <a
                        className="text-ink underline"
                        href={w.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {w.name}
                      </a>
                    ) : (
                      <span className="text-ink">{w.name}</span>
                    )}
                    {w.usable ? null : (
                      <Badge tone="warning" className="ml-2">
                        {t("excel.otherAccount")}
                      </Badge>
                    )}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    data-testid="excel-remove"
                    disabled={busy}
                    onClick={() => void save(usableIds.filter((id) => id !== w.id))}
                  >
                    {t("excel.remove")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {data.available ? (
            <form className="flex flex-col gap-2" onSubmit={(e) => void search(e)}>
              <label className="text-sm text-ink" htmlFor="excel-search">
                {t("excel.searchLabel")}
              </label>
              <div className="flex flex-wrap gap-2">
                <TextInput
                  id="excel-search"
                  data-testid="excel-search"
                  value={query}
                  maxLength={100}
                  placeholder={t("excel.searchPlaceholder")}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <Button type="submit" disabled={busy}>
                  {t("excel.search")}
                </Button>
              </div>
            </form>
          ) : (
            <p className="text-sm text-ink-muted">{t("excel.notConnected")}</p>
          )}
          {results ? (
            results.length === 0 ? (
              <EmptyState>{t("excel.noResults")}</EmptyState>
            ) : (
              <ul data-testid="excel-results" className="flex flex-col gap-2 text-sm">
                {results.map((r) => {
                  const picked = usableIds.includes(r.id);
                  return (
                    <li key={r.id} className="flex flex-wrap items-center justify-between gap-2">
                      <span className="min-w-0">
                        <span className="text-ink">{r.name}</span>
                        {r.folder ? <span className="ml-2 text-ink-muted">{r.folder}</span> : null}
                      </span>
                      {picked ? (
                        <Badge tone="positive">{t("excel.added")}</Badge>
                      ) : (
                        <Button
                          size="sm"
                          data-testid="excel-add"
                          disabled={busy}
                          onClick={() => void save([...usableIds, r.id])}
                        >
                          {t("excel.add")}
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )
          ) : null}
        </Card>
      ) : null}
    </section>
  );
}
