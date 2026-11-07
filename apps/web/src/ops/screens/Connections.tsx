// `/ops/clients/:clientId/connections` (design screen 2 in the back office; ARCHITECTURE §6.1 "Who
// does what"): which connectors the client is offered, the client's connections with their sync
// state and who uses them, the permission matrix (the operator may loosen as well as tighten) and
// each connection's configuration. The client signs in from the portal; the operator never
// connects a tool on a client's behalf and never sees credentials. The one exception is the Sandbox
// client, the operator's own test client: the operator connects its no-sign-in tools here, and signs
// in to its offered OAuth tools with their own account (the provider returns to
// `/ops/connections/:connector/callback`). The Sandbox's connected Gmail also sends a test email
// to itself from here (plan §1.31).
import { connectionAccountName } from "@countersign/core";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { ConnectorMark, connectionStatusLabel } from "../../connections/ConnectorMark";
import { MatrixTable } from "../../connections/MatrixTable";
import { shortTime } from "../../runs/format";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Loading,
  SectionLabel,
} from "../../ui/primitives";
import { plural } from "../../usage/format";
import { ClientFrame } from "../client/ClientFrame";

type Data = ResponseOf<typeof apiRoutes.opsClientConnections>;

/** How the client connects each kind of connector, in the operator's words. */
const AUTH_LINE: Record<string, string> = {
  oauth2: "the client signs in from their portal",
  api_key: "the client adds a key from their portal",
  none: "no sign-in needed",
};

/**
 * A connector's description for the back office: its manifest writes to the client ("You sign in
 * to QuickBooks yourself."), so the sentences addressed to them are left out here.
 */
export function operatorBlurb(description: string): string {
  const sentences = description.match(/[^.!?]+[.!?]*/g) ?? [description];
  const kept = sentences.filter((s) => !/^\s*you\b/i.test(s));
  return (kept.length > 0 ? kept : sentences).join("").trim();
}

export function OpsConnectionsScreen() {
  const { clientId = "" } = useParams();
  return (
    <ClientFrame clientId={clientId}>
      <Connections clientId={clientId} />
    </ClientFrame>
  );
}

function Connections({ clientId }: { clientId: string }) {
  const api = useApiClient();
  const { data, error, loading, reload } = useApi(apiRoutes.opsClientConnections, {
    params: { id: clientId },
  });
  // v0.12 W2-A: each connector's record types, for the matrix's entity rows.
  const catalog = useApi(apiRoutes.opsConnectors);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!data) return null;

  const names = Object.fromEntries(data.connectors.map((c) => [c.id, c.name]));
  const entitiesOf = Object.fromEntries(
    (catalog.data?.connectors ?? []).map((c) => [c.id, c.permissionEntities]),
  );
  return (
    <div>
      <p className="mb-6 text-ink-muted" data-testid="ops-connections-intro">
        {data.sandbox
          ? "Your own test client, so you connect its tools here. Test runs never write to them."
          : "The tools offered, what is connected, and what agents may do in each. The client signs in from their portal; you never connect on their behalf."}
      </p>
      <div className="flex flex-col gap-6">
        <section>
          <SectionLabel>
            Connected · {data.connections.filter((c) => c.status === "connected").length}
          </SectionLabel>
          {data.connections.length === 0 ? (
            <EmptyState>
              {data.sandbox
                ? "No connections yet. Connect a connector below."
                : "No connections yet. Offer a connector below; the client admin signs in from their portal."}
            </EmptyState>
          ) : (
            <div
              data-testid="ops-connections-list"
              className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3"
            >
              {data.connections.map((c) => (
                <ConnectionCard
                  key={c.id}
                  connection={c}
                  name={names[c.connector] ?? c.connector}
                  usedBy={data.usedBy[c.id] ?? []}
                  testEmail={
                    data.sandbox && c.connector === "gmail" && c.status === "connected"
                      ? clientId
                      : null
                  }
                  {...(data.sandbox && c.status !== "disconnected"
                    ? {
                        onDisconnect: async () => {
                          await api.call(apiRoutes.opsSandboxDisconnect, {
                            params: { id: clientId, connectionId: c.id },
                          });
                          reload();
                        },
                      }
                    : {})}
                  onSaveConfig={async (config) => {
                    await api.call(apiRoutes.opsUpdateConnection, {
                      params: { id: c.id },
                      body: { config },
                    });
                    reload();
                  }}
                />
              ))}
            </div>
          )}
        </section>

        {data.connections.length > 0 ? (
          <MatrixTable
            editor="operator"
            note="The client admin can tighten these from the portal; only you can loosen them."
            rows={data.connections.map((c) => ({
              id: c.id,
              name: names[c.connector] ?? c.connector,
              permissions: c.permissions,
              entities: entitiesOf[c.connector],
            }))}
            onSave={async (id, edit) => {
              await api.call(apiRoutes.opsUpdateConnection, {
                params: { id },
                body: { permissions: edit },
              });
              reload();
            }}
          />
        ) : null}

        <Offering
          clientId={clientId}
          data={data}
          onConnect={async (connector) => {
            await api.call(apiRoutes.opsConnectSandbox, { params: { id: clientId, connector } });
            reload();
          }}
          onSignIn={async (connector) => {
            const res = await api.call(apiRoutes.opsSandboxAuthorize, {
              params: { id: clientId, connector },
            });
            // The provider's sign-in, then back to the back office's callback page.
            window.location.assign(res.redirectUrl);
          }}
          onSave={async (offered) => {
            await api.call(apiRoutes.opsOfferConnectors, {
              params: { id: clientId },
              body: { offered },
            });
            reload();
          }}
        />
      </div>
    </div>
  );
}

/**
 * The Sandbox's connected Gmail: one test email from the mailbox to itself (the API picks the
 * address; nothing here can name another), then where it went, or the plain error.
 */
function GmailTestSend({ clientId }: { clientId: string }) {
  const api = useApiClient();
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [problem, setProblem] = useState<unknown>(null);

  async function send() {
    setBusy(true);
    setProblem(null);
    setSentTo(null);
    try {
      const res = await api.call(apiRoutes.opsSandboxGmailTestSend, {
        params: { id: clientId },
        body: {},
      });
      setSentTo(res.to);
    } catch (e) {
      setProblem(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button data-testid="ops-gmail-test-send" disabled={busy} onClick={() => void send()}>
        {busy ? "Sending…" : "Send a test email"}
      </Button>
      {sentTo || problem ? (
        <div className="basis-full">
          {sentTo ? (
            <p role="status" data-testid="ops-gmail-test-sent" className="text-sm text-positive">
              Sent to {sentTo}. Check that mailbox's Sent folder and inbox.
            </p>
          ) : null}
          {problem ? <ErrorNotice error={problem} /> : null}
        </div>
      ) : null}
    </>
  );
}

function ConnectionCard({
  connection: c,
  name,
  usedBy,
  testEmail,
  onDisconnect,
  onSaveConfig,
}: {
  connection: Data["connections"][number];
  name: string;
  usedBy: { id: string; name: string }[];
  /** The Sandbox client's id when its connected Gmail may send a test email; else null. */
  testEmail: string | null;
  /** The Sandbox only: the operator disconnects what they connected (after a confirm step). */
  onDisconnect?: () => Promise<void>;
  onSaveConfig: (config: Record<string, unknown>) => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectProblem, setDisconnectProblem] = useState<unknown>(null);

  async function disconnect() {
    if (!onDisconnect) return;
    setDisconnecting(true);
    setDisconnectProblem(null);
    try {
      await onDisconnect();
      setConfirming(false);
    } catch (e) {
      setDisconnectProblem(e);
    } finally {
      setDisconnecting(false);
    }
  }
  const saved = JSON.stringify(c.config, null, 2);
  // The company's name, as the portal shows it; the account id (a QuickBooks realm) under it.
  const accountName = connectionAccountName(c.config);
  const [text, setText] = useState(saved);
  const [editing, setEditing] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  useEffect(() => setText(saved), [saved]);

  async function save() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setProblem(new Error("The configuration must be a JSON object."));
      return;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      setProblem(new Error("The configuration must be a JSON object."));
      return;
    }
    setProblem(null);
    try {
      await onSaveConfig(parsed as Record<string, unknown>);
      setEditing(false);
    } catch (e) {
      setProblem(e);
    }
  }

  return (
    <Card testId={`ops-connection-${c.id}`} className="flex flex-col p-4">
      <div className="flex items-start gap-3">
        <ConnectorMark name={name} />
        <div className="min-w-0">
          <p className="font-medium text-ink">{name}</p>
          {accountName ? (
            <p className="text-sm text-ink" data-testid="ops-connection-account">
              {accountName}
            </p>
          ) : c.externalAccountId?.includes("@") ? (
            // A mailbox's address names it; a provider's company id (a QuickBooks realm) never shows.
            <p className="text-sm text-ink-muted" data-testid="ops-connection-account">
              {c.externalAccountId}
            </p>
          ) : null}
        </div>
      </div>
      <p className="mt-3 flex items-center gap-2 text-sm text-ink-muted">
        <Badge tone={c.status === "connected" ? "positive" : "warning"}>
          {connectionStatusLabel(c.status)}
        </Badge>
        {c.lastSyncAt ? `synced ${shortTime(c.lastSyncAt)}` : "never synced"}
      </p>
      <p className="mt-2 text-sm text-ink-muted">
        {usedBy.length === 0
          ? "No agent uses it yet."
          : `Used by ${usedBy.map((u) => u.name).join(", ")}`}
      </p>
      {editing ? (
        <div className="mt-3">
          <label className="eyebrow text-ink-muted" htmlFor={`config-${c.id}`}>
            Configuration
          </label>
          <textarea
            id={`config-${c.id}`}
            data-testid="ops-connection-config-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={6}
            spellCheck={false}
            className="ds-textarea mt-1 font-mono text-xs"
          />
          {problem ? <ErrorNotice error={problem} /> : null}
          <div className="mt-2 flex gap-2">
            <Button
              data-testid="ops-connection-config-save"
              variant="primary"
              onClick={() => void save()}
            >
              Save configuration
            </Button>
            <Button
              data-testid="ops-connection-config-cancel"
              variant="ghost"
              onClick={() => {
                setText(saved);
                setProblem(null);
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-auto flex flex-wrap items-center gap-3 pt-4">
          <Button data-testid="ops-connection-config-edit" onClick={() => setEditing(true)}>
            Configuration
          </Button>
          {testEmail ? <GmailTestSend clientId={testEmail} /> : null}
          {c.lastSyncAt ? (
            <Link
              to={`/ops/clients/${c.tenantId}/records?source=${c.id}`}
              data-testid="ops-connection-records"
              className="ds-btn ds-btn--link text-sm"
            >
              See what it synced
            </Link>
          ) : null}
          {onDisconnect && !confirming ? (
            <Button
              data-testid="ops-connection-disconnect-start"
              variant="ghost"
              onClick={() => setConfirming(true)}
            >
              Disconnect
            </Button>
          ) : null}
        </div>
      )}
      {onDisconnect && confirming ? (
        <div className="ds-banner mt-3 block" data-testid="ops-connection-disconnect-confirm-box">
          <p>
            Agents stop using {name} until you connect it again. Its sign-in, if it has one, is
            revoked at {name} and dropped.
          </p>
          {disconnectProblem ? <ErrorNotice error={disconnectProblem} /> : null}
          <div className="mt-2 flex gap-2">
            <Button
              data-testid="ops-connection-disconnect-confirm"
              variant="primary"
              disabled={disconnecting}
              onClick={() => void disconnect()}
            >
              {disconnecting ? "Disconnecting…" : "Disconnect"}
            </Button>
            <Button
              data-testid="ops-connection-disconnect-cancel"
              variant="ghost"
              onClick={() => {
                setConfirming(false);
                setDisconnectProblem(null);
              }}
            >
              Keep it
            </Button>
          </div>
        </div>
      ) : null}
    </Card>
  );
}

function Offering({
  clientId,
  data,
  onSave,
  onConnect,
  onSignIn,
}: {
  clientId: string;
  data: Data;
  onSave: (offered: string[]) => Promise<void>;
  /** The Sandbox only: the operator connects a connector that needs no sign-in. */
  onConnect: (connector: string) => Promise<void>;
  /** The Sandbox only: the operator signs in to an offered OAuth connector themselves. */
  onSignIn: (connector: string) => Promise<void>;
}) {
  const known = data.offered.filter((id) => data.connectors.some((c) => c.id === id));
  const unknown = data.offered.filter((id) => !known.includes(id));
  const [offered, setOffered] = useState<string[]>(known);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  const savedKey = known.join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the saved offering or client changes.
  useEffect(() => setOffered(savedKey ? savedKey.split(",") : []), [savedKey, clientId]);
  const dirty = [...offered].sort().join(",") !== [...known].sort().join(",");
  const connected = new Set(
    data.connections.filter((c) => c.status === "connected").map((c) => c.connector),
  );

  return (
    <section>
      <SectionLabel>Offered to this client</SectionLabel>
      <Card testId="ops-connections-offering">
        <ul>
          {data.connectors.map((c) => {
            const on = offered.includes(c.id);
            return (
              <li
                key={c.id}
                className="flex items-start gap-3 border-b border-line px-4 py-3 last:border-b-0"
              >
                <input
                  id={`offer-${c.id}`}
                  type="checkbox"
                  data-testid={`ops-connections-offer-${c.id}-toggle`}
                  checked={on}
                  onChange={() =>
                    setOffered((o) => (on ? o.filter((x) => x !== c.id) : [...o, c.id]))
                  }
                  className="mt-1 size-4 accent-slate"
                />
                <label htmlFor={`offer-${c.id}`} className="min-w-0 flex-1">
                  <span className="font-medium text-ink">{c.name}</span>
                  <span className="block text-sm text-ink">{operatorBlurb(c.description)}</span>
                  <span className="block text-xs text-ink-muted">
                    {plural(c.tools.length, "tool")} ·{" "}
                    {AUTH_LINE[c.auth] ?? "the client connects it from their portal"}
                  </span>
                </label>
                {data.sandbox &&
                (c.auth === "none" || (c.auth === "oauth2" && known.includes(c.id))) ? (
                  connected.has(c.id) ? (
                    <Badge tone="positive">Connected</Badge>
                  ) : c.available ? (
                    <Button
                      data-testid={`ops-connections-connect-${c.id}`}
                      disabled={busy}
                      onClick={() => {
                        setBusy(true);
                        setProblem(null);
                        (c.auth === "none" ? onConnect(c.id) : onSignIn(c.id))
                          .catch(setProblem)
                          .finally(() => setBusy(false));
                      }}
                    >
                      Connect
                    </Button>
                  ) : (
                    <span
                      data-testid={`ops-connections-unavailable-${c.id}`}
                      className="shrink-0 text-sm text-ink-muted"
                    >
                      Not available yet
                    </span>
                  )
                ) : null}
              </li>
            );
          })}
          {unknown.length > 0 ? (
            <li className="px-4 py-3 text-sm text-ink-muted">
              {unknown.length === 1
                ? "One connector offered to this client isn't available here any more"
                : `${unknown.length} connectors offered to this client aren't available here any more`}
              ; saving the offering drops {unknown.length === 1 ? "it" : "them"}.
            </li>
          ) : null}
        </ul>
        {problem ? (
          <div className="px-4 pb-3">
            <ErrorNotice error={problem} />
          </div>
        ) : null}
        {dirty ? (
          <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3">
            <p className="text-sm text-ink-muted">
              Withdrawing an offer leaves an existing connection as it is.
            </p>
            <Button
              data-testid="ops-connections-offering-save"
              variant="primary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setProblem(null);
                onSave(offered)
                  .catch(setProblem)
                  .finally(() => setBusy(false));
              }}
            >
              Save offering
            </Button>
          </div>
        ) : null}
      </Card>
    </section>
  );
}
