// The Dev queue's routes (docs/plan.md §1.125): requests for code filed by the Builder, an
// operator or a Claude Code session, triaged, accepted, claimed, built and shipped back to the
// builds waiting on them. Operator only. The MCP tools call these same routes.

import { z } from "zod";
import {
  CloseReason,
  CODE_REQUEST_MOVES,
  CodeRequestActor,
  CodeRequestCreator,
  CodeRequestDecision,
  CodeRequestEventKind,
  CodeRequestKind,
  CodeRequestSpec,
  CodeRequestStatus,
  OpenQuestion,
  PartType,
  ReuseCheck,
  ReuseVerdict,
} from "../build/code-requests";
import { isUuid } from "../ids";
import { defineRoute } from "./contract";

const Id = z.string().refine((v) => isUuid(v), "not an id");
const OPS = ["operator"] as const;
/** A request by its id or its number ("DQ-012", "12"). */
const RequestRef = z.string().trim().min(1).max(64);
const RefParams = z.object({ id: RequestRef });

export const MoveStateView = z.object({ allowed: z.boolean(), reason: z.string() });

export const CodeRequestSummary = z.object({
  id: z.string(),
  number: z.number().int(),
  /** DQ-012. */
  ref: z.string(),
  title: z.string(),
  kind: CodeRequestKind,
  status: CodeRequestStatus,
  /** In progress with a PR: shown as "In review". */
  inReview: z.boolean(),
  decision: CodeRequestDecision.nullable(),
  owner: z.string().nullable(),
  claimedBy: z.object({ id: z.string(), name: z.string() }).nullable(),
  prUrl: z.string().nullable(),
  expectedPartId: z.string().nullable(),
  shippedPartId: z.string().nullable(),
  shippedStagingAt: z.string().nullable(),
  shippedProductionAt: z.string().nullable(),
  builds: z.array(z.object({ id: z.string(), title: z.string() })),
  /** The reuse check found a part that may already do it: suggested decision `exists`. */
  coveredBy: z.object({ partId: z.string(), name: z.string() }).nullable(),
  createdBy: CodeRequestCreator,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CodeRequestSummary = z.infer<typeof CodeRequestSummary>;

export const CodeRequestLinkView = z.object({
  id: z.string(),
  buildId: z.string(),
  buildTitle: z.string(),
  workflowId: z.string().nullable(),
  stepId: z.string().nullable(),
  issueId: z.string().nullable(),
  issueTitle: z.string().nullable(),
  issueOpen: z.boolean().nullable(),
  createdAt: z.string(),
});
export type CodeRequestLinkView = z.infer<typeof CodeRequestLinkView>;

export const CodeRequestEventView = z.object({
  id: z.string(),
  at: z.string(),
  actor: CodeRequestActor,
  userName: z.string().nullable(),
  kind: CodeRequestEventKind,
  body: z.record(z.string(), z.unknown()),
});
export type CodeRequestEventView = z.infer<typeof CodeRequestEventView>;

export const CodeRequestDetail = CodeRequestSummary.extend({
  spec: CodeRequestSpec,
  openQuestions: z.array(OpenQuestion),
  reuseCheck: ReuseCheck.nullable(),
  decisionReason: z.string().nullable(),
  otherUses: z.array(z.string()),
  oneOffApprovedAt: z.string().nullable(),
  mergedInto: z.object({ id: z.string(), ref: z.string() }).nullable(),
  closeReason: CloseReason.nullable(),
  closedAt: z.string().nullable(),
  links: z.array(CodeRequestLinkView),
  events: z.array(CodeRequestEventView),
  /** Each move: allowed, or why not (core's `requestMoves`). */
  moves: z.record(z.enum(CODE_REQUEST_MOVES), MoveStateView),
});
export type CodeRequestDetail = z.infer<typeof CodeRequestDetail>;

/** A verdict on a candidate, as the operator or the Builder gives it. */
export const CandidateVerdict = z.strictObject({
  partId: z.string().min(1).max(300),
  verdict: ReuseVerdict,
  reason: z.string().trim().max(1000).default(""),
  missing: z.string().trim().max(1000).default(""),
});
export type CandidateVerdict = z.infer<typeof CandidateVerdict>;

export const CodeRequestLinkInput = z.strictObject({
  buildId: Id,
  workflowId: z.string().trim().min(1).max(100).optional(),
  stepId: z.string().trim().min(1).max(100).optional(),
  /** The build's open item of kind `gap` it settles. */
  issueId: Id.optional(),
});
export type CodeRequestLinkInput = z.infer<typeof CodeRequestLinkInput>;

export const NewCodeRequest = z.strictObject({
  title: z.string().trim().min(1).max(200),
  kind: CodeRequestKind,
  spec: CodeRequestSpec.default(CodeRequestSpec.parse({})),
  openQuestions: z.array(OpenQuestion).max(20).default([]),
  decision: CodeRequestDecision.optional(),
  decisionReason: z.string().trim().max(2000).optional(),
  otherUses: z.array(z.string().trim().min(1).max(300)).max(20).default([]),
  /** What the filer considered, with its verdicts: kept on the candidates the check finds. */
  considered: z.array(CandidateVerdict).max(20).default([]),
  link: CodeRequestLinkInput.optional(),
  createdBy: CodeRequestCreator.default("operator"),
  owner: z.string().trim().min(1).max(200).optional(),
});
export type NewCodeRequest = z.infer<typeof NewCodeRequest>;

export const FiledCodeRequest = z.object({
  /** The new request; null when an open one asks for the same capability. */
  request: CodeRequestDetail.nullable(),
  /** That open request: link to it instead (proposed, never merged on its own). */
  duplicate: z.object({ id: z.string(), ref: z.string(), title: z.string() }).nullable(),
});
export type FiledCodeRequest = z.infer<typeof FiledCodeRequest>;

export const UpdateCodeRequest = z.strictObject({
  title: z.string().trim().min(1).max(200).optional(),
  kind: CodeRequestKind.optional(),
  spec: CodeRequestSpec.optional(),
  openQuestions: z.array(OpenQuestion).max(20).optional(),
  decision: CodeRequestDecision.nullable().optional(),
  decisionReason: z.string().trim().max(2000).nullable().optional(),
  otherUses: z.array(z.string().trim().min(1).max(300)).max(20).optional(),
  verdicts: z.array(CandidateVerdict).max(20).optional(),
  owner: z.string().trim().min(1).max(200).nullable().optional(),
});

export const CatalogHit = z.object({
  partType: PartType,
  partId: z.string(),
  name: z.string(),
  description: z.string(),
  inputs: z.array(z.string()),
  outputs: z.array(z.string()),
  score: z.number(),
  ref: z.string().nullable(),
});

/** A step that requires code (docs/plan.md §1.125), and its request as the Dev queue has it now. */
export const StepCodeRequest = z.object({
  buildId: z.string(),
  workflowId: z.string().nullable(),
  stepId: z.string().nullable(),
  request: z.object({
    id: z.string(),
    ref: z.string(),
    title: z.string(),
    status: CodeRequestStatus,
    inReview: z.boolean(),
    shippedStagingAt: z.string().nullable(),
  }),
});
export type StepCodeRequest = z.infer<typeof StepCodeRequest>;

/** "Requires code · DQ-012 · In review": a step's status from its request. */
export function stepCodeStatus(r: StepCodeRequest["request"]): string {
  const words: Record<StepCodeRequest["request"]["status"], string> = {
    triage: "Triage",
    accepted: "Accepted",
    in_progress: "In progress",
    shipped: "Shipped",
    closed: "Closed",
  };
  return `Requires code · ${r.ref} · ${r.inReview ? "In review" : words[r.status]}`;
}

const ListQuery = z.object({
  /** A status, `open` (not shipped or closed, the default) or `all`. */
  status: z.union([CodeRequestStatus, z.enum(["open", "all"])]).default("open"),
  kind: CodeRequestKind.optional(),
  build: Id.optional(),
  /** Only requests shipped to this environment. */
  environment: z.enum(["staging", "production"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const codeRequestRoutes = {
  opsCodeRequests: defineRoute({
    method: "GET",
    path: "/api/ops/code-requests",
    auth: "session",
    roles: OPS,
    summary: "The Dev queue: requests for code, newest first, with the open count",
    query: ListQuery,
    response: z.object({
      requests: z.array(CodeRequestSummary),
      openCount: z.number().int(),
    }),
  }),
  opsFileCodeRequest: defineRoute({
    method: "POST",
    path: "/api/ops/code-requests",
    auth: "session",
    roles: OPS,
    summary:
      "File a request for code: the reuse check runs first; an open request for the same capability is returned instead",
    body: NewCodeRequest,
    response: FiledCodeRequest,
  }),
  opsCodeRequest: defineRoute({
    method: "GET",
    path: "/api/ops/code-requests/:id",
    auth: "session",
    roles: OPS,
    summary: "A request (by id or DQ number): spec, questions, reuse check, links, events, moves",
    params: RefParams,
    response: CodeRequestDetail,
  }),
  opsUpdateCodeRequest: defineRoute({
    method: "PATCH",
    path: "/api/ops/code-requests/:id",
    auth: "session",
    roles: OPS,
    summary:
      "Triage a request: its spec, questions, decision and reason, and verdicts on candidates",
    params: RefParams,
    body: UpdateCodeRequest,
    response: CodeRequestDetail,
  }),
  opsCodeRequestReuse: defineRoute({
    method: "POST",
    path: "/api/ops/code-requests/:id/reuse",
    auth: "session",
    roles: OPS,
    summary: "Run the reuse check again",
    params: RefParams,
    response: CodeRequestDetail,
  }),
  opsAcceptCodeRequest: defineRoute({
    method: "POST",
    path: "/api/ops/code-requests/:id/accept",
    auth: "session",
    roles: OPS,
    summary: "Accept a triaged request (guarded); every operator and linked build is told",
    params: RefParams,
    response: CodeRequestDetail,
  }),
  opsApproveOneOff: defineRoute({
    method: "POST",
    path: "/api/ops/code-requests/:id/approve-one-off",
    auth: "session",
    roles: OPS,
    summary: "Approve a request decided as a one-off",
    params: RefParams,
    response: CodeRequestDetail,
  }),
  opsClaimCodeRequest: defineRoute({
    method: "POST",
    path: "/api/ops/code-requests/:id/claim",
    auth: "session",
    roles: OPS,
    summary: "Claim an accepted request (atomic; a claim lapses 2 hours after its last event)",
    params: RefParams,
    response: CodeRequestDetail,
  }),
  opsCodeRequestPr: defineRoute({
    method: "POST",
    path: "/api/ops/code-requests/:id/pr",
    auth: "session",
    roles: OPS,
    summary: "Attach the PR and the catalog part it adds",
    params: RefParams,
    body: z.strictObject({
      prUrl: z.string().trim().min(1).max(300),
      expectedPartId: z.string().trim().min(1).max(300),
    }),
    response: CodeRequestDetail,
  }),
  opsCloseCodeRequest: defineRoute({
    method: "POST",
    path: "/api/ops/code-requests/:id/close",
    auth: "session",
    roles: OPS,
    summary: "Close a request with a reason; merged names the request it merged into",
    params: RefParams,
    body: z.strictObject({
      reason: CloseReason,
      mergedInto: RequestRef.optional(),
      note: z.string().trim().max(2000).optional(),
    }),
    response: CodeRequestDetail,
  }),
  opsCodeRequestNote: defineRoute({
    method: "POST",
    path: "/api/ops/code-requests/:id/notes",
    auth: "session",
    roles: OPS,
    summary: "Add a note to a request's timeline",
    params: RefParams,
    body: z.strictObject({ body: z.string().trim().min(1).max(4000) }),
    response: CodeRequestDetail,
  }),
  opsLinkCodeRequest: defineRoute({
    method: "POST",
    path: "/api/ops/code-requests/:id/links",
    auth: "session",
    roles: OPS,
    summary: "Link a build (and its step and gap item) to a request; a merge records it as one",
    params: RefParams,
    body: CodeRequestLinkInput.extend({ merge: z.boolean().default(false) }),
    response: CodeRequestDetail,
  }),
  opsCatalogSearch: defineRoute({
    method: "GET",
    path: "/api/ops/catalog/search",
    auth: "session",
    roles: OPS,
    summary:
      "The reuse check's search: catalog parts and requests by text and input and output names",
    query: z.object({
      query: z.string().trim().min(1).max(500),
      inputs: z.string().max(1000).optional(),
      outputs: z.string().max(1000).optional(),
      kind: CodeRequestKind.optional(),
      limit: z.coerce.number().int().min(1).max(20).default(8),
    }),
    response: z.object({ hits: z.array(CatalogHit) }),
  }),
  opsAgentCodeRequests: defineRoute({
    method: "GET",
    path: "/api/ops/agents/:id/code-requests",
    auth: "session",
    roles: OPS,
    summary:
      "The steps of an agent's draft that require code, each with its Dev queue request and live status",
    params: z.object({ id: Id }),
    response: z.object({ steps: z.array(StepCodeRequest) }),
  }),
} as const;
