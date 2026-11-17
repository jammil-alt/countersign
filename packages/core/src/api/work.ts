// Build (docs/plan.md §1.123.1; docs/cases-plan.md §3.2): a client's issues and asks, the
// operator's enhancements, agent builds and the work order across them, the safety hold, and the
// portal's Requests (the client's view of its issues and asks). The portal never gets internal
// notes, Reggie's read, plan or draft, to-dos, urgency, the work order or another client's asks
// (invariant 11).

import { z } from "zod";
import { isUuid } from "../ids";
import { RequirementAnswers, RequirementField } from "../work/requirements";
import { ReggieRead } from "../work/reggie-read";
import { Standing } from "../work/standing";
import {
  BuildTab,
  WorkCauseKind,
  WorkEnhancementDecision,
  WorkEnhancementStage,
  WorkIssueSource,
  WorkIssueStage,
  WorkUrgency,
  WorkWaitingOn,
} from "../work/pipelines";
import { defineRoute } from "./contract";

const Id = z.string().refine((v) => isUuid(v), "not an id");
const IdParams = z.object({ id: Id });
const OPS = ["operator"] as const;
const CLIENT = ["client_admin", "client_user"] as const;
const Named = z.object({ id: z.string(), name: z.string() });
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date such as 2026-12-24");

export const ISSUE_TITLE_MAX = 200;
export const ISSUE_TEXT_MAX = 4000;
const Reason = z.string().trim().min(1).max(500);

// ── The list ─────────────────────────────────────────────────────────────────────────────────────

export const WorkKind = z.enum(["issue", "build", "enhancement"]);
export type WorkKind = z.infer<typeof WorkKind>;

/** One row of Build's lists and boards. */
export const WorkItem = z.object({
  kind: WorkKind,
  id: z.string(),
  /** Issues: the client's issue number. */
  number: z.number().int().nullable(),
  title: z.string(),
  description: z.string(),
  /** The client it is for; null for an enhancement (or a build for everyone). */
  client: Named.nullable(),
  /** Enhancements: how many clients asked. */
  asks: z.number().int(),
  agent: Named.nullable(),
  /** The stage in its pipeline (issues, builds, enh). */
  stage: z.string(),
  stageName: z.string(),
  standing: Standing,
  statusLine: z.string(),
  urgency: WorkUrgency.nullable(),
  /** Fix by, promised or decide by (ISO date or instant). */
  due: z.string().nullable(),
  /** Place in the work order; null when done. */
  rank: z.number().int().nullable(),
  why: z.string().nullable(),
  moved: z.boolean(),
  manual: z.boolean(),
  held: z.boolean(),
  /** A build from a template skips the Builder's phases (the board hides "Building"). */
  fromTemplate: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type WorkItem = z.infer<typeof WorkItem>;

/** A KPI box over a list. */
export const WorkKpi = z.object({
  label: z.string(),
  value: z.string(),
  note: z.string(),
  tone: z.enum(["risk", "signal", "positive"]).nullable(),
  href: z.string().nullable(),
});
export type WorkKpi = z.infer<typeof WorkKpi>;

export const HoldView = z.object({
  agent: Named,
  client: Named,
  since: z.string(),
  by: z.enum(["reggie", "operator"]),
  reason: z.string(),
  issueId: z.string(),
  issueNumber: z.number().int().nullable(),
  /** What waits while held: proposed writes and messages awaiting approval since the hold. */
  held: z.object({ writes: z.number().int(), messages: z.number().int() }),
});
export type HoldView = z.infer<typeof HoldView>;

// ── Issues ───────────────────────────────────────────────────────────────────────────────────────

export const IssueMessageView = z.object({
  id: z.string(),
  at: z.string(),
  audience: z.enum(["client", "operator"]),
  who: z.object({
    kind: z.enum(["client", "operator", "reggie", "system"]),
    name: z.string(),
  }),
  text: z.string(),
  sources: z.array(z.string()),
});
export type IssueMessageView = z.infer<typeof IssueMessageView>;

export const IssueEventView = z.object({
  id: z.string(),
  kind: z.string(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  reason: z.string().nullable(),
  actor: z.enum(["operator", "reggie", "client", "system"]),
  who: z.string().nullable(),
  at: z.string(),
});
export type IssueEventView = z.infer<typeof IssueEventView>;

export const WorkTodoLine = z.object({
  id: z.string(),
  owner: z.enum(["operator", "reggie", "client"]),
  title: z.string(),
  dueAt: z.string().nullable(),
  state: z.string(),
});
export type WorkTodoLine = z.infer<typeof WorkTodoLine>;

export const OpsIssue = z.object({
  id: z.string(),
  number: z.number().int(),
  client: Named,
  title: z.string(),
  description: z.string(),
  urgency: WorkUrgency,
  stage: WorkIssueStage,
  causeKind: WorkCauseKind.nullable(),
  agent: Named.nullable(),
  source: WorkIssueSource,
  raisedBy: z.object({ id: z.string().nullable(), name: z.string() }).nullable(),
  waitingOn: WorkWaitingOn,
  statusLine: z.string(),
  stuck: z.boolean(),
  standing: Standing,
  replyBy: z.string().nullable(),
  fixBy: z.string().nullable(),
  firstReplyAt: z.string().nullable(),
  reggieRead: ReggieRead.nullable(),
  askId: z.string().nullable(),
  createdAt: z.string(),
  stageAt: z.string(),
  closedAt: z.string().nullable(),
});
export type OpsIssue = z.infer<typeof OpsIssue>;

export const IssueDetail = z.object({
  issue: OpsIssue,
  messages: z.array(IssueMessageView),
  events: z.array(IssueEventView),
  todos: z.array(WorkTodoLine),
  hold: HoldView.nullable(),
});
export type IssueDetail = z.infer<typeof IssueDetail>;

export const NewIssue = z.strictObject({
  clientId: Id,
  title: z.string().trim().min(1).max(ISSUE_TITLE_MAX),
  text: z.string().trim().max(ISSUE_TEXT_MAX).default(""),
  urgency: WorkUrgency.optional(),
  agentId: Id.optional(),
});

export const UpdateIssue = z.strictObject({
  title: z.string().trim().min(1).max(ISSUE_TITLE_MAX).optional(),
  urgency: WorkUrgency.optional(),
  stage: WorkIssueStage.exclude(["closed"]).optional(),
  causeKind: WorkCauseKind.nullable().optional(),
  agentId: Id.nullable().optional(),
  waitingOn: WorkWaitingOn.optional(),
  statusLine: z.string().trim().max(120).optional(),
  stuck: z.boolean().optional(),
  fixBy: z.iso.datetime().nullable().optional(),
  reason: z.string().trim().max(500).optional(),
});

export const IssueMessage = z.strictObject({
  text: z.string().trim().min(1).max(ISSUE_TEXT_MAX),
  audience: z.enum(["client", "operator"]),
  sources: z.array(Id).max(50).optional(),
});

// ── Asks and enhancements ────────────────────────────────────────────────────────────────────────

export const AskView = z.object({
  id: z.string(),
  client: Named,
  title: z.string(),
  text: z.string(),
  status: z.enum(["open", "grouped", "told", "closed"]),
  agent: Named.nullable(),
  enhancementId: z.string().nullable(),
  issueId: z.string().nullable(),
  raisedBy: z.string().nullable(),
  createdAt: z.string(),
});
export type AskView = z.infer<typeof AskView>;

export const OpsEnhancement = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  stage: WorkEnhancementStage,
  decision: WorkEnhancementDecision.nullable(),
  decisionNote: z.string().nullable(),
  decideBy: z.string().nullable(),
  waitingOn: WorkWaitingOn,
  statusLine: z.string(),
  stuck: z.boolean(),
  standing: Standing,
  asks: z.number().int(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  shippedAt: z.string().nullable(),
});
export type OpsEnhancement = z.infer<typeof OpsEnhancement>;

export const EnhancementDetail = z.object({
  enhancement: OpsEnhancement,
  asks: z.array(AskView),
});
export type EnhancementDetail = z.infer<typeof EnhancementDetail>;

export const UpdateEnhancement = z.strictObject({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(4000).optional(),
  stage: WorkEnhancementStage.exclude(["shipped"]).optional(),
  decideBy: IsoDate.nullable().optional(),
  waitingOn: WorkWaitingOn.optional(),
  statusLine: z.string().trim().max(120).optional(),
  stuck: z.boolean().optional(),
});

// ── The portal: Requests ─────────────────────────────────────────────────────────────────────────

/** How a request stands, in the client's words (core `PORTAL_REQUEST_STATUS_WORDS`). */
export const PortalRequestState = z.enum(["on_it", "waiting_on_you", "fixed", "closed"]);
export type PortalRequestState = z.infer<typeof PortalRequestState>;

/** A client's request as it sees it: a problem (an issue) or an idea (an ask). */
export const PortalWorkRequest = z.object({
  id: z.string(),
  kind: z.enum(["problem", "idea"]),
  /** Problems: the client's own number. */
  number: z.number().int().nullable(),
  title: z.string(),
  text: z.string(),
  state: PortalRequestState,
  service: Named.nullable(),
  raisedBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** The client is asked to confirm the fix (it is at Verify). */
  canConfirm: z.boolean(),
  canReopen: z.boolean(),
});
export type PortalWorkRequest = z.infer<typeof PortalWorkRequest>;

export const PortalWorkMessage = z.object({
  id: z.string(),
  at: z.string(),
  /** `you`: the person reading; `client`: someone else at the client; `lead`: Mezonas. */
  from: z.enum(["you", "client", "lead"]),
  name: z.string(),
  text: z.string(),
});
export type PortalWorkMessage = z.infer<typeof PortalWorkMessage>;

export const PortalWorkRequestDetail = z.object({
  request: PortalWorkRequest,
  messages: z.array(PortalWorkMessage),
});
export type PortalWorkRequestDetail = z.infer<typeof PortalWorkRequestDetail>;

export const PortalRequirementsForm = z.object({
  itemId: z.string(),
  title: z.string(),
  dueOn: z.string().nullable(),
  fields: z.array(RequirementField),
  answers: RequirementAnswers,
  answered: z.number().int(),
  total: z.number().int(),
  submitted: z.boolean(),
});
export type PortalRequirementsForm = z.infer<typeof PortalRequirementsForm>;

export const workRoutes = {
  // ── Back office ────────────────────────────────────────────────────────────────────────────────
  opsWork: defineRoute({
    method: "GET",
    path: "/api/ops/work",
    auth: "session",
    roles: OPS,
    summary:
      "Build's work in the work order: open issues, builds and enhancements, and the last 30 days' done",
    query: z.object({ tab: BuildTab.default("all"), client: Id.optional() }),
    response: z.object({
      items: z.array(WorkItem),
      kpis: z.array(WorkKpi),
      holds: z.array(HoldView),
      counts: z.object({
        all: z.number().int(),
        issues: z.number().int(),
        builds: z.number().int(),
        enh: z.number().int(),
      }),
    }),
  }),
  opsHolds: defineRoute({
    method: "GET",
    path: "/api/ops/holds",
    auth: "session",
    roles: OPS,
    summary: "Client agents on a safety hold, with what waits",
    response: z.object({ holds: z.array(HoldView) }),
  }),
  opsCreateIssue: defineRoute({
    method: "POST",
    path: "/api/ops/issues",
    auth: "session",
    roles: OPS,
    summary: "Open an issue for a client",
    body: NewIssue,
    response: IssueDetail,
  }),
  opsIssue: defineRoute({
    method: "GET",
    path: "/api/ops/issues/:id",
    auth: "session",
    roles: OPS,
    summary:
      "An issue: its conversation (notes included), history, to-dos, Reggie's read and the hold",
    params: IdParams,
    response: IssueDetail,
  }),
  opsUpdateIssue: defineRoute({
    method: "PATCH",
    path: "/api/ops/issues/:id",
    auth: "session",
    roles: OPS,
    summary:
      "Change an issue's stage, urgency, cause, agent or standing (each change is in its history)",
    params: IdParams,
    body: UpdateIssue,
    response: IssueDetail,
  }),
  opsIssueMessage: defineRoute({
    method: "POST",
    path: "/api/ops/issues/:id/messages",
    auth: "session",
    roles: OPS,
    summary: "Reply to the client on an issue, or add an internal note",
    params: IdParams,
    body: IssueMessage,
    response: IssueDetail,
  }),
  opsCloseIssue: defineRoute({
    method: "POST",
    path: "/api/ops/issues/:id/close",
    auth: "session",
    roles: OPS,
    summary: "Close an issue (a note is needed when it isn't a bug)",
    params: IdParams,
    body: z.strictObject({ note: z.string().trim().max(2000).optional() }),
    response: IssueDetail,
  }),
  opsReopenIssue: defineRoute({
    method: "POST",
    path: "/api/ops/issues/:id/reopen",
    auth: "session",
    roles: OPS,
    summary: "Reopen a closed issue",
    params: IdParams,
    response: IssueDetail,
  }),
  opsConvertIssue: defineRoute({
    method: "POST",
    path: "/api/ops/issues/:id/convert",
    auth: "session",
    roles: OPS,
    summary: "It isn't a fault: make it an ask and close the issue",
    params: IdParams,
    body: z.strictObject({ to: z.literal("ask") }),
    response: z.object({ askId: z.string() }),
  }),
  opsHoldAgent: defineRoute({
    method: "POST",
    path: "/api/ops/agents/:id/hold",
    auth: "session",
    roles: OPS,
    summary: "Put a client agent on a safety hold for an issue: its writes and messages wait",
    params: IdParams,
    body: z.strictObject({ issueId: Id, reason: Reason }),
    response: HoldView,
  }),
  opsReleaseAgent: defineRoute({
    method: "POST",
    path: "/api/ops/agents/:id/release",
    auth: "session",
    roles: OPS,
    summary: "Release a client agent's safety hold (a person only, with a reason)",
    params: IdParams,
    body: z.strictObject({ reason: Reason }),
    response: z.object({ hold: HoldView.nullable() }),
  }),
  opsMoveWork: defineRoute({
    method: "POST",
    path: "/api/ops/work/move",
    auth: "session",
    roles: OPS,
    summary: "Move an item in the work order (null puts it back in Reggie's order)",
    body: z.strictObject({
      kind: WorkKind,
      id: Id,
      position: z.number().int().min(1).max(1000).nullable(),
    }),
    response: z.object({ ok: z.literal(true) }),
  }),
  opsAsks: defineRoute({
    method: "GET",
    path: "/api/ops/asks",
    auth: "session",
    roles: OPS,
    summary: "Clients' asks (ideas and changes), newest first",
    query: z.object({
      client: Id.optional(),
      status: z.enum(["open", "grouped", "told", "closed"]).optional(),
    }),
    response: z.object({ asks: z.array(AskView) }),
  }),
  opsCreateAsk: defineRoute({
    method: "POST",
    path: "/api/ops/asks",
    auth: "session",
    roles: OPS,
    summary: "Record a client's ask",
    body: z.strictObject({
      clientId: Id,
      title: z.string().trim().min(1).max(200),
      text: z.string().trim().min(1).max(4000),
      agentId: Id.optional(),
    }),
    response: AskView,
  }),
  opsGroupAsk: defineRoute({
    method: "POST",
    path: "/api/ops/asks/:id/group",
    auth: "session",
    roles: OPS,
    summary: "Group an ask under an enhancement (an existing one or a new one)",
    params: IdParams,
    body: z
      .strictObject({
        enhancementId: Id.optional(),
        newEnhancement: z.strictObject({ title: z.string().trim().min(1).max(200) }).optional(),
      })
      .refine((b) => !!b.enhancementId !== !!b.newEnhancement, {
        message: "name an enhancement or a new one",
      }),
    response: EnhancementDetail,
  }),
  opsCreateEnhancement: defineRoute({
    method: "POST",
    path: "/api/ops/enhancements",
    auth: "session",
    roles: OPS,
    summary: "Capture an enhancement",
    body: z.strictObject({
      title: z.string().trim().min(1).max(200),
      description: z.string().trim().max(4000).optional(),
    }),
    response: EnhancementDetail,
  }),
  opsEnhancement: defineRoute({
    method: "GET",
    path: "/api/ops/enhancements/:id",
    auth: "session",
    roles: OPS,
    summary: "An enhancement and the asks it groups (of the clients served)",
    params: IdParams,
    response: EnhancementDetail,
  }),
  opsUpdateEnhancement: defineRoute({
    method: "PATCH",
    path: "/api/ops/enhancements/:id",
    auth: "session",
    roles: OPS,
    summary: "Change an enhancement",
    params: IdParams,
    body: UpdateEnhancement,
    response: EnhancementDetail,
  }),
  opsDecideEnhancement: defineRoute({
    method: "POST",
    path: "/api/ops/enhancements/:id/decide",
    auth: "session",
    roles: OPS,
    summary: "Decide an enhancement: do it, later, no or sell it",
    params: IdParams,
    body: z.strictObject({
      decision: WorkEnhancementDecision,
      note: z.string().trim().max(2000).default(""),
    }),
    response: EnhancementDetail,
  }),
  opsToldEnhancement: defineRoute({
    method: "POST",
    path: "/api/ops/enhancements/:id/told",
    auth: "session",
    roles: OPS,
    summary: "Shipped: tell everyone who asked, on each ask's conversation",
    params: IdParams,
    body: z.strictObject({ note: z.string().trim().min(1).max(2000) }),
    response: EnhancementDetail,
  }),
  opsSendRequirements: defineRoute({
    method: "POST",
    path: "/api/ops/builds/:id/requirements",
    auth: "session",
    roles: OPS,
    summary: "Send the build's requirements request to the client admin's Desk",
    params: IdParams,
    body: z.strictObject({
      fields: z.array(RequirementField).min(1).max(60).optional(),
      dueOn: IsoDate,
      toUserId: Id,
    }),
    response: z.object({ buildId: z.string(), itemId: z.string() }),
  }),

  // ── Portal ─────────────────────────────────────────────────────────────────────────────────────
  portalWorkRequests: defineRoute({
    method: "GET",
    path: "/api/issues",
    auth: "session",
    roles: CLIENT,
    summary: "Your requests: problems and ideas, newest first (client users: the ones they raised)",
    query: z.object({ status: z.enum(["open", "closed", "all"]).default("all") }),
    response: z.object({ items: z.array(PortalWorkRequest) }),
  }),
  portalWorkRequest: defineRoute({
    method: "GET",
    path: "/api/issues/:id",
    auth: "session",
    roles: CLIENT,
    summary: "A request and its conversation with your Mezonas lead",
    params: IdParams,
    response: PortalWorkRequestDetail,
  }),
  portalWorkRequestMessage: defineRoute({
    method: "POST",
    path: "/api/issues/:id/messages",
    auth: "session",
    roles: CLIENT,
    summary: "Write to your Mezonas lead on a request",
    params: IdParams,
    body: z.strictObject({ text: z.string().trim().min(1).max(ISSUE_TEXT_MAX) }),
    response: PortalWorkRequestDetail,
  }),
  portalConfirmFix: defineRoute({
    method: "POST",
    path: "/api/issues/:id/confirm",
    auth: "session",
    roles: CLIENT,
    summary: "Confirm the fix works",
    params: IdParams,
    response: PortalWorkRequestDetail,
  }),
  portalReopenRequest: defineRoute({
    method: "POST",
    path: "/api/issues/:id/reopen",
    auth: "session",
    roles: CLIENT,
    summary: "It's still happening: open the request again",
    params: IdParams,
    response: PortalWorkRequestDetail,
  }),
  portalRequirements: defineRoute({
    method: "GET",
    path: "/api/requirements/:id",
    auth: "session",
    roles: CLIENT,
    summary: "A requirements request on your Desk: its questions and your answers so far",
    params: IdParams,
    response: PortalRequirementsForm,
  }),
  portalSaveRequirements: defineRoute({
    method: "PUT",
    path: "/api/requirements/:id",
    auth: "session",
    roles: ["client_admin"],
    summary: "Save your answers as a draft",
    params: IdParams,
    body: z.strictObject({ answers: RequirementAnswers }),
    response: PortalRequirementsForm,
  }),
  portalSubmitRequirements: defineRoute({
    method: "POST",
    path: "/api/requirements/:id/submit",
    auth: "session",
    roles: ["client_admin"],
    summary: "Send your answers",
    params: IdParams,
    body: z.strictObject({ answers: RequirementAnswers }),
    response: PortalRequirementsForm,
  }),
} as const;
