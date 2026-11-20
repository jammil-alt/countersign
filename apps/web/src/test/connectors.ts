// Connectors C5: test data shaped as the portal's connector routes answer
// (`packages/core/src/api/connector-access.ts`), with only what a test cares about given.
import type {
  AccessRowView,
  ChangeRequestView,
  ConnectionPageView,
  ConnectionSummaryView,
  ConnectorCardView,
  MezonasMayView,
} from "@countersign/core";

export const NO_ACCESS = { reads: 0, changesAsk: 0, changesAuto: 0 };

/** A row of What agents can do. */
export function accessRow(
  o: Partial<AccessRowView> & Pick<AccessRowView, "verb" | "label">,
): AccessRowView {
  const read = o.verb === "read";
  return {
    group: read ? "read" : "change",
    entity: null,
    level: read ? "auto" : "approval",
    choices: read ? ["auto", "off"] : ["approval", "off"],
    scope: null,
    tools: [],
    usedBy: [],
    neededBy: [],
    ...o,
  };
}

/** One connection of a connector's page. */
export function connectionPage(
  o: Partial<ConnectionPageView> & Pick<ConnectionPageView, "id">,
): ConnectionPageView {
  return {
    status: "connected",
    accountName: null,
    lastSyncAt: null,
    connectedByYou: false,
    read: [],
    change: [],
    access: NO_ACCESS,
    usedBy: [],
    mezonasMay: null,
    openRequest: null,
    history: [],
    ...o,
  };
}

/** A connection in a list (Connected, Built for you). */
export function connectionSummary(
  o: Partial<ConnectionSummaryView> & Pick<ConnectionSummaryView, "id">,
): ConnectionSummaryView {
  return {
    status: "connected",
    accountName: null,
    lastSyncAt: null,
    usedBy: [],
    access: NO_ACCESS,
    needsSomething: false,
    openRequest: false,
    mezonasMay: null,
    ...o,
  };
}

/** A connector in a list. */
export function connectorCard(
  o: Partial<ConnectorCardView> & Pick<ConnectorCardView, "connector" | "name">,
): ConnectorCardView {
  return {
    description: `${o.name}.`,
    icon: null,
    auth: "oauth2",
    personal: false,
    multiple: false,
    available: true,
    beta: false,
    recommended: false,
    custom: false,
    group: "other",
    connections: [],
    ...o,
  };
}

/** `GET /api/portal/connectors` with nothing in it. */
export const NO_CONNECTORS = {
  connected: [],
  builtForYou: [],
  browse: [],
  waiting: [],
  openRequests: 0,
};

/** `GET /api/portal/connectors/:connector`. */
export function connectorPageView(
  card: ConnectorCardView,
  connections: ConnectionPageView[],
  o: Partial<{
    start: { read: AccessRowView[]; change: AccessRowView[] };
    forAgent: {
      agent: { id: string; name: string };
      ready: boolean;
      gaps: {
        kind:
          | "not_connected"
          | "broken"
          | "not_bound"
          | "off_on_connection"
          | "scope_excludes"
          | "off_in_grant"
          | "could_run_alone";
        connector: string;
        connectionId: string | null;
        blocking: boolean;
        fixBy: "client" | "mezonas";
        words: string;
        needs: {
          connector: string;
          verb: "read" | "create" | "update" | "delete";
          entity: string | null;
          level: "on" | "ask";
          wantsAuto: boolean;
          anyOf: string | null;
          label: string;
        }[];
      }[];
    } | null;
    mayEdit: boolean;
  }> = {},
) {
  return {
    connector: card,
    permissionEntities: [],
    start: { read: [], change: [] },
    connections,
    forAgent: null,
    mayEdit: true,
    ...o,
  };
}

export function changeRequest(
  o: Partial<ChangeRequestView> & Pick<ChangeRequestView, "id" | "connectionId">,
): ChangeRequestView {
  return {
    connector: "qbo",
    connectorName: "QuickBooks Online",
    status: "open",
    direction: "looser",
    rows: [],
    reason: "Because.",
    requestedBy: { id: "00000000-0000-4000-8000-00000000d0aa", name: "Ana" },
    forAgent: null,
    outOfDate: false,
    createdAt: "2026-11-19T10:00:00.000Z",
    expiresAt: "2026-12-03T10:00:00.000Z",
    closedAt: null,
    closedBy: null,
    answerNote: null,
    ...o,
  };
}

export function mezonasMay(o: Partial<MezonasMayView> = {}): MezonasMayView {
  return {
    choice: "needs",
    until: null,
    setBy: { id: "00000000-0000-4000-8000-00000000d002", name: "Pat Lee" },
    setAt: "2026-11-20T09:00:00.000Z",
    active: true,
    ...o,
  };
}
