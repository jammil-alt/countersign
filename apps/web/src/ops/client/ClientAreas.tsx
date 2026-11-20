// The client page's Areas tab (docs/plan.md §1.162, owner 2026-11-20): the business areas a client
// can have (Purchasing, Bookkeeping, Marketing; each a pack in the code), whether each is on with
// the switch, the connections each area works through with this client's status and the way to
// connect or fix one, and its reports. Setup's Connections folded in here: a connection no area
// uses is under Other connections, and the permission matrix and the offering follow. The old
// addresses (`…/packs`, `…/connections`) redirect here.
import { type ReactNode, useState } from "react";
import { useParams } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { ConnectorMark, connectionStatusLabel } from "../../connections/ConnectorMark";
import { PackReportLinks } from "../../packs/materials/Reports";
import { EnableButton, ImportBillPrices } from "../../packs/opsScreens";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Loading,
  SectionLabel,
} from "../../ui/primitives";
import { StatusChip } from "../../ui/status";
import {
  activityWords,
  type ClientConnection,
  ClientConnectionCard,
  type ClientConnections,
  ClientConnectionsMatrix,
  ClientOffering,
  connectSandbox,
  useClientConnections,
} from "../screens/Connections";
import { ClientFrame, clientPagePath } from "./ClientFrame";

type Area = ResponseOf<typeof apiRoutes.opsClientPacks>["packs"][number];
type Need = Area["connections"][number];

export function OpsClientAreasScreen() {
  const { clientId = "" } = useParams();
  return (
    <ClientFrame clientId={clientId}>
      <ClientAreas clientId={clientId} />
    </ClientFrame>
  );
}

/** The connector ids any area works through. */
// DECISION: "other" means no area names the connector, whether that area is on or off: an area
// that's off still lists what it would need, so a connection never moves when an area is switched.
// An area's own connection shows as a row with its status, and its full card (configuration, what
// it synced, the Sandbox's actions) opens in place under Manage rather than being drawn twice.
function areaConnectors(areas: readonly Area[]): Set<string> {
  return new Set(areas.flatMap((a) => a.connections.flatMap((n) => n.connectors)));
}

export function ClientAreas({ clientId }: { clientId: string }) {
  const areas = useApi(apiRoutes.opsClientPacks, { params: { id: clientId } });
  const connections = useClientConnections(clientId);
  const data = connections.data;
  // Until both answer, nothing: an area's connections need the client's, and which connections
  // are "other" needs the areas. A failed list shows its error and the other part still shows.
  const areasSettled = areas.data !== undefined || Boolean(areas.error);
  const connectionsSettled = data !== undefined || Boolean(connections.error);
  if (!areasSettled || !connectionsSettled) return <Loading />;
  const list = areas.data?.packs ?? [];
  const used = areaConnectors(list);
  const other = data?.connections.filter((c) => !used.has(c.connector)) ?? [];

  return (
    <div className="flex flex-col gap-8" data-testid="ops-client-areas">
      <p className="text-ink-muted" data-testid="ops-connections-intro">
        {data?.sandbox
          ? "Your own test client, so you connect its tools here. Test runs never write to them."
          : "The business areas this client has, the connections each works through, and what agents may do in each. The client signs in from their portal; you never connect on their behalf."}
      </p>

      <section data-testid="ops-client-areas-list">
        <SectionLabel>Areas</SectionLabel>
        {areas.error ? (
          <ErrorNotice error={areas.error} onRetry={areas.reload} />
        ) : list.length === 0 ? (
          <EmptyState>This deployment has no business areas.</EmptyState>
        ) : (
          <div className="flex flex-col gap-3">
            {list.map((area) => (
              <AreaCard
                key={area.id}
                clientId={clientId}
                area={area}
                connections={data ?? null}
                onChanged={() => {
                  areas.reload();
                  connections.reload();
                }}
              />
            ))}
          </div>
        )}
      </section>

      {connections.error ? (
        <ErrorNotice error={connections.error} onRetry={connections.reload} />
      ) : data ? (
        <>
          <section data-testid="ops-connections-other">
            <SectionLabel>Other connections · {other.length}</SectionLabel>
            {other.length === 0 ? (
              <p className="text-sm text-ink-muted">
                {data.connections.length === 0
                  ? data.sandbox
                    ? "No connections yet. Connect a connector below."
                    : "No connections yet. Offer a connector below; the client admin signs in from their portal."
                  : "Every connection is used by an area above."}
              </p>
            ) : (
              <div
                data-testid="ops-connections-list"
                className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3"
              >
                {other.map((c) => (
                  <ClientConnectionCard
                    key={c.id}
                    clientId={clientId}
                    data={data}
                    connection={c}
                    reload={connections.reload}
                  />
                ))}
              </div>
            )}
          </section>
          <ClientConnectionsMatrix
            data={data}
            entitiesOf={connections.entitiesOf}
            reload={connections.reload}
          />
          <ClientOffering clientId={clientId} data={data} reload={connections.reload} />
        </>
      ) : null}
    </div>
  );
}

function AreaCard({
  clientId,
  area,
  connections,
  onChanged,
}: {
  clientId: string;
  area: Area;
  /** The client's connections, or null when they couldn't be loaded. */
  connections: ClientConnections | null;
  onChanged: () => void;
}) {
  const name = area.area ?? area.name;
  return (
    <Card className="p-5" testId={`ops-client-area-${area.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-medium text-ink">{name}</h3>
          <p className="max-w-2xl text-sm text-ink-muted">{area.description}</p>
        </div>
        {area.enabled ? (
          <Badge tone="positive" testId={`ops-client-area-on-${area.id}`}>
            On
          </Badge>
        ) : (
          <EnableButton clientId={clientId} pack={area.id} onDone={onChanged} />
        )}
      </div>
      {connections && area.connections.length > 0 ? (
        <div className="mt-4">
          <SectionLabel>Connections it works through</SectionLabel>
          <ul className="flex flex-col divide-y divide-line rounded-sm border border-line">
            {area.connections.map((need) => (
              <NeedRow
                key={need.connectors.join("|")}
                clientId={clientId}
                areaId={area.id}
                need={need}
                data={connections}
                onChanged={onChanged}
              />
            ))}
          </ul>
        </div>
      ) : null}
      {area.enabled && area.screens.length > 0 ? (
        <div className="mt-4">
          <SectionLabel>Reports</SectionLabel>
          <PackReportLinks screens={area.screens} base={clientPagePath(clientId, "")} />
        </div>
      ) : null}
      {/* P-9 */}
      {area.enabled && area.id === "materials" ? <ImportBillPrices clientId={clientId} /> : null}
    </Card>
  );
}

/** The client's connection that meets a need: a working one first, then any still there. */
export function connectionFor(
  need: Need,
  connections: readonly ClientConnection[],
): ClientConnection | null {
  const mine = connections.filter((c) => need.connectors.includes(c.connector));
  return (
    mine.find((c) => c.status === "connected") ??
    mine.find((c) => c.status !== "disconnected") ??
    mine[0] ??
    null
  );
}

/** One connection an area works through: this client's status, and the way to connect or fix it. */
function NeedRow({
  clientId,
  areaId,
  need,
  data,
  onChanged,
}: {
  clientId: string;
  areaId: string;
  need: Need;
  data: ClientConnections;
  onChanged: () => void;
}) {
  const api = useApiClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  // Only the connectors this deployment registers; an area naming none of them shows nothing.
  const known = need.connectors
    .map((id) => data.connectors.find((c) => c.id === id))
    .filter((c): c is ClientConnections["connectors"][number] => c !== undefined);
  if (known.length === 0) return null;
  const connection = connectionFor(need, data.connections);
  const offeredOne = known.find((c) => data.offered.includes(c.id));
  // The connector the row is about: the client's connection's, else the one offered, else the first.
  const connector =
    known.find((c) => c.id === connection?.connector) ??
    offeredOne ??
    (known[0] as (typeof known)[number]);
  const title = connection || offeredOne ? connector.name : known.map((c) => c.name).join(" or ");
  const connected = connection?.status === "connected";
  const broken = connection?.status === "error";
  const testId = `ops-area-connection-${areaId}-${connector.id}`;

  async function act(run: () => Promise<void>) {
    setBusy(true);
    setProblem(null);
    try {
      await run();
    } catch (e) {
      setProblem(e);
    } finally {
      setBusy(false);
    }
  }

  // What the operator can do about it: the Sandbox's own Connect, offering it to a real client,
  // or the client's sign-in from their portal.
  let action: ReactNode = null;
  if (!connected) {
    const canConnect =
      data.sandbox && (connector.auth === "none" || (connector.auth === "oauth2" && offeredOne));
    if (!offeredOne && !(data.sandbox && connector.auth === "none")) {
      action = (
        <Button
          size="sm"
          data-testid={`${testId}-offer`}
          disabled={busy}
          onClick={() =>
            void act(async () => {
              await api.call(apiRoutes.opsOfferConnectors, {
                params: { id: clientId },
                body: {
                  offered: [
                    ...data.offered.filter((id) => data.connectors.some((c) => c.id === id)),
                    connector.id,
                  ],
                },
              });
              onChanged();
            })
          }
        >
          Offer {connector.name}
        </Button>
      );
    } else if (canConnect) {
      action = connector.available ? (
        <Button
          size="sm"
          data-testid={`${testId}-connect`}
          disabled={busy}
          onClick={() => void act(() => connectSandbox(api, clientId, connector, onChanged))}
        >
          {broken ? "Connect again" : "Connect"}
        </Button>
      ) : (
        <span className="text-sm text-ink-muted">Not available yet</span>
      );
    } else {
      action = (
        <span className="text-sm text-ink-muted" data-testid={`${testId}-client`}>
          {broken
            ? "The client signs in again from their portal"
            : "Offered; the client signs in from their portal"}
        </span>
      );
    }
  }

  return (
    <li className="px-4 py-3" data-testid={testId}>
      <div className="flex flex-wrap items-center gap-3">
        <ConnectorMark name={connector.name} connector={connector.id} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-ink">{title}</p>
          <p className="text-sm text-ink-muted">{need.use}</p>
        </div>
        <span className="flex flex-wrap items-center gap-2">
          <ConnectionState connection={connection} />
          {connection ? (
            <span className="text-sm text-ink-muted">{activityWords(connection)}</span>
          ) : null}
        </span>
        <span className="flex flex-wrap items-center gap-2">
          {action}
          {connection ? (
            <Button
              size="sm"
              variant="ghost"
              data-testid={`${testId}-manage`}
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
            >
              {open ? "Hide" : "Manage"}
            </Button>
          ) : null}
        </span>
      </div>
      {problem ? (
        <div className="mt-2">
          <ErrorNotice error={problem} />
        </div>
      ) : null}
      {open && connection ? (
        <div className="mt-3">
          <ClientConnectionCard
            clientId={clientId}
            data={data}
            connection={connection}
            reload={onChanged}
          />
        </div>
      ) : null}
    </li>
  );
}

/** The connection's state as a chip, in words: done when connected, risk when it needs fixing. */
function ConnectionState({ connection }: { connection: ClientConnection | null }) {
  if (!connection) return <StatusChip state="setup">Not connected</StatusChip>;
  const state =
    connection.status === "connected"
      ? "done"
      : connection.status === "error"
        ? "blocked"
        : "setup";
  return <StatusChip state={state}>{connectionStatusLabel(connection.status)}</StatusChip>;
}
