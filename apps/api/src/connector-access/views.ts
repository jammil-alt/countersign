// Connectors C4: the Connectors screens' shapes (core's `connector-access.ts` contract), built from
// one client's `ClientAccess`. Portal views carry needs and gaps in words and never a step,
// prompt, bundle, cost or credential (invariant 11); the back office's add the tools and steps
// behind a need and the tool's setup (never its secrets).

import type {
  AgentNeedsState,
  ChangeRequestView,
  ConnectionHistoryEntry,
  ConnectionPageView,
  ConnectionSummaryView,
  ConnectorCardView,
  OpsAgentNeedsState,
  OpsConnectionPageView,
} from "@countersign/core";
import {
  connectionLabel,
  isPlainObject,
  MezonasMay,
  requestStale,
  SELFTEST_CHANGE,
} from "@countersign/core";
import { connectionChange, type Tx } from "@countersign/db";
import { and, desc, eq } from "drizzle-orm";
import { iso } from "../http";
import type { Platform } from "../platform";
import { PERSONAL_CONNECTORS } from "../routes/portal";
import { connectorGroup } from "./groups";
import {
  type AgentInfo,
  accessRows,
  accessSummary,
  type ClientAccess,
  type ConnectionRow,
  connectorName,
  gapView,
  mezonasMayView,
  opsGapView,
  personNames,
  type RequestRow,
  type RowEditor,
  rowsOf,
  rowViews,
  type ShownConnector,
  settingsOf,
} from "./service";

/** Agents bound to a connection (by any binding key). */
export function boundAgents(access: ClientAccess, connectionId: string): AgentInfo[] {
  return access.agents.filter((a) => Object.values(a.bindings).includes(connectionId));
}

/** An agent's state against one connection: its gaps there (or on its connector, when unbound). */
function agentState(_platform: Platform, a: AgentInfo, row: ConnectionRow) {
  const gaps = a.gaps.filter(
    (g) =>
      g.connector === row.connector && (g.connectionId === undefined || g.connectionId === row.id),
  );
  return { agent: { id: a.id, name: a.name }, ready: gaps.every((g) => !g.blocking), gaps };
}

export function agentNeedsState(
  platform: Platform,
  a: AgentInfo,
  row: ConnectionRow,
): AgentNeedsState {
  const s = agentState(platform, a, row);
  return { ...s, gaps: s.gaps.map((g) => gapView(platform, g, a.name)) };
}

export function opsAgentNeedsState(
  platform: Platform,
  a: AgentInfo,
  row: ConnectionRow,
): OpsAgentNeedsState {
  const s = agentState(platform, a, row);
  return { ...s, gaps: s.gaps.map((g) => opsGapView(platform, g, a.name)) };
}

/** The names a set of views needs: who set a go-ahead, who asked, who answered. */
export async function namesFor(tx: Tx, access: ClientAccess, requests: readonly RequestRow[]) {
  return personNames(tx, [
    ...access.connections.map((c) => (c.mezonasMay ? c.mezonasMay.setBy : null)),
    ...requests.flatMap((r) => [r.requestedBy, r.closedBy]),
  ]);
}

export function requestView(
  access: ClientAccess,
  r: RequestRow,
  names: Map<string, string | null>,
): ChangeRequestView {
  const { platform } = access;
  const row = access.connections.find((c) => c.id === r.connectionId);
  const connector = row?.connector ?? "";
  const { direction, rows } = rowsOf(platform, connector, r.against, r.proposed);
  const agentName = r.forAgentId
    ? (access.agents.find((a) => a.id === r.forAgentId)?.name ?? null)
    : null;
  return {
    id: r.id,
    connectionId: r.connectionId,
    connector,
    connectorName: connectorName(platform, connector),
    status: r.status,
    direction,
    rows: rowViews(platform, connector, rows),
    reason: r.reason,
    requestedBy: { id: r.requestedBy, name: names.get(r.requestedBy) ?? null },
    forAgent: r.forAgentId && agentName ? { id: r.forAgentId, name: agentName } : null,
    outOfDate: r.status === "open" && row !== undefined && requestStale(r, settingsOf(row)),
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    closedAt: iso(r.closedAt),
    closedBy: r.closedBy ? { id: r.closedBy, name: names.get(r.closedBy) ?? null } : null,
    answerNote: r.answerNote,
  };
}

const STATUS_WORDS: Record<string, string> = {
  connected: "Connected",
  disconnected: "Disconnected",
  error: "Stopped working",
  pending: "Waiting to connect",
};

/** A connection's history, newest first, worded. */
export async function connectionHistory(
  tx: Tx,
  access: ClientAccess,
  row: ConnectionRow,
  limit = 50,
): Promise<ConnectionHistoryEntry[]> {
  const { platform } = access;
  const changes = await tx
    .select()
    .from(connectionChange)
    .where(
      and(eq(connectionChange.tenantId, row.tenantId), eq(connectionChange.connectionId, row.id)),
    )
    .orderBy(desc(connectionChange.createdAt))
    .limit(limit);
  const names = await personNames(tx, [
    ...changes.map((c) => c.actorId),
    ...changes.flatMap((c) => {
      const j = isPlainObject(c.change) ? c.change : {};
      const auth = MezonasMay.safeParse(j.authorization);
      return auth.success ? [auth.data.setBy] : [];
    }),
  ]);
  return changes.map((c) => {
    const j = isPlainObject(c.change) ? c.change : {};
    let rows: ReturnType<typeof rowViews> = [];
    let note: string | null = null;
    if (j.kind === "settings" || j.kind === "permissions") {
      const before = isPlainObject(j.before) ? j.before : {};
      const after = isPlainObject(j.after) ? j.after : {};
      const b =
        j.kind === "settings"
          ? { permissions: before.permissions as never, config: before.config as never }
          : { permissions: before as never, config: null };
      const a =
        j.kind === "settings"
          ? { permissions: after.permissions as never, config: after.config as never }
          : { permissions: after as never, config: null };
      rows = rowViews(platform, row.connector, rowsOf(platform, row.connector, b, a).rows);
    } else if (j.kind === "config") {
      rows = rowViews(
        platform,
        row.connector,
        rowsOf(
          platform,
          row.connector,
          { permissions: row.permissions, config: (j.before ?? {}) as Record<string, unknown> },
          { permissions: row.permissions, config: (j.after ?? {}) as Record<string, unknown> },
        ).rows,
      );
    } else if (j.kind === "mezonas_may") {
      note = typeof j.words === "string" ? j.words : "Changes by Mezonas changed";
    } else if (j.kind === "status") {
      note = STATUS_WORDS[String(j.after)] ?? null;
    } else if (j.kind === SELFTEST_CHANGE) {
      // The connector self-test (the Sandbox client only): how its checks came out.
      const failed = Number(j.failed) || 0;
      const passed = Number(j.passed) || 0;
      note =
        failed > 0
          ? `Self-test: ${failed} of ${failed + passed} checks failed`
          : `Self-test: all ${passed} checks passed`;
    }
    const auth = MezonasMay.safeParse(j.authorization);
    return {
      id: c.id,
      at: c.createdAt.toISOString(),
      by: c.actorId ? { id: c.actorId, name: names.get(c.actorId) ?? null } : null,
      rows,
      note,
      requestId: c.requestId,
      authorization: auth.success ? mezonasMayView(auth.data, names, access.now) : null,
    };
  });
}

/** One connection on its connector's page, as the portal shows it. */
export async function connectionPage(
  tx: Tx,
  access: ClientAccess,
  row: ConnectionRow,
  input: {
    editor: RowEditor;
    viewerId: string;
    names: Map<string, string | null>;
    /** A client user limited to some agents sees only theirs (docs/plan.md §1.122). */
    agentIds: readonly string[] | null;
  },
): Promise<ConnectionPageView> {
  const { platform } = access;
  const connector = platform.connectors.get(row.connector);
  const bound = boundAgents(access, row.id).filter(
    (a) => input.agentIds === null || input.agentIds.includes(a.id),
  );
  const rows = connector
    ? accessRows({
        connector,
        matrix: row.permissions,
        editor: input.editor,
        agents: bound,
        connectionId: row.id,
      })
    : { read: [], change: [] };
  const open = access.openRequests.find((r) => r.connectionId === row.id);
  return {
    id: row.id,
    status: row.status,
    accountName: connectionLabel(row.config, row.externalAccountId),
    lastSyncAt: iso(row.lastSyncAt),
    connectedByYou: row.connectedBy === input.viewerId,
    read: rows.read,
    change: rows.change,
    access: accessSummary(rows),
    usedBy: bound.map((a) => agentNeedsState(platform, a, row)),
    mezonasMay: mezonasMayView(row.mezonasMay, input.names, access.now),
    openRequest: open ? requestView(access, open, input.names) : null,
    history: await connectionHistory(tx, access, row),
  };
}

/** The back office's view of a connection: the portal's, with the tool's setup and ops gaps. */
export async function opsConnectionPage(
  tx: Tx,
  access: ClientAccess,
  row: ConnectionRow,
  input: { viewerId: string; names: Map<string, string | null> },
): Promise<OpsConnectionPageView> {
  const page = await connectionPage(tx, access, row, {
    editor: "operator",
    viewerId: input.viewerId,
    names: input.names,
    agentIds: null,
  });
  return {
    ...page,
    config: { ...((row.config ?? {}) as Record<string, unknown>) },
    usedBy: boundAgents(access, row.id).map((a) => opsAgentNeedsState(access.platform, a, row)),
  };
}

/** A connection in a list. */
export function connectionSummary(
  access: ClientAccess,
  row: ConnectionRow,
  names: Map<string, string | null>,
  agentIds: readonly string[] | null,
): ConnectionSummaryView {
  const { platform } = access;
  const connector = platform.connectors.get(row.connector);
  const bound = boundAgents(access, row.id).filter(
    (a) => agentIds === null || agentIds.includes(a.id),
  );
  const rows = connector
    ? accessRows({
        connector,
        matrix: row.permissions,
        editor: "none",
        agents: bound,
        connectionId: row.id,
      })
    : { read: [], change: [] };
  return {
    id: row.id,
    status: row.status,
    accountName: connectionLabel(row.config, row.externalAccountId),
    lastSyncAt: iso(row.lastSyncAt),
    usedBy: bound.map((a) => ({ id: a.id, name: a.name })),
    access: accessSummary(rows),
    needsSomething: bound.some((a) =>
      agentState(platform, a, row).gaps.some((g) => g.blocking && g.fixBy === "client"),
    ),
    openRequest: access.openRequests.some((r) => r.connectionId === row.id),
    mezonasMay: mezonasMayView(row.mezonasMay, names, access.now),
  };
}

/** A connector's card, with the client's connections of it. */
export function connectorCard(
  access: ClientAccess,
  shown: ShownConnector,
  names: Map<string, string | null>,
  agentIds: readonly string[] | null,
): ConnectorCardView {
  const m = shown.connector.manifest;
  const needed = access.agents.some((a) =>
    a.gaps.some((g) => g.connector === m.id && g.kind === "not_connected"),
  );
  return {
    connector: m.id,
    name: m.name,
    description: m.description,
    icon: m.icon ?? null,
    auth: m.auth,
    personal: PERSONAL_CONNECTORS.has(m.id),
    multiple: m.multiple === true,
    available: shown.available,
    beta: shown.beta,
    recommended: shown.offered || needed,
    custom: shown.custom,
    group: connectorGroup(m.id),
    connections: access.connections
      .filter((c) => c.connector === m.id)
      .map((c) => connectionSummary(access, c, names, agentIds)),
  };
}

/** Cards in the order a person scans them: recommended first, then by name. */
export function sortCards(cards: ConnectorCardView[]): ConnectorCardView[] {
  return [...cards].sort(
    (a, b) => Number(b.recommended) - Number(a.recommended) || a.name.localeCompare(b.name),
  );
}
