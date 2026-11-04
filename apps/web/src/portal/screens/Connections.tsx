// `/connections` (design screen 2, as the portal page, ARCHITECTURE §6.1 "Who does what"): the
// tools the operator offered this client, which are connected, and what agents may do in each.
// The client admin signs in to each tool here, disconnects, and may tighten permissions (never
// loosen); a client user sees all of it read-only.
import { useState } from "react";
import type { ResponseOf } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { accessLabel, ConnectorMark, connectionStatusLabel } from "../../connections/ConnectorMark";
import { MatrixTable } from "../../connections/MatrixTable";
import { WebhookSetup } from "../../connections/WebhookSetup";
import { shortTime } from "../../runs/format";
import { useSession } from "../../session/session";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  SectionLabel,
} from "../../ui/primitives";
import { UploadSection } from "./Upload";

type Offered = ResponseOf<typeof apiRoutes.portalConnections>["connections"][number];

export function PortalConnectionsScreen() {
  const api = useApiClient();
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
      <PageHeader
        title="Connections"
        subtitle="Connect each tool once. Your agents use these connections, within the permissions shown here."
      />
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
            <SectionLabel>Connected · {connected.length}</SectionLabel>
            {connected.length === 0 ? (
              <EmptyState>
                No tools connected yet.{" "}
                {isAdmin ? "Connect one below." : "Your admin connects them."}
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
                    canDisconnect={isAdmin}
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

          {withRows.length > 0 ? (
            <MatrixTable
              editor={isAdmin ? "client_admin" : "viewer"}
              note="Approval means the change waits in your inbox until someone says yes."
              rows={withRows.map((c) => ({
                id: c.connection?.id ?? c.connector,
                name: c.name,
                permissions: c.connection?.permissions ?? {
                  read: "auto",
                  create: "approval",
                  update: "approval",
                  delete: "off",
                },
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

          {others.length > 0 ? (
            <section>
              <SectionLabel>Available</SectionLabel>
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

function ConnectedCard({
  item,
  canDisconnect,
  onDisconnect,
}: {
  item: Offered;
  canDisconnect: boolean;
  onDisconnect: (connectionId: string) => Promise<void>;
}) {
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
          <p className="text-sm text-ink-muted">{conn.externalAccountId ?? item.description}</p>
        </div>
      </div>
      <p className="mt-3 flex items-center gap-2 text-sm text-ink-muted">
        <Badge tone="positive">{connectionStatusLabel(conn.status)}</Badge>
        {conn.lastSyncAt ? `synced ${shortTime(conn.lastSyncAt)}` : "live"}
      </p>
      <p className="mt-2 text-sm text-ink-muted">
        Used by {conn.usedBy.length} {conn.usedBy.length === 1 ? "service" : "services"} · {writes}{" "}
        {writes === 1 ? "action" : "actions"}
      </p>
      {showTools ? (
        <ul data-testid="portal-connection-tools" className="mt-3 flex flex-col gap-1.5 text-sm">
          {conn.access.map((a) => (
            <li key={a.toolId} className="flex items-start justify-between gap-3">
              <span className="text-ink">{a.description}</span>
              <span className="shrink-0 text-ink-muted">{accessLabel(a.access)}</span>
            </li>
          ))}
          {conn.usedBy.length > 0 ? (
            <li className="text-ink-muted">Used by {conn.usedBy.map((u) => u.name).join(", ")}</li>
          ) : null}
        </ul>
      ) : null}
      <div className="mt-auto flex flex-wrap items-center gap-2 pt-4">
        <Button
          data-testid="portal-connection-permissions-toggle"
          onClick={() => setShowTools((s) => !s)}
          aria-expanded={showTools}
        >
          Permissions
        </Button>
        {canDisconnect && !confirming ? (
          <Button
            data-testid="portal-connection-disconnect-start"
            variant="ghost"
            onClick={() => setConfirming(true)}
          >
            Disconnect
          </Button>
        ) : null}
      </div>
      {confirming ? (
        <div className="ds-banner mt-3 block">
          <p>Agents stop using {item.name} until you connect it again.</p>
          <div className="mt-2 flex gap-2">
            <Button
              data-testid="portal-connection-disconnect-confirm"
              variant="primary"
              onClick={() => void onDisconnect(conn.id).then(() => setConfirming(false))}
            >
              Disconnect
            </Button>
            <Button
              data-testid="portal-connection-disconnect-cancel"
              variant="ghost"
              onClick={() => setConfirming(false)}
            >
              Keep it
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
            <p className="text-sm text-ink-muted">{connectionStatusLabel(status)}</p>
          ) : null}
        </div>
      </div>
      <p className="mt-3 text-sm text-ink">{item.description}</p>
      <div className="mt-auto pt-4">
        {!item.available ? (
          <Badge testId="portal-connection-unavailable">Not available yet</Badge>
        ) : isAdmin ? (
          <Button
            data-testid="portal-connection-connect"
            className="w-full justify-center"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void onConnect().finally(() => setBusy(false));
            }}
          >
            {reconnect ? "Reconnect" : "Connect"}
          </Button>
        ) : (
          <p className="text-sm text-ink-muted">Your admin can connect it.</p>
        )}
      </div>
    </Card>
  );
}
