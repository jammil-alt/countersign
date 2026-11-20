// Connectors C4 (docs/connectors-plan.md §3, §5, §7; docs/plan.md §1.161): what the client's one
// Connectors place and the back office's Connectors tab read and change. A client's connections,
// the connectors shown to it (every live one, custom ones only for their clients, HIPAA-refused
// ones hidden), each agent's needs and gaps (C1's `agentNeeds` and `accessGaps`), and the rules
// for a change (C4's `changeDirection`, `clientMayAllow`, `withinAuthorization`): a client admin's
// change applies at once; ours applies at once only when tighter or covered by the client's
// go-ahead, else it is a change request the client admin answers. Every function runs in the
// caller's transaction, scoped to the client (invariant 1), and filters by `tenant_id` besides.

import { convertLookup, grantsOfClient, skillContext } from "@countersign/agents";
import {
  applyMatrixChange,
  type Connector,
  normalizeMatrix,
  UPLOAD_CONNECTOR_ID,
} from "@countersign/connectors";
import {
  type AccessGap,
  AnyAgentBundle,
  accessGaps,
  activeMezonasMay,
  agentNeeds,
  CONNECTION_NOTICE_SUBJECT,
  CONNECTION_REQUEST_SUBJECT,
  type ConnectionNoticeInboxPayload,
  type ConnectionRequestInboxPayload,
  type ConnectionRowChange,
  type ConnectionSettings,
  type ConnectorNeed,
  type ConnectorStatus,
  changeDirection,
  complianceOf,
  connectorShown,
  declaredScope,
  type GapView,
  type GrantLimits,
  levelFor,
  type MezonasMay,
  type MezonasMayView,
  type NeedsConnection,
  type NeedView,
  type OpsGapView,
  type OpsNeedView,
  type PermissionEntity,
  type PermissionLevel,
  type PermissionMatrix,
  parseCoveredProcessors,
  processingRefusal,
  processorsForOffer,
  type RowChange,
  readEntities,
  requestExpiresAt,
  rowChangeView,
  rowWords,
  type SettingsLike,
  toProcessBundle,
  type Verb,
} from "@countersign/core";
import {
  agent,
  agentVersion,
  appUser,
  connection,
  connectionChange,
  connectionChangeRequest,
  connectorSetting,
  inboxItem,
  readOperatorCatalogue,
  type Tx,
  tenant,
} from "@countersign/db";
import { and, desc, eq, inArray, isNull, lte, ne, or } from "drizzle-orm";
import { HttpError, notFound, type Services } from "../http";
import type { Platform } from "../platform";
import { offeredConnectors } from "../routes/ops-clients";
import { catalogStatus } from "../routes/ops-connectors";
import { canSignIn } from "../routes/portal";

export type ConnectionRow = typeof connection.$inferSelect;
export type RequestRow = typeof connectionChangeRequest.$inferSelect;
type SettingRow = typeof connectorSetting.$inferSelect;
type TenantRow = typeof tenant.$inferSelect;

/** A client agent as the needs and gaps read it. */
export interface AgentInfo {
  id: string;
  /** The name the client knows it by (its service name). */
  name: string;
  bindings: Record<string, string>;
  /** Its grant on each connection it has one for. */
  grants: Record<string, GrantLimits | null>;
  needs: ConnectorNeed[];
  gaps: AccessGap[];
}

/** Everything the Connectors routes read about one client, read once per request. */
export interface ClientAccess {
  tenantId: string;
  tenant: TenantRow;
  sandbox: boolean;
  connections: ConnectionRow[];
  agents: AgentInfo[];
  settings: Map<string, SettingRow>;
  /** Open change requests (after expiring the ones past their end). */
  openRequests: RequestRow[];
  platform: Platform;
  now: Date;
}

// ── Reading a client ─────────────────────────────────────────────────────────────────────────

/** The operator's catalogue settings (connector_setting is an operator table). */
export async function connectorSettings(tx: Tx): Promise<Map<string, SettingRow>> {
  const rows = await readOperatorCatalogue(tx, (inner) => inner.select().from(connectorSetting));
  return new Map(rows.map((r) => [r.connector, r]));
}

/**
 * Open requests past their end become `expired` and their inbox items close with them.
 */
// DECISION (docs/plan.md §1.161, C4): expiry is lazy, on every read and answer of a client's
// requests, and once an hour in the lifecycle cron for the inbox; no request is ever answered
// past its end, whichever comes first.
export async function expireRequests(tx: Tx, tenantId: string, now: Date): Promise<number> {
  const ended = await tx
    .update(connectionChangeRequest)
    .set({ status: "expired", closedAt: now })
    .where(
      and(
        eq(connectionChangeRequest.tenantId, tenantId),
        eq(connectionChangeRequest.status, "open"),
        lte(connectionChangeRequest.expiresAt, now),
      ),
    )
    .returning({ id: connectionChangeRequest.id });
  if (ended.length > 0) {
    await closeRequestItems(
      tx,
      tenantId,
      ended.map((r) => r.id),
      "expired",
      null,
      now,
    );
  }
  return ended.length;
}

/** The version an agent's needs are read from: the live one, else the latest. */
async function shownBundles(tx: Tx, tenantId: string, rows: (typeof agent.$inferSelect)[]) {
  const out = new Map<string, unknown>();
  if (rows.length === 0) return out;
  const live = rows.flatMap((r) => (r.liveVersionId ? [r.liveVersionId] : []));
  if (live.length > 0) {
    const versions = await tx
      .select({ id: agentVersion.id, agentId: agentVersion.agentId, bundle: agentVersion.bundle })
      .from(agentVersion)
      .where(and(eq(agentVersion.tenantId, tenantId), inArray(agentVersion.id, live)));
    for (const v of versions) out.set(v.agentId, v.bundle);
  }
  const rest = rows.filter((r) => !out.has(r.id)).map((r) => r.id);
  if (rest.length > 0) {
    const versions = await tx
      .selectDistinctOn([agentVersion.agentId], {
        agentId: agentVersion.agentId,
        bundle: agentVersion.bundle,
      })
      .from(agentVersion)
      .where(and(eq(agentVersion.tenantId, tenantId), inArray(agentVersion.agentId, rest)))
      .orderBy(agentVersion.agentId, desc(agentVersion.version));
    for (const v of versions) out.set(v.agentId, v.bundle);
  }
  return out;
}

/** What a stored bundle needs of a client's connections; none when it no longer reads. */
export async function bundleNeeds(
  tx: Tx,
  tenantId: string | null,
  stored: unknown,
  platform: Pick<Platform, "catalog" | "tools">,
): Promise<ConnectorNeed[]> {
  try {
    const parsed = AnyAgentBundle.parse(stored);
    const bundle = toProcessBundle(parsed, convertLookup(platform.catalog, platform.tools));
    const { skills } = await skillContext(tx, {
      tenantId,
      bundle: parsed,
      catalog: platform.catalog,
    });
    const all = Object.fromEntries(platform.catalog.list().map((s) => [s.id, s]));
    return agentNeeds(bundle, {
      skills: { ...all, ...skills },
      tools: platform.tools.specs(),
      connectors: new Set(platform.tools.connectors.list().map((c) => c.manifest.id)),
    });
  } catch {
    // A bundle that no longer reads needs nothing here; the agent's own page shows it.
    return [];
  }
}

/** A connection as the gap check reads it: one with nothing to sign in to counts once it exists. */
export function needsConnection(
  row: ConnectionRow,
  platform: Pick<Platform, "connectors">,
): NeedsConnection {
  const none = platform.connectors.get(row.connector)?.manifest.auth === "none";
  return {
    id: row.id,
    connector: row.connector,
    status: row.status === "pending" && none ? "connected" : row.status,
    permissions: row.permissions,
  };
}

export function declaredOf(platform: Pick<Platform, "connectors">) {
  return Object.fromEntries(
    platform.connectors.list().map((c) => [c.manifest.id, c.manifest.permissionEntities]),
  );
}

/** One agent's gaps against the client's connections. */
export function gapsOf(
  needs: readonly ConnectorNeed[],
  input: {
    connections: readonly ConnectionRow[];
    platform: Pick<Platform, "connectors">;
    /** Absent for a template checked against a client: any connection of the connector counts. */
    bindings?: Record<string, string>;
    grants?: Record<string, GrantLimits | null>;
  },
): AccessGap[] {
  return accessGaps(needs, {
    connections: input.connections.map((c) => needsConnection(c, input.platform)),
    ...(input.bindings ? { bindings: input.bindings } : {}),
    ...(input.grants ? { grants: input.grants } : {}),
    declared: declaredOf(input.platform),
  });
}

/** Reads one client's connections, agents (with needs and gaps), settings and open requests. */
export async function loadClientAccess(
  tx: Tx,
  tenantId: string,
  services: Pick<Services, "platform">,
  now: Date = new Date(),
): Promise<ClientAccess> {
  const { platform } = services;
  const [t] = await tx.select().from(tenant).where(eq(tenant.id, tenantId));
  if (!t) throw notFound("client");
  await expireRequests(tx, tenantId, now);
  const [connections, agentRows, grants, settings, openRequests] = await Promise.all([
    tx
      .select()
      .from(connection)
      .where(eq(connection.tenantId, tenantId))
      .orderBy(connection.createdAt),
    tx
      .select()
      .from(agent)
      .where(
        and(
          eq(agent.tenantId, tenantId),
          eq(agent.kind, "client"),
          eq(agent.testCopy, false),
          eq(agent.status, "active"),
          or(isNull(agent.runStatus), ne(agent.runStatus, "retired")),
        ),
      )
      .orderBy(agent.createdAt),
    grantsOfClient(tx, tenantId),
    connectorSettings(tx),
    tx
      .select()
      .from(connectionChangeRequest)
      .where(
        and(
          eq(connectionChangeRequest.tenantId, tenantId),
          eq(connectionChangeRequest.status, "open"),
        ),
      )
      .orderBy(desc(connectionChangeRequest.createdAt)),
  ]);
  const bundles = await shownBundles(tx, tenantId, agentRows);
  const agents: AgentInfo[] = [];
  for (const a of agentRows) {
    const needs = await bundleNeeds(tx, tenantId, bundles.get(a.id), platform);
    const mine: Record<string, GrantLimits | null> = {};
    for (const g of grants) if (g.agentId === a.id) mine[g.connectionId] = g.limits;
    agents.push({
      id: a.id,
      name: a.serviceName ?? a.name,
      bindings: a.bindings,
      grants: mine,
      needs,
      gaps: gapsOf(needs, { connections, platform, bindings: a.bindings, grants: mine }),
    });
  }
  return {
    tenantId,
    tenant: t,
    sandbox: t.settings.sandbox === true,
    connections,
    agents,
    settings,
    openRequests,
    platform,
    now,
  };
}

// ── Which connectors a client sees ───────────────────────────────────────────────────────────

/** A connector as shown to one client. */
export interface ShownConnector {
  connector: Connector;
  setting: SettingRow | undefined;
  /** Built for this client alone (`connector_setting.clients`). */
  custom: boolean;
  beta: boolean;
  offered: boolean;
  available: boolean;
}

interface ShownInput {
  tenantId: string;
  settings: Record<string, unknown>;
  connectorSettings: Map<string, SettingRow>;
  inUse: ReadonlySet<string>;
  platform: Platform;
  baaProcessors: string | undefined;
}

/**
 * The connectors one client sees (docs/connectors-plan.md §3.1, §6, §10 decision 2): every live
 * or beta one, and any offered or already connected; never a custom one built for other clients,
 * never one HIPAA mode refuses (unless already connected), test-only ones only where they show.
 */
// DECISION (docs/plan.md §1.161, C4): a connector in review or being built (or not set up on
// this deployment) is hidden unless we offered it or the client already has it: an offer is
// ours to make, as before. A custom connector stays hidden from every other client even when
// offered to them; a connection a client already has is always shown, so they can disconnect it.
export function shownConnectors(input: ShownInput): ShownConnector[] {
  const offeredIds = new Set(offeredConnectors(input.settings));
  const profile = complianceOf(input.settings);
  const covered = parseCoveredProcessors(input.baaProcessors);
  const out: ShownConnector[] = [];
  for (const c of input.platform.connectors.list()) {
    const id = c.manifest.id;
    const inUse = input.inUse.has(id);
    if (!connectorShown(c.manifest, { sandbox: input.settings.sandbox === true, inUse })) continue;
    const setting = input.connectorSettings.get(id);
    const clients = setting?.clients ?? null;
    const custom = clients !== null;
    if (custom && !clients.includes(input.tenantId)) continue;
    const offered = offeredIds.has(id) || id === UPLOAD_CONNECTOR_ID;
    const available = canSignIn(c);
    const status: ConnectorStatus | null = catalogStatus(setting?.status ?? null, available).status;
    if (!inUse) {
      if (processingRefusal(profile, covered, processorsForOffer(id), id) !== null) continue;
      if (status !== "live" && status !== "beta" && !offered) continue;
    }
    out.push({ connector: c, setting, custom, beta: status === "beta", offered, available });
  }
  return out;
}

export function shownFor(access: ClientAccess, services: Pick<Services, "env">) {
  return shownConnectors({
    tenantId: access.tenantId,
    settings: access.tenant.settings,
    connectorSettings: access.settings,
    inUse: new Set(access.connections.map((c) => c.connector)),
    platform: access.platform,
    baaProcessors: services.env.BAA_PROCESSORS,
  });
}

/**
 * Throws 404 unless the client may see and connect this connector (the portal's Connect, the
 * Sandbox's sign-in, a key form): the same rule as the Connectors list, so a custom connector
 * built for another client, or one HIPAA mode refuses, is never connected here.
 */
export async function connectableTo(
  tx: Tx,
  services: Pick<Services, "platform" | "env">,
  tenantId: string,
  connectorId: string,
): Promise<void> {
  const [t] = await tx.select().from(tenant).where(eq(tenant.id, tenantId));
  if (!t) throw notFound("client");
  const used = await tx
    .select({ connector: connection.connector })
    .from(connection)
    .where(and(eq(connection.tenantId, tenantId), eq(connection.connector, connectorId)))
    .limit(1);
  const shown = shownConnectors({
    tenantId,
    settings: t.settings,
    connectorSettings: await connectorSettings(tx),
    inUse: new Set(used.map((u) => u.connector)),
    platform: services.platform,
    baaProcessors: services.env.BAA_PROCESSORS,
  });
  if (shown.some((s) => s.connector.manifest.id === connectorId)) return;
  // One we offered that this deployment doesn't have: the sign-in says it isn't available yet.
  if (
    !services.platform.connectors.has(connectorId) &&
    offeredConnectors(t.settings).includes(connectorId)
  ) {
    return;
  }
  throw notFound("connector");
}

// ── Words ────────────────────────────────────────────────────────────────────────────────────

function lowerFirst(s: string): string {
  return s.length > 0 ? `${s[0]?.toLowerCase()}${s.slice(1)}` : s;
}

export function connectorName(platform: Pick<Platform, "connectors">, id: string): string {
  return platform.connectors.get(id)?.manifest.name ?? id;
}

function declaredFor(
  platform: Pick<Platform, "connectors">,
  id: string,
): readonly PermissionEntity[] | undefined {
  return platform.connectors.get(id)?.manifest.permissionEntities;
}

/** A row's name for a verb and record type: "Create bills", "Read" (the verb as a whole). */
function levelRowWords(
  platform: Pick<Platform, "connectors">,
  connector: string,
  verb: Verb,
  entity: string | null,
) {
  const row: RowChange = {
    kind: "level",
    verb,
    entity,
    from: "off",
    to: "off",
    direction: "tighter",
  };
  return rowWords(row, declaredFor(platform, connector));
}

/** A need in words: "Create bills"; with no record type, "Create in Gmail". */
export function needLabel(platform: Pick<Platform, "connectors">, n: ConnectorNeed): string {
  const words = levelRowWords(platform, n.connector, n.verb, n.entity ?? null);
  return n.entity ? words : `${words} in ${connectorName(platform, n.connector)}`;
}

export function needView(platform: Pick<Platform, "connectors">, n: ConnectorNeed): NeedView {
  return {
    connector: n.connector,
    verb: n.verb,
    entity: n.entity ?? null,
    level: n.level,
    wantsAuto: n.wantsAuto,
    anyOf: n.anyOf ?? null,
    label: needLabel(platform, n),
  };
}

export function opsNeedView(platform: Pick<Platform, "connectors">, n: ConnectorNeed): OpsNeedView {
  return {
    ...needView(platform, n),
    tool: n.tool ?? null,
    why: n.why,
    because: n.because.map((b) => ({
      workflow: b.workflow,
      stepId: b.stepId,
      stepName: b.stepName,
    })),
  };
}

function labelsOf(platform: Pick<Platform, "connectors">, needs: readonly ConnectorNeed[]): string {
  const labels = [...new Set(needs.map((n) => lowerFirst(needLabel(platform, n))))];
  return labels.join(", ");
}

/** A gap's fix in words: "Connect QuickBooks", "Allow create bills", "Bind the connection". */
export function gapWords(
  platform: Pick<Platform, "connectors">,
  gap: AccessGap,
  agentName: string,
): string {
  const name = connectorName(platform, gap.connector);
  const what = labelsOf(platform, gap.needs);
  switch (gap.kind) {
    case "not_connected":
      return `Connect ${name}`;
    case "broken":
      return `Sign in to ${name} again`;
    case "not_bound":
      return `Bind ${agentName} to ${name}`;
    case "off_on_connection":
      return `Allow ${what}`;
    case "scope_excludes":
      return `Widen the scope on ${name}: ${what}`;
    case "off_in_grant":
      return `Widen ${agentName}'s access: ${what}`;
    case "could_run_alone":
      return `Could run on its own: ${what}`;
  }
}

export function gapView(
  platform: Pick<Platform, "connectors">,
  gap: AccessGap,
  agentName: string,
): GapView {
  return {
    kind: gap.kind,
    connector: gap.connector,
    connectionId: gap.connectionId ?? null,
    blocking: gap.blocking,
    fixBy: gap.fixBy,
    words: gapWords(platform, gap, agentName),
    needs: gap.needs.map((n) => needView(platform, n)),
  };
}

export function opsGapView(
  platform: Pick<Platform, "connectors">,
  gap: AccessGap,
  agentName: string,
): OpsGapView {
  return {
    ...gapView(platform, gap, agentName),
    needs: gap.needs.map((n) => opsNeedView(platform, n)),
  };
}

export async function personNames(tx: Tx, ids: readonly (string | null | undefined)[]) {
  const wanted = [...new Set(ids.filter((v): v is string => typeof v === "string"))];
  if (wanted.length === 0) return new Map<string, string | null>();
  const rows = await tx
    .select({ id: appUser.id, name: appUser.name })
    .from(appUser)
    .where(inArray(appUser.id, wanted));
  return new Map(rows.map((r) => [r.id, r.name]));
}

export function mezonasMayView(
  may: MezonasMay | null | undefined,
  names: Map<string, string | null>,
  now: Date,
): MezonasMayView | null {
  if (!may) return null;
  return {
    choice: may.choice,
    until: may.until,
    setBy: { id: may.setBy, name: names.get(may.setBy) ?? null },
    setAt: may.setAt,
    active: activeMezonasMay(may, now) !== null,
  };
}

// ── Settings and their changes ───────────────────────────────────────────────────────────────

/** A connection's settings, normalised, as requests and history keep them. */
export function settingsOf(row: Pick<ConnectionRow, "permissions" | "config">): ConnectionSettings {
  return {
    permissions: normalizeMatrix(row.permissions),
    config: { ...((row.config ?? {}) as Record<string, unknown>) },
  };
}

/** The edit applied to the current settings (verbs left out keep their level). 422 if invalid. */
export function editedSettings(
  row: ConnectionRow,
  edit: {
    permissions?: Record<string, unknown> | undefined;
    config?: Record<string, unknown> | undefined;
  },
  platform: Platform,
): ConnectionSettings {
  const before = settingsOf(row);
  let permissions = before.permissions;
  if (edit.permissions) {
    const proposed: Partial<PermissionMatrix> = {};
    for (const [k, v] of Object.entries(edit.permissions)) {
      if (v !== undefined) (proposed as Record<string, unknown>)[k] = v;
    }
    const r = applyMatrixChange({
      current: row.permissions,
      proposed,
      by: "operator",
      declared: declaredFor(platform, row.connector),
    });
    if (!r.ok) throw new HttpError(422, r.reason, r.message);
    permissions = r.matrix;
  }
  return { permissions, config: edit.config ? { ...edit.config } : before.config };
}

export function rowsOf(
  platform: Platform,
  connector: string,
  before: SettingsLike,
  after: SettingsLike,
): { direction: ReturnType<typeof changeDirection>["direction"]; rows: RowChange[] } {
  return changeDirection(before, after, declaredFor(platform, connector));
}

export function rowViews(
  platform: Platform,
  connector: string,
  rows: readonly RowChange[],
): ConnectionRowChange[] {
  const declared = declaredFor(platform, connector);
  return rows.map((r) => rowChangeView(r, declared));
}

/** What `connection_change.change` holds for a change of the settings made here. */
export interface SettingsChange {
  kind: "settings";
  by: "client" | "operator";
  before: ConnectionSettings;
  after: ConnectionSettings;
  reason?: string;
  /** Changes by Mezonas, when the change was ours and applied under it. */
  authorization?: MezonasMay;
  /** The agent it was for (Allow what Buyer needs, a request for an agent). */
  forAgentId?: string;
  /** For an approved request: who asked (the change's actor is who approved). */
  requestedBy?: string;
}

/** Writes new settings to a connection and its `connection_change` row. */
export async function applySettings(
  tx: Tx,
  row: ConnectionRow,
  input: {
    after: ConnectionSettings;
    actorId: string;
    change: Omit<SettingsChange, "kind" | "before" | "after">;
    requestId?: string;
  },
): Promise<ConnectionRow> {
  const before = settingsOf(row);
  const [updated] = await tx
    .update(connection)
    .set({ permissions: input.after.permissions, config: input.after.config })
    .where(and(eq(connection.id, row.id), eq(connection.tenantId, row.tenantId)))
    .returning();
  if (!updated) throw new Error("connection update returned nothing");
  const change: SettingsChange = {
    kind: "settings",
    ...input.change,
    before,
    after: input.after,
  };
  await tx.insert(connectionChange).values({
    tenantId: row.tenantId,
    connectionId: row.id,
    actorId: input.actorId,
    change: { ...change },
    ...(input.requestId ? { requestId: input.requestId } : {}),
  });
  return updated;
}

/** A connection of this client, locked for a change. */
export async function lockConnection(tx: Tx, tenantId: string, id: string): Promise<ConnectionRow> {
  const [row] = await tx
    .select()
    .from(connection)
    .where(and(eq(connection.id, id), eq(connection.tenantId, tenantId)))
    .for("update");
  if (!row) throw notFound("connection");
  return row;
}

// ── Notices and requests in the inbox ────────────────────────────────────────────────────────

/** Our change that applied at once: a notice to the client admin that waits on nobody. */
export async function addNotice(
  tx: Tx,
  input: {
    row: ConnectionRow;
    platform: Platform;
    because: "tightened" | "authorized";
    rows: ConnectionRowChange[];
    reason: string;
    changedBy: { id: string; name: string | null };
    authorization: MezonasMay | null;
  },
): Promise<void> {
  const name = connectorName(input.platform, input.row.connector);
  const payload: ConnectionNoticeInboxPayload = {
    connectionId: input.row.id,
    connector: input.row.connector,
    connectorName: name,
    because: input.because,
    rows: input.rows,
    reason: input.reason,
    changedBy: input.changedBy,
    authorization: input.authorization,
  };
  const who = input.changedBy.name ?? "Mezonas";
  const title =
    input.because === "tightened"
      ? `${who} made ${name} access safer`
      : `${who} changed ${name} access, as you allowed`;
  await tx.insert(inboxItem).values({
    tenantId: input.row.tenantId,
    kind: "review",
    subjectType: CONNECTION_NOTICE_SUBJECT,
    subjectId: input.row.id,
    assigneeRole: "client_admin",
    title,
    payload,
  });
}

/** Closes the open inbox items of these requests: resolved, or expired with them. */
export async function closeRequestItems(
  tx: Tx,
  tenantId: string,
  requestIds: readonly string[],
  how: "resolved" | "expired",
  by: string | null,
  now: Date,
  resolution?: Record<string, unknown>,
): Promise<void> {
  if (requestIds.length === 0) return;
  await tx
    .update(inboxItem)
    .set({
      status: how,
      resolvedAt: now,
      ...(by ? { resolvedBy: by } : {}),
      ...(resolution ? { resolution } : {}),
    })
    .where(
      and(
        eq(inboxItem.tenantId, tenantId),
        eq(inboxItem.subjectType, CONNECTION_REQUEST_SUBJECT),
        inArray(inboxItem.subjectId, [...requestIds]),
        eq(inboxItem.status, "open"),
      ),
    );
}

/**
 * Sends our change as a request for a client admin to approve, replacing the connection's open
 * one (marked `replaced`); it ends unanswered after 14 days.
 */
export async function createRequest(
  tx: Tx,
  input: {
    row: ConnectionRow;
    platform: Platform;
    after: ConnectionSettings;
    reason: string;
    requestedBy: { id: string; name: string | null };
    forAgent: { id: string; name: string } | null;
    now: Date;
  },
): Promise<{ request: RequestRow; replaced: string | null }> {
  const { row, now } = input;
  const replacedRows = await tx
    .update(connectionChangeRequest)
    .set({ status: "replaced", closedAt: now })
    .where(
      and(
        eq(connectionChangeRequest.tenantId, row.tenantId),
        eq(connectionChangeRequest.connectionId, row.id),
        eq(connectionChangeRequest.status, "open"),
      ),
    )
    .returning({ id: connectionChangeRequest.id });
  const replaced = replacedRows[0]?.id ?? null;
  await closeRequestItems(
    tx,
    row.tenantId,
    replacedRows.map((r) => r.id),
    "resolved",
    null,
    now,
    { replaced: true },
  );
  const [request] = await tx
    .insert(connectionChangeRequest)
    .values({
      tenantId: row.tenantId,
      connectionId: row.id,
      against: settingsOf(row),
      proposed: input.after,
      reason: input.reason,
      requestedBy: input.requestedBy.id,
      forAgentId: input.forAgent?.id ?? null,
      expiresAt: requestExpiresAt(now),
    })
    .returning();
  if (!request) throw new Error("request insert returned nothing");
  const name = connectorName(input.platform, row.connector);
  const { rows } = rowsOf(input.platform, row.connector, request.against, request.proposed);
  const payload: ConnectionRequestInboxPayload = {
    requestId: request.id,
    connectionId: row.id,
    connector: row.connector,
    connectorName: name,
    rows: rowViews(input.platform, row.connector, rows),
    reason: input.reason,
    requestedBy: input.requestedBy,
    forAgent: input.forAgent,
    expiresAt: request.expiresAt.toISOString(),
  };
  await tx.insert(inboxItem).values({
    tenantId: row.tenantId,
    kind: "approval",
    ...(input.forAgent ? { agentId: input.forAgent.id } : {}),
    subjectType: CONNECTION_REQUEST_SUBJECT,
    subjectId: request.id,
    assigneeRole: "client_admin",
    title: `Mezonas asks to change ${name} access`,
    payload,
  });
  return { request, replaced };
}

// ── Access rows ──────────────────────────────────────────────────────────────────────────────

const READ_VERBS: readonly Verb[] = ["read"];
const CHANGE_VERBS: readonly Verb[] = ["create", "update"];
const STRICT: Record<PermissionLevel, number> = { auto: 0, approval: 1, off: 2 };

function stricter(a: PermissionLevel, b: PermissionLevel): PermissionLevel {
  return STRICT[a] >= STRICT[b] ? a : b;
}

/** A row's level as the gate reads it: the verb's, or the stricter of the verb's and the type's. */
export function rowLevel(
  matrix: Partial<PermissionMatrix> | null | undefined,
  verb: Verb,
  entity: string | null,
): PermissionLevel {
  const verbLevel = levelFor(matrix ?? undefined, verb);
  if (entity === null) return verbLevel;
  const entities = readEntities(matrix ?? undefined);
  if (entities === null) return "off";
  return stricter(verbLevel, entities[entity]?.[verb] ?? "auto");
}

/** Who sets the rows: a client admin (Off to Ask me first), us, or nobody (a client user). */
export type RowEditor = "client_admin" | "operator" | "none";

function choicesFor(editor: RowEditor, verb: Verb, level: PermissionLevel): PermissionLevel[] {
  if (editor === "none") return [];
  if (verb === "read") return ["auto", "off"];
  if (editor === "operator") return ["auto", "approval", "off"];
  // A client admin never gets On its own unless the row already is (then only lowered).
  return level === "auto" ? ["auto", "approval", "off"] : ["approval", "off"];
}

function needMatchesRow(n: ConnectorNeed, verb: Verb, entity: string | null): boolean {
  if (n.verb !== verb) return false;
  return entity === null ? !n.entity : n.entity === entity;
}

export interface RowsInput {
  connector: Connector;
  matrix: Partial<PermissionMatrix> | null | undefined;
  editor: RowEditor;
  /** Agents bound to this connection, with their needs and gaps (empty before connecting). */
  agents: readonly AgentInfo[];
  connectionId: string | null;
}

/** What agents can do, as Read and Change rows: each verb's own row, then its record types. */
export function accessRows(input: RowsInput) {
  const m = input.connector.manifest;
  const declared = m.permissionEntities ?? [];
  const build = (verbs: readonly Verb[], group: "read" | "change") =>
    verbs.flatMap((verb) => {
      const entities: (string | null)[] = [
        null,
        ...declared.filter((e) => e.verbs.includes(verb)).map((e) => e.id),
      ];
      return entities.map((entity) => {
        const level = rowLevel(input.matrix, verb, entity);
        const scopeId =
          entity !== null ? readEntities(input.matrix ?? undefined)?.[entity]?.scope?.[verb] : null;
        const scope =
          entity !== null && typeof scopeId === "string"
            ? {
                id: scopeId,
                label: declaredScope(declared, entity, verb, scopeId)?.label ?? scopeId,
              }
            : null;
        const usedBy = input.agents
          .filter((a) =>
            a.needs.some((n) => n.connector === m.id && needMatchesRow(n, verb, entity)),
          )
          .map((a) => ({ id: a.id, name: a.name }));
        const neededBy = input.agents
          .filter((a) =>
            a.gaps.some(
              (g) =>
                g.blocking &&
                g.connector === m.id &&
                (g.connectionId ?? null) === input.connectionId &&
                (g.kind === "off_on_connection" || g.kind === "scope_excludes") &&
                g.needs.some((n) => needMatchesRow(n, verb, entity)),
            ),
          )
          .map((a) => ({ id: a.id, name: a.name }));
        return {
          group,
          verb,
          entity,
          label: rowWords(
            { kind: "level", verb, entity, from: "off", to: "off", direction: "tighter" },
            declared,
          ),
          level,
          choices: choicesFor(input.editor, verb, level),
          scope,
          tools: m.tools
            .filter((t) => t.verb === verb && (entity === null ? !t.entity : t.entity === entity))
            .map((t) => ({ id: t.id, description: t.description })),
          usedBy,
          neededBy,
        };
      });
    });
  return { read: build(READ_VERBS, "read"), change: build(CHANGE_VERBS, "change") };
}

/** "Reads 9 · changes 3 with your approval": record types where the connector has them. */
export function accessSummary(rows: ReturnType<typeof accessRows>) {
  const counted = (list: { entity: string | null; verb: Verb }[]) => {
    const verbs = new Set(list.map((r) => r.verb));
    return [...verbs].flatMap((verb) => {
      const ofVerb = list.filter((r) => r.verb === verb);
      const typed = ofVerb.filter((r) => r.entity !== null);
      return typed.length > 0 ? typed : ofVerb;
    });
  };
  const reads = counted(rows.read) as typeof rows.read;
  const changes = counted(rows.change) as typeof rows.change;
  return {
    reads: reads.filter((r) => r.level !== "off").length,
    changesAsk: changes.filter((r) => r.level === "approval").length,
    changesAuto: changes.filter((r) => r.level === "auto").length,
  };
}
