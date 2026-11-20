// `/ops/clients/:clientId/connections`, the client's Connectors tab (docs/connectors-plan.md §7,
// §7.1, §7.2; design screen 2 in the back office): the same three parts as the portal (Connected,
// Built for you, Recommended), each connection with its account, status, access, the agents using
// it and their gaps, and the client's say over our changes; the open requests we sent (with
// Withdraw); the agents still waiting on something; and what we recommend to the client. A
// connector's own page (../connectors/ClientConnector.tsx) is where we change its access or setup:
// tighter applies at once, anything looser goes to the client to approve. The client signs in from
// the portal; we never connect a tool on a client's behalf and never see credentials. The one
// exception is the Sandbox client, our own test client: we connect its no-sign-in tools here, and
// sign in to its offered OAuth tools with our own account (the provider returns to
// `/ops/connections/:connector/callback`). The Sandbox's connected Gmail also sends a test email to
// itself from here (plan §1.31).
import {
  connectorAccessRoutes as access,
  type ConnectionSummaryView,
  type ConnectorCardView,
  type OpsAgentNeedsState,
} from "@countersign/core";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { ConnectorMark, connectionStatusLabel } from "../../connections/ConnectorMark";
import { shortTime } from "../../runs/format";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Loading,
  SectionLabel,
  Tag,
} from "../../ui/primitives";
import { plural } from "../../usage/format";
import { ClientFrame } from "../client/ClientFrame";
import { clientConnectorPath, OpenRequest } from "../connectors/ClientConnector";
import {
  AUTH_WORDS,
  accessWords,
  fixByWords,
  GAP_WORDS,
  mezonasMayWords,
} from "../connectors/words";

type Data = ResponseOf<typeof apiRoutes.opsClientConnections>;
type OldConnection = Data["connections"][number];

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
  const tab = useApi(access.opsClientConnectors, { params: { id: clientId } });
  // The offering, and the Sandbox's own connect, disconnect and test email, read the connections'
  // stored rows (last activity) beside the tab.
  const { data, error, loading, reload } = useApi(apiRoutes.opsClientConnections, {
    params: { id: clientId },
  });
  const client = useApi(apiRoutes.opsClient, { params: { id: clientId } });
  const clientName = client.data?.client.name ?? "the client";

  if ((loading && !data) || (tab.loading && !tab.data)) return <Loading />;
  if (error && !data) return <ErrorNotice error={error} onRetry={reload} />;
  if (!data) return null;
  const reloadAll = () => {
    reload();
    tab.reload();
  };

  const sandbox = tab.data?.sandbox ?? data.sandbox;
  const oldOf = (id: string) => data.connections.find((c) => c.id === id);
  return (
    <div>
      <p className="mb-6 text-ink-muted" data-testid="ops-connections-intro">
        {sandbox
          ? "Your own test client, so you connect its tools here. Test runs never write to them."
          : `What ${clientName} has connected, what agents may do in each, and what they still need. ${clientName} signs in from their portal; you never connect on their behalf. Open a connector to change it: tighter applies at once, anything looser goes to ${clientName} to approve.`}
      </p>
      <div className="flex flex-col gap-8">
        {tab.error ? <ErrorNotice error={tab.error} onRetry={tab.reload} /> : null}
        {tab.data ? (
          <>
            {tab.data.requests.length > 0 ? (
              <section data-testid="ops-connections-requests">
                <SectionLabel>
                  Requests waiting on {clientName} · {tab.data.requests.length}
                </SectionLabel>
                <div className="flex flex-col gap-2">
                  {tab.data.requests.map((r) => (
                    <OpenRequest
                      key={r.id}
                      clientId={clientId}
                      clientName={clientName}
                      request={r}
                      onChanged={reloadAll}
                      showConnector
                    />
                  ))}
                </div>
              </section>
            ) : null}

            {tab.data.agents.length > 0 ? (
              <AgentsWaiting clientId={clientId} clientName={clientName} agents={tab.data.agents} />
            ) : null}

            <section>
              <SectionLabel>
                Connected · {tab.data.connected.reduce((n, c) => n + c.connections.length, 0)}
              </SectionLabel>
              {tab.data.connected.length === 0 ? (
                <EmptyState>
                  {sandbox
                    ? "No connections yet. Connect a connector below."
                    : "No connections yet. Recommend a connector below; the client admin signs in from their portal."}
                </EmptyState>
              ) : (
                <ConnectorCards
                  testId="ops-connections-list"
                  clientId={clientId}
                  clientName={clientName}
                  cards={tab.data.connected}
                  sandbox={sandbox}
                  oldOf={oldOf}
                  onChanged={reloadAll}
                />
              )}
            </section>

            {tab.data.builtForYou.length > 0 ? (
              <section>
                <SectionLabel>Built for {clientName}</SectionLabel>
                <ConnectorCards
                  testId="ops-connections-built"
                  clientId={clientId}
                  clientName={clientName}
                  cards={tab.data.builtForYou}
                  sandbox={sandbox}
                  oldOf={oldOf}
                  onChanged={reloadAll}
                />
              </section>
            ) : null}

            {tab.data.recommended.length > 0 ? (
              <Recommended
                clientId={clientId}
                cards={tab.data.recommended}
                agents={tab.data.agents}
              />
            ) : null}
          </>
        ) : null}

        <Offering
          clientId={clientId}
          data={{ ...data, sandbox }}
          onConnect={async (connector) => {
            await api.call(apiRoutes.opsConnectSandbox, { params: { id: clientId, connector } });
            reloadAll();
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
            reloadAll();
          }}
        />
      </div>
    </div>
  );
}

/** Each client agent still waiting on something, with its gaps and who fixes each. */
function AgentsWaiting({
  clientId,
  clientName,
  agents,
}: {
  clientId: string;
  clientName: string;
  agents: readonly OpsAgentNeedsState[];
}) {
  return (
    <section data-testid="ops-connections-agents">
      <SectionLabel>Agents waiting on connectors · {agents.length}</SectionLabel>
      <Card>
        <ul>
          {agents.map((a) => (
            <li
              key={a.agent.id}
              className="flex flex-col gap-1 border-b border-line px-4 py-3 last:border-b-0"
            >
              <p className="flex items-center gap-2">
                <span className="font-medium text-ink">{a.agent.name}</span>
                {a.ready ? (
                  <Badge tone="positive">Ready</Badge>
                ) : (
                  <Badge tone="warning">Waiting</Badge>
                )}
              </p>
              <ul className="text-sm text-ink">
                {a.gaps.map((g) => (
                  <li key={`${g.kind}:${g.connector}:${g.words}`} className="flex flex-wrap gap-2">
                    <Link
                      to={clientConnectorPath(clientId, g.connector, a.agent.id)}
                      className="text-link hover:underline"
                    >
                      {g.words}
                    </Link>
                    <span className="text-ink-muted">
                      {GAP_WORDS[g.kind]} · {fixByWords(g.fixBy, clientName)} fix
                      {g.fixBy === "mezonas" ? "" : "es"} it
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}

function ConnectorCards({
  testId,
  clientId,
  clientName,
  cards,
  sandbox,
  oldOf,
  onChanged,
}: {
  testId: string;
  clientId: string;
  clientName: string;
  cards: readonly ConnectorCardView[];
  sandbox: boolean;
  oldOf(id: string): OldConnection | undefined;
  onChanged(): void;
}) {
  const api = useApiClient();
  return (
    <div data-testid={testId} className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
      {cards.flatMap((card) =>
        (card.connections.length > 0 ? card.connections : [null]).map((c) =>
          c ? (
            <ConnectionCard
              key={c.id}
              clientId={clientId}
              clientName={clientName}
              card={card}
              connection={c}
              old={oldOf(c.id)}
              sandbox={sandbox}
              {...(sandbox && c.status !== "disconnected"
                ? {
                    onDisconnect: async () => {
                      await api.call(apiRoutes.opsSandboxDisconnect, {
                        params: { id: clientId, connectionId: c.id },
                      });
                      onChanged();
                    },
                  }
                : {})}
            />
          ) : (
            <NotConnectedCard key={card.connector} clientId={clientId} card={card} />
          ),
        ),
      )}
    </div>
  );
}

function NotConnectedCard({ clientId, card }: { clientId: string; card: ConnectorCardView }) {
  return (
    <Card testId={`ops-connector-${card.connector}`} className="flex flex-col p-4">
      <div className="flex items-start gap-3">
        <ConnectorMark name={card.name} connector={card.connector} />
        <div className="min-w-0">
          <p className="font-medium text-ink">{card.name}</p>
          <p className="text-sm text-ink-muted">{operatorBlurb(card.description)}</p>
        </div>
      </div>
      <p className="mt-3 text-sm text-ink-muted">
        Not connected · {AUTH_WORDS[card.auth] ?? "the client connects it from their portal"}
      </p>
      <div className="mt-auto pt-4">
        <Link
          to={clientConnectorPath(clientId, card.connector)}
          className="ds-btn ds-btn--link text-sm"
        >
          Open
        </Link>
      </div>
    </Card>
  );
}

/** The connectors recommended to the client and not connected, with the agents that need each. */
function Recommended({
  clientId,
  cards,
  agents,
}: {
  clientId: string;
  cards: readonly ConnectorCardView[];
  agents: readonly OpsAgentNeedsState[];
}) {
  const needing = (connector: string) =>
    agents
      .filter((a) => a.gaps.some((g) => g.connector === connector && g.kind === "not_connected"))
      .map((a) => a.agent);
  return (
    <section data-testid="ops-connections-recommended">
      <SectionLabel>Recommended</SectionLabel>
      <Card>
        <ul>
          {cards.map((c) => {
            const who = needing(c.connector);
            return (
              <li
                key={c.connector}
                data-testid={`ops-recommended-${c.connector}`}
                className="flex items-start gap-3 border-b border-line px-4 py-3 last:border-b-0"
              >
                <ConnectorMark name={c.name} connector={c.connector} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2">
                    <Link
                      to={clientConnectorPath(clientId, c.connector, who[0]?.id)}
                      className="font-medium text-ink hover:underline"
                    >
                      {c.name}
                    </Link>
                    {c.beta ? <Tag>Beta</Tag> : null}
                    {who.length > 0 ? (
                      <Badge tone="warning">
                        {who.map((a) => a.name).join(", ")} {who.length === 1 ? "needs" : "need"} it
                      </Badge>
                    ) : null}
                  </p>
                  <p className="text-sm text-ink-muted">
                    {operatorBlurb(c.description)}{" "}
                    {AUTH_WORDS[c.auth] ? `· ${AUTH_WORDS[c.auth]}` : ""}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      </Card>
    </section>
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

/** Upload and email forwarding: built in, nothing syncs; documents come through them. */
// DECISION: named here as the portal's Accounts names it; the API says which is built in by its
// last activity (the last document), so only the words differ.
const BUILT_IN_SOURCES = new Set(["upload"]);

/** "synced 2 h ago", or for upload and forwarding "last document 2 h ago" (never "never synced"). */
function activityWords(
  connector: string,
  c: Pick<ConnectionSummaryView, "lastSyncAt">,
  old: OldConnection | undefined,
): string {
  const at = old?.lastActivityAt === undefined ? c.lastSyncAt : old.lastActivityAt;
  if (BUILT_IN_SOURCES.has(connector)) {
    return at ? `last document ${shortTime(at)}` : "no documents yet";
  }
  return at ? `synced ${shortTime(at)}` : "never synced";
}

function ConnectionCard({
  clientId,
  clientName,
  card,
  connection: c,
  old,
  sandbox,
  onDisconnect,
}: {
  clientId: string;
  clientName: string;
  card: ConnectorCardView;
  connection: ConnectionSummaryView;
  /** The connection's stored row (last activity), when the older list has loaded. */
  old: OldConnection | undefined;
  sandbox: boolean;
  /** The Sandbox only: the operator disconnects what they connected (after a confirm step). */
  onDisconnect?: () => Promise<void>;
}) {
  const name = card.name;
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
  const testEmail = sandbox && card.connector === "gmail" && c.status === "connected";

  return (
    <Card testId={`ops-connection-${c.id}`} className="flex flex-col p-4">
      <div className="flex items-start gap-3">
        <ConnectorMark name={name} connector={card.connector} />
        <div className="min-w-0">
          <p className="font-medium text-ink">
            {name}
            {card.beta ? <Tag className="ml-2">Beta</Tag> : null}
          </p>
          {/* The company or the mailbox's address; a provider's company id never shows. */}
          {c.accountName ? (
            <p className="text-sm text-ink" data-testid="ops-connection-account">
              {c.accountName}
            </p>
          ) : null}
        </div>
      </div>
      <p className="mt-3 flex flex-wrap items-center gap-2 text-sm text-ink-muted">
        <Badge tone={c.status === "connected" ? "positive" : "warning"}>
          {connectionStatusLabel(c.status)}
        </Badge>
        {activityWords(card.connector, c, old)}
      </p>
      <p className="mt-2 text-sm text-ink" data-testid="ops-connection-access">
        {accessWords(c.access)}
      </p>
      <p className="mt-1 text-sm text-ink-muted">
        {c.usedBy.length === 0
          ? "No agent uses it yet."
          : `Used by ${c.usedBy.map((u) => u.name).join(", ")}`}
      </p>
      {c.needsSomething || c.openRequest ? (
        <p className="mt-2 flex flex-wrap gap-2">
          {c.needsSomething ? (
            <Badge tone="warning" testId="ops-connection-needs">
              An agent needs something here
            </Badge>
          ) : null}
          {c.openRequest ? (
            <Badge tone="warning" testId="ops-connection-open-request">
              Waiting on {clientName}
            </Badge>
          ) : null}
        </p>
      ) : null}
      {sandbox ? null : (
        <p className="mt-2 text-sm text-ink-muted" data-testid="ops-connection-may">
          {mezonasMayWords(clientName, c.mezonasMay)}
        </p>
      )}
      <div className="mt-auto flex flex-wrap items-center gap-3 pt-4">
        <Link
          to={clientConnectorPath(clientId, card.connector)}
          data-testid="ops-connection-open"
          className="ds-btn ds-btn--secondary"
        >
          Access and setup
        </Link>
        {testEmail ? <GmailTestSend clientId={clientId} /> : null}
        {c.lastSyncAt ? (
          <Link
            to={`/ops/clients/${clientId}/records?source=${c.id}`}
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
      <SectionLabel>Recommended to this client</SectionLabel>
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
                    {AUTH_WORDS[c.auth] ?? "the client connects it from their portal"}
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
              ; saving drops {unknown.length === 1 ? "it" : "them"}.
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
              Recommended connectors show first in the client's portal. Taking one off leaves an
              existing connection as it is.
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
              Save recommendations
            </Button>
          </div>
        ) : null}
      </Card>
    </section>
  );
}
