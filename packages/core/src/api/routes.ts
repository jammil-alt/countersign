import { z } from "zod";
import { isUuid } from "../ids";
import { ROLES, Role } from "../roles";
import { PermissionLevel } from "../schemas/permissions";
import { defineRoute } from "./contract";

export const HealthResponse = z.object({ ok: z.literal(true) });

export const SessionResponse = z.object({
  user: z.object({ id: z.string(), email: z.string(), name: z.string().nullable() }),
  /** True when the user is an operator (back office). */
  operator: z.boolean(),
  /** The clients this session may act in, with the user's role in each. */
  tenants: z.array(z.object({ id: z.string(), name: z.string(), role: Role })),
  /** The client selected now: a portal session's one client, or the operator's switcher choice. */
  activeTenantId: z.string().nullable(),
});
export type SessionResponse = z.infer<typeof SessionResponse>;

// The foundation's routes (ARCHITECTURE §14). apps/api mounts every entry (it enforces roles and
// validates bodies and responses against these schemas); apps/web's typed client calls them.

// ── Building blocks ──────────────────────────────────────────────────────────────────────────────

export const ApiId = z.string().refine((v) => isUuid(v), "not an id");
const Timestamp = z.string();
const NullableTimestamp = z.string().nullable();
const IdParams = z.object({ id: ApiId });
const AgentVersionParams = z.object({ id: ApiId, vid: ApiId });
const SlugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and dashes")
  .max(64);
const Note = z.string().max(2000);

/** A matrix edit: verbs left out keep their level. */
export const MatrixEdit = z.strictObject({
  read: PermissionLevel.optional(),
  create: PermissionLevel.optional(),
  update: PermissionLevel.optional(),
  delete: PermissionLevel.optional(),
  scope: z.unknown().optional(),
});

export const ConnectionMatrix = z.object({
  read: PermissionLevel,
  create: PermissionLevel,
  update: PermissionLevel,
  delete: PermissionLevel,
  scope: z.unknown().optional(),
});

export const ValidationErrorSchema = z.object({
  stepId: z.string().nullable(),
  field: z.string(),
  message: z.string(),
  code: z.string(),
  workflow: z.string().optional(),
});

export const RunStatusSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
]);
export const InboxStatusSchema = z.enum(["open", "resolved", "expired"]);
export const InboxKindSchema = z.enum([
  "approval",
  "review",
  "request",
  "extraction_review",
  "external_action",
  "change_request",
]);

/** Approve or reject an approval or a change; answer (or decline) a request. */
export const ResolveBody = z.strictObject({
  decision: z.enum(["approve", "reject"]).optional(),
  answer: z.unknown().optional(),
  note: Note.optional(),
});

// ── Back office shapes ───────────────────────────────────────────────────────────────────────────

export const ClientSummary = z.object({
  id: z.string(),
  name: z.string(),
  timezone: z.string(),
  createdAt: Timestamp,
  agents: z.number().int(),
  openInbox: z.number().int(),
});

export const AgentSummary = z.object({
  id: z.string(),
  tenantId: z.string().nullable(),
  kind: z.enum(["template", "client"]),
  slug: z.string(),
  name: z.string(),
  role: z.string().nullable(),
  templateId: z.string().nullable(),
  linked: z.boolean(),
  liveVersionId: z.string().nullable(),
  status: z.string(),
  runStatus: z.string().nullable(),
  serviceName: z.string().nullable(),
  serviceDescription: z.string().nullable(),
  bindings: z.record(z.string(), z.string()),
  approver: z.string().nullable(),
  /** A template's test copy in the Sandbox client: it only test-runs. */
  testCopy: z.boolean(),
  createdAt: Timestamp,
});
export type AgentSummary = z.infer<typeof AgentSummary>;

export const VersionSummary = z.object({
  id: z.string(),
  agentId: z.string(),
  version: z.number().int(),
  status: z.string(),
  bundleHash: z.string(),
  changeNote: z.string().nullable(),
  releaseNote: z.string().nullable(),
  authorType: z.string(),
  authorId: z.string().nullable(),
  parentVersionId: z.string().nullable(),
  basedOnTemplateVersionId: z.string().nullable(),
  mergedFromVersionIds: z.array(z.string()).nullable(),
  createdAt: Timestamp,
});
export type VersionSummary = z.infer<typeof VersionSummary>;

export const VersionDetail = VersionSummary.extend({ bundle: z.unknown() });
export type VersionDetail = z.infer<typeof VersionDetail>;

export const OpsConnection = z.object({
  id: z.string(),
  tenantId: z.string(),
  connector: z.string(),
  status: z.string(),
  externalAccountId: z.string().nullable(),
  config: z.record(z.string(), z.unknown()),
  permissions: ConnectionMatrix,
  lastSyncAt: NullableTimestamp,
  connectedBy: z.string().nullable(),
  createdAt: Timestamp,
});

export const OpsRun = z.object({
  id: z.string(),
  tenantId: z.string(),
  agentId: z.string(),
  agentVersionId: z.string(),
  workflowSlug: z.string(),
  mode: z.enum(["live", "test"]),
  status: RunStatusSchema,
  trigger: z.record(z.string(), z.unknown()),
  costUsd: z.string(),
  error: z.unknown(),
  startedAt: NullableTimestamp,
  finishedAt: NullableTimestamp,
  createdAt: Timestamp,
});

export const OpsStep = z.object({
  id: z.string(),
  nodeId: z.string(),
  nodeType: z.string(),
  skillRef: z.string().nullable(),
  status: z.string(),
  input: z.unknown(),
  output: z.unknown(),
  summary: z.string().nullable(),
  costUsd: z.string(),
  tokensIn: z.number().int(),
  tokensOut: z.number().int(),
  startedAt: NullableTimestamp,
  finishedAt: NullableTimestamp,
});

export const OpsToolCall = z.object({
  id: z.string(),
  stepRunId: z.string(),
  tool: z.string(),
  input: z.unknown(),
  output: z.unknown(),
  status: z.string(),
  durationMs: z.number().int().nullable(),
  externalActionId: z.string().nullable(),
});

export const OpsAction = z.object({
  id: z.string(),
  tool: z.string(),
  connectionId: z.string(),
  stepRunId: z.string().nullable(),
  status: z.string(),
  input: z.unknown(),
  before: z.unknown(),
  result: z.unknown(),
  error: z.unknown(),
  inboxItemId: z.string().nullable(),
  approvedBy: z.string().nullable(),
  approvedAt: NullableTimestamp,
  executedAt: NullableTimestamp,
});

export const OpsInboxItem = z.object({
  id: z.string(),
  tenantId: z.string(),
  kind: InboxKindSchema,
  agentId: z.string().nullable(),
  runId: z.string().nullable(),
  subjectType: z.string().nullable(),
  subjectId: z.string().nullable(),
  assigneeRole: z.string().nullable(),
  assigneeUserId: z.string().nullable(),
  title: z.string(),
  payload: z.record(z.string(), z.unknown()),
  status: InboxStatusSchema,
  resolution: z.unknown(),
  resolvedBy: z.string().nullable(),
  dueAt: NullableTimestamp,
  createdAt: Timestamp,
  resolvedAt: NullableTimestamp,
});

const AgentBody = z.strictObject({
  slug: SlugSchema,
  bundle: z.unknown(),
  name: z.string().min(1).max(200).optional(),
  changeNote: Note.optional(),
});

// ── Portal shapes (never bundles, instructions, prompts or cost) ─────────────────────────────────

export const ServiceSummary = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  status: z.string(),
});
export type ServiceSummary = z.infer<typeof ServiceSummary>;

export const PortalRunSummary = z.object({
  id: z.string(),
  service: z.object({ id: z.string(), name: z.string() }),
  status: RunStatusSchema,
  startedAt: NullableTimestamp,
  finishedAt: NullableTimestamp,
});

export const TimelineStep = z.object({
  id: z.string(),
  label: z.string(),
  status: z.string(),
  summary: z.string().nullable(),
  startedAt: NullableTimestamp,
  finishedAt: NullableTimestamp,
});

export const PortalInboxItem = z.object({
  id: z.string(),
  kind: InboxKindSchema,
  title: z.string(),
  payload: z.record(z.string(), z.unknown()),
  status: InboxStatusSchema,
  runId: z.string().nullable(),
  dueAt: NullableTimestamp,
  createdAt: Timestamp,
  resolvedAt: NullableTimestamp,
  resolvedBy: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
});

export const ToolAccessSchema = z.object({
  toolId: z.string(),
  description: z.string(),
  verb: z.string(),
  level: PermissionLevel,
  access: z.enum(["runs", "asks_first", "steps_may_skip_approval", "not_allowed"]),
});

export const PortalConnection = z.object({
  connector: z.string(),
  name: z.string(),
  description: z.string(),
  icon: z.string().nullable(),
  connection: z
    .object({
      id: z.string(),
      status: z.string(),
      externalAccountId: z.string().nullable(),
      permissions: ConnectionMatrix,
      access: z.array(ToolAccessSchema),
      usedBy: z.array(z.object({ id: z.string(), name: z.string() })),
    })
    .nullable(),
});

// ── Routes ───────────────────────────────────────────────────────────────────────────────────────

const OPS = ["operator"] as const;
const CLIENT = ["client_admin", "client_user"] as const;

export const authRoutes = {
  devUsers: defineRoute({
    method: "GET",
    path: "/api/auth/dev/users",
    auth: "public",
    roles: [],
    summary: "Local only: the seeded users the dev adapter can sign in as",
    response: z.object({
      users: z.array(
        z.object({
          email: z.string(),
          name: z.string().nullable(),
          operator: z.boolean(),
          tenants: z.array(z.object({ id: z.string(), name: z.string(), role: Role })),
        }),
      ),
    }),
  }),
  devSignIn: defineRoute({
    method: "POST",
    path: "/api/auth/dev/sign-in",
    auth: "public",
    roles: [],
    summary: "Local only: sign in as a seeded user by email (the dev adapter)",
    body: z.strictObject({ email: z.string().email() }),
    response: z.object({ ok: z.literal(true) }),
  }),
  signOut: defineRoute({
    method: "POST",
    path: "/api/auth/sign-out",
    auth: "public",
    roles: [],
    summary: "Sign out; WorkOS answers where to send the browser",
    response: z.object({ ok: z.literal(true), redirectTo: z.string().nullable() }),
  }),
} as const;

export const opsRoutes = {
  opsClients: defineRoute({
    method: "GET",
    path: "/api/ops/clients",
    auth: "session",
    roles: OPS,
    summary: "The clients this operator serves",
    response: z.object({ clients: z.array(ClientSummary) }),
  }),
  opsCreateClient: defineRoute({
    method: "POST",
    path: "/api/ops/clients",
    auth: "session",
    roles: OPS,
    summary: "Create a client; the creating operator serves it",
    body: z.strictObject({
      name: z.string().trim().min(1).max(200),
      timezone: z.string().optional(),
      connectorsOffered: z.array(z.string().min(1)).optional(),
    }),
    response: z.object({ client: ClientSummary }),
  }),
  opsClient: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id",
    auth: "session",
    roles: OPS,
    summary: "A client: settings, agents, connections, members",
    params: IdParams,
    response: z.object({
      client: z.object({
        id: z.string(),
        name: z.string(),
        timezone: z.string(),
        settings: z.record(z.string(), z.unknown()),
        createdAt: Timestamp,
      }),
      agents: z.array(AgentSummary),
      connections: z.array(OpsConnection),
      members: z.array(
        z.object({
          userId: z.string(),
          email: z.string(),
          name: z.string().nullable(),
          role: Role,
        }),
      ),
    }),
  }),
  opsClientConnections: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/connections",
    auth: "session",
    roles: OPS,
    summary: "A client's connections with their permission matrices (never credentials)",
    params: IdParams,
    response: z.object({ connections: z.array(OpsConnection) }),
  }),
  opsUpdateConnection: defineRoute({
    method: "PATCH",
    path: "/api/ops/connections/:id",
    auth: "session",
    roles: OPS,
    summary: "Set a connection's permissions (the operator may loosen) or configuration",
    params: IdParams,
    body: z.strictObject({
      permissions: MatrixEdit.optional(),
      config: z.record(z.string(), z.unknown()).optional(),
    }),
    response: z.object({ connection: OpsConnection }),
  }),
  opsTemplates: defineRoute({
    method: "GET",
    path: "/api/ops/templates",
    auth: "session",
    roles: OPS,
    summary: "Templates",
    response: z.object({ templates: z.array(AgentSummary) }),
  }),
  opsCreateTemplate: defineRoute({
    method: "POST",
    path: "/api/ops/templates",
    auth: "session",
    roles: OPS,
    summary: "A new template with its v1 draft",
    body: AgentBody.extend({ releaseNote: Note.optional() }),
    response: z.object({ agent: AgentSummary, version: VersionSummary }),
  }),
  opsFork: defineRoute({
    method: "POST",
    path: "/api/ops/templates/:id/fork",
    auth: "session",
    roles: OPS,
    summary: "Fork a template version into a client as that client's agent",
    params: IdParams,
    body: z.strictObject({
      clientId: ApiId,
      /** Default: the template's live version. */
      versionId: ApiId.optional(),
      slug: SlugSchema.optional(),
      serviceName: z.string().max(200).optional(),
      serviceDescription: z.string().max(2000).optional(),
    }),
    response: z.object({ agent: AgentSummary, version: VersionSummary }),
  }),
  opsClientAgents: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/agents",
    auth: "session",
    roles: OPS,
    summary: "A client's agents",
    params: IdParams,
    response: z.object({ agents: z.array(AgentSummary) }),
  }),
  opsCreateClientAgent: defineRoute({
    method: "POST",
    path: "/api/ops/clients/:id/agents",
    auth: "session",
    roles: OPS,
    summary: "A client agent from scratch, or copied from another client's agent",
    params: IdParams,
    body: z
      .strictObject({
        slug: SlugSchema,
        bundle: z.unknown().optional(),
        /** Copy another client's agent (its live bundle, stripped of client-specific values). */
        copyFrom: ApiId.optional(),
        name: z.string().min(1).max(200).optional(),
        serviceName: z.string().max(200).optional(),
        serviceDescription: z.string().max(2000).optional(),
        changeNote: Note.optional(),
      })
      .refine((b) => (b.bundle === undefined) !== (b.copyFrom === undefined), {
        message: "give either a bundle or copyFrom",
      }),
    response: z.object({ agent: AgentSummary, version: VersionSummary }),
  }),
  opsAgent: defineRoute({
    method: "GET",
    path: "/api/ops/agents/:id",
    auth: "session",
    roles: OPS,
    summary: "An agent (template or client agent) with its versions and lineage",
    params: IdParams,
    response: z.object({
      agent: AgentSummary,
      versions: z.array(VersionSummary),
      live: VersionDetail.nullable(),
      latest: VersionDetail.nullable(),
      update: z
        .object({
          available: z.boolean(),
          behind: z.number().int(),
          baseVersionId: z.string().nullable(),
          templateLiveVersionId: z.string().nullable(),
          releaseNote: z.string().nullable(),
        })
        .nullable(),
    }),
  }),
  opsAgentVersion: defineRoute({
    method: "GET",
    path: "/api/ops/agents/:id/versions/:vid",
    auth: "session",
    roles: OPS,
    summary: "One version with its bundle",
    params: AgentVersionParams,
    response: z.object({ version: VersionDetail }),
  }),
  opsSaveVersion: defineRoute({
    method: "POST",
    path: "/api/ops/agents/:id/versions",
    auth: "session",
    roles: OPS,
    summary: "Save a draft version; answers what would stop it from publishing",
    params: IdParams,
    body: z.strictObject({
      bundle: z.unknown(),
      parentVersionId: ApiId.optional(),
      changeNote: Note.optional(),
      releaseNote: Note.optional(),
    }),
    response: z.object({ version: VersionSummary, errors: z.array(ValidationErrorSchema) }),
  }),
  opsPublish: defineRoute({
    method: "POST",
    path: "/api/ops/agents/:id/versions/:vid/publish",
    auth: "session",
    roles: OPS,
    summary: "Publish a version (validation must pass)",
    params: AgentVersionParams,
    response: z.object({ version: VersionSummary }),
  }),
  opsRollback: defineRoute({
    method: "POST",
    path: "/api/ops/agents/:id/rollback",
    auth: "session",
    roles: OPS,
    summary: "Roll back: an older version copied as a new one and published",
    params: IdParams,
    body: z.strictObject({ versionId: ApiId }),
    response: z.object({ version: VersionSummary }),
  }),
  opsOperation: defineRoute({
    method: "PATCH",
    path: "/api/ops/agents/:id/operation",
    auth: "session",
    roles: OPS,
    summary: "A client agent's bindings, approver and service name (not a new version)",
    params: IdParams,
    body: z.strictObject({
      bindings: z.record(z.string(), ApiId).optional(),
      approver: z.enum(["client_admin", "operator"]).nullable().optional(),
      serviceName: z.string().max(200).nullable().optional(),
      serviceDescription: z.string().max(2000).nullable().optional(),
    }),
    response: z.object({ agent: AgentSummary }),
  }),
  opsActivate: defineRoute({
    method: "POST",
    path: "/api/ops/agents/:id/activate",
    auth: "session",
    roles: OPS,
    summary: "Activate a client agent, or answer every reason it can't run yet",
    params: IdParams,
    response: z.object({ agent: AgentSummary }),
  }),
  opsPause: defineRoute({
    method: "POST",
    path: "/api/ops/agents/:id/pause",
    auth: "session",
    roles: OPS,
    summary: "Pause a client agent: no new runs; running ones finish",
    params: IdParams,
    response: z.object({ agent: AgentSummary }),
  }),
  opsRunAgent: defineRoute({
    method: "POST",
    path: "/api/ops/agents/:id/run",
    auth: "session",
    roles: OPS,
    summary: "Start a manual or command workflow of an active client agent",
    params: IdParams,
    body: z.strictObject({ workflow: z.string().min(1), input: z.unknown().optional() }),
    response: z.object({ runId: z.string() }),
  }),
  opsTestRun: defineRoute({
    method: "POST",
    path: "/api/ops/agents/:id/versions/:vid/test-run",
    auth: "session",
    roles: OPS,
    summary:
      "Test-run a version (never writes): a client agent on its client's data, a template as its test copy in the Sandbox client",
    params: AgentVersionParams,
    body: z.strictObject({ workflow: z.string().min(1), payload: z.unknown().optional() }),
    // For a template, the run belongs to its test copy: agentId and versionId name that copy.
    response: z.object({ runId: z.string(), agentId: z.string(), versionId: z.string() }),
  }),
  opsValidateWorkflow: defineRoute({
    method: "POST",
    path: "/api/ops/workflows/validate",
    auth: "session",
    roles: OPS,
    summary: "Validate a workflow (as the builder does), optionally against an agent",
    body: z.strictObject({ workflow: z.unknown(), agentId: ApiId.optional() }),
    response: z.object({ valid: z.boolean(), errors: z.array(ValidationErrorSchema) }),
  }),
  opsEventCatalog: defineRoute({
    method: "GET",
    path: "/api/ops/catalog/events",
    auth: "session",
    roles: OPS,
    summary: "Event types a trigger can name, with sample payloads",
    response: z.object({
      events: z.array(
        z.object({
          type: z.string(),
          description: z.string(),
          subjectType: z.string().nullable(),
          sample: z.unknown(),
        }),
      ),
    }),
  }),
  opsRuns: defineRoute({
    method: "GET",
    path: "/api/ops/runs",
    auth: "session",
    roles: OPS,
    summary: "Runs across the clients served",
    query: z.object({
      client: ApiId.optional(),
      status: RunStatusSchema.optional(),
      agent: ApiId.optional(),
      mode: z.enum(["live", "test"]).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }),
    response: z.object({ runs: z.array(OpsRun) }),
  }),
  opsRun: defineRoute({
    method: "GET",
    path: "/api/ops/runs/:id",
    auth: "session",
    roles: OPS,
    summary: "A run: steps, tool calls, changes to tools, inbox items, cost",
    params: IdParams,
    response: z.object({
      run: OpsRun,
      steps: z.array(OpsStep),
      toolCalls: z.array(OpsToolCall),
      actions: z.array(OpsAction),
      inbox: z.array(OpsInboxItem),
    }),
  }),
  opsInbox: defineRoute({
    method: "GET",
    path: "/api/ops/inbox",
    auth: "session",
    roles: OPS,
    summary: "The operator inbox (or every item of the clients served)",
    query: z.object({
      client: ApiId.optional(),
      status: InboxStatusSchema.default("open"),
      assigned: z.enum(["operator", "all"]).default("operator"),
    }),
    response: z.object({ items: z.array(OpsInboxItem) }),
  }),
  opsResolveInbox: defineRoute({
    method: "POST",
    path: "/api/ops/inbox/:id/resolve",
    auth: "session",
    roles: OPS,
    summary: "Resolve an operator item (or a delegated approval); resumes the waiting run",
    params: IdParams,
    body: ResolveBody,
    response: z.object({ item: OpsInboxItem }),
  }),
} as const;

export const portalRoutes = {
  portalOverview: defineRoute({
    method: "GET",
    path: "/api/overview",
    auth: "session",
    roles: CLIENT,
    summary: "Your services, what needs you, recent runs",
    response: z.object({
      client: z.object({ id: z.string(), name: z.string() }),
      services: z.array(ServiceSummary),
      needsYou: z.object({ inbox: z.number().int() }),
      recentRuns: z.array(PortalRunSummary),
    }),
  }),
  portalInbox: defineRoute({
    method: "GET",
    path: "/api/inbox",
    auth: "session",
    roles: CLIENT,
    summary: "Your inbox (client users: items assigned to them)",
    query: z.object({
      status: InboxStatusSchema.default("open"),
      kind: InboxKindSchema.optional(),
    }),
    response: z.object({ items: z.array(PortalInboxItem) }),
  }),
  portalResolveInbox: defineRoute({
    method: "POST",
    path: "/api/inbox/:id/resolve",
    auth: "session",
    roles: CLIENT,
    summary: "Approve, reject or answer an item; resumes the waiting run",
    params: IdParams,
    body: ResolveBody,
    response: z.object({ item: PortalInboxItem }),
  }),
  portalRuns: defineRoute({
    method: "GET",
    path: "/api/runs",
    auth: "session",
    roles: CLIENT,
    summary: "Runs of your services (never test runs)",
    query: z.object({
      service: ApiId.optional(),
      status: RunStatusSchema.optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }),
    response: z.object({ runs: z.array(PortalRunSummary) }),
  }),
  portalRun: defineRoute({
    method: "GET",
    path: "/api/runs/:id",
    auth: "session",
    roles: CLIENT,
    summary: "A run's client timeline: visible steps, approvals, changes to your tools",
    params: IdParams,
    response: z.object({
      run: PortalRunSummary,
      steps: z.array(TimelineStep),
      approvals: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          status: InboxStatusSchema,
          approved: z.boolean().nullable(),
          by: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
          resolvedAt: NullableTimestamp,
        }),
      ),
      actions: z.array(
        z.object({
          id: z.string(),
          tool: z.string(),
          description: z.string(),
          status: z.string(),
          executedAt: NullableTimestamp,
        }),
      ),
    }),
  }),
  portalConnections: defineRoute({
    method: "GET",
    path: "/api/connections",
    auth: "session",
    roles: CLIENT,
    summary: "Offered tools, their connections, what agents may do in each, who uses them",
    response: z.object({ connections: z.array(PortalConnection) }),
  }),
  portalTightenPermissions: defineRoute({
    method: "PATCH",
    path: "/api/connections/:id/permissions",
    auth: "session",
    roles: ["client_admin"],
    summary: "Tighten what agents may do in a connected tool (never loosen)",
    params: IdParams,
    body: MatrixEdit,
    response: z.object({ connection: PortalConnection }),
  }),
} as const;

/** Every route the API serves through the contract (ARCHITECTURE §14); later milestones add theirs. */
export const routes = {
  health: defineRoute({
    method: "GET",
    path: "/api/health",
    auth: "public",
    roles: [],
    summary: "Liveness",
    response: HealthResponse,
  }),
  session: defineRoute({
    method: "GET",
    path: "/api/session",
    auth: "session",
    roles: ROLES,
    summary: "The signed-in user, their clients and the active one",
    response: SessionResponse,
  }),
  ...authRoutes,
  ...opsRoutes,
  ...portalRoutes,
} as const;
export type Routes = typeof routes;
