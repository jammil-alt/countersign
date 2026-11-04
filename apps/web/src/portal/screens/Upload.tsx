// Upload and forwarding (ARCHITECTURE §6.3, §6.5), built in on every client's Connections page:
// drop invoices, receipts or a purchases CSV; see the private forwarding address and who may
// forward to it (the client admin edits the list); and the documents that arrived.
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { type UploadResponse, uploadFiles } from "../../api/upload";
import { useApi, useApiClient } from "../../api/useApi";
import { shortTime } from "../../runs/format";
import { TextArea } from "../../ui/forms";
import {
  Badge,
  Button,
  Card,
  cx,
  EmptyState,
  ErrorNotice,
  Loading,
  SectionLabel,
  Tag,
} from "../../ui/primitives";
import { DROP_REASON, documentStatus, money, SOURCE_LABEL } from "../documents";

type Result = UploadResponse["results"][number];
type Shown = Result & { key: string };

export function UploadSection({ isAdmin }: { isAdmin: boolean }) {
  const documents = useApi(apiRoutes.portalDocuments, { query: { limit: 20 } });
  return (
    <section data-testid="portal-upload">
      <SectionLabel>Upload and forwarding · built in</SectionLabel>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <DropZone onUploaded={documents.reload} />
        <Forwarding isAdmin={isAdmin} />
      </div>
      <div className="mt-4">
        <RecentDocuments state={documents} />
      </div>
    </section>
  );
}

function resultLine(r: Result): { text: string; tone: "positive" | "neutral" | "risk" } {
  if (r.kind === "refused") return { text: r.error ?? "Not accepted.", tone: "risk" };
  if (r.kind === "purchases" && r.purchases) {
    const p = r.purchases;
    const parts = [`${p.created} ${p.created === 1 ? "purchase" : "purchases"} added`];
    if (p.duplicates > 0) parts.push(`${p.duplicates} already here`);
    if (p.errors.length > 0) {
      parts.push(`${p.errors.length} ${p.errors.length === 1 ? "row" : "rows"} skipped`);
    }
    return { text: parts.join(" · "), tone: p.errors.length > 0 ? "neutral" : "positive" };
  }
  return r.created
    ? { text: "Received", tone: "positive" }
    : { text: "Already here: we keep one copy.", tone: "neutral" };
}

function DropZone({ onUploaded }: { onUploaded: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [results, setResults] = useState<Shown[]>([]);

  async function send(list: FileList | null) {
    const files = list ? [...list] : [];
    if (files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await uploadFiles(files);
      setResults(res.results.map((r) => ({ ...r, key: crypto.randomUUID() })));
      onUploaded();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <Card className="flex flex-col p-4">
      <p className="font-medium text-ink">Upload</p>
      <p className="mt-1 text-sm text-ink-muted">
        Invoices and receipts (PDF or image), or a CSV of purchases with date, vendor and amount.
      </p>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the drop target; the button inside is the keyboard path. */}
      <div
        data-testid="portal-upload-drop"
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void send(e.dataTransfer.files);
        }}
        className={cx(
          "mt-3 flex flex-col items-center justify-center gap-2 rounded-md border border-dashed px-4 py-8 text-center",
          over ? "border-slate bg-slate-tint" : "border-line-strong",
        )}
      >
        <p className="text-sm text-ink">Drop files here</p>
        <Button
          data-testid="portal-upload-choose"
          disabled={busy}
          onClick={() => input.current?.click()}
        >
          {busy ? "Uploading…" : "Choose files"}
        </Button>
        <input
          ref={input}
          data-testid="portal-upload-input"
          type="file"
          multiple
          accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.csv,application/pdf,image/*,text/csv"
          className="sr-only"
          onChange={(e) => void send(e.target.files)}
        />
      </div>
      {error ? (
        <div className="mt-3">
          <ErrorNotice error={error} />
        </div>
      ) : null}
      {results.length > 0 ? (
        <ul data-testid="portal-upload-results" className="mt-3 flex flex-col gap-1.5 text-sm">
          {results.map((r) => {
            const line = resultLine(r);
            return (
              <li key={r.key} className="flex items-start justify-between gap-3">
                <span className="min-w-0 truncate text-ink">
                  {r.document ? (
                    <Link to={`/documents/${r.document.id}`} className="hover:underline">
                      {r.filename}
                    </Link>
                  ) : (
                    r.filename
                  )}
                </span>
                <span
                  className={cx(
                    "shrink-0 text-right",
                    line.tone === "risk" ? "text-risk-ink" : "text-ink-muted",
                  )}
                >
                  {line.text}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </Card>
  );
}

function Forwarding({ isAdmin }: { isAdmin: boolean }) {
  const api = useApiClient();
  const { data, error, loading, reload } = useApi(apiRoutes.portalForwarding);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saveError, setSaveError] = useState<unknown>(null);
  const [copied, setCopied] = useState(false);
  const f = data?.forwarding;

  async function save() {
    setSaveError(null);
    try {
      const allowed = draft
        .split(/[\s,;]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      await api.call(apiRoutes.portalForwardingSenders, { body: { allowed } });
      setEditing(false);
      reload();
    } catch (e) {
      setSaveError(e);
    }
  }

  return (
    <Card testId="portal-forwarding" className="flex flex-col p-4">
      <p className="font-medium text-ink">Forward invoices by email</p>
      {loading && !data ? <Loading /> : null}
      {error ? <ErrorNotice error={error} onRetry={reload} /> : null}
      {f && !f.available ? (
        <p className="mt-1 text-sm text-ink-muted">
          Forwarding isn't switched on yet. Your private address will appear here.
        </p>
      ) : null}
      {f?.available && f.address ? (
        <>
          <p className="mt-1 text-sm text-ink-muted">
            Add a forwarding rule in your email (for example from your accounts payable inbox) to
            this private address. We keep the attachments, never the message text.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <code
              data-testid="portal-forwarding-address"
              className="min-w-0 flex-1 truncate rounded-sm border border-line bg-surface-subtle px-2 py-1.5 text-sm text-ink"
            >
              {f.address}
            </code>
            <Button
              size="sm"
              data-testid="portal-forwarding-copy"
              onClick={() => {
                void navigator.clipboard?.writeText(f.address ?? "").then(() => setCopied(true));
              }}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="mt-3 text-sm text-ink-muted figures">
            {f.accepted} received · {f.dropped} not accepted
            {f.lastDropReason && f.lastDroppedAt
              ? ` (last ${shortTime(f.lastDroppedAt)}: ${DROP_REASON[f.lastDropReason] ?? f.lastDropReason})`
              : ""}
          </p>
        </>
      ) : null}
      {f?.available ? (
        <div className="mt-4">
          <p className="text-sm font-medium text-ink">Who may forward</p>
          {f.allowedSenders.length === 0 && !editing ? (
            <p className="mt-1 flex items-center gap-2 text-sm text-ink-muted">
              <Badge tone="warning">Waiting on you</Badge>
              {isAdmin
                ? "Add the addresses or domains that forward to you. Mail from anyone else is not accepted."
                : "Your admin adds who may forward. Until then, nothing is accepted."}
            </p>
          ) : null}
          {!editing && f.allowedSenders.length > 0 ? (
            <div data-testid="portal-forwarding-senders" className="mt-2 flex flex-wrap gap-1.5">
              {f.allowedSenders.map((s) => (
                <Tag key={s}>{s}</Tag>
              ))}
            </div>
          ) : null}
          {editing ? (
            <div className="mt-2">
              <TextArea
                data-testid="portal-forwarding-senders-input"
                rows={4}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={"ap@yourshop.com\nyourvendor.com"}
                aria-label="Addresses or domains, one per line"
              />
              <p className="mt-1 text-sm text-ink-muted">
                One per line. A domain (yourvendor.com) covers everyone at it.
              </p>
              {saveError ? (
                <div className="mt-2">
                  <ErrorNotice error={saveError} />
                </div>
              ) : null}
              <div className="mt-2 flex gap-2">
                <Button
                  data-testid="portal-forwarding-save"
                  variant="primary"
                  onClick={() => void save()}
                >
                  Save
                </Button>
                <Button variant="ghost" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : isAdmin ? (
            <Button
              size="sm"
              className="mt-3"
              data-testid="portal-forwarding-edit"
              onClick={() => {
                setDraft(f.allowedSenders.join("\n"));
                setEditing(true);
              }}
            >
              Edit who may forward
            </Button>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

function RecentDocuments({
  state,
}: {
  state: ReturnType<typeof useApi<typeof apiRoutes.portalDocuments>>;
}) {
  const { data, error, loading, reload } = state;
  return (
    <div>
      <p className="mb-2 text-sm font-medium text-ink">Recent documents</p>
      {loading && !data ? <Loading /> : null}
      {error ? <ErrorNotice error={error} onRetry={reload} /> : null}
      {data && data.documents.length === 0 ? (
        <EmptyState>Nothing yet. Upload or forward an invoice and it shows here.</EmptyState>
      ) : null}
      {data && data.documents.length > 0 ? (
        <div className="dt dt-ana">
          <table data-testid="portal-documents">
            <thead>
              <tr className="dt-cols">
                <th>Document</th>
                <th>Vendor</th>
                <th className="n">Total</th>
                <th>Status</th>
                <th>Received</th>
              </tr>
            </thead>
            <tbody>
              {data.documents.map((d) => {
                const s = documentStatus(d.status);
                return (
                  <tr key={d.id}>
                    <td>
                      <Link
                        to={`/documents/${d.id}`}
                        data-testid={`portal-document-${d.id}-open`}
                        className="font-medium text-ink hover:underline"
                      >
                        {d.invoiceNumber ? `Invoice ${d.invoiceNumber}` : d.filename}
                      </Link>
                      <span className="block text-sm text-ink-muted">
                        {SOURCE_LABEL[d.source] ?? d.source}
                      </span>
                    </td>
                    <td className="text-ink">{d.vendorName ?? "–"}</td>
                    <td className="n text-ink figures">{money(d.total)}</td>
                    <td>
                      <Badge tone={s.tone}>{s.label}</Badge>
                    </td>
                    <td className="text-ink figures">{shortTime(d.receivedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
