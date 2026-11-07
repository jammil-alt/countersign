// The connectors catalog (ARCHITECTURE §6.1 "Connectors catalog", docs/plan.md §1.44, W2-A): the
// operator's view of every registered connector, with its status, clients connected, tools, errors
// in the last 24 hours, the default access for new clients and who is waiting to connect. Also the
// one place a new connection's starting matrix is read: the operator's default access for the
// connector (`connector_setting`), else the connector's, else the platform's.

import { requiredConnectors } from "@countersign/agents";
import { type Connector, connectionDefaults, defaultAccessProblems } from "@countersign/connectors";
import {
  type CatalogConnector,
  type ConnectorManifest,
  type PermissionMatrix,
  routes,
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
  for (const c of platform.connectors.list()) {
    for (const t of c.manifest.tools) out.set(t.id, c.manifest.id);
  }
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

  return platform.connectors.list().map((connector) => {
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
    return {
      id: m.id,
      name: m.name,
      description: m.description,
      icon: m.icon,
      auth: m.auth,
      status: setting?.status ?? null,
      note: setting?.note ?? "",
      available: canSignIn(connector),
      clientsConnected: connected.size,
      tools: m.tools.map((t) => ({
        id: t.id,
        description: t.description,
        verb: t.verb,
        entity: t.entity ?? null,
      })),
      permissionEntities: m.permissionEntities ?? [],
      errors: {
        toolCalls: failedBy.get(m.id) ?? 0,
        connections: mine.filter((c) => c.status === "error").length,
      },
      defaultAccess: {
        matrix: connectionDefaults(m, operatorDefault),
        source: operatorDefault ? "operator" : m.defaultPermissions ? "connector" : "platform",
      },
      waiting,
      updatedAt: iso(setting?.updatedAt),
    };
  });
}

export function opsConnectorRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.opsConnectors, async ({ tx, tenantIds, services }) => ({
    connectors: await catalog(tx, tenantIds, services.platform),
  }));

  mount(app, routes.opsSetConnector, async ({ tx, tenantIds, params, body, session, services }) => {
    const connector = services.platform.connectors.get(params.id);
    if (!connector) throw notFound("connector");
    const [before] = await tx
      .select()
      .from(connectorSetting)
      .where(eq(connectorSetting.connector, connector.manifest.id));
    const defaultPermissions =
      body.defaultPermissions === undefined
        ? (before?.defaultPermissions ?? null)
        : body.defaultPermissions;
    if (defaultPermissions) {
      const problems = defaultAccessProblems(connector.manifest, defaultPermissions);
      if (problems.length > 0)
        throw new HttpError(422, "invalid_default_access", problems.join("; "));
    }
    const status = body.status ?? before?.status;
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
      note: body.note ?? before?.note ?? "",
      updatedBy: session.user.id,
    };
    await tx
      .insert(connectorSetting)
      .values({ connector: connector.manifest.id, ...values })
      .onConflictDoUpdate({
        target: connectorSetting.connector,
        set: { ...values, updatedAt: sql`now()` },
      });
    const out = (await catalog(tx, tenantIds, services.platform)).find(
      (c) => c.id === connector.manifest.id,
    );
    if (!out) throw notFound("connector");
    return { connector: out };
  });
}
