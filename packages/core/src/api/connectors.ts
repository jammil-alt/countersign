import { z } from "zod";
import { EntityPermissions, PermissionEntity, PermissionLevel, Verb } from "../schemas/permissions";
import { defineRoute } from "./contract";

// The connectors catalog (ARCHITECTURE §6.1 "Connectors catalog", docs/plan.md §1.44, W2-A): the
// operator's view of every registered connector, its status, clients connected, tools, errors in
// the last 24 hours, the default access for new clients (a matrix with entities, applied when a
// client's connection is first made) and who is waiting to connect. Back office only.

const OPS = ["operator"] as const;
const ConnectorIdParams = z.object({ id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/) });

/** The operator's status for a connector (`connector_setting.status`). */
export const CONNECTOR_STATUS_VALUES = ["live", "beta", "in_review", "building"] as const;
export const ConnectorStatus = z.enum(CONNECTOR_STATUS_VALUES);
export type ConnectorStatus = z.infer<typeof ConnectorStatus>;

/** A whole matrix with entities, as a connection's default access is stored. */
export const AccessMatrix = z
  .strictObject({
    read: PermissionLevel,
    create: PermissionLevel,
    update: PermissionLevel,
    delete: PermissionLevel,
    scope: z.unknown().optional(),
    entities: EntityPermissions.optional(),
  })
  .meta({ id: "AccessMatrix" });
export type AccessMatrix = z.infer<typeof AccessMatrix>;

/** Where a connector's default access comes from: the operator's, the connector's, the platform's. */
export const DefaultAccessSource = z.enum(["operator", "connector", "platform"]);
export type DefaultAccessSource = z.infer<typeof DefaultAccessSource>;

/** A client waiting to connect: it is offered the connector, or an agent of it needs it. */
export const WaitingClient = z.object({
  clientId: z.string(),
  clientName: z.string(),
  offered: z.boolean(),
  /** Client agents whose live version needs the connector (names as the back office shows them). */
  agents: z.array(z.object({ id: z.string(), name: z.string() })),
});
export type WaitingClient = z.infer<typeof WaitingClient>;

export const CatalogTool = z.object({
  id: z.string(),
  description: z.string(),
  verb: Verb,
  /** Its entity; null when it has none or its input names it. */
  entity: z.string().nullable(),
});

/** One registered connector in the catalog. */
export const CatalogConnector = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    icon: z.string(),
    auth: z.enum(["oauth2", "api_key", "none"]),
    /** The operator's status; null until they set one. */
    status: ConnectorStatus.nullable(),
    note: z.string(),
    /** Whether a client can sign in to it on this deployment. */
    available: z.boolean(),
    /** Clients (of those you serve) with a connection that is connected. */
    clientsConnected: z.number().int(),
    tools: z.array(CatalogTool),
    permissionEntities: z.array(PermissionEntity),
    /** In the last 24 hours: failed tool calls, and connections now in error. */
    errors: z.object({ toolCalls: z.number().int(), connections: z.number().int() }),
    defaultAccess: z.object({ matrix: AccessMatrix, source: DefaultAccessSource }),
    waiting: z.array(WaitingClient),
    updatedAt: z.string().nullable(),
  })
  .meta({ id: "CatalogConnector" });
export type CatalogConnector = z.infer<typeof CatalogConnector>;

/**
 * Set a connector's status, its default access for new clients (null: back to the connector's) and
 * its note. A field left out keeps its value; a connector's first setting needs a status.
 */
export const SetConnectorBody = z.strictObject({
  status: ConnectorStatus.optional(),
  defaultPermissions: AccessMatrix.nullable().optional(),
  note: z.string().max(2000).optional(),
});
export type SetConnectorBody = z.infer<typeof SetConnectorBody>;

export const connectorRoutes = {
  opsConnectors: defineRoute({
    method: "GET",
    path: "/api/ops/connectors",
    auth: "session",
    roles: OPS,
    summary:
      "The connectors catalog: each connector's status, clients connected, tools, errors in the last 24 hours, default access for new clients and who is waiting to connect",
    response: z.object({ connectors: z.array(CatalogConnector) }),
  }),
  opsSetConnector: defineRoute({
    method: "PUT",
    path: "/api/ops/connectors/:id",
    auth: "session",
    roles: OPS,
    summary:
      "Set a connector's status, its default access for new clients (never looser than the platform's defaults) and a note",
    params: ConnectorIdParams,
    body: SetConnectorBody,
    response: z.object({ connector: CatalogConnector }),
  }),
};
