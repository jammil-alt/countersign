import { z } from "zod";
import { isUuid } from "../ids";
import { GrantLimits } from "../permissions/grants";
import { RELEASE_STATUSES, ReleaseChannel, ReleaseWindow } from "../permissions/release";
import { CREDENTIAL_VALUE_MAX, CredentialField } from "../schemas/connector";
import { PermissionLevel, Verb } from "../schemas/permissions";
import { BrowserSiteOffer, BrowserVaultInfo } from "./browser";
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

/** What a vault item is: a sign-in, an API key, a browser login (phase 3) or built in. */
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

// ── Human release (phase 4) ─────────────────────────────────────────────────────────────────────

/** A person of the client who can release a vault item, and how a code can reach them. */
export const ReleasePerson = z.object({
  id: z.string(),
  name: z.string().nullable(),
  /** Their sign-in address, masked. */
  email: z.string(),
  /** Whether a text can reach them (a contact with their address, a phone and text consent). */
  canText: z.boolean(),
});
export type ReleasePerson = z.infer<typeof ReleasePerson>;

/** A release that lets an agent through now. */
export const LiveRelease = z.object({
  id: z.string(),
  connectionId: z.string(),
  agentId: z.string(),
  agentName: z.string(),
  person: z.object({ id: z.string(), name: z.string().nullable() }),
  channel: ReleaseChannel,
  /** Set for a `run` release: the run it covers. */
  runId: z.string().nullable(),
  releasedAt: z.string(),
  /** Null for a `run` release (it lasts as long as that run). */
  validUntil: z.string().nullable(),
});
export type LiveRelease = z.infer<typeof LiveRelease>;

/** A vault item's human release setting, as both surfaces show it. Never a code or a hash. */
export const ReleaseView = z.object({
  mode: z.enum(["off", "code"]),
  person: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
  channel: ReleaseChannel,
  window: ReleaseWindow,
  /** Where texts go, masked; null for email. */
  sentTo: z.string().nullable(),
  updatedAt: z.string().nullable(),
  live: z.array(LiveRelease),
});
export type ReleaseView = z.infer<typeof ReleaseView>;

/** Turn human release on (with a person, a channel and a window) or off. */
export const SetRelease = z
  .strictObject({
    mode: z.enum(["off", "code"]),
    personId: Id.optional(),
    channel: ReleaseChannel.optional(),
    window: ReleaseWindow.optional(),
  })
  .refine((v) => v.mode === "off" || (v.personId && v.channel && v.window), {
    message: "turning human release on needs a person, a channel and a window",
  });
export type SetRelease = z.infer<typeof SetRelease>;

/** A request for a code, as the person sees it from their inbox item. */
export const ReleaseRequestView = z.object({
  inboxItemId: z.string(),
  status: z.enum(RELEASE_STATUSES),
  agentName: z.string(),
  toolName: z.string(),
  channel: ReleaseChannel,
  /** Where the code went, masked. */
  sentTo: z.string(),
  expiresAt: z.string(),
  triesLeft: z.number().int(),
  resendsLeft: z.number().int(),
  /** Whether the person looking is the one who can enter the code. */
  mine: z.boolean(),
});
export type ReleaseRequestView = z.infer<typeof ReleaseRequestView>;

/** A code as the person types it: six digits (spaces and dashes are dropped). */
export const EnterReleaseCode = z.strictObject({
  code: z
    .string()
    .max(20)
    .transform((v) => v.replace(/[\s-]/g, ""))
    .refine((v) => /^\d{6}$/.test(v), "a code is six digits"),
});
export type EnterReleaseCode = z.infer<typeof EnterReleaseCode>;

export const VaultItem = z.object({
  connectionId: z.string(),
  connector: z.string(),
  name: z.string(),
  kind: VaultKind,
  status: z.string(),
  externalAccountId: z.string().nullable(),
  /**
   * The account's name in the tool (e.g. the QuickBooks company), or a mail account's address;
   * null when the tool gives neither (core connectionLabel). Never a bare id.
   */
  accountName: z.string().nullable().default(null),
  secret: VaultSecretState,
  /** Whether the client admin can enter or replace its credentials here. */
  credentialForm: z.boolean(),
  matrix: VerbLevels,
  tools: z.array(AccessTool),
  /** Every client agent bound to it. */
  agents: z.array(AgentAccess),
  /** Browser logins only: the site, its tier and the client's stricter settings. */
  browser: BrowserVaultInfo.nullable().default(null),
  /** Human release: whether a person must release it, and the releases live now. */
  release: ReleaseView,
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
  /** Sites a browser login can be set up on (the client admin, when browser logins are offered). */
  browserSites: z.array(BrowserSiteOffer).default([]),
  /** Whether this person may tighten grants and enter credentials (the client admin). */
  canEdit: z.boolean(),
  /** Who can be named to release a vault item (the client admin's view only; else empty). */
  people: z.array(ReleasePerson),
});
export type PortalAccessView = z.infer<typeof PortalAccessView>;

/** Values entered for a connector's credential fields: every field, each time (write-only). */
export const SetCredentials = z.strictObject({
  values: z.record(z.string(), z.string().max(CREDENTIAL_VALUE_MAX)),
  /**
   * Which connection, for a connector a client may have several of (browser logins, one per
   * site). Absent: the client's one connection of that connector.
   */
  connectionId: z
    .string()
    .refine((v) => isUuid(v), "not an id")
    .optional(),
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
  /** The connection's human release setting: the operator may turn it on, never off. */
  release: ReleaseView,
});
export type OpsAgentGrant = z.infer<typeof OpsAgentGrant>;

const InboxParam = z.object({ id: Id });

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
  portalSetRelease: defineRoute({
    method: "PUT",
    path: "/api/access/connections/:connectionId/release",
    auth: "session",
    roles: ["client_admin"],
    summary:
      "Turn human release of a vault item on or off, with the person, the channel and the window",
    params: z.object({ connectionId: Id }),
    body: SetRelease,
    response: z.object({ item: VaultItem }),
  }),
  portalReleases: defineRoute({
    method: "GET",
    path: "/api/access/releases",
    auth: "session",
    roles: CLIENT,
    summary: "Releases that let an agent use a vault item now",
    response: z.object({ releases: z.array(LiveRelease) }),
  }),
  portalRevokeRelease: defineRoute({
    method: "POST",
    path: "/api/access/releases/:id/revoke",
    auth: "session",
    roles: ["client_admin"],
    summary: "Revoke a live release: the agent needs a new code before it uses the item again",
    params: z.object({ id: Id }),
    response: z.object({ item: VaultItem }),
  }),
  portalReleaseRequest: defineRoute({
    method: "GET",
    path: "/api/access/requests/:id",
    auth: "session",
    roles: CLIENT,
    summary: "A request for a code, by its inbox item: where the code went and what is left",
    params: InboxParam,
    response: z.object({ request: ReleaseRequestView }),
  }),
  portalEnterReleaseCode: defineRoute({
    method: "POST",
    path: "/api/access/requests/:id/code",
    auth: "session",
    roles: CLIENT,
    summary:
      "Enter the code we sent (only the person it went to); a wrong code uses one of 5 tries",
    params: InboxParam,
    body: EnterReleaseCode,
    response: z.object({
      request: ReleaseRequestView,
      /** What the code did: released, wrong (a try used), expired, or nothing (closed). */
      result: z.enum(["released", "wrong", "expired", "closed"]),
    }),
  }),
  portalResendReleaseCode: defineRoute({
    method: "POST",
    path: "/api/access/requests/:id/resend",
    auth: "session",
    roles: CLIENT,
    summary: "Send a new code (only the person it went to; at most 3 times while the step waits)",
    params: InboxParam,
    response: z.object({ request: ReleaseRequestView }),
  }),
  opsRelease: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:clientId/connections/:connectionId/release",
    auth: "session",
    roles: OPS,
    summary: "A vault item's human release setting and the people who can be named",
    params: z.object({ clientId: Id, connectionId: Id }),
    response: z.object({ release: ReleaseView, people: z.array(ReleasePerson) }),
  }),
  opsSetRelease: defineRoute({
    method: "PUT",
    path: "/api/ops/clients/:clientId/connections/:connectionId/release",
    auth: "session",
    roles: OPS,
    summary:
      "Turn human release of a vault item on (403 to turn it off or change it: that is the client admin's)",
    params: z.object({ clientId: Id, connectionId: Id }),
    body: SetRelease,
    response: z.object({ release: ReleaseView }),
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
