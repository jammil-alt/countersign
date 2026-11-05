// `/ops/clients/:clientId/documents` and `…/documents/:documentId`: the back office's view of a
// client's documents (plan §1.16): the ones that arrived (uploaded, forwarded, from its tools),
// newest first, and each document as the client sees it, with a fresh 5-minute link to the
// original each time it is opened. In the Sandbox client, which has no client people, the operator
// uploads its documents here with the portal's upload.
import { Link, useParams } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { sandboxUploadPath, uploadFiles } from "../../api/upload";
import { useApi, useApiClient } from "../../api/useApi";
import { DocumentDetailView } from "../../documents/DocumentDetail";
import { documentStatus, money, sourceLabel } from "../../portal/documents";
import { DropZone } from "../../portal/screens/Upload";
import { shortTime } from "../../runs/format";
import { usePoll } from "../../runs/usePoll";
import { useSession } from "../../session/session";
import { Badge, EmptyState, ErrorNotice, Loading, PageHeader } from "../../ui/primitives";

export function OpsDocumentsScreen() {
  const { clientId = "" } = useParams();
  const session = useSession();
  const clientName = session.tenants.find((t) => t.id === clientId)?.name ?? "This client";
  const { data, error, loading, reload } = useApi(apiRoutes.opsClientDocuments, {
    params: { id: clientId },
    query: { limit: 200 },
  });
  const base = `/ops/clients/${clientId}`;
  return (
    <div>
      <PageHeader
        title="Documents"
        subtitle={
          data
            ? `${clientName} · ${data.documents.length} ${data.documents.length === 1 ? "document" : "documents"}, newest first`
            : clientName
        }
      />
      {loading && !data ? <Loading /> : null}
      {error ? <ErrorNotice error={error} onRetry={reload} /> : null}
      {data?.sandbox ? (
        <section className="mb-6 max-w-xl" data-testid="ops-sandbox-upload">
          <p className="mb-2 text-sm text-ink-muted">
            Your test client has no client people, so you upload its invoices here. Once read, each
            one can be picked as a test run's input.
          </p>
          <DropZone
            testId="ops-upload"
            upload={(files) => uploadFiles(files, undefined, sandboxUploadPath(clientId))}
            documentHref={(id) => `${base}/documents/${id}`}
            onUploaded={reload}
          />
        </section>
      ) : null}
      {data && data.documents.length === 0 ? (
        <EmptyState>
          {data.sandbox
            ? "No documents yet. Upload an invoice above."
            : "No documents yet. They arrive when the client uploads or forwards an invoice."}
        </EmptyState>
      ) : null}
      {data && data.documents.length > 0 ? (
        <div className="dt dt-ana">
          <div>
            <table data-testid="ops-documents">
              <thead>
                <tr className="dt-cols">
                  <th>Document</th>
                  <th>Vendor</th>
                  <th className="n">Total</th>
                  <th>Status</th>
                  <th>Matched</th>
                  <th>Received</th>
                </tr>
              </thead>
              <tbody>
                {data.documents.map((d) => {
                  const s = documentStatus(d.status);
                  return (
                    <tr key={d.id} data-testid={`ops-document-row-${d.id}`}>
                      <td>
                        <Link
                          to={`${base}/documents/${d.id}`}
                          className="font-medium text-ink hover:underline"
                        >
                          {d.invoiceNumber ? `Invoice ${d.invoiceNumber}` : d.filename}
                        </Link>
                        <span className="block text-sm text-ink-muted">
                          {sourceLabel(d.source)} · {d.filename}
                        </span>
                      </td>
                      <td className="text-ink">{d.vendorName ?? "–"}</td>
                      <td className="n text-ink figures">{money(d.total)}</td>
                      <td>
                        <Badge tone={s.tone}>{s.label}</Badge>
                      </td>
                      <td>
                        {d.transactionId ? (
                          <Link
                            to={`${base}/records/${d.transactionId}`}
                            className="text-link underline"
                          >
                            Purchase
                          </Link>
                        ) : (
                          <span className="text-ink-muted">Not yet</span>
                        )}
                      </td>
                      <td className="text-ink figures">{shortTime(d.receivedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function OpsDocumentScreen() {
  const { clientId = "", documentId = "" } = useParams();
  const api = useApiClient();
  const params = { id: clientId, documentId };
  const { data, error, loading, reload } = useApi(apiRoutes.opsClientDocument, { params });
  const reading = data?.document.status === "stored" || data?.document.status === "extracting";
  usePoll(reload, reading, 3_000);
  const base = `/ops/clients/${clientId}`;

  async function openOriginal() {
    // The link lasts 5 minutes: ask for a fresh one each time.
    const fresh = await api.call(apiRoutes.opsClientDocument, { params });
    window.open(fresh.url, "_blank", "noopener,noreferrer");
  }

  return (
    <div className="max-w-6xl">
      <p className="mb-2 text-sm">
        <Link
          to={`${base}/documents`}
          className="text-ink-muted hover:underline"
          data-testid="ops-document-back"
        >
          Documents
        </Link>
      </p>
      {loading && !data ? <Loading /> : null}
      {error ? <ErrorNotice error={error} onRetry={reload} /> : null}
      {data ? (
        <DocumentDetailView
          data={data}
          surface="ops"
          onOpenOriginal={() => void openOriginal()}
          transactionHref={(t) => `${base}/records/${t}`}
        />
      ) : null}
    </div>
  );
}
