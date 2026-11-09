import { z } from "zod";
// P-4
import { ConverseOpsView, ConversePortalView } from "../converse";
import { DESK_ITEM_FIELDS } from "../desk/item";
import { Locale } from "../i18n/locale";
import { isUuid } from "../ids";
import { ROLES, Role } from "../roles";
import { JsonSchema } from "../schemas/common";
import { EntityPermissions, PermissionEntity, PermissionLevel } from "../schemas/permissions";
import { SkillDefinition } from "../schemas/skill";
import { ToolSpec } from "../schemas/tool";
import { ToolDisplay } from "../schemas/tool-display";
// P-8: US texting registration
import { a2pRoutes } from "./a2p";
import { accessRoutes } from "./access";
// v0.12 W2-D: Sloan, the account agent
import { accountRoutes } from "./account";
import { approverRuleRoutes } from "./approver-rules";
// v0.12 W2-B: automations
import { automationRoutes, BuilderAutomation } from "./automations";
// v0.12 bankfeed
import { bankfeedRoutes, LinkStartView } from "./bankfeed";
import { billingRoutes } from "./billing";
import { browserRoutes } from "./browser";
// v0.12 W3-A: the Builder as a conversation
import { builderRoutes } from "./builder";
import { callRoutes } from "./calls";
// v0.12 W2-G: KPIs and the client view, credits running out, the client's audit export
import { clientViewRoutes } from "./client-view";
// v0.12 W2-F: the command center, search and plain-words questions
import { commandCenterRoutes } from "./command-center";
import { complianceRoutes } from "./compliance";
// v0.12 W2-A: the connectors catalog
import { connectorRoutes } from "./connectors";
import { defineRoute } from "./contract";
// v0.14 capture: WhatsApp conversations and their capture
import { conversationRoutes } from "./conversations";
import { deskRoutes } from "./desk";
import { directoryRoutes } from "./directory";
import { DocumentDetail, DocumentSummary } from "./documents";
import { exportRoutes } from "./exports";
import { feedbackRoutes } from "./feedback";
// v0.14 W4-E: Google Chat
import { gchatRoutes } from "./gchat";
// v0.14 W4-D: Google Sheets' picking
import { gsheetsRoutes } from "./gsheets";
import { knowledgeRoutes } from "./knowledge";
import { languageRoutes, SessionLanguage } from "./language";
import { ledgerRoutes } from "./ledger";
// v0.12 W1-A: go-live stages and client controls
import { lifecycleRoutes } from "./lifecycle";
import { messagingRoutes } from "./messaging";
import { modelRoutes } from "./models";
// v0.12 W1-B: notifications, the Table and the Weekly Table
import { notifyRoutes } from "./notify";
import { ExternalApprover, InviteBody, InviteResult, onboardingRoutes } from "./onboarding";
// v0.13 W2-I: run oversight
import { OversightDecisionView, oversightRoutes } from "./oversight";
import { packRoutes } from "./packs";
// v0.12 W1-G: people (autonomy).
import { peopleRoutes, voiceSampleRoutes } from "./people";
import { qboRoutes } from "./qbo";
import { reachRoutes } from "./reach";
import { recordRoutes } from "./records";
import { requestRoutes } from "./requests";
import { runControlRoutes } from "./run-controls";
// UI cleanup (stream A)
import { RunWait } from "./run-state";
import { RunSubject } from "./run-subject";
import {
  OpsRunsQuery,
  PortalRunsQuery,
  RunErrorGroup,
  RunStatusSchema,
  RunsPerDay,
} from "./runs-filter";
import { secondFactorRoutes } from "./second-factor";
// v0.14 W4-C: the Slack channel picker
import { slackRoutes } from "./slack";
// P-6
import { SteppedIn, stepInRoutes } from "./step-in";
import { PortalHealth, supervisorRoutes } from "./supervisor";
import { tableRoutes } from "./table";
// v0.12 W2-C: the test bench
import { testbenchRoutes } from "./testbench";
// v0.12 W1-C: threads, the lead and `/commands`
import { PortalLead, threadRoutes } from "./threads";
// v0.12 W2-E: the triggers list
// P-7: message translation
import { translationRoutes } from "./translation";
import { triggerRoutes } from "./triggers";
import { AgentRunsNow, DayRuns, usageRoutes } from "./usage";
// v0.14 W4-A: WhatsApp through Meta
import { whatsappMetaRoutes } from "./whatsapp-meta";
// v0.14 W4-B
import { zohoRoutes } from "./zoho";

export const HealthResponse = z.object({ ok: z.literal(true) });

/** The session without its language (what packages/auth knows on its own). */
export const SessionBase = z.object({
  user: z.object({ id: z.string(), email: z.string(), name: z.string().nullable() }),
  /** True when the user is an operator (back office). */
  operator: z.boolean(),
  /** The clients this session may act in, with the user's role in each. */
  tenants: z.array(z.object({ id: z.string(), name: z.string(), role: Role })),
  /** The client selected now: a portal session's one client, or the operator's switcher choice. */
  activeTenantId: z.string().nullable(),
});
export type SessionBase = z.infer<typeof SessionBase>;

export const SessionResponse = SessionBase.extend({
  /** The language the app reads in, and the choices behind it (docs/plan.md §1.18). */
  language: SessionLanguage,
  // v0.12 W1-C: the active client's lead, by name ("Message Ana"); null when none is set.
  lead: PortalLead.nullable().optional(),
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
/** Lists of agents leave discarded drafts out unless asked. */
const IncludeDiscarded = z.object({ include: z.enum(["discarded"]).optional() });

/** A matrix edit: verbs left out keep their level. */
export const MatrixEdit = z.strictObject({
  read: PermissionLevel.optional(),
  create: PermissionLevel.optional(),
  update: PermissionLevel.optional(),
  delete: PermissionLevel.optional(),
  scope: z.unknown().optional(),
  // v0.12 W2-A: when sent, the matrix's entities, whole; left out, they are kept (docs/plan.md §1.44).
  entities: EntityPermissions.optional(),
});

export const ConnectionMatrix = z.object({
  read: PermissionLevel,
  create: PermissionLevel,
  update: PermissionLevel,
  delete: PermissionLevel,
  scope: z.unknown().optional(),
  // v0.12 W2-A: levels per entity (absent: every entity takes the verb's level).
  entities: EntityPermissions.optional(),
});

export const ValidationErrorSchema = z.object({
  stepId: z.string().nullable(),
  field: z.string(),
  message: z.string(),
  code: z.string(),
  workflow: z.string().optional(),
});

// v0.12 W1-E: RunStatusSchema lives with RunFilter (./runs-filter.ts).
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
  /** Open inbox items, for anyone (us or the client). */
  openInbox: z.number().int(),
  // UI cleanup (stream A): what the back office counts per client, from one source.
  /** Needs us at this client: the command center's escalations (`GET /api/ops/needs-us`). */
  needsUs: z.number().int().optional(),
  /** Its runs waiting for approval now (on anyone: the client or us). */
  waitingRuns: z.number().int().optional(),
  /** The Sandbox client (`tenant.settings.sandbox`): fixture data for building and test runs. */
  sandbox: z.boolean().optional(),
  /** §1.73: one of our own (`tenant.settings.internal`, Mezonas): the Marketing entry opens it. */
  internal: z.boolean().optional(),
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
  // UI cleanup (design pass): a client agent's go-live stage, so "live" is counted one way
  // (isLiveAgent); null for templates; optional so older answers still parse.
  stage: z.string().nullable().optional(),
  createdAt: Timestamp,
});
export type AgentSummary = z.infer<typeof AgentSummary>;

/**
 * UI cleanup (design pass): a client agent's work at a glance, for the client page's Overview: its
 * live runs in the last 7 days, how many wait for approval now, its last run, and its runs each day
 * (KPI_DAYS, UTC, oldest first).
 */
export const OpsAgentActivity = z.object({
  agentId: z.string(),
  runs7d: z.number().int(),
  waitingRuns: z.number().int(),
  lastRun: z
    .object({ id: z.string(), status: z.string(), at: Timestamp, waiting: z.boolean() })
    .nullable(),
  perDay: z.array(DayRuns),
});
export type OpsAgentActivity = z.infer<typeof OpsAgentActivity>;

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
  /**
   * Its last activity: the last sync, or for a built-in source (upload and email forwarding) the
   * last document that came through it. Absent where a route doesn't work it out.
   */
  lastActivityAt: NullableTimestamp.optional(),
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
  // UI cleanup (stream A): a run waiting on a person is "waiting for approval" whatever its stored
  // status; who it waits on and since when (null when it waits on nobody). Absent where a route
  // doesn't read it.
  waiting: RunWait.nullable().optional(),
  /** The workflow's name in the run's version (null when the version has no such workflow). */
  workflowName: z.string().nullable().optional(),
  /** A failed run: the name of the step it failed at, from the run's version. */
  errorStep: z.string().nullable().optional(),
  /** What the run is about, for its title: see RunSubject. */
  subject: RunSubject.optional(),
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
  // v0.13 W2-H: the models the step's calls ran on, from its model calls (ARCHITECTURE §10.11).
  /** Distinct, in the order first called; absent where the route doesn't read model calls. */
  models: z.array(z.string()).optional(),
  // P-4: a conversation step's transcript, with each turn's model and cost (§1.66).
  conversation: ConverseOpsView.optional(),
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

/**
 * How an external action reads on its card ("now / after this change"): the connector's name as
 * people know it ("QuickBooks") and the tool's display spec, when it declares one. The server adds
 * it from the tool registry, so items proposed before a tool declared one read the same.
 */
export const ChangeDisplayView = z.object({
  connectorName: z.string(),
  tool: ToolDisplay.nullable(),
  /**
   * Names for ids the change's before state leaves unnamed (`{ accounts: { "20": "Job
   * Materials" } }`, keyed like the display's `names` lists), found by the server in the
   * connection's synced records. Absent when there is nothing to add. The before state's own
   * names come first.
   */
  names: z.record(z.string(), z.record(z.string(), z.string())).optional(),
});
export type ChangeDisplayView = z.infer<typeof ChangeDisplayView>;

export const OpsAction = z.object({
  id: z.string(),
  tool: z.string(),
  display: ChangeDisplayView.nullable().optional(),
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
  // v0.12 W1-D: the signer's edit before signing; `input` stays the agent's (both show).
  editedInput: z.unknown().optional(),
  editedBy: z.string().nullable().optional(),
  editedAt: NullableTimestamp.optional(),
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
  /** An external action's card: see ChangeDisplayView. */
  display: ChangeDisplayView.nullable().optional(),
  status: InboxStatusSchema,
  resolution: z.unknown(),
  resolvedBy: z.string().nullable(),
  dueAt: NullableTimestamp,
  createdAt: Timestamp,
  resolvedAt: NullableTimestamp,
  /**
   * Whether the signed-in operator may resolve the item: theirs (assigned or delegated to the
   * operator, or to them by name), or any item of the Sandbox client (docs/plan.md §1.5). The
   * server decides; the back office only reads it.
   */
  resolvableByOperator: z.boolean(),
  // v0.12 W1-D: the Desk's undo window, snooze and batch.
  ...DESK_ITEM_FIELDS,
});

/** The client agent a run or inbox item belongs to, for the back office's lists (Track B). */
export const OpsAgentRef = z.object({
  id: z.string(),
  tenantId: z.string().nullable(),
  slug: z.string(),
  name: z.string(),
  serviceName: z.string().nullable(),
});
export type OpsAgentRef = z.infer<typeof OpsAgentRef>;

/** A registered connector as the back office offers it (Track B). */
export const OpsConnectorInfo = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  icon: z.string().nullable(),
  auth: z.string(),
  /**
   * Whether this deployment can connect it: an OAuth connector needs its client id and the state
   * secret; one needing no sign-in always can ("Not available yet" otherwise).
   */
  available: z.boolean(),
  tools: z.array(
    z.object({
      id: z.string(),
      description: z.string(),
      verb: z.string(),
      sideEffect: z.string(),
    }),
  ),
});

/** A connector id in a path. */
const ConnectorId = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/);

/**
 * A provider's callback parameters as the callback page received them (code, state and the rest),
 * posted once in the session that started the sign-in: the portal's or the back office's.
 */
export const OAuthCallbackBody = z.strictObject({
  params: z.record(z.string(), z.string().max(4096)),
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
  // QA round 1: its go-live stage and what it has going now, for its state in the sidebar.
  stage: z.string().nullable().optional(),
  runsNow: AgentRunsNow.optional(),
});
export type ServiceSummary = z.infer<typeof ServiceSummary>;

export const PortalRunSummary = z.object({
  id: z.string(),
  service: z.object({ id: z.string(), name: z.string() }),
  status: RunStatusSchema,
  startedAt: NullableTimestamp,
  finishedAt: NullableTimestamp,
  // QA round 1: the run waits on someone of the client now (its stored status stays running),
  // and how long it has waited on the client in all, kept out of its working time.
  waitingOnYou: z.boolean().optional(),
  waitedMs: z.number().int().nonnegative().optional(),
  /** What the run is about, for its title: see RunSubject. */
  subject: RunSubject.optional(),
});

/** Record names by id, for the receipts a run's steps cite (never "Record ·3f9a1c"). */
export const SourceNames = z.record(z.string(), z.string());

export const TimelineStep = z.object({
  id: z.string(),
  label: z.string(),
  status: z.string(),
  summary: z.string().nullable(),
  /** Record ids the step's output cites (`output.sources`), shown as links. */
  sources: z.array(z.string()),
  startedAt: NullableTimestamp,
  finishedAt: NullableTimestamp,
  // v0.13 W2-I: run oversight in the platform's words ("Corrected the vendor name and tried
  // again"), one line per decision, in the client's language; never the agent's note (§10.11).
  oversight: z.array(z.string()).optional(),
  // P-4: the client's side of a conversation step; never a prompt, a model or a cost (§1.66).
  conversation: ConversePortalView.optional(),
});

export const PortalInboxItem = z.object({
  id: z.string(),
  kind: InboxKindSchema,
  title: z.string(),
  payload: z.record(z.string(), z.unknown()),
  /** An external action's card: see ChangeDisplayView. */
  display: ChangeDisplayView.nullable().optional(),
  status: InboxStatusSchema,
  runId: z.string().nullable(),
  dueAt: NullableTimestamp,
  createdAt: Timestamp,
  resolvedAt: NullableTimestamp,
  resolvedBy: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
  // v0.12 W1-D: the Desk's undo window, snooze and batch.
  ...DESK_ITEM_FIELDS,
  // UI-1b: the client agent that asks (its service name, as the sidebar shows it); null when no
  // agent does (a platform item). Never its bundle, instructions or cost (invariant 11).
  service: z.object({ id: z.string(), name: z.string() }).nullable().optional(),
  // P-6: we stepped in, on the client's behalf, with the reason (docs/plan.md §1.68). The portal
  // names no person of ours: `resolvedBy.name` is then null and the screens say "Mezonas".
  steppedIn: SteppedIn.nullable().optional(),
});

export const ToolAccessSchema = z.object({
  toolId: z.string(),
  description: z.string(),
  verb: z.string(),
  level: PermissionLevel,
  access: z.enum(["runs", "asks_first", "steps_may_skip_approval", "not_allowed"]),
  // v0.12 W2-A: the tool's entity; null when it has none or its input names it.
  entity: z.string().nullable().optional(),
});

/** One connection of a tool, as the portal shows it. */
export const PortalConnectionState = z.object({
  id: z.string(),
  status: z.string(),
  externalAccountId: z.string().nullable(),
  /**
   * The account's name in the tool (e.g. the QuickBooks company), or a mail account's address;
   * null when the tool gives neither (core connectionLabel).
   */
  accountName: z.string().nullable(),
  lastSyncAt: NullableTimestamp,
  /** The last sync, or for upload and forwarding the last document that came through. */
  lastActivityAt: NullableTimestamp.optional(),
  permissions: ConnectionMatrix,
  access: z.array(ToolAccessSchema),
  usedBy: z.array(z.object({ id: z.string(), name: z.string() })),
  /** The signed-in person connected it (a client user may then disconnect it). */
  connectedByYou: z.boolean().optional(),
});

export const PortalConnection = z.object({
  connector: z.string(),
  name: z.string(),
  description: z.string(),
  icon: z.string().nullable(),
  /** Whether the client can sign in to it from the portal yet. */
  available: z.boolean(),
  /** An API-key connector the client admin sets up with a form on the Access page. */
  credentialForm: z.boolean(),
  /**
   * A person's own account (Gmail): a client user may connect it too, and disconnect it if they
   * connected it; other tools are the client admin's.
   */
  personal: z.boolean().optional(),
  // v0.12 W2-A: the record types the connector declares, for the entity rows of the matrix.
  permissionEntities: z.array(PermissionEntity).optional(),
  connection: PortalConnectionState.nullable(),
  /** B-5 (docs/plan.md §1.79): a tool the client may connect several times (a second bank). */
  multiple: z.boolean().optional(),
  /** B-5: its other connections, oldest first, after `connection`. */
  others: z.array(PortalConnectionState).optional(),
});

/**
 * B-5: for a tool a client may connect several times, which one a sign-in is for: another one
 * (`add=1`), or one signed in again (`connection=<id>`). Neither: the client's one, as before.
 */
export const PortalAuthorizeQuery = z.object({
  add: z.literal("1").optional(),
  connection: z.uuid().optional(),
});

/** The Gmail test email's body: empty. The recipient is never an input. */
export const GmailTestSendBody = z.strictObject({});

/** A webhook connection as its client admin sees it: hook URLs carry their secret tokens. */
export const PortalWebhookSetup = z.object({
  hooks: z.array(
    z.object({ id: z.string(), name: z.string(), url: z.string(), createdAt: Timestamp }),
  ),
  outbound: z
    .object({
      /** The URL as saved, shown back to the client who pasted it. */
      url: z.string(),
      host: z.string(),
      /** Receivers may check `x-mezonas-signature` with it. */
      signingSecret: z.string(),
      setAt: z.string().nullable(),
    })
    .nullable(),
});

/** What a delivery to an inbound hook gets back. */
export const InboundHookResponse = z.object({
  status: z.enum(["accepted", "duplicate"]),
  id: z.string(),
});

// ── Documents, uploads and forwarding (stream D, docs/plan.md §1.6) ─────────────────────────────

// DocumentSummary and DocumentExtractionView live in ./documents (shared with the records routes).

export const UploadResult = z.object({
  filename: z.string(),
  kind: z.enum(["document", "purchases", "refused"]),
  /** For a document: the stored one (a repeat gives the first back, `created` false). */
  document: DocumentSummary.nullable(),
  created: z.boolean(),
  /** For a purchases CSV. */
  purchases: z
    .object({
      rows: z.number(),
      created: z.number(),
      duplicates: z.number(),
      errors: z.array(z.object({ row: z.number(), message: z.string() })),
    })
    .nullable(),
  /** Why a file was refused. */
  error: z.string().nullable(),
});

/**
 * One of a client's recent events, offered as a test run's trigger payload (docs/plan.md §1.16
 * "Test-run payloads"): its payload as emitted, and a plain label for the picker.
 */
export const RecentEvent = z.object({
  id: z.string(),
  type: z.string(),
  createdAt: Timestamp,
  payload: z.record(z.string(), z.unknown()),
  /** What it is about: a document's file name, a purchase's date, or the payload's plain fields. */
  label: z.string(),
  /** A document's extracted vendor, or a purchase's vendor, when the event names one. */
  vendorName: z.string().nullable(),
  /** A document's extracted total, or a purchase's total. */
  total: z.object({ amount: z.string(), currency: z.string() }).nullable(),
});
export type RecentEvent = z.infer<typeof RecentEvent>;

export const ForwardingView = z.object({
  /** False until the deployment has a forwarding domain (EMAIL_FORWARDING_DOMAIN). */
  available: z.boolean(),
  address: z.string().nullable(),
  allowedSenders: z.array(z.string()),
  accepted: z.number(),
  dropped: z.number(),
  lastReceivedAt: NullableTimestamp,
  lastDroppedAt: NullableTimestamp,
  lastDropReason: z.string().nullable(),
});

export const ConnectorInfo = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  icon: z.string(),
  auth: z.enum(["oauth2", "api_key", "none"]),
  entities: z.array(z.string()),
  tools: z.array(
    z.object({
      id: z.string(),
      description: z.string(),
      verb: z.enum(["read", "create", "update", "delete"]),
      sideEffect: z.enum(["none", "internal", "external"]),
    }),
  ),
});

// ── Back office: agents, versions and lineage (Track B) ─────────────────────────────────────────

/** One change between two bundles (core's `diffBundles`), as the versions views show it. */
export const BundleChangeSchema = z.object({
  kind: z.enum(["added", "removed", "changed", "moved", "reordered"]),
  entity: z.string(),
  path: z.string(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
});
export type BundleChangeView = z.infer<typeof BundleChangeSchema>;

/**
 * A readable diff: the changes, plus a label for every entity and list key either side names
 * (`step:<id>` → its name, `workflow:<slug>` → its name), so the screens can write sentences.
 */
export const BundleDiff = z.object({
  changes: z.array(BundleChangeSchema),
  labels: z.record(z.string(), z.string()),
});

/** One merge conflict (core's `MergeConflict`): settled by a resolution with the same path. */
export const MergeConflictSchema = z.object({
  path: z.string(),
  kind: z.enum(["field", "exists", "location", "order"]),
  entity: z.string(),
  base: z.unknown(),
  ours: z.unknown(),
  theirs: z.unknown(),
});

/** How the merge view settles one conflict (core's `Resolution`). */
export const ResolutionSchema = z.union([
  z.strictObject({ path: z.string().max(2000), choice: z.enum(["ours", "theirs", "base"]) }),
  z.strictObject({ path: z.string().max(2000), choice: z.literal("value"), value: z.unknown() }),
]);

/**
 * A three-way merge's inputs and its unresolved result, for the merge view (ARCHITECTURE §10.5).
 * The view re-runs core's `mergeBundles` and `validateBundle` with its resolutions as they change;
 * the server runs them again on save.
 */
export const MergeInputs = z.object({
  base: VersionDetail,
  ours: VersionDetail,
  /** For a promotion, the client version with client-specific values stripped. */
  theirs: VersionDetail,
  conflicts: z.array(MergeConflictSchema),
  labels: z.record(z.string(), z.string()),
});

/** A skill an agent may use, with its settings schema (the editor builds its forms from it). */
export const SkillOption = z.object({
  /** The reference a bundle names it by (`docs.extract`, `custom:<slug>`). */
  id: z.string(),
  name: z.string(),
  description: z.string(),
  category: z.string(),
  source: z.enum(["builtin", "client", "shared"]),
  version: z.number().int().nullable(),
  settings: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      type: z.enum(["number", "boolean", "string", "enum"]),
      default: z.unknown(),
      options: z.array(z.string()).optional(),
      clientSpecific: z.boolean(),
    }),
  ),
  requiresConnectors: z.array(z.string()),
});
export type SkillOption = z.infer<typeof SkillOption>;

/**
 * What the workflow builder places and types steps with (ARCHITECTURE §10.5): every skill the agent
 * may use with its full definition (input and output schemas, tools, settings; instructions are
 * left out), every registered tool, and the connectors their actions are grouped under.
 */
export const BuilderCatalog = z.object({
  skills: z.array(
    z.object({
      /** The reference a bundle names it by: its id, or a pinned `id@version` the agent uses. */
      ref: z.string(),
      source: z.enum(["builtin", "client", "shared", "pinned"]),
      version: z.number().int().nullable(),
      definition: SkillDefinition,
    }),
  ),
  tools: z.array(ToolSpec),
  connectors: z.array(z.object({ id: z.string(), name: z.string(), icon: z.string().nullable() })),
  // v0.12 W2-B: the automations a use step can pin (live versions, and those the agent pins).
  automations: z.array(BuilderAutomation).default([]),
});
export type BuilderCatalog = z.infer<typeof BuilderCatalog>;

// ── Skills library and the Builder (ARCHITECTURE §9.2, §9.6) ─────────────────────────────────────

/** A row of the skills library: built-in (code) or operator-written (rows, shared or one client's). */
export const SkillListItem = z.object({
  /** The `skill` row id; built-ins (no row) carry their skill id. */
  id: z.string(),
  /** The reference a bundle names it by (`docs.extract`, `custom:<slug>`). */
  ref: z.string(),
  name: z.string(),
  description: z.string(),
  category: z.string(),
  source: z.enum(["builtin", "shared", "client"]),
  clientId: z.string().nullable(),
  clientName: z.string().nullable(),
  status: z.string(),
  liveVersion: z.number().int().nullable(),
  latestVersion: z.number().int().nullable(),
  latestStatus: z.string().nullable(),
  /** Top-level fields of its input and output schemas: "in → out". */
  inputs: z.array(z.string()),
  outputs: z.array(z.string()),
  tools: z.array(z.string()),
  connectors: z.array(z.string()),
  /**
   * Client agents whose live, else latest, version uses it: a template and its test copies are
   * not uses (the owner's review: "used by 2 agents" when one exists).
   */
  usedBy: z.number().int(),
  /** Those client agents, "Bill clerk · Demo client", for the library's hover and list. */
  usedByNames: z.array(z.string()).optional(),
});
export type SkillListItem = z.infer<typeof SkillListItem>;

export const SkillVersionView = z.object({
  id: z.string(),
  version: z.number().int(),
  status: z.string(),
  definition: SkillDefinition,
  changeNote: z.string().nullable(),
  authorId: z.string().nullable(),
  parentVersionId: z.string().nullable(),
  createdAt: Timestamp,
});
export type SkillVersionView = z.infer<typeof SkillVersionView>;

export const SkillUse = z.object({
  agentId: z.string(),
  kind: z.enum(["template", "client"]),
  slug: z.string(),
  name: z.string(),
  clientId: z.string().nullable(),
  clientName: z.string().nullable(),
  /** The reference as the agent names it (maybe pinned `@N`). */
  ref: z.string(),
  version: z.number().int(),
});
export type SkillUse = z.infer<typeof SkillUse>;

const BuilderOutcome = z.object({
  bundle: z.unknown(),
  /** The Builder's own account of the draft, in plain words. */
  summary: z.string(),
  /** What it needs that doesn't exist (no skill, tool, connector or connection). */
  gaps: z.array(z.string()),
  /** Rules the server enforced on the model's answer. */
  notes: z.array(z.string()),
  /** What would still stop a publish. */
  errors: z.array(ValidationErrorSchema),
  /** USD, the model calls' cost (operator only). */
  costUsd: z.string().nullable(),
});

// ── Routes ───────────────────────────────────────────────────────────────────────────────────────

const OPS = ["operator"] as const;
const CLIENT = ["client_admin", "client_user"] as const;

export const authRoutes = {
  authProvider: defineRoute({
    method: "GET",
    path: "/api/auth/provider",
    auth: "public",
    roles: [],
    summary: "Which sign-in this environment uses, so the sign-in page shows the right one",
    response: z.object({
      provider: z.enum(["workos", "dev", "unavailable"]),
      /** Why sign-in is unavailable (misconfiguration), for the operator. */
      message: z.string().nullable(),
    }),
  }),
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
    // §1.84: `names` leaves out Needs us and runs waiting (the costly counts), for pickers.
    query: z.object({ view: z.enum(["full", "names"]).optional() }),
    response: z.object({ clients: z.array(ClientSummary) }),
  }),
  opsCreateClient: defineRoute({
    method: "POST",
    path: "/api/ops/clients",
    auth: "session",
    roles: OPS,
    summary:
      "Create a client; the creating operator serves it. Optionally invites its client admin and sets who approves",
    body: z.strictObject({
      name: z.string().trim().min(1).max(200),
      timezone: z.string().optional(),
      connectorsOffered: z.array(z.string().min(1)).optional(),
      /** Who approves its external actions (default: the client admin). */
      approvals: ExternalApprover.optional(),
      /** Its default language (plan §1.18); unset follows each reader's browser. */
      language: Locale.optional(),
      /** Its client admin, invited in the same step. */
      admin: InviteBody.omit({ role: true }).optional(),
      /** Add the supervisor (docs/plan.md §1.28) as a draft to test and activate. */
      supervisor: z.boolean().optional(),
    }),
    response: z.object({ client: ClientSummary, admin: InviteResult.nullable() }),
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
      /** UI cleanup (design pass): each client agent's work at a glance (test copies left out). */
      activity: z.array(OpsAgentActivity).optional(),
    }),
  }),
  opsClientConnections: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/connections",
    auth: "session",
    roles: OPS,
    summary: "A client's connections with their permission matrices (never credentials)",
    params: IdParams,
    response: z.object({
      connections: z.array(OpsConnection),
      /** Connector ids offered to the client (`tenant.settings.connectors_offered`). */
      offered: z.array(z.string()),
      /** Every registered connector, for the offering. */
      connectors: z.array(OpsConnectorInfo),
      /** Client agents bound to each connection, by connection id. */
      usedBy: z.record(z.string(), z.array(z.object({ id: z.string(), name: z.string() }))),
      /** The Sandbox client (`tenant.settings.sandbox`): the operator connects its tools. */
      sandbox: z.boolean(),
    }),
  }),
  opsConnectSandbox: defineRoute({
    method: "POST",
    path: "/api/ops/clients/:id/connections/:connector/connect",
    auth: "session",
    roles: OPS,
    summary:
      "Connect a tool in the Sandbox client (only there: in a real client, the client signs in)",
    params: z.object({ id: ApiId, connector: ConnectorId }),
    response: z.object({ connection: OpsConnection }),
  }),
  opsSandboxAuthorize: defineRoute({
    method: "POST",
    path: "/api/ops/clients/:id/connections/:connector/authorize",
    auth: "session",
    roles: OPS,
    summary:
      "Start the operator's own sign-in to an OAuth tool of the Sandbox client: answers where the provider's sign-in starts (403 not_sandbox in any other client)",
    params: z.object({ id: ApiId, connector: ConnectorId }),
    response: z.object({ redirectUrl: z.string() }),
  }),
  opsSandboxDisconnect: defineRoute({
    method: "DELETE",
    path: "/api/ops/clients/:id/connections/:connectionId",
    auth: "session",
    roles: OPS,
    summary:
      "Disconnect a tool in the Sandbox client: the grant is revoked at the provider and the credentials dropped (403 not_sandbox in any other client)",
    params: z.object({ id: ApiId, connectionId: ApiId }),
    response: z.object({ connection: OpsConnection }),
  }),
  opsSandboxGmailTestSend: defineRoute({
    method: "POST",
    path: "/api/ops/clients/:id/connections/gmail/test-send",
    auth: "session",
    roles: OPS,
    summary:
      "Send one test email from the Sandbox client's connected Gmail to that same mailbox; at most one a minute (403 not_sandbox in any other client)",
    params: IdParams,
    body: GmailTestSendBody,
    response: z.object({ to: z.string(), sentAt: Timestamp }),
  }),
  opsSandboxUploads: defineRoute({
    method: "POST",
    path: "/api/ops/clients/:id/uploads",
    auth: "session",
    roles: OPS,
    summary:
      "Upload files to the Sandbox client as the portal does (multipart, field `files`): PDFs and images become documents, a CSV of purchases becomes transactions (403 not_sandbox in any other client)",
    params: IdParams,
    response: z.object({ results: z.array(UploadResult) }),
  }),
  opsSandboxAuthorizeCallback: defineRoute({
    method: "POST",
    path: "/api/ops/connections/:connector/callback",
    auth: "session",
    roles: OPS,
    summary:
      "Finish the operator's sign-in to a Sandbox tool: the provider's parameters, checked against the signed state (its client, user and back-office origin)",
    params: z.object({ connector: ConnectorId }),
    body: OAuthCallbackBody,
    response: z.object({ clientId: z.string(), connection: OpsConnection }),
  }),
  opsOfferConnectors: defineRoute({
    method: "PUT",
    path: "/api/ops/clients/:id/connectors",
    auth: "session",
    roles: OPS,
    summary: "Choose which connectors a client is offered (the client signs in to them)",
    params: IdParams,
    body: z.strictObject({ offered: z.array(z.string().min(1)).max(50) }),
    response: z.object({ offered: z.array(z.string()) }),
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
    summary: "Templates (discarded drafts with ?include=discarded)",
    query: IncludeDiscarded,
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
    summary: "A client's agents (discarded drafts with ?include=discarded)",
    params: IdParams,
    query: IncludeDiscarded,
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
  opsRetire: defineRoute({
    method: "POST",
    path: "/api/ops/agents/:id/retire",
    auth: "session",
    roles: OPS,
    summary: "Retire a client agent: it never runs again; its history stays",
    params: IdParams,
    response: z.object({ agent: AgentSummary }),
  }),
  opsActivation: defineRoute({
    method: "GET",
    path: "/api/ops/agents/:id/activation",
    auth: "session",
    roles: OPS,
    summary: "Whether a client agent can be activated, every reason it can't, what it must bind",
    params: IdParams,
    response: z.object({
      ready: z.boolean(),
      problems: z.array(z.string()),
      /** Connectors its live (else latest) version needs bound. */
      requiredConnectors: z.array(z.string()),
      /**
       * The latest test run of its live version, if any, so the page can poll while one is going
       * (docs/plan.md §1.16).
       */
      testRun: z
        .object({ id: z.string(), status: RunStatusSchema, createdAt: Timestamp })
        .nullable(),
    }),
  }),
  opsAgentSkills: defineRoute({
    method: "GET",
    path: "/api/ops/agents/:id/skills",
    auth: "session",
    roles: OPS,
    summary: "Skills this agent may use (built-in, shared, and its client's own) with settings",
    params: IdParams,
    response: z.object({ skills: z.array(SkillOption) }),
  }),
  opsVersionDiff: defineRoute({
    method: "GET",
    path: "/api/ops/agents/:id/versions/:vid/diff",
    auth: "session",
    roles: OPS,
    summary: "What a version changed against its parent (or another version of the agent)",
    params: AgentVersionParams,
    query: z.object({ against: ApiId.optional() }),
    response: BundleDiff.extend({ from: VersionSummary.nullable(), to: VersionSummary }),
  }),
  opsCustomizations: defineRoute({
    method: "GET",
    path: "/api/ops/agents/:id/customizations",
    auth: "session",
    roles: OPS,
    summary: "A client agent's customizations: its live (else latest) version against its base",
    params: IdParams,
    response: BundleDiff.extend({
      /** The base template version (null when the agent has no template). */
      base: VersionSummary.nullable(),
      version: VersionSummary.nullable(),
    }),
  }),
  opsUsedBy: defineRoute({
    method: "GET",
    path: "/api/ops/templates/:id/used-by",
    auth: "session",
    roles: OPS,
    summary: "The client agents forked from a template: base version, behind, customizations",
    params: IdParams,
    response: z.object({
      templateLiveVersion: z.number().int().nullable(),
      agents: z.array(
        z.object({
          agent: AgentSummary,
          client: z.object({ id: z.string(), name: z.string() }),
          version: z.number().int().nullable(),
          baseVersion: z.number().int().nullable(),
          behind: z.number().int(),
          customizations: z.number().int(),
          /** Open conflicts an update to the template's live version would raise. */
          conflicts: z.number().int().nullable(),
        }),
      ),
    }),
  }),
  opsUpdatePreview: defineRoute({
    method: "GET",
    path: "/api/ops/agents/:id/update-preview",
    auth: "session",
    roles: OPS,
    summary:
      "A template update for a client agent: base, client and template bundles and the merge's conflicts",
    params: IdParams,
    response: MergeInputs.extend({
      /** The template the update comes from. */
      template: AgentSummary,
    }),
  }),
  opsUpdate: defineRoute({
    method: "POST",
    path: "/api/ops/agents/:id/update",
    auth: "session",
    roles: OPS,
    summary:
      "Apply a template update: the merge with every conflict resolved, saved as the client agent's draft",
    params: IdParams,
    body: z.strictObject({
      resolutions: z.array(ResolutionSchema).max(500),
      changeNote: Note.optional(),
    }),
    response: z.object({ version: VersionSummary }),
  }),
  opsPromotePreview: defineRoute({
    method: "GET",
    path: "/api/ops/agents/:id/promote-preview",
    auth: "session",
    roles: OPS,
    summary:
      "Promote a client agent's changes: base, template and stripped client bundles, what stays with the client",
    params: IdParams,
    query: z.object({ version: ApiId.optional() }),
    response: MergeInputs.extend({
      template: AgentSummary,
      /** The client version promoted (its bundle, stripped, is `theirs.bundle`). */
      client: VersionSummary,
      /** Client-specific values left out: the stripped bundle against the client version. */
      leftOut: z.array(BundleChangeSchema),
    }),
  }),
  opsPromote: defineRoute({
    method: "POST",
    path: "/api/ops/agents/:id/promote",
    auth: "session",
    roles: OPS,
    summary: "Promote a client agent's changes (all or selected) into a new template draft",
    params: IdParams,
    body: z.strictObject({
      versionId: ApiId.optional(),
      /** Ids from core's `selectableBetween(base, stripped)`; omitted: every change. */
      changes: z.array(z.string().max(2000)).max(1000).optional(),
      resolutions: z.array(ResolutionSchema).max(500),
      changeNote: Note.optional(),
      releaseNote: Note.optional(),
    }),
    response: z.object({ template: AgentSummary, version: VersionSummary }),
  }),
  opsDetach: defineRoute({
    method: "POST",
    path: "/api/ops/agents/:id/detach",
    auth: "session",
    roles: OPS,
    summary: "Detach a client agent from its template: it keeps its history, takes no updates",
    params: IdParams,
    response: z.object({ agent: AgentSummary }),
  }),
  opsRelink: defineRoute({
    method: "POST",
    path: "/api/ops/agents/:id/relink",
    auth: "session",
    roles: OPS,
    summary: "Re-link a client agent to a published template version as its new base",
    params: IdParams,
    body: z.strictObject({ templateVersionId: ApiId }),
    response: z.object({ agent: AgentSummary, version: VersionSummary }),
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
      "Test-run a version (never writes): a client agent on its client's data, a template as its test copy in the Sandbox client or in a chosen client it serves",
    params: AgentVersionParams,
    body: z.strictObject({
      workflow: z.string().min(1),
      payload: z.unknown().optional(),
      /** A template only: the served client whose data it runs on (default: the Sandbox). */
      clientId: ApiId.optional(),
    }),
    // For a template, the run belongs to its test copy: agentId and versionId name that copy.
    response: z.object({ runId: z.string(), agentId: z.string(), versionId: z.string() }),
  }),
  opsClientEvents: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/events",
    auth: "session",
    roles: OPS,
    summary:
      "A client's most recent events of one type, newest first, to use as a test run's trigger payload (never a test run's)",
    params: IdParams,
    query: z.object({
      type: z.string().trim().min(1).max(200),
      limit: z.coerce.number().int().min(1).max(50).optional(),
    }),
    response: z.object({ events: z.array(RecentEvent) }),
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
          /** The payload's JSON Schema: what `{{trigger.…}}` can reference. */
          payload: JsonSchema,
          sample: z.unknown(),
          /**
           * The connector that emits it (`zoho_crm`), so the builder offers it only where that
           * connector is connected; null or absent for the platform's own events.
           */
          connector: z.string().nullable().optional(),
        }),
      ),
    }),
  }),
  opsBuilderCatalog: defineRoute({
    method: "GET",
    path: "/api/ops/agents/:id/builder-catalog",
    auth: "session",
    roles: OPS,
    summary: "What the workflow builder needs for an agent: skills with schemas, tools, connectors",
    params: IdParams,
    response: BuilderCatalog,
  }),
  opsRuns: defineRoute({
    method: "GET",
    path: "/api/ops/runs",
    auth: "session",
    roles: OPS,
    summary: "Runs across the clients served",
    // v0.12 W1-E: RunFilter as query parameters, `perDay=1`, `groupBy=error` (docs/plan.md §1.40).
    query: OpsRunsQuery,
    response: z.object({
      runs: z.array(OpsRun),
      agents: z.array(OpsAgentRef),
      perDay: RunsPerDay.optional(),
      groups: z.array(RunErrorGroup).optional(),
    }),
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
      agent: OpsAgentRef.nullable(),
      /** The version's number and the workflow that ran (its steps name the run's nodes). */
      version: z.number().int().nullable(),
      workflow: z
        .object({ slug: z.string(), name: z.string(), definition: z.unknown() })
        .nullable(),
      // v0.13 W2-I: the run's oversight decisions, oldest first (ARCHITECTURE §10.11).
      oversight: z.array(OversightDecisionView).optional(),
      /** The records the steps cite (`sources`), by id: "Northline Panel Supply · 20418". */
      sourceNames: SourceNames.optional(),
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
    response: z.object({ items: z.array(OpsInboxItem), agents: z.array(OpsAgentRef) }),
  }),
  opsSkills: defineRoute({
    method: "GET",
    path: "/api/ops/skills",
    auth: "session",
    roles: OPS,
    summary: "The skills library: built-in, shared and the clients' own skills, with used-by",
    query: z.object({ client: ApiId.optional() }),
    response: z.object({
      skills: z.array(SkillListItem),
      /** What the skill editor picks tools from, grouped under the connectors. */
      tools: z.array(ToolSpec),
      connectors: z.array(z.object({ id: z.string(), name: z.string() })),
    }),
  }),
  opsCreateSkill: defineRoute({
    method: "POST",
    path: "/api/ops/skills",
    auth: "session",
    roles: OPS,
    summary: "A new operator skill (shared, or for one client) with its v1 draft",
    body: z.strictObject({
      clientId: ApiId.optional(),
      definition: z.unknown(),
      changeNote: Note.optional(),
    }),
    response: z.object({ skill: SkillListItem, version: SkillVersionView }),
  }),
  opsSkill: defineRoute({
    method: "GET",
    path: "/api/ops/skills/:id",
    auth: "session",
    roles: OPS,
    summary: "An operator skill with its versions and the agents that use it",
    params: IdParams,
    response: z.object({
      skill: SkillListItem,
      versions: z.array(SkillVersionView),
      usedBy: z.array(SkillUse),
    }),
  }),
  opsSaveSkillVersion: defineRoute({
    method: "POST",
    path: "/api/ops/skills/:id/versions",
    auth: "session",
    roles: OPS,
    summary: "Save a new draft version of an operator skill",
    params: IdParams,
    body: z.strictObject({
      definition: z.unknown(),
      parentVersionId: ApiId.optional(),
      changeNote: Note.optional(),
    }),
    response: z.object({ version: SkillVersionView }),
  }),
  opsPublishSkill: defineRoute({
    method: "POST",
    path: "/api/ops/skills/:id/versions/:vid/publish",
    auth: "session",
    roles: OPS,
    summary: "Publish a skill version: agents that name the skill without a version use it",
    params: z.object({ id: ApiId, vid: ApiId }),
    response: z.object({ version: SkillVersionView }),
  }),
  opsRollbackSkill: defineRoute({
    method: "POST",
    path: "/api/ops/skills/:id/rollback",
    auth: "session",
    roles: OPS,
    summary: "Roll a skill back: an older version copied as a new one and published",
    params: IdParams,
    body: z.strictObject({ versionId: ApiId }),
    response: z.object({ version: SkillVersionView }),
  }),
  opsDraftAgent: defineRoute({
    method: "POST",
    path: "/api/ops/agents/draft",
    auth: "session",
    roles: OPS,
    summary: "The Builder drafts a new template (or a client agent) from a description",
    body: z.strictObject({
      description: z.string().trim().min(1).max(4000),
      clientId: ApiId.optional(),
      name: z.string().max(200).optional(),
      role: z.string().max(200).optional(),
    }),
    response: BuilderOutcome.extend({
      agent: AgentSummary,
      version: VersionSummary,
      /** A template that already does most of the job, when the Builder found one. */
      startFromTemplate: z
        .object({ id: z.string(), slug: z.string(), name: z.string() })
        .nullable(),
    }),
  }),
  opsReviseAgent: defineRoute({
    method: "POST",
    path: "/api/ops/agents/:id/revise",
    auth: "session",
    roles: OPS,
    summary: "The Builder revises an agent from an instruction or a client's request",
    params: IdParams,
    body: z
      .strictObject({
        instruction: z.string().trim().min(1).max(4000).optional(),
        /** Default: the agent's latest version. */
        fromVersionId: ApiId.optional(),
        /** A client's change request handed to the Builder. */
        requestId: ApiId.optional(),
      })
      .refine((b) => b.instruction !== undefined || b.requestId !== undefined, {
        message: "give an instruction or a request",
      }),
    response: BuilderOutcome.extend({
      version: VersionSummary,
      diff: BundleDiff,
    }),
  }),
  opsDiscardAgent: defineRoute({
    method: "POST",
    path: "/api/ops/agents/:id/discard",
    auth: "session",
    roles: OPS,
    summary: "Discard an agent that was never published (e.g. an unwanted Builder draft)",
    params: IdParams,
    response: z.object({ agent: AgentSummary }),
  }),
  opsRestoreAgent: defineRoute({
    method: "POST",
    path: "/api/ops/agents/:id/restore",
    auth: "session",
    roles: OPS,
    summary: "Bring a discarded draft back",
    params: IdParams,
    response: z.object({ agent: AgentSummary }),
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
      /** The supervisor's latest summary and its open findings for the client admin (§1.28). */
      health: PortalHealth.default({ summary: null, findings: [] }),
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
      // v0.12 W1-D: open items leave "waiting" while snoozed; `snoozed` lists them.
      view: z.enum(["waiting", "snoozed"]).optional(),
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
    // v0.12 W1-E: RunFilter without the back office's keys (docs/plan.md §1.40).
    query: PortalRunsQuery,
    response: z.object({ runs: z.array(PortalRunSummary), perDay: RunsPerDay.optional() }),
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
      /** The records the steps cite (`sources`), by id: "Northline Panel Supply · 20418". */
      sourceNames: SourceNames.optional(),
      approvals: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          status: InboxStatusSchema,
          approved: z.boolean().nullable(),
          by: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
          resolvedAt: NullableTimestamp,
          // P-6: we stepped in on the client's behalf (docs/plan.md §1.68).
          steppedIn: SteppedIn.nullable().optional(),
        }),
      ),
      actions: z.array(
        z.object({
          id: z.string(),
          tool: z.string(),
          description: z.string(),
          display: ChangeDisplayView.nullable().optional(),
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
  portalAuthorize: defineRoute({
    method: "POST",
    path: "/api/connections/:connector/authorize",
    auth: "session",
    roles: ["client_admin", "client_user"],
    summary:
      "Sign in to an offered tool: connects it, or answers where the provider's sign-in starts (a URL, or a link widget to open)",
    params: z.object({ connector: ConnectorId }),
    query: PortalAuthorizeQuery,
    response: z.object({
      connection: PortalConnection,
      redirectUrl: z.string().nullable(),
      // v0.12 bankfeed: Plaid Link, opened in the page, in place of a redirect.
      link: LinkStartView.nullable().optional(),
    }),
  }),
  portalAuthorizeCallback: defineRoute({
    method: "POST",
    path: "/api/connections/:connector/callback",
    auth: "session",
    roles: ["client_admin", "client_user"],
    summary:
      "Finish signing in to a tool: the provider's callback parameters, checked against the state",
    params: z.object({ connector: ConnectorId }),
    body: OAuthCallbackBody,
    response: z.object({ connection: PortalConnection }),
  }),
  portalWebhook: defineRoute({
    method: "GET",
    path: "/api/connections/:id/webhook",
    auth: "session",
    roles: ["client_admin"],
    summary: "A webhook connection's hooks with their URLs, and where outbound events go",
    params: IdParams,
    response: PortalWebhookSetup,
  }),
  portalWebhookAddHook: defineRoute({
    method: "POST",
    path: "/api/connections/:id/webhook/hooks",
    auth: "session",
    roles: ["client_admin"],
    summary: "Make an inbound hook: a URL with its own secret to paste into a Zap",
    params: IdParams,
    body: z.strictObject({ name: z.string().trim().min(1).max(80) }),
    response: PortalWebhookSetup,
  }),
  portalWebhookRemoveHook: defineRoute({
    method: "DELETE",
    path: "/api/connections/:id/webhook/hooks/:hookId",
    auth: "session",
    roles: ["client_admin"],
    summary: "Remove an inbound hook: deliveries to it are refused from now on",
    params: z.object({ id: ApiId, hookId: ApiId }),
    response: PortalWebhookSetup,
  }),
  portalWebhookOutbound: defineRoute({
    method: "PUT",
    path: "/api/connections/:id/webhook/outbound",
    auth: "session",
    roles: ["client_admin"],
    summary: "Set (or clear) the https URL outbound events are sent to, e.g. a Zap's catch hook",
    params: IdParams,
    body: z.strictObject({ url: z.string().max(2048).nullable() }),
    response: PortalWebhookSetup,
  }),
  portalUploads: defineRoute({
    method: "POST",
    path: "/api/uploads",
    auth: "session",
    roles: CLIENT,
    summary:
      "Upload files (multipart, field `files`): PDFs and images become documents, a CSV of purchases becomes transactions",
    response: z.object({ results: z.array(UploadResult) }),
  }),
  portalDocuments: defineRoute({
    method: "GET",
    path: "/api/documents",
    auth: "session",
    roles: CLIENT,
    summary: "Recent documents: uploaded and forwarded",
    query: z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }),
    response: z.object({ documents: z.array(DocumentSummary) }),
  }),
  portalDocument: defineRoute({
    method: "GET",
    path: "/api/documents/:id",
    auth: "session",
    roles: CLIENT,
    summary: "A document: a 5-minute link to the file and its latest extraction",
    params: IdParams,
    response: DocumentDetail,
  }),
  portalForwarding: defineRoute({
    method: "GET",
    path: "/api/connections/upload/forwarding",
    auth: "session",
    roles: CLIENT,
    summary: "Your private forwarding address, who may forward to it, and what arrived",
    response: z.object({ forwarding: ForwardingView }),
  }),
  portalForwardingSenders: defineRoute({
    method: "PUT",
    path: "/api/connections/upload/senders",
    auth: "session",
    roles: ["client_admin"],
    summary: "Set who may forward to your address: email addresses or domains",
    body: z.strictObject({ allowed: z.array(z.string().min(1).max(254)).max(100) }),
    response: z.object({ forwarding: ForwardingView }),
  }),
  portalDisconnect: defineRoute({
    method: "DELETE",
    path: "/api/connections/:id",
    auth: "session",
    roles: ["client_admin", "client_user"],
    summary: "Disconnect a tool: agents can no longer use it; its permissions are kept",
    params: IdParams,
    response: z.object({ connection: PortalConnection }),
  }),
  portalGmailTestSend: defineRoute({
    method: "POST",
    path: "/api/connections/gmail/test-send",
    auth: "session",
    roles: CLIENT,
    summary:
      "Send one test email from the connected Gmail to that same mailbox (the client admin, or the person who connected it); at most one a minute",
    // Nothing to choose: the recipient is always the connection's own address. Strict, so a body
    // that tries to name one (or anything else) is refused.
    body: GmailTestSendBody,
    response: z.object({ to: z.string(), sentAt: Timestamp }),
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
  inboundHook: defineRoute({
    method: "POST",
    path: "/api/hooks/:tenantId/:hookId",
    auth: "public",
    roles: [],
    summary:
      "A delivery to a client's inbound hook (Zapier, Make, n8n): JSON or a form, with the hook's token or signature",
    params: z.object({ tenantId: ApiId, hookId: ApiId }),
    response: InboundHookResponse,
  }),
  connectors: defineRoute({
    method: "GET",
    path: "/api/connectors",
    auth: "session",
    roles: ROLES,
    summary: "The connectors this deployment offers, with the tools each gives agents",
    response: z.object({ connectors: z.array(ConnectorInfo) }),
  }),
  documentFile: defineRoute({
    method: "GET",
    path: "/api/files/:token",
    auth: "public",
    roles: [],
    summary:
      "A document's bytes through a signed, 5-minute link (where object storage can't sign its own); not JSON",
    params: z.object({ token: z.string().min(10).max(2000) }),
    response: z.unknown(),
  }),
  ...authRoutes,
  ...opsRoutes,
  ...portalRoutes,
  ...feedbackRoutes,
  ...complianceRoutes,
  ...secondFactorRoutes,
  ...exportRoutes,
  ...onboardingRoutes,
  ...requestRoutes,
  ...languageRoutes,
  ...usageRoutes,
  ...recordRoutes,
  ...approverRuleRoutes,
  ...messagingRoutes,
  ...knowledgeRoutes,
  ...callRoutes,
  ...billingRoutes,
  ...reachRoutes,
  ...accessRoutes,
  ...browserRoutes,
  ...directoryRoutes,
  ...supervisorRoutes,
  ...qboRoutes,
  // v0.14 W4-B: Zoho CRM notifications
  ...zohoRoutes,
  // v0.12 bankfeed: Plaid's webhook
  ...bankfeedRoutes,
  // v0.12 W1-G: people (autonomy).
  ...peopleRoutes,
  ...voiceSampleRoutes,
  // v0.12 W1-E
  ...runControlRoutes,
  // v0.12 W1-A: go-live stages and client controls
  ...lifecycleRoutes,
  // v0.12 W1-B: notifications, the Table and the Weekly Table
  ...notifyRoutes,
  ...tableRoutes,
  // v0.12 W1-D: the Desk
  ...deskRoutes,
  // v0.12 W2-B: automations
  ...automationRoutes,
  // v0.12 W1-C
  ...threadRoutes,
  // v0.12 W2-D: Sloan, the account agent
  ...accountRoutes,
  // v0.12 W2-G: KPIs and the client view, credits running out, the client's audit export
  ...clientViewRoutes,
  // v0.12 W2-C: the test bench, skill tests and the agent lab
  ...testbenchRoutes,
  // v0.12 W2-F: the command center, search and plain-words questions
  ...commandCenterRoutes,
  // v0.12 W2-A: the connectors catalog
  ...connectorRoutes,
  // v0.12 W2-E
  ...triggerRoutes,
  // v0.13 W2-H: models for task skills and skill steps.
  ...modelRoutes,
  // v0.13 W2-I: run oversight decisions for the agent lab.
  ...oversightRoutes,
  // v0.12 W3-A: the Builder as a conversation.
  ...builderRoutes,
  // v0.14 W4-E: Google Chat
  ...gchatRoutes,
  // v0.14 W4-D: Google Sheets' picking
  ...gsheetsRoutes,
  // v0.14 W4-C: the Slack channel picker.
  ...slackRoutes,
  // v0.14 capture: WhatsApp conversations and their capture.
  ...conversationRoutes,
  // v0.14 W4-A: WhatsApp through Meta (the webhook and the groups setting).
  ...whatsappMetaRoutes,
  // P-1: packs (the Purchasing area's Materials pack), docs/plan.md §1.63.
  ...packRoutes,
  // The back office's chart of accounts (docs/plan.md §1.79).
  ...ledgerRoutes,
  // P-6: the client runs it, we step in (docs/plan.md §1.68).
  ...stepInRoutes,
  // P-7: message translation (docs/plan.md §1.69).
  ...translationRoutes,
  // P-8: US texting registration (docs/plan.md §1.70)
  ...a2pRoutes,
} as const;
export type Routes = typeof routes;
