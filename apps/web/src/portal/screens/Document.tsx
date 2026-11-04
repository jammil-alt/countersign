// `/documents/:id`: one of the client's documents as we read it (DocumentDetailView), with a fresh
// 5-minute link to the original each time it is opened. Polls while the document is being read.
import { Link, useParams } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { DocumentDetailView } from "../../documents/DocumentDetail";
import { usePoll } from "../../runs/usePoll";
import { ErrorNotice, Loading } from "../../ui/primitives";

export function PortalDocumentScreen() {
  const { id = "" } = useParams();
  const api = useApiClient();
  const { data, error, loading, reload } = useApi(apiRoutes.portalDocument, { params: { id } });
  const reading = data?.document.status === "stored" || data?.document.status === "extracting";
  usePoll(reload, reading, 3_000);

  async function openOriginal() {
    // The link lasts 5 minutes: ask for a fresh one each time.
    const fresh = await api.call(apiRoutes.portalDocument, { params: { id } });
    window.open(fresh.url, "_blank", "noopener,noreferrer");
  }

  return (
    <div className="max-w-6xl">
      <p className="mb-2 text-sm">
        <Link to="/connections" className="text-ink-muted hover:underline">
          Connections
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
        />
      ) : null}
    </div>
  );
}
