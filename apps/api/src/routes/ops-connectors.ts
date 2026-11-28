// The connectors catalog (ARCHITECTURE §6.1 "Connectors catalog", docs/plan.md §1.44, W2-A): the
// operator's view of every registered connector, with its status, clients connected, tools, errors
// in the last 24 hours, the default access for new clients and who is waiting to connect. Also the
// one place a new connection's starting matrix is read: the operator's default access for the
// connector (`connector_setting`), else the connector's, else the platform's.

import { requiredConnectors } from "@countersign/agents";
import {
  type ActionSwitches,
  actionIsOn,
  BUILTIN_CONNECTORS,
  type Connector,
  connectionDefaults,
  defaultAccessProblems,
} from "@countersign/connectors";
import {
  type CatalogAction,
  type CatalogConnector,
  type ConnectorManifest,
  type ConnectorStatus,
  type PermissionMatrix,
  routes,
  steps,
  type ToolSpec,
  type WaitingClient,
} from "@countersign/core";
import {
  agent,
  agentVersion,
  connection,
  connectorSetting,
  readOperatorCatalogue,
  type Tx,
  tenant,
  toolCall,
} from "@countersign/db";
import { and, count, eq, gt, inArray, isNotNull, ne, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { type AppEnv, HttpError, iso, mount, notFound } from "../http";
import type { Platform } from "../platform";
import { offeredConnectors } from "./ops-clients";
import { canSignIn } from "./portal";

type SettingRow = typeof connectorSetting.$inferSelect;

/**
 * The matrix a client's new connection starts with (docs/plan.md §1.44 "Catalog"): the operator's
 * default access for the connector, else the connector's, else the platform's. Read inside the
 * request's transaction as the operator's catalogue (connector_setting is an operator table).
 */
export async function newConnectionMatrix(
  tx: Tx,
  manifest: (Pick<ConnectorManifest, "id"> & Partial<ConnectorManifest>) | undefined,
): Promise<PermissionMatrix> {
  const setting = manifest
    ? await readOperatorCatalogue(tx, async (inner) => {
        const [row] = await inner
          .select({ defaultPermissions: connectorSetting.defaultPermissions })
          .from(connectorSetting)
          .where(eq(connectorSetting.connector, manifest.id));
        return row ?? null;
      })
    : null;
  return connectionDefaults(manifest, setting?.defaultPermissions ?? null);
}

/** A connection an agent can use: connected, or pending on a connector without sign-in. */
function usable(c: { status: string }, connector: Connector | undefined): boolean {
  return (
    c.status === "connected" || (c.status === "pending" && connector?.manifest.auth === "none")
  );
}

/** The connector each tool id belongs to (shared namespaces such as `sms.` included). */
function toolOwners(platform: Platform): Map<string, string> {
  const out = new Map<string, string>();
  for (const b of BUILTIN_CONNECTORS) for (const a of b.actions) out.set(a.id, b.id);
  for (const c of platform.connectors.list()) {
    for (const t of c.manifest.tools) out.set(t.id, c.manifest.id);
  }
  return out;
}

/**
 * A connector's status in the catalog: the operator's when they set one, else what this deployment
 * shows. Without this every connector read "Not set" until someone chose a status by hand, even
 * QuickBooks with clients connected.
 */
// DECISION: with no status set, a connector a client can sign in to on this deployment reads as
// live (it is: clients connect it here); one that isn't set up here has none ("Not set up").
export function catalogStatus(
  set: ConnectorStatus | null,
  available: boolean,
): Pick<CatalogConnector, "status" | "statusSource"> {
  if (set) return { status: set, statusSource: "operator" };
  return { status: available ? "live" : null, statusSource: "deployment" };
}

/** An action's words when no one has named it: the tool's id, read aloud. */
function actionLabel(id: string): string {
  return id.replace(/[._-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/**
 * A connector's actions as the page shows them (docs/step-model-plan.md §10c): every tool it gives,
 * with its kind and whether it is on for agents. An action the operator never looked at and that the
 * manifest starts off is `isNew`: it waits there to be turned on.
 */
export function catalogActions(
  manifest: Pick<ConnectorManifest, "offByDefault">,
  specs: readonly ToolSpec[],
  switches: ActionSwitches,
  labels: Readonly<Record<string, string>> = {},
): CatalogAction[] {
  return specs.map((t) => ({
    id: t.id,
    label: labels[t.id] ?? actionLabel(t.id),
    description: t.description,
    kind: steps.actionKind(t),
    entity: t.entity ?? null,
    on: actionIsOn(manifest, t.id, switches),
    isNew: switches?.[t.id] === undefined && (manifest.offByDefault ?? []).includes(t.id),
  }));
}

/**
 * The switches a save leaves: the ones stored, with the named ones changed. Only ids the connector
 * has count (anything else is refused by the route first). A connector's first switch writes the
 * choice of every action it has, so later actions never follow the first save by accident.
 */
export function nextSwitches(
  stored: ActionSwitches,
  ids: readonly string[],
  manifest: Pick<ConnectorManifest, "offByDefault">,
  change: Readonly<Record<string, boolean>>,
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const id of ids) out[id] = stored?.[id] ?? actionIsOn(manifest, id, stored);
  for (const [id, on] of Object.entries(change)) out[id] = on;
  return out;
}

/** The catalog over the clients this operator serves (`tenantIds`). */
async function catalog(
  tx: Tx,
  tenantIds: readonly string[],
  platform: Platform,
): Promise<CatalogConnector[]> {
  const ids = [...tenantIds];
  const settings: SettingRow[] = await tx.select().from(connectorSetting);
  const clients =
    ids.length > 0
      ? await tx
          .select({ id: tenant.id, name: tenant.name, settings: tenant.settings })
          .from(tenant)
          .where(inArray(tenant.id, ids))
      : [];
  const conns =
    ids.length > 0
      ? await tx
          .select({
            tenantId: connection.tenantId,
            connector: connection.connector,
            status: connection.status,
          })
          .from(connection)
          .where(inArray(connection.tenantId, ids))
      : [];
  // Failed tool calls in the last 24 hours, by tool, then by connector.
  const failed =
    ids.length > 0
      ? await tx
          .select({ tool: toolCall.tool, n: count() })
          .from(toolCall)
          .where(
            and(
              inArray(toolCall.tenantId, ids),
              eq(toolCall.status, "failed"),
              gt(toolCall.createdAt, sql`now() - interval '24 hours'`),
            ),
          )
          .groupBy(toolCall.tool)
      : [];
  const owners = toolOwners(platform);
  const failedBy = new Map<string, number>();
  for (const f of failed) {
    const owner = owners.get(f.tool);
    if (owner) failedBy.set(owner, (failedBy.get(owner) ?? 0) + Number(f.n));
  }
  // Agents that need a connector: live client agents, from their live version (as the weekly
  // setup items read it, apps/api/src/weekly/stats.ts).
  // DECISION: "an agent needs it" is the connectors its live version names (agents'
  // `requiredConnectors`); drafts and retired agents don't wait for anything.
  const agents =
    ids.length > 0
      ? await tx
          .select({
            id: agent.id,
            tenantId: agent.tenantId,
            name: agent.name,
            bundle: agentVersion.bundle,
          })
          .from(agent)
          .innerJoin(
            agentVersion,
            and(
              eq(agentVersion.id, agent.liveVersionId),
              eq(agentVersion.tenantId, agent.tenantId),
            ),
          )
          .where(
            and(
              inArray(agent.tenantId, ids),
              eq(agent.kind, "client"),
              eq(agent.testCopy, false),
              isNotNull(agent.liveVersionId),
              ne(agent.runStatus, "retired"),
            ),
          )
      : [];
  const skills = Object.fromEntries(platform.catalog.list().map((d) => [d.id, d]));
  const needs = agents.map((a) => {
    let needed: string[] = [];
    try {
      needed = requiredConnectors(a.bundle, skills, platform.tools);
    } catch {
      // A bundle that no longer reads names nothing here; the agent's own page shows it.
    }
    return { ...a, needed };
  });

  const builtIns: CatalogConnector[] = BUILTIN_CONNECTORS.map((b) => {
    const setting = settings.find((x) => x.connector === b.id);
    const specs = b.actions
      .map((a) => platform.tools.get(a.id)?.spec)
      .filter((t): t is ToolSpec => t !== undefined);
    const labels = Object.fromEntries(b.actions.map((a) => [a.id, a.label]));
    const manifest = { offByDefault: b.offByDefault ? [...b.offByDefault] : [] };
    return {
      id: b.id,
      name: b.name,
      description: b.description,
      icon: b.icon,
      auth: "none" as const,
      ...catalogStatus(setting?.status ?? null, true),
      testOnly: false,
      note: setting?.note ?? "",
      available: true,
      clientsConnected: 0,
      tools: specs.map((t) => ({
        id: t.id,
        description: t.description,
        verb: t.verb,
        entity: t.entity ?? null,
      })),
      actions: catalogActions(manifest, specs, setting?.actions, labels),
      syncs: [],
      builtIn: true,
      permissionEntities: [],
      errors: { toolCalls: failedBy.get(b.id) ?? 0, connections: 0 },
      defaultAccess: { matrix: connectionDefaults(undefined, null), source: "platform" as const },
      waiting: [],
      updatedAt: iso(setting?.updatedAt),
    };
  });

  const registered = platform.connectors.list().map((connector) => {
    const m = connector.manifest;
    const setting = settings.find((s) => s.connector === m.id);
    const operatorDefault =
      setting?.defaultPermissions &&
      defaultAccessProblems(m, setting.defaultPermissions).length === 0
        ? setting.defaultPermissions
        : null;
    const mine = conns.filter((c) => c.connector === m.id);
    const connected = new Set(mine.filter((c) => c.status === "connected").map((c) => c.tenantId));
    const waiting: WaitingClient[] = clients.flatMap((t) => {
      if (mine.some((c) => c.tenantId === t.id && usable(c, connector))) return [];
      const offered = offeredConnectors(t.settings).includes(m.id);
      const agentsNeeding = needs
        .filter((a) => a.tenantId === t.id && a.needed.includes(m.id))
        .map((a) => ({ id: a.id, name: a.name }));
      if (!offered && agentsNeeding.length === 0) return [];
      return [{ clientId: t.id, clientName: t.name, offered, agents: agentsNeeding }];
    });
    const available = canSignIn(connector);
    return {
      id: m.id,
      name: m.name,
      description: m.description,
      icon: m.icon,
      auth: m.auth,
      ...catalogStatus(setting?.status ?? null, available),
      testOnly: m.testOnly === true,
      note: setting?.note ?? "",
      available,
      clientsConnected: connected.size,
      tools: m.tools.map((t) => ({
        id: t.id,
        description: t.description,
        verb: t.verb,
        entity: t.entity ?? null,
      })),
      actions: catalogActions(m, m.tools, setting?.actions),
      syncs: m.entities,
      builtIn: false,
      permissionEntities: m.permissionEntities ?? [],
      errors: {
        toolCalls: failedBy.get(m.id) ?? 0,
        connections: mine.filter((c) => c.status === "error").length,
      },
      defaultAccess: {
        matrix: connectionDefaults(m, operatorDefault),
        source: (operatorDefault
          ? "operator"
          : m.defaultPermissions
            ? "connector"
            : "platform") as CatalogConnector["defaultAccess"]["source"],
      },
      waiting,
      updatedAt: iso(setting?.updatedAt),
    };
  });
  return [...registered, ...builtIns];
}

export function opsConnectorRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.opsConnectors, async ({ tx, tenantIds, services }) => ({
    connectors: await catalog(tx, tenantIds, services.platform),
  }));

  mount(app, routes.opsSetConnector, async ({ tx, tenantIds, params, body, session, services }) => {
    const connector = services.platform.connectors.get(params.id);
    const builtIn = connector ? undefined : BUILTIN_CONNECTORS.find((b) => b.id === params.id);
    if (!connector && !builtIn) throw notFound("connector");
    const id = connector?.manifest.id ?? (builtIn?.id as string);
    const [before] = await tx
      .select()
      .from(connectorSetting)
      .where(eq(connectorSetting.connector, id));
    if (builtIn && body.defaultPermissions) {
      throw new HttpError(422, "invalid_default_access", `${builtIn.name} has no access to set`);
    }
    const defaultPermissions =
      body.defaultPermissions === undefined
        ? (before?.defaultPermissions ?? null)
        : body.defaultPermissions;
    if (defaultPermissions && connector) {
      const problems = defaultAccessProblems(connector.manifest, defaultPermissions);
      if (problems.length > 0)
        throw new HttpError(422, "invalid_default_access", problems.join("; "));
    }
    // Step model E: switch actions on or off. Only ids the connector has; delete is not an action
    // and stays off whatever is set here (invariant 8).
    const own = connector
      ? connector.manifest.tools.map((t) => t.id)
      : (builtIn?.actions.map((a) => a.id) ?? []);
    let actions = before?.actions ?? null;
    if (body.actions) {
      const unknown = Object.keys(body.actions).filter((a) => !own.includes(a));
      if (unknown.length > 0) {
        throw new HttpError(422, "unknown_action", `no such action: ${unknown.join(", ")}`);
      }
      actions = nextSwitches(
        before?.actions,
        own,
        connector?.manifest ?? {
          offByDefault: builtIn?.offByDefault ? [...builtIn.offByDefault] : [],
        },
        body.actions,
      );
    }
    // DECISION: switching an action on a connector nobody has set a status on keeps the status the
    // deployment shows (live where a client can sign in, else still being built), so the page
    // doesn't ask for one first.
    const status =
      body.status ??
      before?.status ??
      (body.actions
        ? connector && !canSignIn(connector)
          ? ("building" as const)
          : ("live" as const)
        : undefined);
    if (!status) {
      throw new HttpError(
        422,
        "status_required",
        "say whether the connector is live, in beta, in review or still being built",
      );
    }
    const values = {
      status,
      defaultPermissions,
      actions,
      note: body.note ?? before?.note ?? "",
      updatedBy: session.user.id,
    };
    await tx
      .insert(connectorSetting)
      .values({ connector: id, ...values })
      .onConflictDoUpdate({
        target: connectorSetting.connector,
        set: { ...values, updatedAt: sql`now()` },
      });
    const out = (await catalog(tx, tenantIds, services.platform)).find((c) => c.id === id);
    if (!out) throw notFound("connector");
    return { connector: out };
  });
}
