// Record pages (plan §1.16): `/records/:id` in the portal (the client's own records only) and
// `/ops/clients/:clientId/records/:recordId` in the back office. A source id that names a document
// (or one of its extractions) opens the document page; an id that is not a record says so.
import { Link, Navigate, useParams } from "react-router-dom";
import { isApiError } from "../api/client";
import { apiRoutes } from "../api/routes";
import { useApi } from "../api/useApi";
import { useI18n } from "../i18n/i18n";
import { PORTAL_PATHS } from "../portal/paths";
import { EmptyState, ErrorNotice, Loading } from "../ui/primitives";
import { RecordDetail, type RecordHrefs } from "./RecordDetail";
import { RecordRuns, type RecordRunsSource } from "./RecordRuns";

function NotARecord() {
  const { t } = useI18n();
  return (
    <EmptyState>
      <span data-testid="record-not-found">{t("record.notFound")}</span>
    </EmptyState>
  );
}

function RecordBody({
  state,
  hrefs,
  source,
  recordId,
  runHref,
}: {
  state: ReturnType<typeof useApi<typeof apiRoutes.portalRecord>>;
  hrefs: RecordHrefs;
  source: RecordRunsSource;
  recordId: string;
  runHref(id: string): string;
}) {
  const { data, error, loading, reload } = state;
  if (loading && !data) return <Loading />;
  if (isApiError(error) && error.status === 404) return <NotARecord />;
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!data) return null;
  if (data.record.kind === "document") {
    return <Navigate to={hrefs.document(data.record.documentId)} replace />;
  }
  return (
    <>
      <RecordDetail record={data.record} hrefs={hrefs} />
      {/* R3 (docs/plan.md §1.200): what our agents did with it. */}
      <RecordRuns source={source} recordId={recordId} runHref={runHref} />
    </>
  );
}

export function PortalRecordScreen() {
  const { t } = useI18n();
  const { id = "" } = useParams();
  const state = useApi(apiRoutes.portalRecord, { params: { id } });
  // UI-3a: the page's column, with the way back to the records list above the title.
  return (
    <div className="ui-page" data-testid="portal-record-page">
      <div>
        <p className="eyebrow mb-2 text-ink-muted">
          <Link to="/records" className="text-link hover:underline">
            {t("records.title")}
          </Link>
        </p>
        <RecordBody
          state={state}
          hrefs={{ record: (r) => `/records/${r}`, document: (d) => `/documents/${d}` }}
          source={{ surface: "portal" }}
          recordId={id}
          runHref={(r) => `${PORTAL_PATHS.runs}/${r}`}
        />
      </div>
    </div>
  );
}

export function OpsRecordScreen() {
  const { clientId = "", recordId = "" } = useParams();
  const state = useApi(apiRoutes.opsClientRecord, { params: { id: clientId, recordId } });
  const base = `/ops/clients/${clientId}`;
  return (
    <div className="max-w-6xl">
      <p className="mb-2 text-sm">
        <Link to={`${base}/documents`} className="text-ink-muted hover:underline">
          Documents
        </Link>
      </p>
      <RecordBody
        state={state}
        hrefs={{
          record: (r) => `${base}/records/${r}`,
          document: (d) => `${base}/documents/${d}`,
        }}
        source={{ surface: "ops", clientId }}
        recordId={recordId}
        runHref={(r) => `/ops/runs/${r}`}
      />
    </div>
  );
}
