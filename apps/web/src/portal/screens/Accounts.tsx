// `/accounts`, C4 Accounts and vault (docs/ui-plan.md; ARCHITECTURE §6.1 "Who does what", §6.9):
// your connections and your vault, nothing else (Review 1). Each connected tool is a row: its
// account and state and the agents that use it; what agents may do there (On its own, Needs
// approval, Off), each agent's grant, human release and the tool's own setup expand from the row.
// The right rail holds the vault (website logins and keys, entered write-only) and the tools still
// to connect. Upload and email forwarding are on the agents that read documents (and `/upload`).
//
// The client admin signs in to each tool, disconnects, enters logins and may tighten (never
// loosen); a client user sees it all read-only, except a person's own account (Gmail), which they
// may connect themselves and disconnect if they connected it. Whoever may disconnect a connected
// Gmail may also send a test email from it to itself (plan §1.31). The API enforces the same rules.
//
// R8 (plan §1.86, ARCHITECTURE §10.14 "Connections"): the tools still to connect are grouped by
// kind, each saying how it connects (you sign in, or you enter a key), and the websites an agent
// may be given a login for are listed with them; the login goes into the vault, never to us.
import { useEffect, useState } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { PortalScriptsCard } from "../../accounts/scripts";
import { AgentsLine, LoginEditor, VaultCard, VaultDetails } from "../../accounts/vault";
import type { ResponseOf } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { accessLabel, ConnectorMark, connectionStatusLabel } from "../../connections/ConnectorMark";
// v0.14 W4-E
import { GchatSetup } from "../../connections/GchatSetup";
// v0.14 W4-D
import { GsheetsSetup } from "../../connections/GsheetsSetup";
// R8: the tools to connect, grouped by kind
import { GROUP_KEY, groupByConnector } from "../../connections/groups";
import { MatrixTable } from "../../connections/MatrixTable";
import { openPlaidLink } from "../../connections/plaidLink";
// v0.14 W4-C
import { SlackChannels } from "../../connections/SlackChannels";
import { WebhookSetup } from "../../connections/WebhookSetup";
import type { PlainKey } from "../../i18n/catalog";
import { type I18n, useI18n } from "../../i18n/i18n";
import { shortTime } from "../../runs/format";
import { useSession } from "../../session/session";
import { Icon } from "../../ui/icons";
import { Loaded, Page, PageGrid, Section } from "../../ui/page";
import { Badge, Button, Card, EmptyState, ErrorNotice, PageHeader } from "../../ui/primitives";
import { type ChipState, StatusChip } from "../../ui/status";
import { askSloan, PORTAL_PATHS } from "../paths";
// v0.14 W4-A
import { WHATSAPP_META_SIGNUP_PATH } from "./WhatsappMetaSignup";

type Offered = ResponseOf<typeof apiRoutes.portalConnections>["connections"][number];
type Vault = ResponseOf<typeof apiRoutes.portalAccess>;
type SiteOffer = Vault["browserSites"][number];

// Website logins are connections of the browser connector (packages/connectors/src/browser): one
// per site, so they live in the vault, never as a tool row. Upload is built in: it lives on the
// agents that read documents.
const BROWSER_CONNECTOR = "browser";
const UPLOAD_CONNECTOR = "upload";

/** Connectors whose description we show in the reader's language (else the API's English). */
const DESCRIPTIONS: Record<string, PlainKey> = {
  gmail: "connections.gmail.description",
  // v0.14 W4-D
  gsheets: "connections.gsheets.description",
  // v0.14 W4-C
  slack: "connections.slack.description",
  // v0.12 bankfeed
  bankfeed: "connections.bankfeed.description",
  // v0.14 W4-A
  whatsapp_meta: "connections.whatsappMeta.description",
};

/** v0.12 bankfeed: the connect button's words, where "Connect" alone says too little. */
const CONNECT_LABELS: Record<string, PlainKey> = {
  bankfeed: "connections.bankfeed.connect",
  // v0.14 W4-A
  whatsapp_meta: "connections.whatsappMeta.connect",
};

/** A connection's status as a chip: connected is done, a broken one is blocked, the rest idle. */
const STATUS_CHIP: Record<string, ChipState> = {
  connected: "done",
  error: "blocked",
  disconnected: "idle",
  pending: "setup",
};

function descriptionOf(item: Offered, { t }: Pick<I18n, "t">): string {
  const key = DESCRIPTIONS[item.connector];
  return key ? t(key) : item.description;
}

/**
 * The provider's id for the account, where a person knows it by that (a mailbox's address); null
 * for a company or realm id, which never shows (Review 2, decision 3).
 */
// DECISION: an id that is an email address is the account as people know it; any other id is the
// provider's own and stays out of sight.
export function accountAddress(id: string | null | undefined): string | null {
  return id && /^[^\s@]+@[^\s@]+$/.test(id) ? id : null;
}

function isBroken(status: string | undefined): boolean {
  return status === "error" || status === "disconnected";
}

/** Brings a part of the page into view (the vault, the tools to add). */
function scrollToId(id: string) {
  document.getElementById(id)?.scrollIntoView?.({ behavior: "smooth", block: "start" });
}

/** `/access`, `/accounts/access`: the vault's old pages, now this page's rail (the query kept). */
export function VaultRedirect() {
  const { search } = useLocation();
  return <Navigate to={{ pathname: PORTAL_PATHS.accounts, search, hash: "#vault" }} replace />;
}

export function AccountsScreen() {
  const api = useApiClient();
  const { t } = useI18n();
  const session = useSession();
  const location = useLocation();
  const role =
    session.tenants.find((c) => c.id === session.activeTenantId)?.role ??
    session.tenants[0]?.role ??
    "client_user";
  const isAdmin = role === "client_admin";
  const connections = useApi(apiRoutes.portalConnections);
  const vault = useApi(apiRoutes.portalAccess);
  const [adding, setAdding] = useState<boolean | null>(null);
  // The website whose "Enter a login" opened the vault: its setup comes first, chosen.
  const [chosenSite, setChosenSite] = useState<string | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);

  function reloadAll() {
    connections.reload();
    vault.reload();
  }

  async function act(fn: () => Promise<unknown>) {
    setActionError(null);
    try {
      await fn();
      reloadAll();
    } catch (e) {
      setActionError(e);
    }
  }

  async function connect(c: Offered) {
    // v0.14 W4-A: Meta's Embedded Signup runs on a page of its own (Meta's SDK is allowed only
    // there), loaded as a document.
    if (c.connector === "whatsapp_meta") {
      window.location.assign(WHATSAPP_META_SIGNUP_PATH);
      return;
    }
    const res = await api.call(apiRoutes.portalAuthorize, { params: { connector: c.connector } });
    // An OAuth connector answers where the provider's sign-in starts.
    if (res.redirectUrl) window.location.assign(res.redirectUrl);
    // v0.12 bankfeed: Plaid Link opens here; its result goes to the callback.
    if (res.link?.provider === "plaid") {
      const done = await openPlaidLink(res.link);
      if (done) {
        await api.call(apiRoutes.portalAuthorizeCallback, {
          params: { connector: c.connector },
          body: { params: { public_token: done.publicToken, state: done.state } },
        });
      }
    }
  }

  const tools =
    connections.data?.connections.filter(
      (c) => c.connector !== UPLOAD_CONNECTOR && c.connector !== BROWSER_CONNECTOR,
    ) ?? [];
  // A tool with a connection gets its own card; one never connected (or half-way) is to add.
  const cards = tools.filter((c) => c.connection && c.connection.status !== "pending");
  const toAdd = tools.filter((c) => !c.connection || c.connection.status === "pending");
  const cardIds = new Set(cards.map((c) => c.connection?.id));
  const items = vault.data?.items.filter((i) => i.connector !== UPLOAD_CONNECTOR) ?? [];
  const logins = items.filter((i) => i.kind === "browser" || i.kind === "api_key");
  // The vault lists website logins, and any key whose tool has no card here.
  const vaultItems = logins.filter((i) => !cardIds.has(i.connectionId));
  const offers = vault.data?.canEdit ? vault.data.browserSites.length + vault.data.setup.length : 0;
  // Open the add panel at first when the vault is empty and there is something to set up.
  const addOpen = adding ?? (vault.data !== undefined && vaultItems.length === 0 && offers > 0);

  const vaultLoaded = vault.data !== undefined;
  useEffect(() => {
    // `/access` and `/accounts/access` land here with `#vault`: bring the vault into view.
    if (location.hash === "#vault" && vaultLoaded) scrollToId("vault");
  }, [location.hash, vaultLoaded]);

  /** Opens the vault's add panel; from a website's "Enter a login", with that site chosen. */
  function openVault(site?: string) {
    setAdding(true);
    setChosenSite(site ?? null);
    scrollToId("vault");
  }

  return (
    <Page testId="portal-accounts">
      <div>
        <PageHeader
          title={t("accounts.title")}
          subtitle={t("accounts.subtitle")}
          actions={
            isAdmin ? (
              <>
                <Button data-testid="accounts-add-login" onClick={() => openVault()}>
                  {t("accounts.addLogin")}
                </Button>
                <Button
                  data-testid="accounts-connect"
                  variant="primary"
                  onClick={() => scrollToId("add-tool")}
                >
                  {t("accounts.connectAccount")}
                </Button>
              </>
            ) : null
          }
        />
      </div>
      {actionError ? <ErrorNotice error={actionError} /> : null}
      <PageGrid
        rail={
          <>
            <div id="vault" className="scroll-mt-24">
              <Loaded state={vault}>
                {(view) => (
                  <VaultCard
                    view={view}
                    items={vaultItems}
                    adding={addOpen}
                    site={chosenSite}
                    onAdding={setAdding}
                    onChanged={reloadAll}
                  />
                )}
              </Loaded>
            </div>
            {/* Wave 4: scripts on the website logins (the client admin records; we publish). */}
            {isAdmin ? <PortalScriptsCard /> : null}
            <div id="add-tool" className="scroll-mt-24">
              <Loaded state={connections}>
                {() => (
                  <AddToolCard
                    items={toAdd}
                    sites={vault.data?.canEdit ? vault.data.browserSites : []}
                    isAdmin={isAdmin}
                    onEnterLogin={openVault}
                    onConnect={(c) => act(() => connect(c))}
                  />
                )}
              </Loaded>
            </div>
          </>
        }
      >
        <Section title={t("accounts.tools.title")} testId="portal-connections-connected">
          <Loaded state={connections}>
            {() =>
              cards.length === 0 ? (
                <EmptyState>
                  {t("connections.noneConnected")}{" "}
                  {isAdmin ? t("accounts.tools.connectRight") : t("connections.adminConnects")}
                </EmptyState>
              ) : (
                <Card testId="portal-connections-list">
                  {cards.map((c) => (
                    <ConnectionRow
                      key={c.connector}
                      item={c}
                      vault={vault.data}
                      isAdmin={isAdmin}
                      canManage={
                        isAdmin || (c.personal === true && c.connection?.connectedByYou === true)
                      }
                      onConnect={() => act(() => connect(c))}
                      onDisconnect={(id) =>
                        act(() => api.call(apiRoutes.portalDisconnect, { params: { id } }))
                      }
                      onChanged={reloadAll}
                    />
                  ))}
                </Card>
              )
            }
          </Loaded>
          {/* Who approves what, and up to how much, is in Settings, under Approvals. */}
          {isAdmin ? (
            <p className="text-sm text-ink-muted" data-testid="accounts-signoff">
              {t("accounts.signoff")}{" "}
              <Link className="text-slate underline" to={PORTAL_PATHS.approvals}>
                {t("accounts.signoffLink")}
              </Link>
              .
            </p>
          ) : null}
        </Section>
      </PageGrid>
    </Page>
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

/**
 * One connected tool, as a row: its account, state and the agents that use it. What agents may do
 * there (the matrix), each agent's grant, release, the tools, the tool's own setup and disconnect
 * expand from the row.
 */
function ConnectionRow({
  item,
  vault,
  isAdmin,
  canManage,
  onConnect,
  onDisconnect,
  onChanged,
}: {
  item: Offered;
  vault: Vault | undefined;
  isAdmin: boolean;
  /** The client admin, or the person who connected their own account (Gmail). */
  canManage: boolean;
  onConnect: () => Promise<void>;
  onDisconnect: (connectionId: string) => Promise<void>;
  onChanged: () => void;
}) {
  const api = useApiClient();
  const i18n = useI18n();
  const { t } = i18n;
  // DECISION: every row starts folded (the account, its state and its agents); the rest opens
  // per row, so a page of several tools stays short. The matrix stays on this page, per
  // connection (docs/ui-plan.md, open question 2).
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const conn = item.connection;
  if (!conn) return null;
  const vaultItem = vault?.items.find((i) => i.connectionId === conn.id);
  const connected = conn.status === "connected";
  const account =
    conn.accountName ?? accountAddress(conn.externalAccountId) ?? descriptionOf(item, i18n);
  const synced = connected
    ? conn.lastSyncAt
      ? t("connections.synced", { time: shortTime(conn.lastSyncAt, undefined, i18n) })
      : t("connections.live")
    : null;

  return (
    <div
      data-testid={`portal-connection-${item.connector}`}
      className="border-b border-line last:border-b-0"
    >
      <div className="flex flex-wrap items-start gap-3 px-6 py-4 max-sm:px-4">
        <ConnectorMark name={item.name} connector={item.connector} />
        <div className="min-w-0 flex-1">
          <p className="type-subheading text-ink">{item.name}</p>
          <p className="text-sm break-words text-ink-muted">
            <span>{account}</span>
            {synced ? <span> · {synced}</span> : null}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip state={STATUS_CHIP[conn.status] ?? "idle"} testId="portal-connection-status">
            {connectionStatusLabel(conn.status, i18n)}
          </StatusChip>
          {isBroken(conn.status) && (isAdmin || item.personal === true) ? (
            <Button
              size="sm"
              variant="primary"
              data-testid="portal-connection-connect"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void onConnect().finally(() => setBusy(false));
              }}
            >
              {t("connections.reconnect")}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            data-testid="portal-connection-permissions-toggle"
            onClick={() => setOpen((s) => !s)}
            aria-expanded={open}
          >
            {open ? t("accounts.card.hide") : t("accounts.card.agentsMay")}
            <Icon name={open ? "chevron-down" : "chevron-right"} size={16} />
          </Button>
        </div>
        <div className="basis-full pl-12 max-sm:pl-0">
          <AgentsLine names={conn.usedBy.map((u) => u.name)} />
        </div>
      </div>
      {open ? (
        <div
          className="flex flex-col gap-5 border-t border-line py-4"
          data-testid="portal-connection-detail"
        >
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2 px-6">
              <h4 className="text-sm font-medium text-ink">{t("accounts.card.agentsMay")}</h4>
            </div>
            <MatrixTable
              bare
              editor={isAdmin ? "client_admin" : "viewer"}
              rows={[
                {
                  id: conn.id,
                  name: item.name,
                  permissions: conn.permissions,
                  // v0.12 W2-A: the connector's record types, as rows under it.
                  entities: item.permissionEntities,
                },
              ]}
              {...(isAdmin
                ? {
                    onSave: async (id, edit) => {
                      await api.call(apiRoutes.portalTightenPermissions, {
                        params: { id },
                        body: edit,
                      });
                      onChanged();
                    },
                  }
                : {})}
            />
            <p className="px-6 text-sm text-ink-muted">{t("accounts.card.matrixNote")}</p>
          </div>
          {conn.access.length > 0 ? (
            <div className="px-6">
              <h4 className="eyebrow mb-2 text-ink-muted">{t("accounts.card.tools")}</h4>
              <ul data-testid="portal-connection-tools" className="flex flex-col gap-1.5 text-sm">
                {conn.access.map((a) => (
                  <li key={a.toolId} className="flex items-start justify-between gap-3">
                    <span className="text-ink">{a.description}</span>
                    <span className="shrink-0 text-ink-muted">{accessLabel(a.access, i18n)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {vaultItem && vault ? (
            <div className="flex flex-col gap-3 px-6">
              <LoginEditor item={vaultItem} canEdit={vault.canEdit} onChanged={onChanged} />
              <VaultDetails
                item={vaultItem}
                canEdit={vault.canEdit}
                people={vault.people}
                onChanged={onChanged}
              />
            </div>
          ) : null}
          {/* The tool's own setup, for the client admin. DECISION: the webhook connector's setup
              (hooks, outbound URL) is its own panel, named by connector id; a generic
              per-connector setup schema waits for a second case. */}
          {isAdmin && connected ? (
            <div className="flex flex-col gap-4 px-6 empty:hidden">
              {item.connector === "webhook" ? <WebhookSetup connectionId={conn.id} /> : null}
              {/* v0.14 W4-E: Google Chat's spaces and binding code. */}
              {item.connector === "gchat" ? <GchatSetup connectionId={conn.id} /> : null}
              {/* v0.14 W4-C: the Slack channels agents may post to. */}
              {item.connector === "slack" ? <SlackChannels /> : null}
              {/* v0.14 W4-D: the sheets agents may use, and Google's Picker to choose them. */}
              {item.connector === "gsheets" ? <GsheetsSetup /> : null}
            </div>
          ) : null}
          <ConnectionActions
            item={item}
            connectionId={conn.id}
            connected={connected}
            canManage={canManage}
            onDisconnect={onDisconnect}
          />
        </div>
      ) : null}
    </div>
  );
}

/** A connected tool's own actions, at the foot of its open row: a test email, disconnect. */
function ConnectionActions({
  item,
  connectionId,
  connected,
  canManage,
  onDisconnect,
}: {
  item: Offered;
  connectionId: string;
  connected: boolean;
  canManage: boolean;
  onDisconnect: (connectionId: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const gmail = item.connector === "gmail" && connected && canManage;
  if (!gmail && !(canManage && connected)) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 px-6 max-sm:px-4">
      {gmail ? <GmailTestSend /> : null}
      {canManage && connected && !confirming ? (
        <Button
          size="sm"
          data-testid="portal-connection-disconnect-start"
          variant="ghost"
          onClick={() => setConfirming(true)}
        >
          {t("connections.disconnect")}
        </Button>
      ) : null}
      {confirming ? (
        <div className="ds-banner block basis-full">
          <p>{t("connections.disconnectWarning", { tool: item.name })}</p>
          <div className="mt-2 flex gap-2">
            <Button
              data-testid="portal-connection-disconnect-confirm"
              variant="primary"
              onClick={() => void onDisconnect(connectionId).then(() => setConfirming(false))}
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
    </div>
  );
}

/**
 * "Add another tool": the offered tools not connected yet, grouped by what they are (accounting,
 * email, messages, …), then the websites the client admin may give an agent a login for. Each says
 * how it connects: you sign in to it, you enter its key, or you enter an agent account's login into
 * the vault (R8, ARCHITECTURE §10.14). We never see a password, key or login.
 */
function AddToolCard({
  items,
  sites,
  isAdmin,
  onEnterLogin,
  onConnect,
}: {
  items: Offered[];
  /** Websites a browser login can be set up on (the client admin's view; else empty). */
  sites: SiteOffer[];
  isAdmin: boolean;
  /** Opens the vault to enter a key, or a website's login with that site chosen. */
  onEnterLogin: (site?: string) => void;
  onConnect: (item: Offered) => Promise<void>;
}) {
  const { t } = useI18n();
  const groups = groupByConnector(items);
  return (
    <Card
      testId="portal-connections-available"
      title={t("accounts.add.title")}
      footer={
        <p className="text-sm text-ink-muted">
          {t("accounts.add.ask")}{" "}
          <Link className="text-slate underline" to={askSloan(t("accounts.add.askPrompt"))}>
            {t("accounts.add.askLink")}
          </Link>
        </p>
      }
    >
      {items.length === 0 && sites.length === 0 ? (
        <p className="ui-card__body text-sm text-ink-muted">{t("accounts.add.none")}</p>
      ) : (
        <div>
          {groups.map(({ group, items: inGroup }) => (
            <section
              key={group}
              data-testid={`portal-connections-group-${group}`}
              className="border-b border-line last:border-b-0"
            >
              <h3 className="eyebrow px-6 pt-4 text-ink-muted">{t(GROUP_KEY[group])}</h3>
              <ul>
                {inGroup.map((c) => (
                  <AddToolRow
                    key={c.connector}
                    item={c}
                    isAdmin={isAdmin}
                    onEnterLogin={onEnterLogin}
                    onConnect={() => onConnect(c)}
                  />
                ))}
              </ul>
            </section>
          ))}
          {sites.length > 0 ? (
            <section
              data-testid="portal-connections-group-logins"
              className="border-b border-line last:border-b-0"
            >
              <h3 className="eyebrow px-6 pt-4 text-ink-muted">{t("accounts.group.logins")}</h3>
              <p className="px-6 pt-1 text-sm text-ink-muted">{t("accounts.how.login")}</p>
              <ul>
                {sites.map((s) => (
                  <li
                    key={s.slug}
                    data-testid={`portal-connections-site-${s.slug}`}
                    className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-6 py-4 last:border-b-0"
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <ConnectorMark name={s.name} connector={BROWSER_CONNECTOR} />
                      <span className="font-medium text-ink">{s.name}</span>
                    </span>
                    <Button
                      size="sm"
                      onClick={() => onEnterLogin(s.slug)}
                      data-testid={`portal-connections-site-${s.slug}-login`}
                    >
                      {t("accounts.add.enterLogin")}
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      )}
    </Card>
  );
}

/**
 * How a tool connects, in a line: you sign in (OAuth or a hosted link), you enter its key, or
 * nothing to sign in to. Null when the server didn't say (an older Worker) and it has no key
 * form: no line rather than a sign-in it may not have.
 */
// DECISION (web, wave 3b): the line follows the connector's manifest `auth` (PortalConnection's
// `auth`); Google Chat, the website, Hacker News and webhooks say there is nothing to sign in to.
export function howKey(item: Pick<Offered, "auth" | "credentialForm">): PlainKey | null {
  if (item.credentialForm || item.auth === "api_key") return "accounts.how.key";
  if (item.auth === "oauth2") return "accounts.how.signIn";
  if (item.auth === "none") return "accounts.how.none";
  return null;
}

function AddToolRow({
  item,
  isAdmin,
  onEnterLogin,
  onConnect,
}: {
  item: Offered;
  isAdmin: boolean;
  onEnterLogin: () => void;
  onConnect: () => Promise<void>;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const [busy, setBusy] = useState(false);
  const how = howKey(item);
  return (
    <li
      data-testid={`portal-connection-${item.connector}`}
      className="flex flex-col gap-2 border-b border-line px-6 py-4 last:border-b-0"
    >
      <div className="flex items-start gap-3">
        <ConnectorMark name={item.name} connector={item.connector} />
        <div className="min-w-0">
          <p className="font-medium text-ink">{item.name}</p>
          <p className="text-sm text-ink-muted">{descriptionOf(item, i18n)}</p>
        </div>
      </div>
      <div className="flex flex-col items-start gap-1">
        {!item.available ? (
          <Badge testId="portal-connection-unavailable">{t("connections.notAvailable")}</Badge>
        ) : item.credentialForm ? (
          // API-key tools: the login is entered in the vault (write-only).
          isAdmin ? (
            <Button
              size="sm"
              data-testid="portal-connection-enter-key"
              onClick={() => onEnterLogin()}
            >
              {t("connections.enterKey")}
            </Button>
          ) : (
            <p className="text-sm text-ink-muted">{t("connections.adminCanConnect")}</p>
          )
        ) : isAdmin || item.personal === true ? (
          <Button
            size="sm"
            variant="primary"
            data-testid="portal-connection-connect"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void onConnect().finally(() => setBusy(false));
            }}
          >
            {t(CONNECT_LABELS[item.connector] ?? "connections.connect")}
          </Button>
        ) : (
          <p className="text-sm text-ink-muted">{t("connections.adminCanConnect")}</p>
        )}
        {item.available && how ? (
          <p className="text-sm text-ink-muted" data-testid="portal-connection-how">
            {t(how)}
          </p>
        ) : null}
      </div>
    </li>
  );
}
