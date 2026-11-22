// The client page's Areas tab (docs/plan.md §1.162, owner 2026-11-20): the business areas a client
// can have (Purchasing, Bookkeeping, Marketing; each a pack in the code), whether each is on with
// the switch, the connections each area needs with this client's status, and its reports. The
// client's connections have one place, Setup's Connectors (§1.161): each need links to its
// connector there, and nothing here changes a connection. The old address (`…/packs`) redirects
// here.
import {
  connectorAccessRoutes as access,
  type ConnectionSummaryView,
  type ConnectorCardView,
} from "@countersign/core";
import { lazy, Suspense, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { ConnectorMark, connectionStatusLabel } from "../../connections/ConnectorMark";
import { PackReportLinks } from "../../packs/materials/Reports";
import { EnableButton, ImportBillPrices } from "../../packs/opsScreens";
import {
  Badge,
  Button,
  buttonClass,
  Card,
  EmptyState,
  ErrorNotice,
  Loading,
  SectionLabel,
} from "../../ui/primitives";
import { StatusChip } from "../../ui/status";
import { clientConnectorPath } from "../connectors/ClientConnector";
import { ClientFrame, clientPagePath } from "./ClientFrame";

// §1.230: a pack's settings, loaded only for a pack that has some.
const PackSettings = lazy(() => import("../../packs/PackSettings"));

type Area = ResponseOf<typeof apiRoutes.opsClientPacks>["packs"][number];
type Need = Area["connections"][number];
type ClientConnections = ResponseOf<typeof apiRoutes.opsClientConnections>;
type ClientConnection = ClientConnections["connections"][number];

export function OpsClientAreasScreen() {
  const { clientId = "" } = useParams();
  return (
    <ClientFrame
      clientId={clientId}
      intro="The business areas this client can have, the connections each needs and its reports. Connections change on Setup, Connectors."
    >
      <ClientAreas clientId={clientId} />
    </ClientFrame>
  );
}

export function ClientAreas({ clientId }: { clientId: string }) {
  const areas = useApi(apiRoutes.opsClientPacks, { params: { id: clientId } });
  // The client's connections and what is offered (recommended) to it, and the Connectors tab's
  // flags on each connection (§1.161: an agent's gaps, a request waiting on the client).
  const connections = useApi(apiRoutes.opsClientConnections, { params: { id: clientId } });
  const tab = useApi(access.opsClientConnectors, { params: { id: clientId } });
  if (areas.error) return <ErrorNotice error={areas.error} onRetry={areas.reload} />;
  if (!areas.data || (!connections.data && !connections.error)) return <Loading />;
  const list = areas.data.packs;
  if (list.length === 0) return <EmptyState>This deployment has no business areas.</EmptyState>;
  const summaries = new Map<string, ConnectionSummaryView>();
  for (const card of [
    ...(tab.data?.connected ?? []),
    ...(tab.data?.builtForYou ?? []),
    ...(tab.data?.recommended ?? []),
  ] satisfies ConnectorCardView[]) {
    for (const c of card.connections) summaries.set(c.id, c);
  }
  const reloadAll = () => {
    areas.reload();
    connections.reload();
    tab.reload();
  };

  return (
    <section className="flex flex-col gap-3" data-testid="ops-client-areas">
      {connections.error ? (
        <ErrorNotice error={connections.error} onRetry={connections.reload} />
      ) : null}
      {list.map((area) => (
        <AreaCard
          key={area.id}
          clientId={clientId}
          area={area}
          connections={connections.data ?? null}
          summaries={summaries}
          onChanged={reloadAll}
        />
      ))}
    </section>
  );
}

function AreaCard({
  clientId,
  area,
  connections,
  summaries,
  onChanged,
}: {
  clientId: string;
  area: Area;
  /** The client's connections, or null when they couldn't be loaded. */
  connections: ClientConnections | null;
  summaries: ReadonlyMap<string, ConnectionSummaryView>;
  onChanged: () => void;
}) {
  return (
    <Card className="p-5" testId={`ops-client-area-${area.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-medium text-ink">{area.area ?? area.name}</h3>
          <p className="max-w-2xl text-sm text-ink-muted">{area.description}</p>
        </div>
        {area.enabled ? (
          <Badge tone="positive" testId={`ops-client-area-on-${area.id}`}>
            On
          </Badge>
        ) : area.config.fields.length === 0 ? (
          <EnableButton clientId={clientId} pack={area.id} onDone={onChanged} />
        ) : null}
      </div>
      {area.config.fields.length > 0 ? (
        <Suspense fallback={null}>
          <PackSettings clientId={clientId} area={area} onChanged={onChanged} />
        </Suspense>
      ) : null}
      {area.processors.length > 0 ? <Vendors area={area} /> : null}
      {connections && area.connections.length > 0 ? (
        <div className="mt-4">
          <SectionLabel>Connections it needs</SectionLabel>
          <ul className="flex flex-col divide-y divide-line rounded-sm border border-line">
            {area.connections.map((need) => (
              <NeedRow
                key={need.connectors.join("|")}
                clientId={clientId}
                areaId={area.id}
                need={need}
                data={connections}
                summaries={summaries}
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

/**
 * §1.230: the vendors of ours the area sends this client's data to, beyond its steps' models and
 * its connections; one HIPAA mode holds back says so (its features refuse it where they're used).
 */
function Vendors({ area }: { area: Area }) {
  const held = area.processors.filter((p) => p.heldForHipaa);
  return (
    <p
      className="mt-3 flex flex-wrap items-center gap-2 text-sm text-ink-muted"
      data-testid={`ops-client-area-vendors-${area.id}`}
    >
      Also sends data to {area.processors.map((p) => p.name).join(", ")}.
      {held.length > 0 ? (
        <Badge tone="warning" testId={`ops-client-area-held-${area.id}`}>
          Held in HIPAA mode: {held.map((p) => p.name).join(", ")}
        </Badge>
      ) : null}
    </p>
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

/**
 * One connection an area needs: this client's status, and the way to it on Setup's Connectors.
 * A connector not yet recommended to the client can be recommended from here.
 */
// DECISION: the row only reads and links. Connecting, access and setup change on the connector's
// own page (§1.161, the one place); recommending is the one write here, the same offering list
// Connectors saves, since an area is the usual reason to recommend a connector.
function NeedRow({
  clientId,
  areaId,
  need,
  data,
  summaries,
  onChanged,
}: {
  clientId: string;
  areaId: string;
  need: Need;
  data: ClientConnections;
  summaries: ReadonlyMap<string, ConnectionSummaryView>;
  onChanged: () => void;
}) {
  const api = useApiClient();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  // Only the connectors this deployment registers; an area naming none of them shows nothing.
  const known = need.connectors
    .map((id) => data.connectors.find((c) => c.id === id))
    .filter((c): c is ClientConnections["connectors"][number] => c !== undefined);
  const first = known[0];
  if (!first) return null;
  const connection = connectionFor(need, data.connections);
  const offeredOne = known.find((c) => data.offered.includes(c.id));
  // The connector the row is about: the client's connection's, else the one offered, else the first.
  const connector = known.find((c) => c.id === connection?.connector) ?? offeredOne ?? first;
  const title = connection || offeredOne ? connector.name : known.map((c) => c.name).join(" or ");
  const summary = connection ? summaries.get(connection.id) : undefined;
  const testId = `ops-area-connection-${areaId}-${connector.id}`;

  async function recommend() {
    setBusy(true);
    setProblem(null);
    try {
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
    } catch (e) {
      setProblem(e);
    } finally {
      setBusy(false);
    }
  }

  const connected = connection?.status === "connected";
  const note = connected
    ? null
    : connection?.status === "error"
      ? "The client signs in again from their portal"
      : offeredOne
        ? "Recommended; the client signs in from their portal"
        : null;

  return (
    <li className="px-4 py-3" data-testid={testId}>
      <div className="flex flex-wrap items-center gap-3">
        <ConnectorMark name={connector.name} connector={connector.id} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-ink">{title}</p>
          <p className="text-sm text-ink-muted">{need.use}</p>
          {note ? (
            <p className="text-sm text-ink-muted" data-testid={`${testId}-note`}>
              {note}
            </p>
          ) : null}
        </div>
        <span className="flex flex-wrap items-center gap-2">
          <ConnectionState connection={connection} />
          {summary?.needsSomething ? (
            <Badge tone="warning" testId={`${testId}-needs`}>
              An agent needs something here
            </Badge>
          ) : null}
          {summary?.openRequest ? (
            <Badge tone="warning" testId={`${testId}-request`}>
              Waiting on the client
            </Badge>
          ) : null}
        </span>
        <span className="flex flex-wrap items-center gap-2">
          {!connected && !offeredOne ? (
            <Button
              size="sm"
              data-testid={`${testId}-recommend`}
              disabled={busy}
              onClick={() => void recommend()}
            >
              Recommend
            </Button>
          ) : null}
          <Link
            to={clientConnectorPath(clientId, connector.id)}
            className={buttonClass("ghost")}
            data-testid={`${testId}-open`}
          >
            Open in Connectors
          </Link>
        </span>
      </div>
      {problem ? (
        <div className="mt-2">
          <ErrorNotice error={problem} />
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
