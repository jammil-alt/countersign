// Upload and forwarding (ARCHITECTURE §6.3, §6.5), built in on every client's Accounts page and on
// `/upload` (UploadPage.tsx): drop invoices, receipts or a purchases CSV; see the private forwarding
// address and who may forward to it (the client admin edits the list); and the documents that
// arrived.
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { type UploadResponse, uploadFiles } from "../../api/upload";
import { useApi, useApiClient } from "../../api/useApi";
import { type I18n, useI18n } from "../../i18n/i18n";
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
import { documentStatus, dropReason, money, sourceLabel } from "../documents";

type Result = UploadResponse["results"][number];
type Shown = Result & { key: string };

export function UploadSection({ isAdmin }: { isAdmin: boolean }) {
  const { t } = useI18n();
  const documents = useApi(apiRoutes.portalDocuments, { query: { limit: 20 } });
  return (
    <section data-testid="portal-upload">
      <SectionLabel>{t("upload.section")}</SectionLabel>
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

function resultLine(
  r: Result,
  i18n: Pick<I18n, "t" | "locale" | "fmt">,
): { text: string; tone: "positive" | "neutral" | "risk" } {
  const { t, locale } = i18n;
  // The server's reason is English: other languages show their own word for a refusal.
  if (r.kind === "refused") {
    return {
      text: r.error && locale === "en" ? r.error : t("upload.refused"),
      tone: "risk",
    };
  }
  if (r.kind === "purchases" && r.purchases) {
    const p = r.purchases;
    const parts = [t("upload.purchasesAdded", { count: p.created })];
    if (p.duplicates > 0) parts.push(t("upload.alreadyHere", { count: p.duplicates }));
    if (p.errors.length > 0) parts.push(t("upload.rowsSkipped", { count: p.errors.length }));
    return { text: parts.join(" · "), tone: p.errors.length > 0 ? "neutral" : "positive" };
  }
  if (r.created) return { text: t("upload.received"), tone: "positive" };
  // The same bytes are one document: the first one comes back, with when it arrived.
  return {
    text: r.document
      ? t("upload.sameFile", { time: shortTime(r.document.receivedAt, undefined, i18n) })
      : t("upload.duplicate"),
    tone: "neutral",
  };
}

/**
 * Drop or choose files. The portal's by default; the back office's Sandbox documents page passes
 * its own upload, links and test ids.
 */
export function DropZone({
  onUploaded,
  upload = uploadFiles,
  documentHref = (id) => `/documents/${id}`,
  testId = "portal-upload",
}: {
  onUploaded: () => void;
  upload?: (files: File[]) => Promise<UploadResponse>;
  documentHref?: (documentId: string) => string;
  testId?: string;
}) {
  const i18n = useI18n();
  const { t } = i18n;
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
      const res = await upload(files);
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
    <Card title={t("upload.title")} pad>
      <p className="mt-1 text-sm text-ink-muted">{t("upload.help")}</p>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the drop target; the button inside is the keyboard path. */}
      <div
        data-testid={`${testId}-drop`}
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
        <p className="text-sm text-ink">{t("upload.drop")}</p>
        <Button
          data-testid={`${testId}-choose`}
          disabled={busy}
          onClick={() => input.current?.click()}
        >
          {busy ? t("upload.uploading") : t("upload.choose")}
        </Button>
        <input
          ref={input}
          data-testid={`${testId}-input`}
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
        <ul data-testid={`${testId}-results`} className="mt-3 flex flex-col gap-1.5 text-sm">
          {results.map((r) => {
            const line = resultLine(r, i18n);
            return (
              <li key={r.key} className="flex items-start justify-between gap-3">
                <span className="min-w-0 truncate text-ink">
                  {r.document ? (
                    <Link to={documentHref(r.document.id)} className="hover:underline">
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

export function Forwarding({ isAdmin }: { isAdmin: boolean }) {
  const api = useApiClient();
  const i18n = useI18n();
  const { t } = i18n;
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
    <Card testId="portal-forwarding" title={t("forwarding.title")} pad>
      {loading && !data ? <Loading /> : null}
      {error ? <ErrorNotice error={error} onRetry={reload} /> : null}
      {f && !f.available ? (
        <p className="mt-1 text-sm text-ink-muted">{t("forwarding.off")}</p>
      ) : null}
      {f?.available && f.address ? (
        <>
          <p className="mt-1 text-sm text-ink-muted">{t("forwarding.help")}</p>
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
              {copied ? t("common.copied") : t("common.copy")}
            </Button>
          </div>
          <p className="mt-3 text-sm text-ink-muted figures">
            {t("forwarding.received", { count: f.accepted })} ·{" "}
            {t("forwarding.dropped", { count: f.dropped })}
            {f.lastDropReason && f.lastDroppedAt
              ? ` ${t("forwarding.lastDrop", {
                  time: shortTime(f.lastDroppedAt, undefined, i18n),
                  reason: dropReason(f.lastDropReason, i18n),
                })}`
              : ""}
          </p>
        </>
      ) : null}
      {f?.available ? (
        <div className="mt-4">
          <p className="text-sm font-medium text-ink">{t("forwarding.whoMay")}</p>
          {f.allowedSenders.length === 0 && !editing ? (
            <p className="mt-1 flex items-center gap-2 text-sm text-ink-muted">
              <Badge tone="warning">{t("common.waitingOnYou")}</Badge>
              {isAdmin ? t("forwarding.adminAdd") : t("forwarding.userWait")}
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
                aria-label={t("forwarding.sendersLabel")}
              />
              <p className="mt-1 text-sm text-ink-muted">{t("forwarding.sendersHelp")}</p>
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
                  {t("common.save")}
                </Button>
                <Button variant="ghost" onClick={() => setEditing(false)}>
                  {t("common.cancel")}
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
              {t("forwarding.edit")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

export function RecentDocuments({
  state,
}: {
  state: ReturnType<typeof useApi<typeof apiRoutes.portalDocuments>>;
}) {
  const { data, error, loading, reload } = state;
  const i18n = useI18n();
  const { t } = i18n;
  return (
    <Card title={t("documents.recent")} testId="portal-recent-documents">
      {loading && !data ? (
        <div className="ui-card__body">
          <Loading />
        </div>
      ) : null}
      {error ? (
        <div className="ui-card__body">
          <ErrorNotice error={error} onRetry={reload} />
        </div>
      ) : null}
      {data && data.documents.length === 0 ? (
        <div className="ui-card__body">
          <EmptyState>{t("documents.empty")}</EmptyState>
        </div>
      ) : null}
      {data && data.documents.length > 0 ? (
        <div className="dt dt-ana overflow-x-auto">
          <table data-testid="portal-documents">
            <thead>
              <tr className="dt-cols">
                <th>{t("documents.col.document")}</th>
                <th>{t("documents.col.vendor")}</th>
                <th className="n">{t("documents.col.total")}</th>
                <th>{t("documents.col.status")}</th>
                <th>{t("documents.col.received")}</th>
              </tr>
            </thead>
            <tbody>
              {data.documents.map((d) => {
                const s = documentStatus(d.status, i18n);
                return (
                  <tr key={d.id}>
                    <td>
                      <Link
                        to={`/documents/${d.id}`}
                        data-testid={`portal-document-${d.id}-open`}
                        className="font-medium text-ink hover:underline"
                      >
                        {d.invoiceNumber
                          ? t("documents.invoiceNumber", { number: d.invoiceNumber })
                          : d.filename}
                      </Link>
                      <span className="block text-sm text-ink-muted">
                        {sourceLabel(d.source, i18n)}
                      </span>
                      {d.sameInvoiceAs ? (
                        <Link
                          to={`/documents/${d.sameInvoiceAs.id}`}
                          data-testid={`portal-document-${d.id}-same`}
                          className="block text-sm text-link hover:underline"
                        >
                          {t("documents.sameInvoice", {
                            time: shortTime(d.sameInvoiceAs.receivedAt, undefined, i18n),
                          })}
                        </Link>
                      ) : null}
                    </td>
                    <td className="text-ink">{d.vendorName ?? "–"}</td>
                    <td className="n text-ink figures">{money(d.total, "USD", i18n)}</td>
                    <td>
                      <Badge tone={s.tone}>{s.label}</Badge>
                    </td>
                    <td className="text-ink figures">{shortTime(d.receivedAt, undefined, i18n)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </Card>
  );
}
