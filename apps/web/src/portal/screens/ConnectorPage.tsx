// `/connectors/:connector`, a connector's page (Connectors C5, docs/connectors-plan.md §3.2, §5.2,
// §7.1, §7.2): one page per tool, not a modal. Not connected: Connect (the provider's sign-in, or a
// key into the vault) and What it can do once connected (the low-risk start, plus the picked
// agent's needs). Connected: each connection's account, status, Sign in again and Disconnect; an
// open change request from Mezonas to approve or decline; What agents can do (Read and Change, a row
// per record type and verb); Changes by Mezonas; Used by, with each agent's gaps and the fix; the
// tool's own setup; the sign-in and each agent's access (the vault's details); History.
//
// `?for=<agent>` marks the rows that agent needs and puts the gold strip on top: what's missing and
// one button, Allow what Buyer needs, which sets exactly those rows as the client admin's change.
// A client admin edits; a client user reads (`mayEdit`), except a person's own account (Gmail),
// which they may connect and, once theirs, disconnect. The API enforces the same rules.
import {
  type AgentNeedsState,
  type ConnectionHistoryEntry,
  type ConnectionPageView,
  type ConnectionRowChange,
  connectorAccessRoutes,
  type GapView,
  type NeedView,
} from "@countersign/core";
import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { LoginEditor, SetupCard, VaultDetails, type VaultView } from "../../accounts/vault";
import type { ResponseOf } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { ConnectorMark, connectionStatusLabel } from "../../connections/ConnectorMark";
import { ExcelSetup } from "../../connections/ExcelSetup";
import { GchatSetup } from "../../connections/GchatSetup";
import { GsheetsSetup } from "../../connections/GsheetsSetup";
import { SlackChannels } from "../../connections/SlackChannels";
import { TeamsSetup } from "../../connections/TeamsSetup";
import { WebhookSetup } from "../../connections/WebhookSetup";
import { useI18n } from "../../i18n/i18n";
import { usePoll } from "../../runs/usePoll";
import { useSession } from "../../session/session";
import { Page } from "../../ui/page";
import { Badge, Button, ErrorNotice, Tag } from "../../ui/primitives";
import { StatusChip } from "../../ui/status";
import { AccessGroups } from "../connectors/AccessGroups";
import { ChangeRequestCard, RowChanges } from "../connectors/ChangeRequest";
import { startConnect } from "../connectors/connect";
import { MezonasMaySection } from "../connectors/MezonasMay";
import {
  accessSummary,
  CONNECT_LABELS,
  descriptionOf,
  HOW_KEY,
  isBroken,
  STATUS_CHIP,
} from "../connectors/words";
import { PORTAL_PATHS } from "../paths";

// DECISION: the page itself polls once a minute while a connection is connected (overnight S3.7:
// it showed the sync time it loaded with); the vault (`cache: "none"`) is not asked again.
export const CONNECTOR_POLL_MS = 60_000;

type PageView = ResponseOf<typeof connectorAccessRoutes.portalConnector>;
type Card = PageView["connector"];
type AllowResult = ResponseOf<typeof connectorAccessRoutes.portalAllowForAgent>;

/** Whose session this is: the client admin edits; a client user reads. */
function useIsAdmin(): boolean {
  const session = useSession();
  const role =
    session.tenants.find((c) => c.id === session.activeTenantId)?.role ??
    session.tenants[0]?.role ??
    "client_user";
  return role === "client_admin";
}

export function ConnectorPageScreen() {
  const { connector = "" } = useParams();
  const [params] = useSearchParams();
  const forId = params.get("for");
  const { t } = useI18n();
  const page = useApi(connectorAccessRoutes.portalConnector, {
    params: { connector },
    query: forId ? { for: forId } : {},
  });
  // The vault: an API-key tool's key form, and each connection's sign-in details. Never stored
  // (docs/audit-plan.md 1.2).
  const vault = useApi(apiRoutes.portalAccess, { cache: "none" });
  const reload = () => {
    page.reload();
    vault.reload();
  };
  // A sync runs behind the page (every 15 minutes, or a webhook): while a connection here is
  // connected, the page asks again each minute, so its sync time and status are never older.
  const live = page.data?.connections.some((c) => c.status === "connected") === true;
  usePoll(page.reload, live, CONNECTOR_POLL_MS, page.loading);

  return (
    <Page testId="portal-connector">
      <nav className="text-sm text-ink-muted" aria-label={t("connectors.crumbs")}>
        <Link to={PORTAL_PATHS.connectors} className="text-link hover:underline">
          {t("nav.connectors")}
        </Link>{" "}
        / {page.data?.connector.name ?? connector}
      </nav>
      {page.error && !page.data ? (
        <ErrorNotice error={page.error} onRetry={page.reload} />
      ) : !page.data ? (
        <p className="text-ink-muted">{t("common.loading")}</p>
      ) : (
        <ConnectorBody view={page.data} vault={vault.data} forId={forId} onChanged={reload} />
      )}
    </Page>
  );
}

function ConnectorBody({
  view,
  vault,
  forId,
  onChanged,
}: {
  view: PageView;
  vault: VaultView | undefined;
  forId: string | null;
  onChanged: () => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const api = useApiClient();
  const isAdmin = useIsAdmin();
  const card = view.connector;
  // What the API answered to an edit on this page, until the page reloads.
  const [answered, setAnswered] = useState<Record<string, ConnectionPageView>>({});
  const [allowed, setAllowed] = useState<AllowResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the page as the API holds it now replaces what edits answered.
  useEffect(() => setAnswered({}), [view]);

  const connections = view.connections
    .filter((c) => c.status !== "pending")
    .map((c) => answered[c.id] ?? c);
  const connected = connections.length > 0;
  const mayConnect = card.available && (isAdmin || card.personal);

  const keep = (c: ConnectionPageView) => setAnswered((cur) => ({ ...cur, [c.id]: c }));

  async function allowFor(connectionId: string, agentId: string) {
    setError(null);
    try {
      const res = await api.call(connectorAccessRoutes.portalAllowForAgent, {
        params: { connectionId, agentId },
        body: {},
      });
      keep(res.connection);
      if (agentId === view.forAgent?.agent.id) setAllowed(res);
      onChanged();
    } catch (e) {
      setError(e);
    }
  }

  async function connect() {
    setError(null);
    try {
      await startConnect(api, card.connector, forId);
      onChanged();
    } catch (e) {
      setError(e);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-wrap items-start gap-4">
        <ConnectorMark name={card.name} connector={card.connector} />
        <div className="min-w-0 flex-1">
          <h1 className="type-title text-ink">
            {card.name}
            {card.beta ? (
              <Tag className="ml-2 align-middle" testId="connector-beta">
                {t("connectors.beta")}
              </Tag>
            ) : null}
          </h1>
          <p className="text-sm text-ink-muted">{descriptionOf(card, i18n)}</p>
        </div>
        {!connected || card.multiple ? (
          <ConnectButton
            card={card}
            connected={connected}
            mayConnect={mayConnect}
            vault={vault}
            onConnect={connect}
            onSaved={onChanged}
          />
        ) : null}
      </header>

      {error ? <ErrorNotice error={error} /> : null}

      <ForAgentStrip
        view={view}
        connections={connections}
        allowed={allowed}
        mayEdit={view.mayEdit}
        onAllow={allowFor}
      />

      {connected ? (
        connections.map((c) => (
          <ConnectionBlock
            key={c.id}
            card={card}
            connection={c}
            many={connections.length > 1}
            view={view}
            vault={vault}
            isAdmin={isAdmin}
            forId={forId}
            onKeep={keep}
            onAllow={allowFor}
            onReconnect={connect}
            onChanged={onChanged}
          />
        ))
      ) : (
        <NotConnected view={view} />
      )}
    </div>
  );
}

/**
 * Connect, as the tool connects: the provider's sign-in (OAuth, Meta, Plaid), or its key entered
 * into the vault (write-only). A client user may connect a person's own account (Gmail) only.
 */
function ConnectButton({
  card,
  connected,
  mayConnect,
  vault,
  onConnect,
  onSaved,
}: {
  card: Card;
  connected: boolean;
  mayConnect: boolean;
  vault: VaultView | undefined;
  onConnect: () => Promise<void>;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [keying, setKeying] = useState(false);
  if (!card.available) {
    return <Badge testId="connector-unavailable">{t("connections.notAvailable")}</Badge>;
  }
  if (!mayConnect) {
    return (
      <p className="text-sm text-ink-muted" data-testid="connector-admin-connects">
        {t("connections.adminCanConnect")}
      </p>
    );
  }
  if (card.auth === "api_key") {
    const setup = vault?.setup.find((s) => s.connector === card.connector);
    if (!setup) return null;
    return keying ? (
      <div className="basis-full">
        <SetupCard setup={setup} onSaved={onSaved} />
      </div>
    ) : (
      <Button variant="primary" data-testid="connector-enter-key" onClick={() => setKeying(true)}>
        {t("connections.enterKey")}
      </Button>
    );
  }
  return (
    <Button
      variant={connected ? "secondary" : "primary"}
      data-testid="connector-connect"
      working={busy}
      onClick={() => {
        setBusy(true);
        void onConnect().finally(() => setBusy(false));
      }}
    >
      {connected
        ? t("connectors.connectAnother")
        : t(CONNECT_LABELS[card.connector] ?? "connections.connect")}
    </Button>
  );
}

/** The picked agent's needs here: the gold strip, its one button, and what it did. */
function ForAgentStrip({
  view,
  connections,
  allowed,
  mayEdit,
  onAllow,
}: {
  view: PageView;
  connections: ConnectionPageView[];
  allowed: AllowResult | null;
  mayEdit: boolean;
  onAllow: (connectionId: string, agentId: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const fa = view.forAgent;
  if (!fa) return null;
  const agent = fa.agent.name;

  if (allowed) {
    return (
      <div
        className="flex flex-col gap-2 rounded-md border border-line bg-positive-tint p-4 text-ink"
        data-testid="for-agent-allowed"
      >
        <strong>
          {allowed.unresolved.length === 0
            ? t("connectors.for.has", { agent })
            : t("connectors.for.allowedSome", { agent })}
        </strong>
        {allowed.rows.length > 0 ? <RowList rows={allowed.rows} /> : null}
        {allowed.unresolved.length > 0 ? (
          <p className="text-sm" data-testid="for-agent-unresolved">
            {t("connectors.for.unresolved", {
              needs: allowed.unresolved.map((n) => n.label).join(", "),
            })}
          </p>
        ) : null}
        <p className="text-sm">{t("connectors.for.allowedByYou")}</p>
      </div>
    );
  }

  const gaps = fa.gaps.filter((g) => g.blocking);
  if (fa.ready || gaps.length === 0) {
    return (
      <div
        className="rounded-md border border-line bg-positive-tint p-4 text-ink"
        data-testid="for-agent-ready"
      >
        <strong>{t("connectors.for.has", { agent })}</strong>
      </div>
    );
  }

  const notConnected = gaps.some((g) => g.kind === "not_connected");
  const needs = gaps.flatMap(needLines);
  const allowable = gaps.find(
    (g) => g.kind === "off_on_connection" && g.fixBy === "client" && g.connectionId,
  );
  const ours = gaps.filter((g) => g.fixBy === "mezonas");
  const onPage = connections.some((c) => c.id === allowable?.connectionId);
  return (
    <div
      className="flex flex-wrap items-center gap-4 rounded-md border border-line bg-signal-tint p-4 text-signal-ink"
      data-testid="for-agent-needs"
    >
      <div className="min-w-0 flex-1">
        <strong>
          {notConnected
            ? t("connectors.for.needsThis", { agent })
            : t("connectors.for.needsMore", { agent, count: needs.length })}
        </strong>
        <ul className="mt-1 list-disc pl-5" data-testid="for-agent-list">
          {needs.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
        <p className="mt-2 text-sm">
          {notConnected ? t("connectors.for.connectTurnsOn", { agent }) : t("connectors.for.asks")}
        </p>
        {ours.length > 0 ? (
          <p className="mt-1 text-sm" data-testid="for-agent-ours">
            {t("connectors.for.ours", { words: ours.map((g) => g.words).join(", ") })}
          </p>
        ) : null}
        {!mayEdit && allowable ? (
          <p className="mt-1 text-sm" data-testid="for-agent-admin-only">
            {t("connectors.for.adminAllows")}
          </p>
        ) : null}
      </div>
      {mayEdit && allowable?.connectionId && onPage ? (
        <Button
          variant="primary"
          data-testid="for-agent-allow"
          working={busy}
          onClick={() => {
            setBusy(true);
            void onAllow(allowable.connectionId as string, fa.agent.id).finally(() =>
              setBusy(false),
            );
          }}
        >
          {t("connectors.for.allow", { agent })}
        </Button>
      ) : null}
    </div>
  );
}

/** A gap's lines: each need it holds ("Create purchase orders"), else its fix in words. */
function needLines(g: GapView): string[] {
  return g.needs.length > 0 ? g.needs.map((n: NeedView) => n.label) : [g.words];
}

function RowList({ rows }: { rows: ConnectionRowChange[] }) {
  return (
    <ul className="list-disc pl-5 text-sm" data-testid="for-agent-rows">
      {rows.map((r) => (
        <li key={r.label}>{r.label}</li>
      ))}
    </ul>
  );
}

/** Not connected yet: what agents may do once it is (the low-risk start, plus the agent's needs). */
function NotConnected({ view }: { view: PageView }) {
  const { t } = useI18n();
  const card = view.connector;
  return (
    <section className="flex flex-col gap-4" data-testid="connector-start">
      <div>
        <h2 className="type-heading text-ink">{t("connectors.start.title")}</h2>
        <p className="text-sm text-ink-muted">{t(HOW_KEY[card.auth])}</p>
      </div>
      <AccessGroups read={view.start.read} change={view.start.change} mayEdit={false} />
      <p className="text-sm text-ink-muted">
        {card.personal ? t("connectors.start.personal") : t("connectors.start.admin")}{" "}
        {t("connectors.start.later")}
      </p>
    </section>
  );
}

/** One connection: its head, the open request, what agents can do, our say, who uses it, history. */
function ConnectionBlock({
  card,
  connection: c,
  many,
  view,
  vault,
  isAdmin,
  forId,
  onKeep,
  onAllow,
  onReconnect,
  onChanged,
}: {
  card: Card;
  connection: ConnectionPageView;
  many: boolean;
  view: PageView;
  vault: VaultView | undefined;
  isAdmin: boolean;
  forId: string | null;
  onKeep: (c: ConnectionPageView) => void;
  onAllow: (connectionId: string, agentId: string) => Promise<void>;
  onReconnect: () => Promise<void>;
  onChanged: () => void;
}) {
  const i18n = useI18n();
  const { t, fmt } = i18n;
  const api = useApiClient();
  const connected = c.status === "connected";
  const canManage = isAdmin || (card.personal && c.connectedByYou);
  const vaultItem = vault?.items.find((i) => i.connectionId === c.id);
  const [details, setDetails] = useState(false);
  const [mayView, setMayView] = useState(c.mezonasMay);
  useEffect(() => setMayView(c.mezonasMay), [c.mezonasMay]);

  const line = [
    c.accountName,
    connected
      ? c.lastSyncAt
        ? t("connections.synced", { time: fmt.time(c.lastSyncAt) })
        : t("connections.live")
      : null,
    c.connectedByYou ? t("connectors.connectedByYou") : null,
  ].filter((x): x is string => !!x);

  return (
    <section className="flex flex-col gap-6" data-testid={`connection-${c.id}`}>
      <div
        className="flex flex-wrap items-center gap-3 rounded-md border border-line bg-surface px-4 py-3"
        data-testid={`portal-connection-${card.connector}`}
      >
        <div className="min-w-0 flex-1">
          {many ? <p className="font-medium text-ink">{c.accountName ?? card.name}</p> : null}
          <p className="text-sm text-ink-muted">
            {line.join(" · ")}
            {line.length > 0 ? " · " : ""}
            {accessSummary(c.access, i18n)}
          </p>
        </div>
        <StatusChip state={STATUS_CHIP[c.status] ?? "idle"} testId="portal-connection-status">
          {connectionStatusLabel(c.status, i18n)}
        </StatusChip>
        <ConnectionActions
          card={card}
          connection={c}
          canManage={canManage}
          canSignIn={isAdmin || card.personal}
          onReconnect={onReconnect}
          onDisconnect={async () => {
            await api.call(apiRoutes.portalDisconnect, { params: { id: c.id } });
            onChanged();
          }}
        />
      </div>

      {c.openRequest ? (
        <ChangeRequestCard
          request={c.openRequest}
          mayAnswer={view.mayEdit}
          onAnswered={onChanged}
        />
      ) : null}

      <section className="flex flex-col gap-3">
        <h2 className="type-heading text-ink">{t("connectors.agentsCan")}</h2>
        <AccessGroups
          read={c.read}
          change={c.change}
          mayEdit={view.mayEdit && connected}
          forAgentId={forId}
          testId="connection-access"
          onSave={async (permissions) => {
            const res = await api.call(connectorAccessRoutes.portalSetAccess, {
              params: { connectionId: c.id },
              body: { permissions },
            });
            onKeep(res.connection);
            onChanged();
          }}
        />
      </section>

      <MezonasMaySection
        connectionId={c.id}
        value={mayView}
        mayEdit={view.mayEdit}
        onChanged={(next) => {
          setMayView(next);
          onChanged();
        }}
      />

      <UsedBy connection={c} mayEdit={view.mayEdit} onAllow={(agentId) => onAllow(c.id, agentId)} />

      {/* The tool's own setup, for the client admin. */}
      {isAdmin && connected ? (
        <div className="flex flex-col gap-4 empty:hidden" data-testid="connection-setup">
          {card.connector === "webhook" ? <WebhookSetup connectionId={c.id} /> : null}
          {card.connector === "gchat" ? <GchatSetup connectionId={c.id} /> : null}
          {card.connector === "slack" ? <SlackChannels /> : null}
          {card.connector === "gsheets" ? <GsheetsSetup /> : null}
          {card.connector === "teams" ? <TeamsSetup connectionId={c.id} /> : null}
          {card.connector === "excel" ? <ExcelSetup /> : null}
        </div>
      ) : null}

      {vaultItem && vault ? (
        <section className="flex flex-col gap-3">
          <Button
            variant="ghost"
            className="self-start"
            aria-expanded={details}
            data-testid="connection-details-toggle"
            onClick={() => setDetails((d) => !d)}
          >
            {details ? t("connectors.details.hide") : t("connectors.details.show")}
          </Button>
          {details ? (
            <div className="flex flex-col gap-3 rounded-md border border-line bg-surface p-4">
              <LoginEditor item={vaultItem} canEdit={vault.canEdit} onChanged={onChanged} />
              <VaultDetails
                item={vaultItem}
                canEdit={vault.canEdit}
                people={vault.people}
                onChanged={onChanged}
              />
            </div>
          ) : null}
        </section>
      ) : null}

      <History entries={c.history} />
    </section>
  );
}

/** Sign in again, a test email from Gmail, Disconnect (after a warning). */
function ConnectionActions({
  card,
  connection: c,
  canManage,
  canSignIn,
  onReconnect,
  onDisconnect,
}: {
  card: Card;
  connection: ConnectionPageView;
  canManage: boolean;
  canSignIn: boolean;
  onReconnect: () => Promise<void>;
  onDisconnect: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const connected = c.status === "connected";
  const broken = isBroken(c.status);
  return (
    <>
      {canSignIn && card.auth !== "api_key" && (broken || canManage) ? (
        <Button
          size="sm"
          variant={broken ? "primary" : "ghost"}
          data-testid="portal-connection-connect"
          working={busy}
          onClick={() => {
            setBusy(true);
            void onReconnect().finally(() => setBusy(false));
          }}
        >
          {t("connectors.signInAgain")}
        </Button>
      ) : null}
      {card.connector === "gmail" && connected && canManage ? <GmailTestSend /> : null}
      {canManage && connected && !confirming ? (
        <Button
          size="sm"
          variant="ghost"
          data-testid="portal-connection-disconnect-start"
          onClick={() => setConfirming(true)}
        >
          {t("connections.disconnect")}
        </Button>
      ) : null}
      {confirming ? (
        <div className="ds-banner block basis-full">
          <p>{t("connections.disconnectWarning", { tool: card.name })}</p>
          <div className="mt-2 flex gap-2">
            <Button
              data-testid="portal-connection-disconnect-confirm"
              variant="primary"
              onClick={() => {
                setError(null);
                void onDisconnect().then(
                  () => setConfirming(false),
                  (e: unknown) => setError(e),
                );
              }}
            >
              {t("connections.disconnect")}
            </Button>
            <Button
              data-testid="portal-connection-disconnect-cancel"
              variant="ghost"
              onClick={() => setConfirming(false)}
            >
              {t("connections.keepIt")}
            </Button>
          </div>
        </div>
      ) : null}
      {error ? (
        <div className="basis-full">
          <ErrorNotice error={error} />
        </div>
      ) : null}
    </>
  );
}

/**
 * "Send a test email" on a connected Gmail: one email from the mailbox to itself (the API picks
 * the address; nothing here can name another), then where it went, or the plain error.
 */
function GmailTestSend() {
  const api = useApiClient();
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  async function send() {
    setBusy(true);
    setError(null);
    setSentTo(null);
    try {
      const res = await api.call(apiRoutes.portalGmailTestSend, { body: {} });
      setSentTo(res.to);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        size="sm"
        data-testid="portal-gmail-test-send"
        disabled={busy}
        onClick={() => void send()}
      >
        {busy ? t("common.sending") : t("connections.gmail.testSend")}
      </Button>
      {sentTo || error ? (
        <div className="basis-full">
          {sentTo ? (
            <p role="status" data-testid="portal-gmail-test-sent" className="text-sm text-positive">
              {t("connections.gmail.testSent", { address: sentTo })}
            </p>
          ) : null}
          {error ? <ErrorNotice error={error} /> : null}
        </div>
      ) : null}
    </>
  );
}

/** Each agent bound to the connection: Has what it needs, or what it needs here and the fix. */
function UsedBy({
  connection,
  mayEdit,
  onAllow,
}: {
  connection: ConnectionPageView;
  mayEdit: boolean;
  onAllow: (agentId: string) => Promise<void>;
}) {
  const { t } = useI18n();
  return (
    <section className="flex flex-col gap-3" data-testid="connection-used-by">
      <h2 className="type-heading text-ink">{t("connectors.usedBy.title")}</h2>
      {connection.usedBy.length === 0 ? (
        <p className="text-sm text-ink-muted">{t("connectors.usedBy.none")}</p>
      ) : (
        <div className="divide-y divide-line overflow-hidden rounded-md border border-line bg-surface">
          {connection.usedBy.map((a) => (
            <UsedByRow
              key={a.agent.id}
              state={a}
              connectionId={connection.id}
              mayEdit={mayEdit}
              onAllow={onAllow}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function UsedByRow({
  state,
  connectionId,
  mayEdit,
  onAllow,
}: {
  state: AgentNeedsState;
  connectionId: string;
  mayEdit: boolean;
  onAllow: (agentId: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const gaps = state.gaps.filter((g) => g.blocking);
  const needs = gaps.flatMap(needLines);
  const fixable = gaps.some(
    (g) =>
      g.kind === "off_on_connection" && g.fixBy === "client" && g.connectionId === connectionId,
  );
  return (
    <div
      className="flex flex-wrap items-center gap-3 px-4 py-3"
      data-testid={`used-by-${state.agent.id}`}
    >
      <div className="min-w-0 flex-1">
        <Link
          to={PORTAL_PATHS.agent(state.agent.id)}
          className="font-medium text-ink hover:underline"
        >
          {state.agent.name}
        </Link>
        {needs.length > 0 ? (
          <p className="text-sm text-ink-muted">
            {t("connectors.usedBy.needs", { needs: needs.join(", ") })}
          </p>
        ) : null}
      </div>
      {state.ready ? (
        <Badge tone="positive" testId={`used-by-${state.agent.id}-state`}>
          {t("connectors.usedBy.ready")}
        </Badge>
      ) : (
        <Badge tone="warning" testId={`used-by-${state.agent.id}-state`}>
          {t("connectors.usedBy.needsCount", { count: needs.length })}
        </Badge>
      )}
      {!state.ready && fixable && mayEdit ? (
        <Button
          size="sm"
          variant="primary"
          data-testid={`used-by-${state.agent.id}-allow`}
          working={busy}
          onClick={() => {
            setBusy(true);
            void onAllow(state.agent.id).finally(() => setBusy(false));
          }}
        >
          {t("connectors.for.allow", { agent: state.agent.name })}
        </Button>
      ) : null}
    </div>
  );
}

/** Who changed what and when (`connection_change`): the newest first, a few at a time. */
function History({ entries }: { entries: ConnectionHistoryEntry[] }) {
  const { t, fmt } = useI18n();
  const [all, setAll] = useState(false);
  const shown = all ? entries : entries.slice(0, 5);
  return (
    <section className="flex flex-col gap-3" data-testid="connection-history">
      <h2 className="type-heading text-ink">{t("connectors.history.title")}</h2>
      {entries.length === 0 ? (
        <p className="text-sm text-ink-muted">{t("connectors.history.none")}</p>
      ) : (
        <ol className="flex flex-col gap-4">
          {shown.map((e) => (
            <li key={e.id} className="flex flex-col gap-2" data-testid={`history-${e.id}`}>
              <p className="text-sm text-ink-muted">
                {fmt.time(e.at)} ·{" "}
                <span className="text-ink">{e.by?.name ?? t("connectors.history.system")}</span>
                {e.requestId ? ` · ${t("connectors.history.fromRequest")}` : ""}
                {e.authorization
                  ? ` · ${t("connectors.history.underGoAhead", { date: fmt.date(e.authorization.setAt) })}`
                  : ""}
              </p>
              {e.note ? <p className="text-ink">{e.note}</p> : null}
              {e.rows.length > 0 ? <RowChanges rows={e.rows} /> : null}
            </li>
          ))}
        </ol>
      )}
      {entries.length > 5 ? (
        <Button variant="link" className="self-start" onClick={() => setAll((a) => !a)}>
          {all
            ? t("connectors.history.fewer")
            : t("connectors.history.all", { count: entries.length })}
        </Button>
      ) : null}
    </section>
  );
}
