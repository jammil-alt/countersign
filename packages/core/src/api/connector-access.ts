import { z } from "zod";
import { isUuid } from "../ids";
import { MEZONAS_MAY_DURATIONS } from "../permissions/change";
import type { GapKind } from "../permissions/needs";
import {
  CONNECTION_CHANGE_REQUEST_STATUSES,
  ConnectionRowChange,
  MEZONAS_MAY_CHOICES,
} from "../schemas/connection-requests";
import { ConnectorAuth } from "../schemas/connector";
import { PermissionEntity, PermissionLevel, Verb } from "../schemas/permissions";
import { defineRoute } from "./contract";
import { MatrixEdit } from "./routes";

// Connectors C4 (docs/connectors-plan.md §3, §5, §7; docs/plan.md §1.161): the routes behind the
// client's one Connectors place and the back office's Connectors tab, Needs and Readiness panels.
// A client admin sets what agents may read and change (`clientMayAllow`), allows what an agent
// needs, and says how much we may change without asking (Changes by Mezonas). Our changes apply
// at once only when tighter or covered by that go-ahead (`withinAuthorization`); anything else is
// a change request the client admin approves or declines. No response carries a credential, and
// no portal response an agent's bundle, prompts, steps or cost (invariant 11).
//
// DECISION (docs/plan.md §1.161, C4): the client's routes live under `/api/portal/`:
// `/api/connectors` is the shared catalog every role reads, and `/api/connections/...` holds the
// portal's older Accounts routes, which stay until the Connectors screens replace them. A
// connection is addressed by its id alone (it names its connector).
// DECISION: the back office's agent panels hang off `/api/ops/agents/:id` (as grants do): an agent
// id names its client; a template's Readiness takes the client in `?client=`.

const Id = z.string().refine((v) => isUuid(v), "not an id");
const ConnectorId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]*$/)
  .max(64);
const OPS = ["operator"] as const;
const CLIENT = ["client_admin", "client_user"] as const;
const ADMIN = ["client_admin"] as const;
const Timestamp = z.string();

const Person = z.object({ id: z.string(), name: z.string().nullable() });
const AgentRef = z.object({ id: z.string(), name: z.string() });

// ── Needs and gaps (C1's `ConnectorNeed` and `AccessGap`, as screens read them) ──────────────────

const GAP_KINDS = [
  "not_connected",
  "broken",
  "not_bound",
  "off_on_connection",
  "scope_excludes",
  "off_in_grant",
  "could_run_alone",
] as const satisfies readonly GapKind[];
export const GapKindSchema = z.enum(GAP_KINDS);

/** One need of an agent, in the portal's words: never the step or skill it comes from. */
export const NeedView = z
  .object({
    connector: z.string(),
    verb: Verb,
    entity: z.string().nullable(),
    level: z.enum(["on", "ask"]),
    /** A step set to run without approval would run on its own (a suggestion, never a blocker). */
    wantsAuto: z.boolean(),
    /** Needs sharing this key are alternatives: one met is enough. */
    anyOf: z.string().nullable(),
    /** "Create bills". */
    label: z.string(),
  })
  .meta({ id: "NeedView" });
export type NeedView = z.infer<typeof NeedView>;

/** A need as the back office reads it: the tool behind it, why, and the steps it comes from. */
export const OpsNeedView = NeedView.extend({
  tool: z.string().nullable(),
  why: z.array(z.string()),
  because: z.array(z.object({ workflow: z.string(), stepId: z.string(), stepName: z.string() })),
}).meta({ id: "OpsNeedView" });
export type OpsNeedView = z.infer<typeof OpsNeedView>;

const gapFields = {
  kind: GapKindSchema,
  connector: z.string(),
  connectionId: z.string().nullable(),
  /** False only for `could_run_alone`. */
  blocking: z.boolean(),
  fixBy: z.enum(["client", "mezonas"]),
  /** The fix in words: "Connect QuickBooks", "Allow creating bills", "Bind the connection". */
  words: z.string(),
};

export const GapView = z.object({ ...gapFields, needs: z.array(NeedView) }).meta({ id: "GapView" });
export type GapView = z.infer<typeof GapView>;

export const OpsGapView = z
  .object({ ...gapFields, needs: z.array(OpsNeedView) })
  .meta({ id: "OpsGapView" });
export type OpsGapView = z.infer<typeof OpsGapView>;

/** An agent against one connection or one client: ready (no blocking gap) or what it needs. */
export const AgentNeedsState = z
  .object({ agent: AgentRef, ready: z.boolean(), gaps: z.array(GapView) })
  .meta({ id: "AgentNeedsState" });
export type AgentNeedsState = z.infer<typeof AgentNeedsState>;

export const OpsAgentNeedsState = z
  .object({ agent: AgentRef, ready: z.boolean(), gaps: z.array(OpsGapView) })
  .meta({ id: "OpsAgentNeedsState" });
export type OpsAgentNeedsState = z.infer<typeof OpsAgentNeedsState>;

// ── Changes by Mezonas (§7.2) ────────────────────────────────────────────────────────────────

export const MezonasMayView = z
  .object({
    choice: z.enum(MEZONAS_MAY_CHOICES),
    /** Null: until the client admin turns it off. */
    until: Timestamp.nullable(),
    setBy: Person,
    setAt: Timestamp,
    /** False once `until` has passed: it covers nothing, and the page says it ended. */
    active: z.boolean(),
  })
  .meta({ id: "MezonasMayView" });
export type MezonasMayView = z.infer<typeof MezonasMayView>;

/** Set Changes by Mezonas: `ask` (Ask me each time) clears it; the others last as chosen. */
export const SetMezonasMayBody = z
  .strictObject({
    choice: z.enum(["ask", ...MEZONAS_MAY_CHOICES]),
    duration: z.enum(MEZONAS_MAY_DURATIONS).default("until_off"),
  })
  .meta({ id: "SetMezonasMayBody" });
export type SetMezonasMayBody = z.infer<typeof SetMezonasMayBody>;

// ── Change requests (§7.1) ───────────────────────────────────────────────────────────────────

export const ChangeRequestView = z
  .object({
    id: z.string(),
    connectionId: z.string(),
    connector: z.string(),
    connectorName: z.string(),
    status: z.enum(CONNECTION_CHANGE_REQUEST_STATUSES),
    direction: z.enum(["looser", "mixed", "tighter", "none"]),
    /** What approving changes, row by row, against what the request was made against. */
    rows: z.array(ConnectionRowChange),
    /** Why, in our words. */
    reason: z.string(),
    requestedBy: Person,
    forAgent: AgentRef.nullable(),
    /** Open, but the connection changed since: approving is refused (Out of date). */
    outOfDate: z.boolean(),
    createdAt: Timestamp,
    expiresAt: Timestamp,
    closedAt: Timestamp.nullable(),
    closedBy: Person.nullable(),
    answerNote: z.string().nullable(),
  })
  .meta({ id: "ChangeRequestView" });
export type ChangeRequestView = z.infer<typeof ChangeRequestView>;

export const AnswerRequestBody = z
  .strictObject({ note: z.string().trim().max(1000).optional() })
  .meta({ id: "AnswerRequestBody" });
export type AnswerRequestBody = z.infer<typeof AnswerRequestBody>;

// ── A connector's page ───────────────────────────────────────────────────────────────────────

/**
 * One row of What agents can do: a record type and verb (or the verb as a whole), its level, what
 * this viewer may choose, and the tools, agents and needs behind it. Delete never appears.
 */
export const AccessRowView = z
  .object({
    group: z.enum(["read", "change"]),
    verb: Verb,
    /** Null: the group's control (the verb as a whole). */
    entity: z.string().nullable(),
    /** "Bills" under Read; "Create bills" under Change. */
    label: z.string(),
    level: PermissionLevel,
    /** The levels this viewer may set (a client admin never gets `auto` unless it is already). */
    choices: z.array(PermissionLevel),
    /** The record type's scope for this verb, when one is set. */
    scope: z.object({ id: z.string(), label: z.string() }).nullable(),
    tools: z.array(z.object({ id: z.string(), description: z.string() })),
    /** Agents bound to the connection whose needs include this row. */
    usedBy: z.array(AgentRef),
    /** Agents whose needs call for this row and don't have it now ("Buyer needs this"). */
    neededBy: z.array(AgentRef),
  })
  .meta({ id: "AccessRowView" });
export type AccessRowView = z.infer<typeof AccessRowView>;

/** A connection's access in one line: "Reads 9 · changes 3 with your approval". */
export const AccessSummary = z.object({
  reads: z.number().int(),
  changesAsk: z.number().int(),
  changesAuto: z.number().int(),
});

/** One entry of a connection's history (`connection_change`), worded. */
export const ConnectionHistoryEntry = z
  .object({
    id: z.string(),
    at: Timestamp,
    /** Null for the system. */
    by: Person.nullable(),
    rows: z.array(ConnectionRowChange),
    /** A change Changes by Mezonas was set, cleared or changed: its words. */
    note: z.string().nullable(),
    /** The request it applied, when a client admin approved one. */
    requestId: z.string().nullable(),
    /** The go-ahead it was made under, when it was. */
    authorization: MezonasMayView.nullable(),
  })
  .meta({ id: "ConnectionHistoryEntry" });
export type ConnectionHistoryEntry = z.infer<typeof ConnectionHistoryEntry>;

/** A connection in a list: Connected, Built for you, the back office's tab. */
export const ConnectionSummaryView = z
  .object({
    id: z.string(),
    status: z.string(),
    /** The company or address; null when the tool gives neither. */
    accountName: z.string().nullable(),
    lastSyncAt: Timestamp.nullable(),
    usedBy: z.array(AgentRef),
    access: AccessSummary,
    /** A bound agent has a blocking gap the client fixes here. */
    needsSomething: z.boolean(),
    /** An open change request waits on the client admin. */
    openRequest: z.boolean(),
    mezonasMay: MezonasMayView.nullable(),
  })
  .meta({ id: "ConnectionSummaryView" });
export type ConnectionSummaryView = z.infer<typeof ConnectionSummaryView>;

/** A connector in a list, with the client's connections of it. */
export const ConnectorCardView = z
  .object({
    connector: z.string(),
    name: z.string(),
    description: z.string(),
    icon: z.string().nullable(),
    /** "You sign in" / "You enter a key" / "Nothing to sign in to". */
    auth: ConnectorAuth,
    /** A person's own account (Gmail): any client user may connect it. */
    personal: z.boolean(),
    /** A tool the client may connect several times (a second bank). */
    multiple: z.boolean(),
    /** The client can sign in to it on this deployment. */
    available: z.boolean(),
    /** `connector_setting.status` is `beta`: shown with a Beta tag. */
    beta: z.boolean(),
    /** Offered to the client, or an agent of theirs needs it: shown first. */
    recommended: z.boolean(),
    /** Built for this client alone (`connector_setting.clients`). */
    custom: z.boolean(),
    /** Its kind, for Browse's groups (Money, Email, Messages, Files, Sales, Web, Other). */
    group: z.string(),
    connections: z.array(ConnectionSummaryView),
  })
  .meta({ id: "ConnectorCardView" });
export type ConnectorCardView = z.infer<typeof ConnectorCardView>;

/** One connection on its connector's page. */
export const ConnectionPageView = z
  .object({
    id: z.string(),
    status: z.string(),
    accountName: z.string().nullable(),
    lastSyncAt: Timestamp.nullable(),
    /** The signed-in person connected it (a client user may then disconnect it). */
    connectedByYou: z.boolean(),
    read: z.array(AccessRowView),
    change: z.array(AccessRowView),
    access: AccessSummary,
    /** Each agent bound to it: "Has what it needs" or what it needs here. */
    usedBy: z.array(AgentNeedsState),
    mezonasMay: MezonasMayView.nullable(),
    openRequest: ChangeRequestView.nullable(),
    history: z.array(ConnectionHistoryEntry),
  })
  .meta({ id: "ConnectionPageView" });
export type ConnectionPageView = z.infer<typeof ConnectionPageView>;

/** The back office's view of a connection: the portal's, plus the tool's setup (never secrets). */
export const OpsConnectionPageView = ConnectionPageView.extend({
  config: z.record(z.string(), z.unknown()),
  usedBy: z.array(OpsAgentNeedsState),
}).meta({ id: "OpsConnectionPageView" });
export type OpsConnectionPageView = z.infer<typeof OpsConnectionPageView>;

/** An agent waiting on something from the client, for the needs banner. */
export const NeedsBannerItem = z
  .object({
    agent: AgentRef,
    connector: z.string(),
    connectorName: z.string(),
    kind: GapKindSchema,
    /** "Buyer: connect QuickBooks", "Bookkeeper: allow creating deposits". */
    words: z.string(),
  })
  .meta({ id: "NeedsBannerItem" });
export type NeedsBannerItem = z.infer<typeof NeedsBannerItem>;

/** `?for=<agent id>`: the rows that agent needs are marked, with the gold strip. */
export const ForAgentQuery = z.object({ for: Id.optional() });

/** The picked agent on a connector's page: what it is missing here. */
export const ForAgentView = z.object({
  agent: AgentRef,
  ready: z.boolean(),
  gaps: z.array(GapView),
});

export const PortalConnectorsResponse = z.object({
  connected: z.array(ConnectorCardView),
  builtForYou: z.array(ConnectorCardView),
  /** Every live connector for this client, recommended first (`beta` tagged). */
  browse: z.array(ConnectorCardView),
  /** Agents waiting on the client, for the banner; empty when none. */
  waiting: z.array(NeedsBannerItem),
  /** Open change requests waiting on a client admin. */
  openRequests: z.number().int(),
});

export const PortalConnectorPageResponse = z.object({
  connector: ConnectorCardView,
  permissionEntities: z.array(PermissionEntity),
  /**
   * What it can do once connected: the low-risk start, plus the picked agent's needs when
   * `?for=` (§5.2), so the client sees it before signing in. Rows' `usedBy` are empty.
   */
  start: z.object({ read: z.array(AccessRowView), change: z.array(AccessRowView) }),
  connections: z.array(ConnectionPageView),
  forAgent: ForAgentView.nullable(),
  /** The signed-in person is a client admin: they may edit rows and Changes by Mezonas. */
  mayEdit: z.boolean(),
});

/** A client admin's edit of a connection's rows (verbs left out keep their level). */
export const SetAccessBody = z
  .strictObject({ permissions: MatrixEdit })
  .meta({ id: "SetAccessBody" });
export type SetAccessBody = z.infer<typeof SetAccessBody>;

// ── Our changes (§7.1) ───────────────────────────────────────────────────────────────────────

/** Our edit of a client's connection: the rows and the tool's setup, and why (shown to them). */
export const OpsConnectionChangeBody = z
  .strictObject({
    permissions: MatrixEdit.optional(),
    /** The tool's whole setup, as the connection keeps it. */
    config: z.record(z.string(), z.unknown()).optional(),
    reason: z.string().trim().min(1).max(1000),
    forAgentId: Id.optional(),
  })
  .refine((b) => b.permissions !== undefined || b.config !== undefined, "nothing to change")
  .meta({ id: "OpsConnectionChangeBody" });
export type OpsConnectionChangeBody = z.infer<typeof OpsConnectionChangeBody>;

/** The same edit before it is made: what it would do, and whether it would apply or be sent. */
export const OpsConnectionChangePreviewBody = z
  .strictObject({
    permissions: MatrixEdit.optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .meta({ id: "OpsConnectionChangePreviewBody" });

export const OpsConnectionChangePreview = z
  .object({
    direction: z.enum(["none", "tighter", "looser", "mixed"]),
    rows: z.array(ConnectionRowChange),
    /** Apply now; apply now and the client is told (under their go-ahead); send for approval. */
    outcome: z.enum(["none", "apply", "apply_under_authorization", "request"]),
    /** Why it goes for approval ("Create bills isn't something an agent needs"); else null. */
    whyNot: z.string().nullable(),
    /** The client's go-ahead on this connection, for the footer's words. */
    mezonasMay: MezonasMayView.nullable(),
  })
  .meta({ id: "OpsConnectionChangePreview" });
export type OpsConnectionChangePreview = z.infer<typeof OpsConnectionChangePreview>;

/**
 * What became of our edit: applied (only tighter, or the Sandbox), applied under the client's
 * go-ahead (they are told), or sent as a request (replacing any open one).
 */
export const OpsConnectionChangeResult = z
  .discriminatedUnion("outcome", [
    z.object({
      outcome: z.literal("applied"),
      rows: z.array(ConnectionRowChange),
      connection: OpsConnectionPageView,
    }),
    z.object({
      outcome: z.literal("applied_under_authorization"),
      rows: z.array(ConnectionRowChange),
      authorization: MezonasMayView,
      connection: OpsConnectionPageView,
    }),
    z.object({
      outcome: z.literal("request_sent"),
      request: ChangeRequestView,
      /** Why it couldn't apply at once. */
      whyNot: z.string(),
      /** The open request it replaced, if any. */
      replaced: z.string().nullable(),
    }),
  ])
  .meta({ id: "OpsConnectionChangeResult" });
export type OpsConnectionChangeResult = z.infer<typeof OpsConnectionChangeResult>;

// ── The back office's agent panels (§7) ──────────────────────────────────────────────────────

export const AgentNeedsPanel = z
  .object({
    agent: z.object({ id: z.string(), name: z.string(), template: z.boolean() }),
    connectors: z.array(
      z.object({ connector: z.string(), name: z.string(), needs: z.array(OpsNeedView) }),
    ),
  })
  .meta({ id: "AgentNeedsPanel" });
export type AgentNeedsPanel = z.infer<typeof AgentNeedsPanel>;

/** One connector on the Readiness panel. */
export const ReadinessState = z.enum([
  "ready",
  "not_connected",
  "broken",
  "needs_access",
  "not_bound",
  "grant_too_narrow",
  "could_run_alone",
]);

export const AgentReadinessPanel = z
  .object({
    agent: z.object({ id: z.string(), name: z.string(), template: z.boolean() }),
    clientId: z.string(),
    ready: z.boolean(),
    connectors: z.array(
      z.object({
        connector: z.string(),
        name: z.string(),
        state: ReadinessState,
        connectionId: z.string().nullable(),
        gaps: z.array(OpsGapView),
        /** An open request on this connection already asks for something. */
        openRequest: ChangeRequestView.nullable(),
      }),
    ),
  })
  .meta({ id: "AgentReadinessPanel" });
export type AgentReadinessPanel = z.infer<typeof AgentReadinessPanel>;

export const ReadinessSendBody = z
  .strictObject({ connectionId: Id, reason: z.string().trim().min(1).max(1000) })
  .meta({ id: "ReadinessSendBody" });
export type ReadinessSendBody = z.infer<typeof ReadinessSendBody>;

export const OpsConnectorsResponse = z.object({
  connected: z.array(ConnectorCardView),
  builtForYou: z.array(ConnectorCardView),
  /** Offered, or needed by an agent, and not connected. */
  recommended: z.array(ConnectorCardView),
  /** Open change requests, newest first. */
  requests: z.array(ChangeRequestView),
  /** Each client agent with a gap (test copies left out). */
  agents: z.array(OpsAgentNeedsState),
  /** The Sandbox client: our edits apply directly, never as requests. */
  sandbox: z.boolean(),
});

const ClientConnectionParams = z.object({ id: Id, connectionId: Id });

export const connectorAccessRoutes = {
  // ── The portal ─────────────────────────────────────────────────────────────────────────────
  portalConnectors: defineRoute({
    method: "GET",
    path: "/api/portal/connectors",
    auth: "session",
    roles: CLIENT,
    summary:
      "Connectors: the client's connections, the ones built for them, every live connector to browse (recommended first, beta tagged, custom ones only for their clients, HIPAA-refused ones hidden), and the agents waiting on something",
    response: PortalConnectorsResponse,
  }),
  portalConnector: defineRoute({
    method: "GET",
    path: "/api/portal/connectors/:connector",
    auth: "session",
    roles: CLIENT,
    summary:
      "A connector's page: its connections with the Read and Change rows, the agents using each and their gaps, history, the open request and Changes by Mezonas; `?for=` marks what that agent needs (404 for another client's custom connector)",
    params: z.object({ connector: ConnectorId }),
    query: ForAgentQuery,
    response: PortalConnectorPageResponse,
  }),
  portalAllowForAgent: defineRoute({
    method: "POST",
    path: "/api/portal/connections/:connectionId/allow-for/:agentId",
    auth: "session",
    roles: ADMIN,
    summary:
      "Allow what an agent needs: turns on exactly the rows its needs call for on this connection (reads on, writes Ask me first, never On its own), at once, as the client admin's own change",
    params: z.object({ connectionId: Id, agentId: Id }),
    body: z.strictObject({}),
    response: z.object({
      connection: ConnectionPageView,
      rows: z.array(ConnectionRowChange),
      /** Needs rows alone can't meet (a scope that leaves the tool out): left for a person. */
      unresolved: z.array(NeedView),
    }),
  }),
  portalSetAccess: defineRoute({
    method: "PUT",
    path: "/api/portal/connections/:connectionId/access",
    auth: "session",
    roles: ADMIN,
    summary:
      "Set what agents may read and change on a connection: any read on or off, any write between Off and Ask me first, On its own only lowered, delete never (422 not_allowed with the refused rows)",
    params: z.object({ connectionId: Id }),
    body: SetAccessBody,
    response: z.object({ connection: ConnectionPageView, rows: z.array(ConnectionRowChange) }),
  }),
  portalSetMezonasMay: defineRoute({
    method: "PUT",
    path: "/api/portal/connections/:connectionId/mezonas-may",
    auth: "session",
    roles: ADMIN,
    summary:
      "Changes by Mezonas: how much we may change on this connection without asking (Ask me each time clears it), until turned off or for 30 days; only a client admin sets it",
    params: z.object({ connectionId: Id }),
    body: SetMezonasMayBody,
    response: z.object({ mezonasMay: MezonasMayView.nullable() }),
  }),
  portalConnectionRequests: defineRoute({
    method: "GET",
    path: "/api/portal/connection-requests",
    auth: "session",
    roles: CLIENT,
    summary: "Open change requests from Mezonas, newest first, each Out of date when it is",
    response: z.object({ requests: z.array(ChangeRequestView) }),
  }),
  portalApproveConnectionRequest: defineRoute({
    method: "POST",
    path: "/api/portal/connection-requests/:id/approve",
    auth: "session",
    roles: ADMIN,
    summary:
      "Approve a change request: sets exactly what it asked as one change naming who asked and who approved (409 out_of_date when the connection changed since; 409 closed when no longer open)",
    params: z.object({ id: Id }),
    body: AnswerRequestBody,
    response: z.object({ request: ChangeRequestView, connection: ConnectionPageView }),
  }),
  portalDeclineConnectionRequest: defineRoute({
    method: "POST",
    path: "/api/portal/connection-requests/:id/decline",
    auth: "session",
    roles: ADMIN,
    summary: "Decline a change request, with an optional note back; nothing changes",
    params: z.object({ id: Id }),
    body: AnswerRequestBody,
    response: z.object({ request: ChangeRequestView }),
  }),

  // ── The back office ────────────────────────────────────────────────────────────────────────
  opsClientConnectors: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/connectors",
    auth: "session",
    roles: OPS,
    summary:
      "A client's Connectors tab: connected, built for them and recommended, each connection's access and Changes by Mezonas, open requests, and agents' gaps (never credentials)",
    params: z.object({ id: Id }),
    response: OpsConnectorsResponse,
  }),
  opsClientConnector: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/connectors/:connector",
    auth: "session",
    roles: OPS,
    summary:
      "One connector of a client: each connection's rows, setup, agents and gaps, history, open request and Changes by Mezonas; `?for=` marks what that agent needs",
    params: z.object({ id: Id, connector: ConnectorId }),
    query: ForAgentQuery,
    response: z.object({
      connector: ConnectorCardView,
      permissionEntities: z.array(PermissionEntity),
      connections: z.array(OpsConnectionPageView),
      forAgent: z
        .object({ agent: AgentRef, ready: z.boolean(), gaps: z.array(OpsGapView) })
        .nullable(),
      sandbox: z.boolean(),
    }),
  }),
  opsPreviewConnectionChange: defineRoute({
    method: "POST",
    path: "/api/ops/clients/:id/connections/:connectionId/changes/preview",
    auth: "session",
    roles: OPS,
    summary:
      "What an edit of a client's connection would do, row by row, and whether it would apply now, apply under the client's go-ahead, or go to them for approval; changes nothing",
    params: ClientConnectionParams,
    body: OpsConnectionChangePreviewBody,
    response: OpsConnectionChangePreview,
  }),
  opsConnectionChange: defineRoute({
    method: "POST",
    path: "/api/ops/clients/:id/connections/:connectionId/changes",
    auth: "session",
    roles: OPS,
    summary:
      "Change a client's connection: tighter applies at once (the client is told); looser applies only under the client's go-ahead (never On its own, never delete), else it is sent as a change request for a client admin to approve, replacing any open one; the Sandbox applies directly",
    params: ClientConnectionParams,
    body: OpsConnectionChangeBody,
    response: OpsConnectionChangeResult,
  }),
  opsWithdrawConnectionRequest: defineRoute({
    method: "POST",
    path: "/api/ops/clients/:id/connection-requests/:requestId/withdraw",
    auth: "session",
    roles: OPS,
    summary: "Withdraw an open change request before it is answered (409 closed otherwise)",
    params: z.object({ id: Id, requestId: Id }),
    body: z.strictObject({}),
    response: z.object({ request: ChangeRequestView }),
  }),
  opsAgentNeeds: defineRoute({
    method: "GET",
    path: "/api/ops/agents/:id/needs",
    auth: "session",
    roles: OPS,
    summary:
      "The Needs panel: per connector, the record types and verbs a template or client agent reads and changes, from its steps' tools and skills",
    params: z.object({ id: Id }),
    response: AgentNeedsPanel,
  }),
  opsAgentReadiness: defineRoute({
    method: "GET",
    path: "/api/ops/agents/:id/readiness",
    auth: "session",
    roles: OPS,
    summary:
      "The Readiness panel: per connector, ready or what's missing (not connected, broken, needs access, not bound, grant too narrow) and who fixes it; a template takes the client in `?client=`",
    params: z.object({ id: Id }),
    query: z.object({ client: Id.optional() }),
    response: AgentReadinessPanel,
  }),
  opsAgentReadinessSend: defineRoute({
    method: "POST",
    path: "/api/ops/agents/:id/readiness/send",
    auth: "session",
    roles: OPS,
    summary:
      "Send to client: a change request on one connection with exactly the rows the client agent is missing there (applied at once where the client's go-ahead covers it)",
    params: z.object({ id: Id }),
    body: ReadinessSendBody,
    response: OpsConnectionChangeResult,
  }),
};
