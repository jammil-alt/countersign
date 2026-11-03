// `/ops/clients/:clientId/connections` (design screen 2 in the back office; ARCHITECTURE §6.1 "Who
// does what"): which connectors the client is offered, the client's connections with their sync
// state and who uses them, the permission matrix (the operator may loosen as well as tighten) and
// each connection's configuration. The client signs in from the portal; the operator never
// connects a tool on a client's behalf and never sees credentials. The one exception is the Sandbox
// client, the operator's own test client, whose no-sign-in tools the operator connects here.
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { ConnectorMark, connectionStatusLabel } from "../../connections/ConnectorMark";
import { MatrixTable } from "../../connections/MatrixTable";
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

type Data = ResponseOf<typeof apiRoutes.opsClientConnections>;

export function OpsConnectionsScreen() {
  const { clientId = "" } = useParams();
  const api = useApiClient();
  const session = useSession();
  const clientName = session.tenants.find((t) => t.id === clientId)?.name ?? "This client";
  const { data, error, loading, reload } = useApi(apiRoutes.opsClientConnections, {
    params: { id: clientId },
  });

  if (loading && !data) return <Loading />;
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!data) return null;

  const names = Object.fromEntries(data.connectors.map((c) => [c.id, c.name]));
  return (
    <div>
      <PageHeader
        title="Connections"
        subtitle={
          data.sandbox
            ? `${clientName}: your own test client, so you connect its tools here. Test runs never write to them.`
            : `${clientName}: the tools offered, what is connected, and what agents may do in each. The client signs in from their portal; you never connect on their behalf.`
        }
      />
      <div className="flex flex-col gap-6">
        <section>
          <SectionLabel>
            Connected · {data.connections.filter((c) => c.status === "connected").length}
          </SectionLabel>
          {data.connections.length === 0 ? (
            <EmptyState>
              {data.sandbox
                ? "No connections yet. Connect a connector below."
                : "No connections yet. Offer a connector below; the client admin signs in from the portal's Connections page."}
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

function ConnectionCard({
  connection: c,
  name,
  usedBy,
  onSaveConfig,
}: {
  connection: Data["connections"][number];
  name: string;
  usedBy: { id: string; name: string }[];
  onSaveConfig: (config: Record<string, unknown>) => Promise<void>;
}) {
  const saved = JSON.stringify(c.config, null, 2);
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
          <p className="font-semibold text-primary">{name}</p>
          <p className="text-sm text-secondary">{c.externalAccountId ?? c.connector}</p>
        </div>
      </div>
      <p className="mt-3 flex items-center gap-2 text-sm text-secondary">
        <Badge tone={c.status === "connected" ? "positive" : "warning"}>
          {connectionStatusLabel(c.status)}
        </Badge>
        {c.lastSyncAt ? `synced ${shortTime(c.lastSyncAt)}` : "never synced"}
      </p>
      <p className="mt-2 text-sm text-secondary">
        {usedBy.length === 0
          ? "No agent uses it yet."
          : `Used by ${usedBy.map((u) => u.name).join(", ")}`}
      </p>
      {editing ? (
        <div className="mt-3">
          <label className="label-caps text-secondary" htmlFor={`config-${c.id}`}>
            Configuration
          </label>
          <textarea
            id={`config-${c.id}`}
            data-testid="ops-connection-config-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={6}
            spellCheck={false}
            className="mt-1 w-full rounded-sm border border-control bg-card px-3 py-2 font-mono text-xs text-primary"
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
        <div className="mt-auto pt-4">
          <Button data-testid="ops-connection-config-edit" onClick={() => setEditing(true)}>
            Configuration
          </Button>
        </div>
      )}
    </Card>
  );
}

function Offering({
  clientId,
  data,
  onSave,
  onConnect,
}: {
  clientId: string;
  data: Data;
  onSave: (offered: string[]) => Promise<void>;
  /** The Sandbox only: the operator connects its tools (no-sign-in connectors today). */
  onConnect: (connector: string) => Promise<void>;
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
                className="flex items-start gap-3 border-b border-divider px-4 py-3 last:border-b-0"
              >
                <input
                  id={`offer-${c.id}`}
                  type="checkbox"
                  data-testid={`ops-connections-offer-${c.id}-toggle`}
                  checked={on}
                  onChange={() =>
                    setOffered((o) => (on ? o.filter((x) => x !== c.id) : [...o, c.id]))
                  }
                  className="mt-1"
                />
                <label htmlFor={`offer-${c.id}`} className="min-w-0 flex-1">
                  <span className="font-medium text-primary">{c.name}</span>
                  <span className="ml-2 font-mono text-xs text-secondary">{c.id}</span>
                  <span className="block text-sm text-body">{c.description}</span>
                  <span className="block text-xs text-secondary">
                    {c.tools.length} tools ·{" "}
                    {c.auth === "none" ? "no sign-in needed" : `signs in with ${c.auth}`}
                  </span>
                </label>
                {data.sandbox && c.auth === "none" ? (
                  connected.has(c.id) ? (
                    <Badge tone="positive">Connected</Badge>
                  ) : (
                    <Button
                      data-testid={`ops-connections-connect-${c.id}`}
                      disabled={busy}
                      onClick={() => {
                        setBusy(true);
                        setProblem(null);
                        onConnect(c.id)
                          .catch(setProblem)
                          .finally(() => setBusy(false));
                      }}
                    >
                      Connect
                    </Button>
                  )
                ) : null}
              </li>
            );
          })}
          {unknown.map((id) => (
            <li key={id} className="px-4 py-3 text-sm text-secondary">
              <span className="font-mono">{id}</span>: offered, but this deployment does not have
              it; saving the offering drops it.
            </li>
          ))}
        </ul>
        {problem ? (
          <div className="px-4 pb-3">
            <ErrorNotice error={problem} />
          </div>
        ) : null}
        {dirty ? (
          <div className="flex items-center justify-between gap-3 border-t border-edge px-4 py-3">
            <p className="text-sm text-secondary">
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
