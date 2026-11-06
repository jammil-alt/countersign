// v0.14 capture: a client's WhatsApp conversations and what each keeps (ARCHITECTURE §6.12, plan
// §1.55), on the portal's /conversations (client admin) and the back office's messaging page. Two
// switches per conversation: keep messages, download attachments. "Download now" fetches one
// message's attachments when the setting allows. Minimal until the owner's redesign. Words in the
// reader's language (English in the back office); what people wrote is shown as text, never
// translated or obeyed.
import {
  CAPTURE_ATTACHMENTS,
  type CaptureAttachments,
  type ConversationMessageView,
  type PortalConversationView,
} from "@countersign/core";
import { useState } from "react";
import { isApiError } from "../api/client";
import { apiRoutes } from "../api/routes";
import { useApi, useApiClient } from "../api/useApi";
import type { PlainKey } from "../i18n/catalog";
import { errorText } from "../i18n/errors";
import { useI18n } from "../i18n/i18n";
import { Field, Select } from "../ui/forms";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Loading,
  SectionLabel,
  type Tone,
} from "../ui/primitives";

export type ConversationsSurface = { kind: "ops"; clientId: string } | { kind: "portal" };

const ATTACHMENTS_KEY: Record<CaptureAttachments, PlainKey> = {
  off: "conversations.attachments.off",
  documents: "conversations.attachments.documents",
  all: "conversations.attachments.all",
};

const STATUS: Record<
  ConversationMessageView["attachments"][number]["status"],
  { key: PlainKey; tone: Tone }
> = {
  not_downloaded: { key: "conversations.attachment.not_downloaded", tone: "neutral" },
  pending: { key: "conversations.attachment.pending", tone: "accent" },
  filed: { key: "conversations.attachment.filed", tone: "positive" },
  refused: { key: "conversations.attachment.refused", tone: "neutral" },
  failed: { key: "conversations.attachment.failed", tone: "risk" },
};

type Row = Pick<PortalConversationView, "id" | "title" | "capture" | "updatedAt" | "lastMessageAt">;

export function ConversationsPanel({ surface }: { surface: ConversationsSurface }) {
  const i18n = useI18n();
  const { t } = i18n;
  const api = useApiClient();
  const ops = surface.kind === "ops" ? surface.clientId : null;
  const opsList = useApi(apiRoutes.opsConversations, ops ? { params: { id: ops } } : null);
  const portalList = useApi(apiRoutes.portalConversations, ops ? null : {});
  const list = ops ? opsList : portalList;
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  async function change(row: Row, next: { archive?: boolean; attachments?: CaptureAttachments }) {
    setError(null);
    try {
      if (ops) {
        const full = opsList.data?.items.find((c) => c.id === row.id);
        if (!full) return;
        await api.call(apiRoutes.opsSetCapture, {
          params: { id: ops, conversationId: row.id },
          body: { capture: { ...full.capture, ...next }, updatedAt: row.updatedAt },
        });
      } else {
        await api.call(apiRoutes.portalSetCapture, {
          params: { id: row.id },
          body: { ...next, updatedAt: row.updatedAt },
        });
      }
      list.reload();
    } catch (e) {
      setError(isApiError(e) ? errorText(e, i18n) : t("conversations.failed"));
    }
  }

  const items: Row[] = list.data?.items ?? [];
  return (
    <section data-testid="conversations">
      <SectionLabel>{t("conversations.title")}</SectionLabel>
      {list.loading && !list.data ? <Loading /> : null}
      {list.error ? <ErrorNotice error={list.error} onRetry={list.reload} /> : null}
      {error ? (
        <p className="ds-error mb-2 text-sm" role="alert">
          {error}
        </p>
      ) : null}
      {list.data && items.length === 0 ? <EmptyState>{t("conversations.empty")}</EmptyState> : null}
      <div className="space-y-2">
        {items.map((c) => (
          <Card key={c.id} className="p-3" testId={`conversation-${c.id}`}>
            <div className="flex flex-wrap items-end gap-4">
              <div className="min-w-48 grow">
                <div className="font-medium text-ink">{c.title}</div>
                <div className="text-sm text-ink-muted">
                  {c.lastMessageAt
                    ? t("conversations.lastMessage", { when: i18n.fmt.time(c.lastMessageAt) })
                    : t("conversations.noMessages")}
                </div>
              </div>
              <Field label={t("conversations.keepMessages")} className="w-40">
                <Select
                  value={c.capture.archive ? "yes" : "no"}
                  onChange={(e) => change(c, { archive: e.target.value === "yes" })}
                  data-testid={`conversation-${c.id}-archive`}
                >
                  <option value="yes">{t("conversations.yes")}</option>
                  <option value="no">{t("conversations.no")}</option>
                </Select>
              </Field>
              <Field label={t("conversations.attachments")} className="w-48">
                <Select
                  value={c.capture.attachments}
                  onChange={(e) => change(c, { attachments: e.target.value as CaptureAttachments })}
                  data-testid={`conversation-${c.id}-attachments`}
                >
                  {CAPTURE_ATTACHMENTS.map((a) => (
                    <option key={a} value={a}>
                      {t(ATTACHMENTS_KEY[a])}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setOpen(open === c.id ? null : c.id)}
              >
                {open === c.id ? t("conversations.hideMessages") : t("conversations.showMessages")}
              </Button>
            </div>
            {open === c.id ? <Messages surface={surface} conversationId={c.id} /> : null}
          </Card>
        ))}
      </div>
    </section>
  );
}

function Messages({
  surface,
  conversationId,
}: {
  surface: ConversationsSurface;
  conversationId: string;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const api = useApiClient();
  const ops = surface.kind === "ops" ? surface.clientId : null;
  const opsMessages = useApi(
    apiRoutes.opsConversationMessages,
    ops ? { params: { id: ops, conversationId } } : null,
  );
  const portalMessages = useApi(
    apiRoutes.portalConversationMessages,
    ops ? null : { params: { id: conversationId } },
  );
  const messages = ops ? opsMessages : portalMessages;
  const [note, setNote] = useState<string | null>(null);

  async function downloadNow(rawRecordId: string) {
    setNote(null);
    try {
      const r = ops
        ? await api.call(apiRoutes.opsDownloadNow, {
            params: { id: ops, conversationId, rawRecordId },
          })
        : await api.call(apiRoutes.portalDownloadNow, {
            params: { id: conversationId, rawRecordId },
          });
      setNote(t("conversations.downloading", { count: r.started.length }));
      messages.reload();
    } catch (e) {
      setNote(isApiError(e) ? errorText(e, i18n) : t("conversations.failed"));
    }
  }

  return (
    <div className="mt-3 border-t border-line pt-3">
      {messages.loading && !messages.data ? <Loading /> : null}
      {messages.error ? <ErrorNotice error={messages.error} onRetry={messages.reload} /> : null}
      {note ? <p className="mb-2 text-sm text-ink-muted">{note}</p> : null}
      {messages.data && messages.data.items.length === 0 ? (
        <EmptyState>{t("conversations.noMessages")}</EmptyState>
      ) : null}
      <ul className="space-y-2">
        {messages.data?.items.map((m) => (
          <li key={m.rawRecordId} className="text-sm">
            <div className="text-ink-muted">{i18n.fmt.time(m.at)}</div>
            <div className="whitespace-pre-wrap text-ink">
              {m.text === null ? (
                <span className="text-ink-muted">{t("conversations.notKept")}</span>
              ) : (
                m.text
              )}
            </div>
            {m.attachments.length > 0 ? (
              <div className="mt-1 flex flex-wrap items-center gap-2">
                {m.attachments.map((a) => (
                  <Badge key={a.index} tone={STATUS[a.status].tone}>
                    {t(STATUS[a.status].key)}
                  </Badge>
                ))}
                {m.attachments.some((a) => a.status !== "filed") ? (
                  <Button size="sm" onClick={() => downloadNow(m.rawRecordId)}>
                    {t("conversations.downloadNow")}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
