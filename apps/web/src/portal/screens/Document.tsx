// `/documents/:id`: one of the client's documents as we read it (DocumentDetailView), with a fresh
// 5-minute link to the original each time it is opened. Polls while the document is being read.
import { Link, useParams } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { DocumentDetailView } from "../../documents/DocumentDetail";
import { useI18n } from "../../i18n/i18n";
import { usePoll } from "../../runs/usePoll";
import { ErrorNotice, Loading } from "../../ui/primitives";
import { PORTAL_PATHS } from "../paths";

export function PortalDocumentScreen() {
  const { id = "" } = useParams();
  const api = useApiClient();
  const { t } = useI18n();
  const { data, error, loading, reload } = useApi(apiRoutes.portalDocument, {
    params: { id },
    // A 5-minute signed link to the file: never stored.
    cache: "none",
  });
  const reading = data?.document.status === "stored" || data?.document.status === "extracting";
  usePoll(reload, reading, 3_000, loading);

  async function openOriginal() {
    // The link lasts 5 minutes: ask for a fresh one each time.
    const fresh = await api.call(apiRoutes.portalDocument, { params: { id } });
    window.open(fresh.url, "_blank", "noopener,noreferrer");
  }

  // UI-3a: the page's column, with the way back to the documents (Upload) above the title.
  return (
    <div className="ui-page" data-testid="portal-document-page">
      <div>
        <p className="eyebrow mb-2 text-ink-muted">
          <Link to={PORTAL_PATHS.upload} className="text-link hover:underline">
            {t("uploadPage.documents")}
          </Link>
        </p>
        {loading && !data ? <Loading /> : null}
        {error ? <ErrorNotice error={error} onRetry={reload} /> : null}
        {data ? (
          <DocumentDetailView
            data={data}
            surface="portal"
            onOpenOriginal={() => void openOriginal()}
            transactionHref={(t) => `/records/${t}`}
            documentHref={(d) => `/documents/${d}`}
          />
        ) : null}
      </div>
    </div>
  );
}
