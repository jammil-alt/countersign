import { z } from "zod";
import { isUuid } from "../ids";
import { GrantLimits } from "../permissions/grants";
import { CREDENTIAL_VALUE_MAX, CredentialField } from "../schemas/connector";
import { PermissionLevel, Verb } from "../schemas/permissions";
import { defineRoute } from "./contract";

// Access, phase 1 (ARCHITECTURE §6.9, docs/plan.md §1.26): the client's vault (every connection,
// with whether its secret is set, never the secret), the agents that can use each item and with
// what, and the grants that narrow them. The operator sets grants up to the connection's matrix
// from the back office; the client admin sees them on the portal's Access page and may only
// tighten or revoke. The client admin enters an API-key connector's credentials; no route returns
// them and no operator route sets them.

const Id = z.string().refine((v) => isUuid(v), "not an id");
const OPS = ["operator"] as const;
const CLIENT = ["client_admin", "client_user"] as const;

/** A level per verb, as an agent gets it on a connection. */
export const VerbLevels = z.object({
  read: PermissionLevel,
  create: PermissionLevel,
  update: PermissionLevel,
  delete: PermissionLevel,
});
export type VerbLevels = z.infer<typeof VerbLevels>;

/** What a vault item is. Browser logins arrive in phase 3. */
export const VaultKind = z.enum(["oauth", "api_key", "browser", "built_in"]);
export type VaultKind = z.infer<typeof VaultKind>;

/** One credential field as a read model shows it: whether it is set, and a non-secret's value. */
export const VaultField = z.object({
  name: z.string(),
  label: z.string(),
  secret: z.boolean(),
  hint: z.string().nullable(),
  set: z.boolean(),
  /** Non-secret fields only (a username); always null for a secret. */
  value: z.string().nullable(),
});
export type VaultField = z.infer<typeof VaultField>;

export const AccessTool = z.object({ id: z.string(), description: z.string(), verb: Verb });
export type AccessTool = z.infer<typeof AccessTool>;

/** One agent's access to one vault item. */
export const AgentAccess = z.object({
  agentId: z.string(),
  /** The portal shows the service's name; the back office the agent's. */
  name: z.string(),
  /** The grant's own limits (`{}`: no narrowing). */
  limits: GrantLimits,
  /** Per verb, the stricter of the connection's matrix and the grant. */
  effective: VerbLevels,
  /** The tools it may call, when the grant names a subset; null = every tool. */
  tools: z.array(z.string()).nullable(),
  revoked: z.boolean(),
  updatedAt: z.string().nullable(),
});
export type AgentAccess = z.infer<typeof AgentAccess>;

export const VaultSecretState = z.object({
  /** Whether the connection holds stored credentials. */
  set: z.boolean(),
  /** For connectors with a credential form: each field. */
  fields: z.array(VaultField),
  updatedAt: z.string().nullable(),
});

export const VaultItem = z.object({
  connectionId: z.string(),
  connector: z.string(),
  name: z.string(),
  kind: VaultKind,
  status: z.string(),
  externalAccountId: z.string().nullable(),
  secret: VaultSecretState,
  /** Whether the client admin can enter or replace its credentials here. */
  credentialForm: z.boolean(),
  matrix: VerbLevels,
  tools: z.array(AccessTool),
  /** Every client agent bound to it. */
  agents: z.array(AgentAccess),
});
export type VaultItem = z.infer<typeof VaultItem>;

/** An offered API-key connector with a credential form and no connection yet. */
export const VaultSetup = z.object({
  connector: z.string(),
  name: z.string(),
  description: z.string(),
  fields: z.array(CredentialField),
});
export type VaultSetup = z.infer<typeof VaultSetup>;

export const PortalAccessView = z.object({
  items: z.array(VaultItem),
  setup: z.array(VaultSetup),
  /** Whether this person may tighten grants and enter credentials (the client admin). */
  canEdit: z.boolean(),
});
export type PortalAccessView = z.infer<typeof PortalAccessView>;

/** Values entered for a connector's credential fields: every field, each time (write-only). */
export const SetCredentials = z.strictObject({
  values: z.record(z.string(), z.string().max(CREDENTIAL_VALUE_MAX)),
});
export type SetCredentials = z.infer<typeof SetCredentials>;

export const SetGrant = z.strictObject({ limits: GrantLimits });
export type SetGrant = z.infer<typeof SetGrant>;

/** A client agent's grant on one bound connection, as the back office shows it. */
export const OpsAgentGrant = z.object({
  connector: z.string(),
  connectorName: z.string(),
  connectionId: z.string(),
  status: z.string(),
  externalAccountId: z.string().nullable(),
  kind: VaultKind,
  secretSet: z.boolean(),
  matrix: VerbLevels,
  tools: z.array(AccessTool),
  access: AgentAccess,
});
export type OpsAgentGrant = z.infer<typeof OpsAgentGrant>;

const ConnectorParam = z.object({ connector: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/) });

export const accessRoutes = {
  portalAccess: defineRoute({
    method: "GET",
    path: "/api/access",
    auth: "session",
    roles: CLIENT,
    summary:
      "The client's vault: each connection, whether its secret is set, and which agents can use it with what",
    response: PortalAccessView,
  }),
  portalSetGrant: defineRoute({
    method: "PUT",
    path: "/api/access/agents/:agentId/connections/:connectionId",
    auth: "session",
    roles: ["client_admin"],
    summary: "Tighten or revoke what an agent may do through a connection (never loosen: 403)",
    params: z.object({ agentId: Id, connectionId: Id }),
    body: SetGrant,
    response: z.object({ item: VaultItem }),
  }),
  portalSetCredentials: defineRoute({
    method: "PUT",
    path: "/api/connections/:connector/credentials",
    auth: "session",
    roles: ["client_admin"],
    summary:
      "Enter or replace an API-key connector's credentials; answers only which fields are set",
    params: ConnectorParam,
    body: SetCredentials,
    response: z.object({ item: VaultItem }),
  }),
  opsAgentGrants: defineRoute({
    method: "GET",
    path: "/api/ops/agents/:id/grants",
    auth: "session",
    roles: OPS,
    summary: "A client agent's bound connections and its grant on each",
    params: z.object({ id: Id }),
    response: z.object({ grants: z.array(OpsAgentGrant) }),
  }),
  opsSetAgentGrant: defineRoute({
    method: "PUT",
    path: "/api/ops/agents/:id/grants/:connectionId",
    auth: "session",
    roles: OPS,
    summary:
      "Set a client agent's grant on a bound connection, up to the connection's matrix (422 beyond it)",
    params: z.object({ id: Id, connectionId: Id }),
    body: SetGrant,
    response: z.object({ grant: OpsAgentGrant }),
  }),
} as const;
