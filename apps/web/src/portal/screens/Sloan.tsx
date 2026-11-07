// `/sloan` and `/sloan/:id` (C6, docs/ui-plan.md): conversations with Sloan, the client's account
// agent (ARCHITECTURE §9.8, §11.2; docs/plan.md §1.38, §1.47). Each conversation is an account
// thread; a message starting with `/name` asks one of the client's agents. Changes Sloan drafts wait
// on the client admin's signature here and on the Desk; signing applies them through the portal's
// own code (`/api/account-changes/:id/resolve`). Sloan sees only what the portal shows and never
// loosens a rule (invariant 11): this page shows what the thread routes return and nothing else.
import type { PortalMessage, PortalThread } from "@countersign/core";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import type { PlainKey } from "../../i18n/catalog";
import { useI18n } from "../../i18n/i18n";
import { InboxCard, isAccountChangeItem } from "../../inbox/InboxCard";
import { SourceLinks } from "../../records/SourceLinks";
import { usePoll } from "../../runs/usePoll";
import { useSession } from "../../session/session";
import { ActivityRow } from "../../ui/activity";
import { AgentBadge, PersonBadge } from "../../ui/badges";
import { Select, TextArea } from "../../ui/forms";
import { Icon } from "../../ui/icons";
import { Page, PageGrid, Section } from "../../ui/page";
import { Button, Card, ErrorNotice, Loading, PageHeader } from "../../ui/primitives";
import { StatusChip } from "../../ui/status";
import { useRefreshInboxCount } from "../inboxCount";
import { PORTAL_PATHS } from "../paths";
import { agentChip } from "../status";

/** How often an open conversation looks for Sloan's answer while it waits for one. */
const ANSWER_POLL_MS = 3_000;

/** What Sloan does and doesn't do, in the portal's words (ARCHITECTURE §9.8). */
const CAN: [PlainKey, boolean][] = [
  ["sloan.can.see", true],
  ["sloan.can.pause", true],
  ["sloan.can.draft", true],
  ["sloan.can.pass", true],
  ["sloan.can.never", false],
];

/** Questions to start from; each fills the box, nothing is sent until you send it. */
const STARTERS: PlainKey[] = [
  "sloan.starter.today",
  "sloan.starter.waiting",
  "sloan.starter.newAgent",
];

function newest(threads: readonly PortalThread[]): PortalThread | null {
  const at = (x: PortalThread) => Date.parse(x.lastMessageAt ?? x.createdAt);
  return [...threads].sort((a, b) => at(b) - at(a))[0] ?? null;
}

export function PortalSloanScreen() {
  const { t, fmt } = useI18n();
  const { id } = useParams();
  const navigate = useNavigate();
  const api = useApiClient();
  const threads = useApi(apiRoutes.portalThreads, { query: { subject: "account" } });
  const list = threads.data?.threads ?? [];
  const current = id ?? newest(list)?.id ?? null;
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function start(): Promise<string | null> {
    setStarting(true);
    setError(null);
    try {
      const { thread } = await api.call(apiRoutes.portalStartThread, {
        body: { subject: "account" },
      });
      threads.reload();
      return thread.id;
    } catch (e) {
      setError(e);
      return null;
    } finally {
      setStarting(false);
    }
  }

  return (
    <Page testId="portal-sloan">
      <PageHeader
        leading={<AgentBadge name="Sloan" size="lg" />}
        title={t("sloan.title")}
        subtitle={t("sloan.subtitle")}
        actions={
          <>
            {list.length > 1 ? (
              <Select
                aria-label={t("sloan.past")}
                data-testid="portal-sloan-past"
                className="w-auto"
                value={current ?? ""}
                onChange={(e) => navigate(`${PORTAL_PATHS.sloan}/${e.target.value}`)}
              >
                {[...list]
                  .sort(
                    (a, b) =>
                      Date.parse(b.lastMessageAt ?? b.createdAt) -
                      Date.parse(a.lastMessageAt ?? a.createdAt),
                  )
                  .map((th) => (
                    <option key={th.id} value={th.id}>
                      {t("sloan.pastItem", { date: fmt.date(th.createdAt) })}
                    </option>
                  ))}
              </Select>
            ) : null}
            <Button
              disabled={starting}
              data-testid="portal-sloan-new"
              onClick={() =>
                void start().then((tid) => {
                  if (tid) navigate(`${PORTAL_PATHS.sloan}/${tid}`);
                })
              }
            >
              {t("sloan.new")}
            </Button>
          </>
        }
      />
      {error ? <ErrorNotice error={error} /> : null}
      {threads.error ? <ErrorNotice error={threads.error} onRetry={threads.reload} /> : null}
      <PageGrid rail={<SloanRail />}>
        {threads.loading && !threads.data ? (
          <Loading />
        ) : (
          <Conversation
            key={current ?? "new"}
            threadId={current}
            start={start}
            onStarted={(tid) => navigate(`${PORTAL_PATHS.sloan}/${tid}`, { replace: true })}
          />
        )}
      </PageGrid>
    </Page>
  );
}

function Conversation({
  threadId,
  start,
  onStarted,
}: {
  threadId: string | null;
  start: () => Promise<string | null>;
  onStarted: (id: string) => void;
}) {
  const { t } = useI18n();
  const api = useApiClient();
  const [params] = useSearchParams();
  const [text, setText] = useState(() => params.get("ask") ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const messages = useApi(
    apiRoutes.portalThreadMessages,
    threadId ? { params: { id: threadId }, query: {} } : null,
  );
  const list = messages.data?.messages ?? [];
  const last = list[list.length - 1];
  const waitingForAnswer = !!last && last.sender.you;
  usePoll(messages.reload, waitingForAnswer, ANSWER_POLL_MS, messages.loading);

  // Opening a conversation reads it up to now.
  const marked = useRef<string | null>(null);
  useEffect(() => {
    if (!threadId || !messages.data || marked.current === threadId) return;
    marked.current = threadId;
    api.call(apiRoutes.portalReadThread, { params: { id: threadId } }).catch(() => {});
  }, [api, threadId, messages.data]);

  async function send(e?: FormEvent) {
    e?.preventDefault();
    const body = text.trim();
    if (!body) return;
    setBusy(true);
    setError(null);
    try {
      const id = threadId ?? (await start());
      if (!id) return;
      await api.call(apiRoutes.portalPostMessage, { params: { id }, body: { text: body } });
      setText("");
      if (threadId) messages.reload();
      else onStarted(id);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card testId="portal-sloan-conversation">
      <div className="ui-card__body flex flex-col gap-6">
        {messages.error ? <ErrorNotice error={messages.error} onRetry={messages.reload} /> : null}
        {threadId && messages.loading && !messages.data ? <Loading /> : null}
        {list.length === 0 && !messages.loading ? (
          <p className="text-ink-muted" data-testid="portal-sloan-empty">
            {t("sloan.empty")}
          </p>
        ) : null}
        {list.length > 0 ? (
          <ol className="ui-thread" data-testid="portal-sloan-messages">
            {list.map((m) => (
              <Message key={m.id} message={m} />
            ))}
          </ol>
        ) : null}
        {waitingForAnswer ? (
          <p role="status" className="text-sm text-ink-muted" data-testid="portal-sloan-thinking">
            {t("sloan.answering")}
          </p>
        ) : null}
      </div>
      <form onSubmit={(e) => void send(e)} className="ui-card__foot ui-composer">
        <div className="flex flex-wrap gap-1.5">
          {STARTERS.map((k) => (
            <button
              key={k}
              type="button"
              className="ds-tag hover:border-line-strong"
              onClick={() => setText(t(k))}
            >
              {t(k)}
            </button>
          ))}
        </div>
        <div className="ui-composer__row">
          <TextArea
            aria-label={t("sloan.compose")}
            data-testid="portal-sloan-input"
            rows={2}
            maxLength={4000}
            value={text}
            placeholder={t("sloan.compose")}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            className="flex-1"
          />
          <Button
            type="submit"
            variant="primary"
            disabled={busy || !text.trim()}
            data-testid="portal-sloan-send"
          >
            {busy ? t("common.sending") : t("common.send")}
          </Button>
        </div>
        <p className="text-sm text-ink-muted">{t("sloan.commandHint")}</p>
        {error ? <ErrorNotice error={error} /> : null}
      </form>
    </Card>
  );
}

function Message({ message: m }: { message: PortalMessage }) {
  const { t, fmt } = useI18n();
  const you = m.sender.you;
  const name = m.sender.name ?? (m.sender.type === "agent" ? t("sloan.title") : t("sloan.mezonas"));
  const badge = you ? null : m.sender.lead ? (
    <PersonBadge name={name} size="sm" />
  ) : m.sender.type === "agent" ? (
    <AgentBadge name={name} size="sm" />
  ) : (
    <PersonBadge name={name} size="sm" plain />
  );
  return (
    <li
      className={you ? "ui-msg ui-msg--you" : "ui-msg"}
      data-testid={`portal-sloan-message-${m.id}`}
    >
      {badge}
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-xs text-ink-muted">
          {[you ? t("sloan.you") : name, fmt.time(m.createdAt)].join(" · ")}
        </p>
        <p className={m.kind === "command" ? "ui-msg__text font-mono" : "ui-msg__text"}>{m.text}</p>
        <SourceLinks ids={m.sources} href={(id) => `/records/${id}`} />
      </div>
    </li>
  );
}

/** Changes Sloan drafted waiting on a signature, your team now, what Sloan can do, your lead. */
function SloanRail() {
  const { t } = useI18n();
  const api = useApiClient();
  const session = useSession();
  const refreshCount = useRefreshInboxCount();
  const role = session.tenants.find((x) => x.id === session.activeTenantId)?.role;
  const isAdmin = role === "client_admin";
  const inbox = useApi(apiRoutes.portalInbox, { query: { status: "open" } });
  const overview = useApi(apiRoutes.portalOverview);
  const changes = (inbox.data?.items ?? []).filter(isAccountChangeItem);

  return (
    <>
      {changes.length > 0 ? (
        <Section title={t("sloan.changes")} testId="portal-sloan-changes">
          {changes.map((item) => (
            <InboxCard
              key={item.id}
              item={item}
              runHref={item.runId ? `${PORTAL_PATHS.runs}/${item.runId}` : null}
              recordHref={(id) => `/records/${id}`}
              waitingOn={isAdmin ? null : t("sloan.adminSigns")}
              onResolve={
                isAdmin
                  ? async (body) => {
                      await api.call(apiRoutes.portalResolveAccountChange, {
                        params: { id: item.id },
                        body: {
                          decision: body.decision ?? "approve",
                          ...(body.note ? { note: body.note } : {}),
                        },
                      });
                      inbox.reload();
                      refreshCount();
                    }
                  : null
              }
            />
          ))}
        </Section>
      ) : null}

      <Section
        title={t("sloan.canTitle")}
        action={
          // UI-3a: what Sloan passes to us lands on Requests, with our answers.
          <Link
            to={PORTAL_PATHS.requests}
            className="text-sm text-link hover:underline"
            data-testid="portal-sloan-requests"
          >
            {t("sloan.requests")}
          </Link>
        }
      >
        <Card testId="portal-sloan-can">
          {CAN.map(([k, yes]) => (
            <ActivityRow
              key={k}
              badge={<Icon name={yes ? "check" : "close"} className="text-ink-muted" />}
            >
              <span className={yes ? "text-sm" : "text-sm text-ink-muted"}>{t(k)}</span>
            </ActivityRow>
          ))}
        </Card>
      </Section>

      {overview.data && overview.data.services.length > 0 ? (
        <Section title={t("sloan.team")}>
          <Card testId="portal-sloan-team">
            {overview.data.services.map((s) => (
              <ActivityRow
                key={s.id}
                badge={<AgentBadge name={s.name} size="sm" />}
                to={PORTAL_PATHS.agent(s.id)}
                end={<StatusChip state={agentChip(s, t).state}>{agentChip(s, t).label}</StatusChip>}
              >
                {s.name}
              </ActivityRow>
            ))}
          </Card>
        </Section>
      ) : null}

      {session.lead ? (
        <div className="ui-leadnote" data-testid="portal-sloan-lead">
          <PersonBadge name={session.lead.name} line={t("nav.lead")} size="sm" />
          <p className="text-sm">{t("sloan.leadNote", { name: session.lead.name })}</p>
        </div>
      ) : null}
    </>
  );
}
