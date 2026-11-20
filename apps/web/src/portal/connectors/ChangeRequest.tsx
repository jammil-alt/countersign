// Connectors C5 (docs/connectors-plan.md §7.1, §7.2): a change Mezonas asks to make to a connection,
// and a change we made at once. The request shows what changes, row by row (before → after), why,
// who asked and for which agent; a client admin approves or declines it, with a note back if they
// like. Approving one the connection has changed since is refused (Out of date): nothing changes,
// and the lead sends a new one. A client user reads it. The same card is on the connector's page
// and in the Inbox.
import {
  type ChangeRequestView,
  type ConnectionNoticeInboxPayload,
  type ConnectionRequestInboxPayload,
  type ConnectionRowChange,
  connectorAccessRoutes,
  ConnectionNoticeInboxPayload as NoticePayload,
  ConnectionRequestInboxPayload as RequestPayload,
} from "@countersign/core";
import { useState } from "react";
import { Link } from "react-router-dom";
import { isApiError } from "../../api/client";
import { useApi, useApiClient } from "../../api/useApi";
import type { PlainKey } from "../../i18n/catalog";
import { useI18n } from "../../i18n/i18n";
import { Field, TextArea } from "../../ui/forms";
import { Badge, Button, ErrorNotice, type Tone } from "../../ui/primitives";
import { PORTAL_PATHS } from "../paths";
import { levelKey } from "./words";

/** A change request's inbox payload, when the item is one (else null). */
export function connectionRequestOf(item: {
  kind: string;
  payload: Record<string, unknown>;
}): ConnectionRequestInboxPayload | null {
  if (item.kind !== "approval" || typeof item.payload.requestId !== "string") return null;
  const parsed = RequestPayload.safeParse(item.payload);
  return parsed.success ? parsed.data : null;
}

/** A notice of a change we made at once, when the item is one (else null). */
export function connectionNoticeOf(item: {
  kind: string;
  payload: Record<string, unknown>;
}): ConnectionNoticeInboxPayload | null {
  if (item.kind !== "review" || typeof item.payload.because !== "string") return null;
  const parsed = NoticePayload.safeParse(item.payload);
  return parsed.success ? parsed.data : null;
}

/**
 * One row of a change: its name, then from → to in the reader's words for a level; the API's own
 * words for a scope or the tool's setup.
 */
export function RowChangeLine({ row }: { row: ConnectionRowChange }) {
  const { t } = useI18n();
  if (row.kind === "level") {
    const cut = row.label.lastIndexOf(": ");
    const name = cut > 0 ? row.label.slice(0, cut) : row.label;
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
        <span className="min-w-0 flex-1 text-ink">{name}</span>
        <span className="text-sm text-ink-muted">{t(levelKey(row.verb, row.from))}</span>
        <span aria-hidden className="text-sm text-ink-muted">
          →
        </span>
        <span className="sr-only">{t("connectors.request.to")}</span>
        <strong className="text-sm font-medium text-ink">{t(levelKey(row.verb, row.to))}</strong>
      </div>
    );
  }
  return <div className="px-4 py-2.5 text-ink">{row.label}</div>;
}

export function RowChanges({ rows, testId }: { rows: ConnectionRowChange[]; testId?: string }) {
  return (
    <div
      className="divide-y divide-line overflow-hidden rounded-md border border-line bg-surface"
      data-testid={testId}
    >
      {rows.map((r, i) => (
        // Rows of one change have no id of their own; their order is the API's.
        // biome-ignore lint/suspicious/noArrayIndexKey: a change's rows are fixed once made.
        <RowChangeLine key={i} row={r} />
      ))}
    </div>
  );
}

const STATE: Record<ChangeRequestView["status"], { key: PlainKey; tone: Tone }> = {
  open: { key: "common.waitingOnYou", tone: "warning" },
  approved: { key: "connectors.request.approved", tone: "positive" },
  declined: { key: "connectors.request.declined", tone: "neutral" },
  replaced: { key: "connectors.request.replaced", tone: "neutral" },
  expired: { key: "connectors.request.expired", tone: "neutral" },
  withdrawn: { key: "connectors.request.withdrawn", tone: "neutral" },
};

/** What the card needs of a request: the view, or an inbox payload with what is known of it. */
export type RequestLike = Pick<
  ChangeRequestView,
  | "id"
  | "connector"
  | "connectorName"
  | "rows"
  | "reason"
  | "requestedBy"
  | "forAgent"
  | "expiresAt"
> &
  Partial<
    Pick<ChangeRequestView, "status" | "outOfDate" | "createdAt" | "closedBy" | "answerNote">
  >;

/**
 * A change request: the rows before → after, why, who asked and for which agent, and Approve /
 * Decline (a client admin), with an optional note back.
 */
export function ChangeRequestCard({
  request,
  mayAnswer,
  onAnswered,
  showConnector = false,
  gone = false,
  testId = "change-request",
}: {
  request: RequestLike;
  /** No longer open, in a state the screen doesn't know (an Inbox item already answered). */
  gone?: boolean;
  /** A client admin: the API answers only theirs. */
  mayAnswer: boolean;
  /** After an answer (or a refusal that says it changed): the page reloads. */
  onAnswered?: () => void;
  /** In the Inbox: a link to the connector's page. */
  showConnector?: boolean;
  testId?: string;
}) {
  const { t, fmt } = useI18n();
  const api = useApiClient();
  const [answered, setAnswered] = useState<ChangeRequestView | null>(null);
  const [outOfDate, setOutOfDate] = useState(false);
  const [closed, setClosed] = useState(false);
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"approve" | "decline" | null>(null);
  const [error, setError] = useState<unknown>(null);

  const status = answered?.status ?? request.status ?? "open";
  const stale = !answered && (outOfDate || request.outOfDate === true);
  const open = status === "open" && !closed && !gone;

  async function answer(how: "approve" | "decline") {
    setBusy(how);
    setError(null);
    const body = note.trim() ? { note: note.trim() } : {};
    try {
      const res =
        how === "approve"
          ? await api.call(connectorAccessRoutes.portalApproveConnectionRequest, {
              params: { id: request.id },
              body,
            })
          : await api.call(connectorAccessRoutes.portalDeclineConnectionRequest, {
              params: { id: request.id },
              body,
            });
      setAnswered(res.request);
      onAnswered?.();
    } catch (e) {
      if (isApiError(e) && e.status === 409 && e.code === "out_of_date") {
        setOutOfDate(true);
        onAnswered?.();
      } else if (isApiError(e) && e.status === 409 && e.code === "closed") {
        setClosed(true);
        onAnswered?.();
      } else {
        setError(e);
      }
    } finally {
      setBusy(null);
    }
  }

  const state: { key: PlainKey; tone: Tone } =
    stale && open
      ? { key: "connectors.request.outOfDate", tone: "risk" }
      : gone && !answered
        ? { key: "connectors.request.answered", tone: "neutral" }
        : STATE[status];
  const asker = request.requestedBy.name ?? t("connectors.mezonas");
  return (
    <article
      className="flex flex-col gap-4 rounded-md border border-line bg-surface p-5 max-sm:p-4"
      data-testid={testId}
      data-state={stale && open ? "out_of_date" : gone && !answered ? "answered" : status}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="type-subheading text-ink">
            {t("connectors.request.title", { tool: request.connectorName })}
          </h3>
          <p className="text-sm text-ink-muted">
            {request.forAgent ? (
              <>{t("connectors.request.forAgent", { agent: request.forAgent.name })} · </>
            ) : null}
            <span className="text-copper-ink">
              {t("connectors.request.askedBy", { name: asker })}
            </span>
            {request.createdAt ? <> · {fmt.time(request.createdAt)}</> : null}
          </p>
        </div>
        <Badge tone={state.tone} testId={`${testId}-state`}>
          {t(state.key)}
        </Badge>
      </div>

      <RowChanges rows={request.rows} testId={`${testId}-rows`} />

      <div>
        <p className="eyebrow text-ink-muted">{t("connectors.request.why")}</p>
        <p className="whitespace-pre-line text-ink" data-testid={`${testId}-reason`}>
          {request.reason}
        </p>
      </div>

      {showConnector ? (
        <Link
          className="self-start text-sm text-link hover:underline"
          to={PORTAL_PATHS.connector(request.connector, request.forAgent?.id)}
        >
          {t("connectors.request.openPage", { tool: request.connectorName })}
        </Link>
      ) : null}

      {error ? <ErrorNotice error={error} /> : null}

      {answered ? (
        <p className="text-sm text-ink-muted" data-testid={`${testId}-answered`}>
          {answered.status === "approved"
            ? t("connectors.request.approvedNow", { tool: request.connectorName })
            : t("connectors.request.declinedNow")}
        </p>
      ) : closed ? (
        <p className="text-sm text-ink-muted" data-testid={`${testId}-closed`}>
          {t("connectors.request.closed")}
        </p>
      ) : !open ? (
        <p className="text-sm text-ink-muted" data-testid={`${testId}-answered`}>
          {request.closedBy?.name
            ? t("connectors.request.answeredBy", { name: request.closedBy.name })
            : t(state.key)}
          {request.answerNote ? ` · ${request.answerNote}` : ""}
        </p>
      ) : (
        <>
          {stale ? (
            <p className="text-sm text-risk" data-testid={`${testId}-out-of-date`}>
              {t("connectors.request.outOfDateWords")}
            </p>
          ) : (
            <p className="text-sm text-ink-muted">
              {t("connectors.request.nothingUntil")}{" "}
              {t("connectors.request.ends", { date: fmt.date(request.expiresAt) })}
            </p>
          )}
          {mayAnswer ? (
            <div className="flex flex-col gap-3">
              {noting ? (
                <Field label={t("connectors.request.note")}>
                  <TextArea
                    rows={2}
                    value={note}
                    maxLength={1000}
                    onChange={(e) => setNote(e.target.value)}
                    data-testid={`${testId}-note`}
                  />
                </Field>
              ) : null}
              <div className="flex flex-wrap items-center justify-end gap-2">
                {noting ? null : (
                  <Button
                    variant="link"
                    data-testid={`${testId}-add-note`}
                    onClick={() => setNoting(true)}
                  >
                    {t("connectors.request.addNote")}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  data-testid={`${testId}-decline`}
                  disabled={busy !== null}
                  working={busy === "decline"}
                  onClick={() => void answer("decline")}
                >
                  {t("connectors.request.decline")}
                </Button>
                {stale ? null : (
                  <Button
                    variant="primary"
                    data-testid={`${testId}-approve`}
                    disabled={busy !== null}
                    working={busy === "approve"}
                    onClick={() => void answer("approve")}
                  >
                    {t("connectors.request.approve")}
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <p className="text-sm text-ink-muted" data-testid={`${testId}-admin-only`}>
              {t("connectors.request.adminAnswers")}
            </p>
          )}
        </>
      )}
    </article>
  );
}

/**
 * A change request in the Inbox: the item's payload, with its state as the API holds it now (open
 * requests, each Out of date when it is). One no longer open shows as answered.
 */
// DECISION (C5): an inbox item whose request is no longer open says who answered it (the item's
// resolver) rather than which closed state it ended in: the portal lists open requests only
// (`GET /api/portal/connection-requests`).
export function InboxConnectionRequest({
  itemId,
  payload,
  itemOpen,
  resolvedBy,
  mayAnswer,
  onChanged,
}: {
  itemId: string;
  payload: ConnectionRequestInboxPayload;
  itemOpen: boolean;
  resolvedBy: string | null;
  mayAnswer: boolean;
  onChanged: () => void;
}) {
  const open = useApi(connectorAccessRoutes.portalConnectionRequests, itemOpen ? {} : null);
  const live = open.data?.requests.find((r) => r.id === payload.requestId) ?? null;
  const gone = !itemOpen || (open.data !== undefined && live === null);
  const request: RequestLike = {
    id: payload.requestId,
    connector: payload.connector,
    connectorName: payload.connectorName,
    rows: live?.rows ?? payload.rows,
    reason: payload.reason,
    requestedBy: payload.requestedBy,
    forAgent: payload.forAgent,
    expiresAt: payload.expiresAt,
    ...(live
      ? {
          status: live.status,
          outOfDate: live.outOfDate,
          createdAt: live.createdAt,
          closedBy: live.closedBy,
          answerNote: live.answerNote,
        }
      : { closedBy: resolvedBy ? { id: "", name: resolvedBy } : null }),
  };
  return (
    <ChangeRequestCard
      key={itemId}
      request={request}
      gone={gone}
      mayAnswer={mayAnswer}
      onAnswered={() => {
        open.reload();
        onChanged();
      }}
      showConnector
      testId="inbox-connection-request"
    />
  );
}

/** A change we made at once (only tighter, or under the client's go-ahead): what, why, by whom. */
export function ConnectionNotice({ payload }: { payload: ConnectionNoticeInboxPayload }) {
  const { t, fmt } = useI18n();
  const who = payload.changedBy.name ?? t("connectors.mezonas");
  return (
    <div className="flex flex-col gap-4" data-testid="inbox-connection-notice">
      <p className="text-ink">
        {payload.because === "tightened"
          ? t("connectors.notice.tightened", { name: who, tool: payload.connectorName })
          : t("connectors.notice.authorized", { name: who, tool: payload.connectorName })}
      </p>
      <RowChanges rows={payload.rows} testId="inbox-connection-notice-rows" />
      <div>
        <p className="eyebrow text-ink-muted">{t("connectors.request.why")}</p>
        <p className="whitespace-pre-line text-ink">{payload.reason}</p>
      </div>
      {payload.because === "authorized" && payload.authorization ? (
        <p className="text-sm text-ink-muted" data-testid="inbox-connection-notice-authorization">
          {t(
            payload.authorization.choice === "any"
              ? "connectors.notice.underAny"
              : "connectors.notice.underNeeds",
            { tool: payload.connectorName, date: fmt.date(payload.authorization.setAt) },
          )}
        </p>
      ) : null}
      <Link
        className="self-start text-sm text-link hover:underline"
        to={PORTAL_PATHS.connector(payload.connector)}
      >
        {t("connectors.notice.undo", { tool: payload.connectorName })}
      </Link>
    </div>
  );
}
