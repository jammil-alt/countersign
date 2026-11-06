// `/connections` (design screen 2, as the portal page, ARCHITECTURE §6.1 "Who does what"): the
// tools the operator offered this client, which are connected, and what agents may do in each.
// The client admin signs in to each tool here, disconnects, and may tighten permissions (never
// loosen); a client user sees all of it read-only, except a person's own account (Gmail), which
// they may connect themselves and disconnect if they connected it. Whoever may disconnect a
// connected Gmail may also send a test email from it to itself (plan §1.31).
import { useState } from "react";
import { Link } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { accessLabel, ConnectorMark, connectionStatusLabel } from "../../connections/ConnectorMark";
// v0.14 W4-D
import { GsheetsSetup } from "../../connections/GsheetsSetup";
import { MatrixTable } from "../../connections/MatrixTable";
import { openPlaidLink } from "../../connections/plaidLink";
import { WebhookSetup } from "../../connections/WebhookSetup";
import type { PlainKey } from "../../i18n/catalog";
import { type I18n, useI18n } from "../../i18n/i18n";
import { shortTime } from "../../runs/format";
import { useSession } from "../../session/session";
import {
  Badge,
  Button,
  buttonClass,
  Card,
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  SectionLabel,
} from "../../ui/primitives";
import { PortalApproverRules } from "./ApproverRules";
import { UploadSection } from "./Upload";

type Offered = ResponseOf<typeof apiRoutes.portalConnections>["connections"][number];

/** Connectors whose description we show in the reader's language (else the API's English). */
const DESCRIPTIONS: Record<string, PlainKey> = {
  gmail: "connections.gmail.description",
  // v0.14 W4-D
  gsheets: "connections.gsheets.description",
  // v0.12 bankfeed
  bankfeed: "connections.bankfeed.description",
};

/** v0.12 bankfeed: the connect button's words, where "Connect" alone says too little. */
const CONNECT_LABELS: Record<string, PlainKey> = {
  bankfeed: "connections.bankfeed.connect",
};

function descriptionOf(item: Offered, { t }: Pick<I18n, "t">): string {
  const key = DESCRIPTIONS[item.connector];
  return key ? t(key) : item.description;
}

export function PortalConnectionsScreen() {
  const api = useApiClient();
  const { t } = useI18n();
  const session = useSession();
  const role =
    session.tenants.find((t) => t.id === session.activeTenantId)?.role ??
    session.tenants[0]?.role ??
    "client_user";
  const isAdmin = role === "client_admin";
  const { data, error, loading, reload } = useApi(apiRoutes.portalConnections);
  const [actionError, setActionError] = useState<unknown>(null);

  async function act(fn: () => Promise<unknown>) {
    setActionError(null);
    try {
      await fn();
      reload();
    } catch (e) {
      setActionError(e);
    }
  }

  // Upload and forwarding is built in and has its own section; the cards are the tools to sign in to.
  const tools = data?.connections.filter((c) => c.connector !== "upload") ?? [];
  const connected = tools.filter((c) => c.connection?.status === "connected");
  const others = tools.filter((c) => c.connection?.status !== "connected");
  const withRows = tools.filter((c) => c.connection !== null);

  return (
    <div>
      <PageHeader title={t("connections.title")} subtitle={t("connections.subtitle")} />
      {loading && !data ? <Loading /> : null}
      {error ? <ErrorNotice error={error} onRetry={reload} /> : null}
      {actionError ? (
        <div className="mb-4">
          <ErrorNotice error={actionError} />
        </div>
      ) : null}
      {data ? (
        <div className="flex flex-col gap-6">
          <UploadSection isAdmin={isAdmin} />
          <section>
            <SectionLabel>{t("connections.connected", { count: connected.length })}</SectionLabel>
            {connected.length === 0 ? (
              <EmptyState>
                {t("connections.noneConnected")}{" "}
                {isAdmin ? t("connections.connectBelow") : t("connections.adminConnects")}
              </EmptyState>
            ) : (
              <div
                data-testid="portal-connections-connected"
                className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-4"
              >
                {connected.map((c) => (
                  <ConnectedCard
                    key={c.connector}
                    item={c}
                    canManage={
                      isAdmin || (c.personal === true && c.connection?.connectedByYou === true)
                    }
                    onDisconnect={(id) =>
                      act(() => api.call(apiRoutes.portalDisconnect, { params: { id } }))
                    }
                  />
                ))}
              </div>
            )}
          </section>

          {/* DECISION: the webhook connector's setup (hooks, outbound URL) is its own panel here,
              named by connector id; a generic per-connector setup schema waits for a second case. */}
          {isAdmin
            ? connected
                .filter((c) => c.connector === "webhook" && c.connection)
                .map((c) => (
                  <WebhookSetup key={c.connector} connectionId={c.connection?.id ?? ""} />
                ))
            : null}

          {/* v0.14 W4-D: the sheets agents may use, and Google's Picker to choose them. */}
          {isAdmin && connected.some((c) => c.connector === "gsheets") ? <GsheetsSetup /> : null}

          {withRows.length > 0 ? (
            <MatrixTable
              editor={isAdmin ? "client_admin" : "viewer"}
              note={t("connections.matrixNote")}
              rows={withRows.map((c) => ({
                id: c.connection?.id ?? c.connector,
                name: c.name,
                permissions: c.connection?.permissions ?? {
                  read: "auto",
                  create: "approval",
                  update: "approval",
                  delete: "off",
                },
                // v0.12 W2-A: the connector's record types, as rows under it.
                entities: c.permissionEntities,
              }))}
              {...(isAdmin
                ? {
                    onSave: async (id, edit) => {
                      await api.call(apiRoutes.portalTightenPermissions, {
                        params: { id },
                        body: edit,
                      });
                      reload();
                    },
                  }
                : {})}
            />
          ) : null}

          <PortalApproverRules />

          {others.length > 0 ? (
            <section>
              <SectionLabel>{t("connections.available")}</SectionLabel>
              <div
                data-testid="portal-connections-available"
                className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-4"
              >
                {others.map((c) => (
                  <AvailableCard
                    key={c.connector}
                    item={c}
                    isAdmin={isAdmin}
                    onConnect={() =>
                      act(async () => {
                        const res = await api.call(apiRoutes.portalAuthorize, {
                          params: { connector: c.connector },
                        });
                        // An OAuth connector answers where the provider's sign-in starts.
                        if (res.redirectUrl) window.location.assign(res.redirectUrl);
                        // v0.12 bankfeed: Plaid Link opens here; its result goes to the callback.
                        if (res.link) {
                          const done = await openPlaidLink(res.link);
                          if (done) {
                            await api.call(apiRoutes.portalAuthorizeCallback, {
                              params: { connector: c.connector },
                              body: {
                                params: { public_token: done.publicToken, state: done.state },
                              },
                            });
                          }
                        }
                      })
                    }
                  />
                ))}
              </div>
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
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
      <Button data-testid="portal-gmail-test-send" disabled={busy} onClick={() => void send()}>
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

function ConnectedCard({
  item,
  canManage,
  onDisconnect,
}: {
  item: Offered;
  /** The client admin, or the person who connected their own account (Gmail). */
  canManage: boolean;
  onDisconnect: (connectionId: string) => Promise<void>;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const [showTools, setShowTools] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const conn = item.connection;
  if (!conn) return null;
  const writes = conn.access.filter((a) => a.verb !== "read").length;
  return (
    <Card testId={`portal-connection-${item.connector}`} className="flex flex-col p-4">
      <div className="flex items-start gap-3">
        <ConnectorMark name={item.name} />
        <div className="min-w-0">
          <p className="font-medium text-ink">{item.name}</p>
          <p className="text-sm text-ink-muted">
            {conn.accountName ?? conn.externalAccountId ?? descriptionOf(item, i18n)}
          </p>
        </div>
      </div>
      <p className="mt-3 flex items-center gap-2 text-sm text-ink-muted">
        <Badge tone="positive">{connectionStatusLabel(conn.status, i18n)}</Badge>
        {conn.lastSyncAt
          ? t("connections.synced", { time: shortTime(conn.lastSyncAt, undefined, i18n) })
          : t("connections.live")}
      </p>
      <p className="mt-2 text-sm text-ink-muted">
        {t("connections.usedByServices", { count: conn.usedBy.length })} ·{" "}
        {t("connections.actions", { count: writes })}
      </p>
      {showTools ? (
        <ul data-testid="portal-connection-tools" className="mt-3 flex flex-col gap-1.5 text-sm">
          {conn.access.map((a) => (
            <li key={a.toolId} className="flex items-start justify-between gap-3">
              <span className="text-ink">{a.description}</span>
              <span className="shrink-0 text-ink-muted">{accessLabel(a.access, i18n)}</span>
            </li>
          ))}
          {conn.usedBy.length > 0 ? (
            <li className="text-ink-muted">
              {t("connections.usedByNames", {
                names: new Intl.ListFormat(i18n.intl).format(conn.usedBy.map((u) => u.name)),
              })}
            </li>
          ) : null}
        </ul>
      ) : null}
      <div className="mt-auto flex flex-wrap items-center gap-2 pt-4">
        <Button
          data-testid="portal-connection-permissions-toggle"
          onClick={() => setShowTools((s) => !s)}
          aria-expanded={showTools}
        >
          {t("connections.permissions")}
        </Button>
        {item.connector === "gmail" && conn.status === "connected" && canManage ? (
          <GmailTestSend />
        ) : null}
        {canManage && !confirming ? (
          <Button
            data-testid="portal-connection-disconnect-start"
            variant="ghost"
            onClick={() => setConfirming(true)}
          >
            {t("connections.disconnect")}
          </Button>
        ) : null}
      </div>
      {confirming ? (
        <div className="ds-banner mt-3 block">
          <p>{t("connections.disconnectWarning", { tool: item.name })}</p>
          <div className="mt-2 flex gap-2">
            <Button
              data-testid="portal-connection-disconnect-confirm"
              variant="primary"
              onClick={() => void onDisconnect(conn.id).then(() => setConfirming(false))}
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
    </Card>
  );
}

function AvailableCard({
  item,
  isAdmin,
  onConnect,
}: {
  item: Offered;
  isAdmin: boolean;
  onConnect: () => Promise<void>;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const [busy, setBusy] = useState(false);
  const status = item.connection?.status;
  const reconnect = status === "disconnected" || status === "error";
  return (
    <Card testId={`portal-connection-${item.connector}`} className="flex flex-col p-4">
      <div className="flex items-start gap-3">
        <ConnectorMark name={item.name} />
        <div className="min-w-0">
          <p className="font-medium text-ink">{item.name}</p>
          {status && status !== "pending" ? (
            <p className="text-sm text-ink-muted">{connectionStatusLabel(status, i18n)}</p>
          ) : null}
        </div>
      </div>
      <p className="mt-3 text-sm text-ink">{descriptionOf(item, i18n)}</p>
      <div className="mt-auto pt-4">
        {!item.available ? (
          <Badge testId="portal-connection-unavailable">{t("connections.notAvailable")}</Badge>
        ) : item.credentialForm ? (
          // API-key tools: the login is entered on the Access page (write-only).
          isAdmin ? (
            <Link
              data-testid="portal-connection-enter-key"
              to="/access"
              className={buttonClass("secondary", "w-full justify-center")}
            >
              {t("connections.enterKey")}
            </Link>
          ) : (
            <p className="text-sm text-ink-muted">{t("connections.adminCanConnect")}</p>
          )
        ) : isAdmin || item.personal === true ? (
          <Button
            data-testid="portal-connection-connect"
            className="w-full justify-center"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void onConnect().finally(() => setBusy(false));
            }}
          >
            {reconnect
              ? t("connections.reconnect")
              : t(CONNECT_LABELS[item.connector] ?? "connections.connect")}
          </Button>
        ) : (
          <p className="text-sm text-ink-muted">{t("connections.adminCanConnect")}</p>
        )}
      </div>
    </Card>
  );
}
