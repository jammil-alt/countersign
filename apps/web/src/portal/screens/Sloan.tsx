// `/sloan` and `/sloan/:id` (C6, docs/ui-plan.md): conversations with Sloan, the client's account
// agent (ARCHITECTURE §9.8, §11.2; docs/plan.md §1.38, §1.47). Each conversation is an account
// thread; a message starting with `/name` asks one of the client's agents. Changes Sloan drafts wait
// on the client admin's signature here and on the Desk; signing applies them through the portal's
// own code (`/api/account-changes/:id/resolve`). Sloan sees only what the portal shows and never
// loosens a rule (invariant 11): this page shows what the thread routes return and nothing else.
// Sloan is the one place to ask (QA round 1): "Ask for a change" (`?mode=change`) holds the
// requests to us that had their own page (`/requests` redirects there).
import type { PortalMessage, PortalThread } from "@countersign/core";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { attachToMessage } from "../../api/upload";
import { useApi, useApiClient } from "../../api/useApi";
import { voiceFor } from "../../api/voice";
import type { PlainKey } from "../../i18n/catalog";
import { useI18n } from "../../i18n/i18n";
import { InboxCard, isAccountChangeItem } from "../../inbox/InboxCard";
import { SourceLinks } from "../../records/SourceLinks";
import { useSession } from "../../session/session";
import { ActivityRow } from "../../ui/activity";
import { type AttachedFile, MessageFiles } from "../../ui/attach";
import { AgentBadge, PersonBadge } from "../../ui/badges";
import { AgentSaid, ChatLog, Composer, Thinking, YouSaid } from "../../ui/chat";
import { Select } from "../../ui/forms";
import { Icon } from "../../ui/icons";
import { Page, PageGrid, Section } from "../../ui/page";
import { Button, Card, cx, ErrorNotice, Loading, PageHeader, Tabs } from "../../ui/primitives";
import { Skeleton, SkeletonCard } from "../../ui/skeleton";
import { StatusChip } from "../../ui/status";
import { useRefreshInboxCount } from "../inboxCount";
import { PORTAL_PATHS } from "../paths";
import { type Backoff, useBackoffPoll } from "../poll";
import { agentChip } from "../status";
import { ChangeRequests } from "./Requests";

/** How often an open conversation looks for Sloan's answer while it waits for one. */
// Sloan's answer is asked for every 3 s at first, then less often up to 30 s, and never in a
// hidden tab (docs/audit-plan.md 2.7); a new message starts it again from 3 s.
const ANSWER_POLL: Backoff = { firstMs: 3_000, maxMs: 30_000 };

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
  const [params] = useSearchParams();
  const changeMode = params.get("mode") === "change";
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
          changeMode ? null : (
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
          )
        }
      />
      <div className="overflow-x-auto" data-testid="portal-sloan-modes">
        <Tabs
          items={[
            {
              to: current ? `${PORTAL_PATHS.sloan}/${current}` : PORTAL_PATHS.sloan,
              label: t("table.askSloan"),
              active: !changeMode,
            },
            { to: PORTAL_PATHS.sloanChange, label: t("sloan.mode.change"), active: changeMode },
          ]}
        />
      </div>
      {changeMode ? (
        <ChangeRequests />
      ) : (
        <>
          {error ? <ErrorNotice error={error} /> : null}
          {threads.error ? <ErrorNotice error={threads.error} onRetry={threads.reload} /> : null}
          <PageGrid rail={<SloanRail />}>
            {threads.loading && !threads.data ? (
              <Skeleton>
                <SkeletonCard lines={4} />
              </Skeleton>
            ) : (
              <Conversation
                key={current ?? "new"}
                threadId={current}
                start={start}
                onStarted={(tid) => navigate(`${PORTAL_PATHS.sloan}/${tid}`, { replace: true })}
              />
            )}
          </PageGrid>
        </>
      )}
    </Page>
  );
}

export function Conversation({
  threadId,
  start,
  onStarted,
  bare,
  prefill,
}: {
  threadId: string | null;
  start: () => Promise<string | null>;
  onStarted: (id: string) => void;
  /** In the side panel: no card around it, the box pinned to the panel's foot. */
  bare?: boolean;
  /** Text put in the box when the chat panel opens ("@Pia "; ARCHITECTURE v0.19 §10.15). */
  prefill?: string | undefined;
}) {
  const { t } = useI18n();
  const api = useApiClient();
  const [params] = useSearchParams();
  const [text, setText] = useState(() => prefill || (params.get("ask") ?? ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const messages = useApi(
    apiRoutes.portalThreadMessages,
    threadId ? { params: { id: threadId }, query: {} } : null,
  );
  const list = messages.data?.messages ?? [];
  const last = list[list.length - 1];
  const waitingForAnswer = !!last && last.sender.you;
  useBackoffPoll(messages.reload, waitingForAnswer, ANSWER_POLL, messages.loading, last?.id);

  // Opening a conversation reads it up to now.
  const marked = useRef<string | null>(null);
  useEffect(() => {
    if (!threadId || !messages.data || marked.current === threadId) return;
    marked.current = threadId;
    api.call(apiRoutes.portalReadThread, { params: { id: threadId } }).catch(() => {});
  }, [api, threadId, messages.data]);

  async function send(body: string, files: AttachedFile[]): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const id = threadId ?? (await start());
      if (!id) return false;
      await api.call(apiRoutes.portalPostMessage, {
        params: { id },
        body: { text: body, documents: files.map((f) => f.id) },
      });
      if (threadId) messages.reload();
      else onStarted(id);
      return true;
    } catch (err) {
      setError(err);
      return false;
    } finally {
      setBusy(false);
    }
  }

  const Frame = bare ? BareFrame : Card;
  return (
    <Frame testId="portal-sloan-conversation">
      <div className={cx("flex flex-col gap-6", !bare && "ui-card__body", bare && "flex-1")}>
        {messages.error ? <ErrorNotice error={messages.error} onRetry={messages.reload} /> : null}
        {threadId && messages.loading && !messages.data ? <Loading /> : null}
        {list.length === 0 && !messages.loading ? (
          <p className="text-ink-muted" data-testid="portal-sloan-empty">
            {t("sloan.empty")}
          </p>
        ) : null}
        {list.length > 0 || waitingForAnswer ? (
          <ChatLog
            roomy
            follow={`${list.length}:${waitingForAnswer}`}
            testId="portal-sloan-messages"
          >
            {list.map((m) => (
              <Message key={m.id} message={m} />
            ))}
            {waitingForAnswer ? (
              <Thinking
                badge={<AgentBadge name={t("sloan.title")} size="sm" />}
                label={t("sloan.answering")}
                state="drafting"
                testId="portal-sloan-thinking"
              />
            ) : null}
          </ChatLog>
        ) : null}
      </div>
      <div
        className={cx(
          "ui-composer",
          bare ? "sticky bottom-0 flex flex-col gap-2 bg-surface pt-3" : "ui-card__foot",
        )}
      >
        <Composer
          label={t("sloan.compose")}
          placeholder={t("sloan.compose")}
          busy={busy}
          value={text}
          onValueChange={setText}
          onSend={send}
          words={{
            hint: t("common.enterToSend"),
            send: t("common.send"),
            sending: t("common.sending"),
          }}
          testId="portal-sloan-composer"
          inputTestId="portal-sloan-input"
          sendTestId="portal-sloan-send"
          attach={{
            upload: async (picked) => {
              try {
                return await attachToMessage(picked, (name) => t("attach.refused", { name }));
              } catch {
                throw new Error(t("attach.failed"));
              }
            },
            words: {
              attach: t("attach.add"),
              uploading: t("attach.uploading"),
              remove: t("attach.remove"),
              failed: t("attach.failed"),
            },
          }}
          voice={voiceFor("portal", null, {
            dictate: t("voice.dictate"),
            stop: t("voice.stop"),
            listening: t("voice.listening"),
            writing: t("voice.writing"),
            blocked: t("voice.blocked"),
            failed: t("voice.failed"),
          })}
          above={
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
          }
        />
        <p className="text-sm text-ink-muted">{t("sloan.commandHint")}</p>
        {error ? <ErrorNotice error={error} /> : null}
      </div>
    </Frame>
  );
}

/** The conversation's frame in the side panel: a plain column, the panel is its card. */
function BareFrame({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div className="flex min-h-full flex-col gap-4" data-testid={testId}>
      {children}
    </div>
  );
}

function Message({ message: m }: { message: PortalMessage }) {
  const { t, fmt } = useI18n();
  const you = m.sender.you;
  const name = m.sender.name ?? (m.sender.type === "agent" ? t("sloan.title") : t("sloan.mezonas"));
  // An agent's answer says who it is ("Pia · purchasing agent", ARCHITECTURE v0.19 §10.15).
  const above = [you ? t("sloan.you") : name, you ? null : m.sender.role, fmt.time(m.createdAt)]
    .filter((v): v is string => !!v)
    .join(" · ");
  const sources = <SourceLinks ids={m.sources} href={(id) => `/records/${id}`} />;
  if (you) {
    return (
      <div className="flex flex-col items-end gap-1" data-testid={`portal-sloan-message-${m.id}`}>
        <YouSaid text={m.text} above={above} mono={m.kind === "command"} />
        <MessageFiles
          files={m.documents}
          href={(id) => `/records/${id}`}
          testId={`portal-sloan-files-${m.id}`}
        />
        {sources}
      </div>
    );
  }
  const badge = m.sender.lead ? (
    <PersonBadge name={name} size="sm" />
  ) : m.sender.type === "agent" ? (
    <AgentBadge name={name} size="sm" />
  ) : (
    <PersonBadge name={name} size="sm" plain />
  );
  // An agent's words read as a chat reply; a person's stay as they wrote them.
  return (
    <AgentSaid
      badge={badge}
      above={above}
      text={m.text}
      asWritten={m.sender.type !== "agent"}
      mono={m.kind === "command"}
      testId={`portal-sloan-message-${m.id}`}
    >
      <MessageFiles files={m.documents} href={(id) => `/records/${id}`} />
      {sources}
    </AgentSaid>
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
  // §1.150: Sloan's own address and the account's number, where they're set up.
  const reach = useApi(apiRoutes.portalSloanReach);
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
          // What Sloan passes to us lands under "Ask for a change", with our answers.
          <Link
            to={PORTAL_PATHS.sloanChange}
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

      {reach.data && (reach.data.email || reach.data.phone) ? (
        <Section title={t("sloan.reach.title")}>
          <Card testId="portal-sloan-reach">
            {reach.data.email ? (
              <ActivityRow badge={<Icon name="email" className="text-ink-muted" />}>
                <span className="text-sm">
                  {t("sloan.reach.email")}{" "}
                  <a
                    href={`mailto:${reach.data.email}`}
                    className="text-link hover:underline break-all"
                    data-testid="portal-sloan-reach-email"
                  >
                    {reach.data.email}
                  </a>
                </span>
              </ActivityRow>
            ) : null}
            {reach.data.phone ? (
              <ActivityRow badge={<Icon name="message" className="text-ink-muted" />}>
                <span className="text-sm">
                  {t("sloan.reach.text")}{" "}
                  <a
                    href={`sms:${reach.data.phone}`}
                    className="text-link hover:underline"
                    data-testid="portal-sloan-reach-phone"
                  >
                    {reach.data.phone}
                  </a>
                </span>
              </ActivityRow>
            ) : null}
            <p className="text-sm text-ink-muted">{t("sloan.reach.note")}</p>
          </Card>
        </Section>
      ) : null}

      {overview.data && overview.data.services.length > 0 ? (
        <Section title={t("sloan.team")}>
          <Card testId="portal-sloan-team">
            {overview.data.services.map((s) => (
              <ActivityRow
                key={s.id}
                badge={<AgentBadge name={s.name} seed={s.id} size="sm" />}
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
