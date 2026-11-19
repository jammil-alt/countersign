// Builds (docs/plan.md §1.108): the board, a build with its conversation, open items and the
// phase's work, and the moves between phases. Operator only.

import { z } from "zod";
import {
  Brief,
  BuildItemKind,
  BuildItemOwner,
  BuildItemState,
  BuildKind,
  BuildPhase,
  BuildProposal,
  BuildStatus,
  DecisionOperatorStatus,
  FitGap,
  FitReason,
  FitVerdict,
  ProposalState,
  QaCheck,
  QaCheckId,
  QaRecord,
  TestPlan,
} from "../build/build";
import { isUuid } from "../ids";
import { AgentStage } from "../lifecycle/stage";
import { WorkBuildStage, WorkWaitingOn } from "../work/pipelines";
import { RequirementsRequest } from "../work/requirements";
import { Standing } from "../work/standing";
import { defineRoute } from "./contract";
import { StepCodeRequest } from "./step-code-request";

const Id = z.string().refine((v) => isUuid(v), "not an id");
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date such as 2026-12-24");
export const BuildPath = z.enum(["new", "template"]);
export type BuildPath = z.infer<typeof BuildPath>;
/** What started a build or a deal (docs/plan.md §1.124). */
export const WorkOriginKind = z.enum(["deal", "ask", "enhancement", "issue"]);
export type WorkOriginKind = z.infer<typeof WorkOriginKind>;
const OPS = ["operator"] as const;
const IdParams = z.object({ id: Id });
const ItemParams = z.object({ id: Id, itemId: Id });

export const BUILD_TEXT_MAX = 4000;
const Reason = z.string().trim().min(1).max(500);

export const BuildSummary = z.object({
  id: z.string(),
  kind: BuildKind,
  title: z.string(),
  /** The client it is for (a client agent or that client's skill); null: everyone. */
  client: z.object({ id: z.string(), name: z.string() }).nullable(),
  phase: BuildPhase,
  status: BuildStatus,
  agentId: z.string().nullable(),
  skillId: z.string().nullable(),
  /** The copy under test, and its client. */
  testAgentId: z.string().nullable(),
  testClient: z.object({ id: z.string(), name: z.string() }).nullable(),
  openItems: z.number().int(),
  /** Open items the client has. */
  waitingOnClient: z.number().int(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  phaseAt: z.string(),
  // docs/plan.md §1.124: the build as back office work.
  /** `new`: built through the phases; `template`: forked from a template for the client. */
  path: BuildPath,
  templateId: z.string().nullable(),
  promisedOn: z.string().nullable(),
  origin: z.object({ kind: WorkOriginKind, id: z.string() }).nullable(),
  requirements: RequirementsRequest.nullable(),
  /** Where it stands in Build's Agent builds pipeline: derived, never stored. */
  pipelineStage: WorkBuildStage,
  standing: Standing,
  waitingOn: WorkWaitingOn,
  statusLine: z.string(),
  stuck: z.boolean(),
});
export type BuildSummary = z.infer<typeof BuildSummary>;

export const BuildMessageView = z.object({
  id: z.string(),
  phase: BuildPhase,
  role: z.enum(["operator", "builder"]),
  text: z.string(),
  /** Answers the Builder offered to pick from. */
  chips: z.array(z.string()),
  /** What the turn changed, one line each ("Brief: data in"). */
  changes: z.array(z.string()),
  /** The Builder's turn failed: this message says so, nothing changed, and it can be retried. */
  failed: z.boolean().optional(),
  /** The issue it is about (`buildIssues`' key): the thread it belongs to. */
  about: z.string().optional(),
  /** The Builder's proposed change, and what the operator decided. */
  proposal: BuildProposal.extend({
    state: ProposalState,
    /** Agreed: what was done. Undone: what was put back. */
    result: z.string().optional(),
    /** Offered while agreed and its opposite is exact (an item's state). */
    undo: z.boolean().optional(),
    /** Agreed and made, but the issue it was for is still open (a draft edit that didn't fix it). */
    unresolved: z.boolean().optional(),
    /** A draft edit's changes to the steps, one line each, for "What changed". */
    changes: z.array(z.string()).optional(),
  }).optional(),
  createdAt: z.string(),
});
export type BuildMessageView = z.infer<typeof BuildMessageView>;

export const BuildItemRef = z.object({
  testCaseId: z.string().optional(),
  runId: z.string().optional(),
  actionId: z.string().optional(),
  /** A skill's build made for this one. */
  buildId: z.string().optional(),
  /** The Dev queue's request it waits on (docs/plan.md §1.125), and its number (DQ-012). */
  codeRequestId: z.string().optional(),
  codeRequestRef: z.string().optional(),
});

export const BuildItemView = z.object({
  id: z.string(),
  phase: BuildPhase,
  kind: BuildItemKind,
  title: z.string(),
  detail: z.string(),
  owner: BuildItemOwner,
  state: BuildItemState,
  stepId: z.string().nullable(),
  ref: BuildItemRef,
  /** What made it once, e.g. `fit:<row id>` for a fit-gap row. */
  key: z.string().nullable(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
});
export type BuildItemView = z.infer<typeof BuildItemView>;

/** One of the draft's own problems, read live from its latest version (never stored). */
export const DraftProblem = z.object({
  key: z.string(),
  code: z.string(),
  title: z.string(),
  stepId: z.string().nullable(),
  workflow: z.string().nullable(),
  /** Feedback (2026-11-16): the step and workflow by the names the operator reads. */
  stepName: z.string().nullable().optional(),
  workflowName: z.string().nullable().optional(),
});
export type DraftProblem = z.infer<typeof DraftProblem>;

export const BuildDraftView = z.object({
  agentId: z.string().nullable(),
  skillId: z.string().nullable(),
  /** A skill build's Builder conversation. */
  sessionId: z.string().nullable(),
  versionId: z.string().nullable(),
  version: z.number().int().nullable(),
  live: z.boolean(),
  problems: z.array(DraftProblem),
});
export type BuildDraftView = z.infer<typeof BuildDraftView>;

/**
 * builder-plan.md B1: one example the operator tried in the POC test (a document or an input), run
 * once as a test (never writes) and not kept yet. What the agent would do is `output`: a template's
 * step outputs by step id, a skill's output.
 */
export const BuildTryView = z.object({
  caseId: z.string(),
  name: z.string(),
  /** `running` until its test finishes; `error` when it couldn't finish (`why` says why). */
  status: z.enum(["running", "done", "error"]),
  output: z.unknown(),
  why: z.string().nullable(),
  /** A template's test run. */
  runId: z.string().nullable(),
  /** Tried on the draft's latest version (else: try it again after a fix). */
  current: z.boolean(),
  at: z.string(),
});
export type BuildTryView = z.infer<typeof BuildTryView>;

/** Most tries the build page shows (newest first). */
export const BUILD_TRIES_SHOWN = 3;

export const BuildPocView = z.object({
  /** Suite runs of test cases (a template or skill), or test runs (a client agent). */
  mode: z.enum(["suite", "test_runs"]),
  cases: z.number().int(),
  required: z.number().int(),
  latest: z
    .object({
      id: z.string(),
      status: z.string(),
      total: z.number().int(),
      passed: z.number().int(),
      failed: z.number().int(),
      at: z.string(),
      /** Of the draft's latest version. */
      current: z.boolean(),
    })
    .nullable(),
  failures: z.array(
    z.object({
      caseId: z.string(),
      name: z.string(),
      status: z.string(),
      runId: z.string().nullable(),
      /** builder-plan.md B0: why it fails: its error, or the first fields that differed. */
      why: z.string().nullable().default(null),
    }),
  ),
  /** builder-plan.md B1: examples tried and not kept yet, newest first (suite mode only). */
  tries: z.array(BuildTryView).default([]),
  /** A template's try document is uploaded to this Sandbox client (where its tests run). */
  trySandbox: z.object({ id: z.string(), name: z.string() }).nullable().default(null),
  testRuns: z
    .object({
      total: z.number().int(),
      succeeded: z.number().int(),
      latestRunId: z.string().nullable(),
    })
    .nullable(),
  passed: z.boolean(),
  detail: z.string(),
});
export type BuildPocView = z.infer<typeof BuildPocView>;

export const BuildClientTestView = z.object({
  client: z.object({ id: z.string(), name: z.string() }),
  agentId: z.string(),
  stage: AgentStage.nullable(),
  trial: z
    .object({
      days: z.number().int(),
      minDays: z.number().int(),
      runs: z.number().int(),
      minRuns: z.number().int(),
      ready: z.boolean(),
    })
    .nullable(),
  writes: z.object({
    signed: z.number().int(),
    rejected: z.number().int(),
    waiting: z.number().int(),
  }),
  /** The client's rejected writes, newest first, with the reason it gave. */
  rejections: z.array(
    z.object({
      actionId: z.string(),
      runId: z.string().nullable(),
      tool: z.string(),
      reason: z.string().nullable(),
      at: z.string(),
    }),
  ),
});
export type BuildClientTestView = z.infer<typeof BuildClientTestView>;

export const BuildEventView = z.object({
  id: z.string(),
  kind: z.enum(["phase", "record", "qa", "decision"]),
  from: BuildPhase.nullable(),
  to: BuildPhase.nullable(),
  reason: z.string().nullable(),
  who: z.string().nullable(),
  at: z.string(),
});
export type BuildEventView = z.infer<typeof BuildEventView>;

export const BuildDetail = z.object({
  build: BuildSummary.extend({
    brief: Brief,
    fitgap: FitGap,
    testPlan: TestPlan,
    qa: QaRecord,
  }),
  phases: z.array(
    z.object({ phase: BuildPhase, label: z.string(), state: z.enum(["done", "current", "todo"]) }),
  ),
  /** The next phase, and why the build can't move to it yet (empty: it can). */
  gate: z.object({ next: BuildPhase.nullable(), reasons: z.array(z.string()) }),
  messages: z.array(BuildMessageView),
  items: z.array(BuildItemView),
  draft: BuildDraftView.nullable(),
  poc: BuildPocView.nullable(),
  clientTest: BuildClientTestView.nullable(),
  qaChecks: z.array(QaCheck),
  events: z.array(BuildEventView),
  /** docs/plan.md §1.125: the steps that require code, with their Dev queue request's status. */
  codeRequests: z.array(StepCodeRequest).optional(),
});
export type BuildDetail = z.infer<typeof BuildDetail>;

export const StartBuild = z
  .strictObject({
    kind: BuildKind,
    title: z.string().trim().min(1).max(200),
    /** For one client (a client agent, that client's skill); else for everyone. */
    clientId: Id.optional(),
    // docs/plan.md §1.124: from a template, what started it, and the date promised.
    path: BuildPath.optional(),
    templateId: Id.optional(),
    origin: z.strictObject({ kind: WorkOriginKind, id: Id }).optional(),
    promisedOn: IsoDate.optional(),
  })
  .refine((b) => b.path !== "template" || (!!b.clientId && !!b.templateId && b.kind === "agent"), {
    message: "a build from a template is an agent build for a client, with its template",
    path: ["templateId"],
  });

export const UpdateBuild = z.strictObject({
  title: z.string().trim().min(1).max(200).optional(),
  brief: Brief.optional(),
  fitgap: FitGap.optional(),
  testPlan: TestPlan.optional(),
  // docs/plan.md §1.124: moving a promised date is the operator's.
  promisedOn: IsoDate.nullable().optional(),
  waitingOn: WorkWaitingOn.optional(),
  statusLine: z.string().trim().max(120).optional(),
  stuck: z.boolean().optional(),
});

/** An item made from a failed case or a rejected write is made once (its key is the case or write). */
export const NewBuildItem = z.strictObject({
  title: z.string().trim().min(1).max(300),
  detail: z.string().trim().max(2000).optional(),
  kind: BuildItemKind.optional(),
  owner: BuildItemOwner.optional(),
  stepId: z.string().min(1).max(100).optional(),
  ref: BuildItemRef.optional(),
});

export const UpdateBuildItem = z.strictObject({
  title: z.string().trim().min(1).max(300).optional(),
  detail: z.string().trim().max(2000).optional(),
  owner: BuildItemOwner.optional(),
  state: BuildItemState.optional(),
});

/**
 * A try (builder-plan.md B1): exactly one of a document uploaded to the Sandbox (a template), an
 * input (a skill's input, or a template's trigger payload), or a try to run again.
 */
export const TryBody = z
  .strictObject({
    documentId: Id.optional(),
    input: z
      .unknown()
      .refine((v) => JSON.stringify(v ?? null).length <= 100_000, "the input is too large")
      .optional(),
    /** A template's workflow, by slug (default: the one that starts on a document, or by hand). */
    workflow: z.string().trim().min(1).max(100).optional(),
    caseId: Id.optional(),
  })
  .refine(
    (b) => [b.documentId, b.input, b.caseId].filter((v) => v !== undefined).length === 1,
    "give a document, an input or a try to run again",
  );
export type TryBody = z.infer<typeof TryBody>;

export const buildRoutes = {
  opsBuilds: defineRoute({
    method: "GET",
    path: "/api/ops/builds",
    auth: "session",
    roles: OPS,
    summary: "Builds of new agents and skills, by phase, with their open items",
    query: z.object({
      status: BuildStatus.optional(),
      agent: Id.optional(),
      // docs/plan.md §1.124: the Agent lab's Drafts (the old Builder board) lists new agents; builds from templates are in
      // Build's Agent builds.
      path: z.enum(["new", "template", "all"]).default("new"),
    }),
    response: z.object({
      builds: z.array(BuildSummary),
      /** Open items across the open builds, newest first. */
      items: z.array(BuildItemView.extend({ buildId: z.string(), buildTitle: z.string() })),
    }),
  }),
  opsStartBuild: defineRoute({
    method: "POST",
    path: "/api/ops/builds",
    auth: "session",
    roles: OPS,
    summary: "Start a build of a new agent or skill, for a client or for everyone",
    body: StartBuild,
    response: BuildDetail,
  }),
  opsBuild: defineRoute({
    method: "GET",
    path: "/api/ops/builds/:id",
    auth: "session",
    roles: OPS,
    summary: "A build: its phase, records, conversation, open items, draft, tests and QA",
    params: IdParams,
    response: BuildDetail,
  }),
  opsUpdateBuild: defineRoute({
    method: "PATCH",
    path: "/api/ops/builds/:id",
    auth: "session",
    roles: OPS,
    summary: "Change a build's title, brief, fit-gap or test plan",
    params: IdParams,
    body: UpdateBuild,
    response: BuildDetail,
  }),
  opsBuildTurn: defineRoute({
    method: "POST",
    path: "/api/ops/builds/:id/turns",
    auth: "session",
    roles: OPS,
    summary:
      "Your words in the build's conversation, and the Builder's answer for the phase. Without words, the Builder's last turn is tried again: its answer to your last words, or its opening of the phase",
    params: IdParams,
    body: z.strictObject({
      text: z.string().trim().min(1).max(BUILD_TEXT_MAX).optional(),
      /** The issue the words are about (the conversation's focus). */
      about: z.string().min(1).max(160).optional(),
    }),
    response: BuildDetail,
  }),
  opsBuildProposal: defineRoute({
    method: "POST",
    path: "/api/ops/builds/:id/messages/:messageId/proposal",
    auth: "session",
    roles: OPS,
    summary:
      "Agree the Builder's proposed change (it is made, as you, through the build's own routes), decline it, or undo an agreed one",
    params: z.object({ id: Id, messageId: Id }),
    body: z.strictObject({ decide: z.enum(["agree", "decline", "undo"]) }),
    response: BuildDetail,
  }),
  opsBuildVerdict: defineRoute({
    method: "POST",
    path: "/api/ops/builds/:id/verdicts",
    auth: "session",
    roles: OPS,
    summary:
      "Change a fit-gap row's verdict, with why: to more work it changes at once; to less work it's a challenge the Builder answers against the catalog",
    params: IdParams,
    body: z.strictObject({
      rowId: z.string().min(1).max(40),
      to: FitVerdict,
      reason: FitReason,
    }),
    response: BuildDetail,
  }),
  opsMoveBuild: defineRoute({
    method: "POST",
    path: "/api/ops/builds/:id/phase",
    auth: "session",
    roles: OPS,
    summary:
      "Move a build to the next phase when its gate passes (into the draft, the Builder drafts it; a client test may move on with a reason), or back to any earlier phase with a reason",
    params: IdParams,
    body: z.strictObject({ to: BuildPhase, reason: Reason.optional() }),
    response: BuildDetail,
  }),
  opsBuildCases: defineRoute({
    method: "POST",
    path: "/api/ops/builds/:id/cases",
    auth: "session",
    roles: OPS,
    summary: "The Builder makes test cases from the test plan (a template's or skill's)",
    params: IdParams,
    response: BuildDetail.extend({ created: z.number().int() }),
  }),
  opsBuildRunTests: defineRoute({
    method: "POST",
    path: "/api/ops/builds/:id/run-tests",
    auth: "session",
    roles: OPS,
    summary: "Run the draft's test cases (the test bench's suite run); results show on the build",
    params: IdParams,
    response: BuildDetail,
  }),
  opsBuildTry: defineRoute({
    method: "POST",
    path: "/api/ops/builds/:id/tries",
    auth: "session",
    roles: OPS,
    summary:
      "Try the draft on a real example in the POC test: a Sandbox document or an input, run once as a test (never writes); with caseId, try one again on the latest version",
    params: IdParams,
    body: TryBody,
    response: BuildDetail,
  }),
  opsBuildTryDecide: defineRoute({
    method: "POST",
    path: "/api/ops/builds/:id/tries/:caseId",
    auth: "session",
    roles: OPS,
    summary:
      "Keep a try as a required test case, its result the expected answer, or discard it (archived)",
    params: z.object({ id: Id, caseId: Id }),
    body: z.strictObject({ decide: z.enum(["keep", "discard"]) }),
    response: BuildDetail,
  }),
  opsBuildClientTest: defineRoute({
    method: "POST",
    path: "/api/ops/builds/:id/client-test",
    auth: "session",
    roles: OPS,
    summary:
      "Ready to test: publish the draft, put it at the client (a template is forked there) and start its trial",
    params: IdParams,
    body: z.strictObject({ clientId: Id.optional() }),
    response: BuildDetail,
  }),
  opsBuildQa: defineRoute({
    method: "POST",
    path: "/api/ops/builds/:id/qa",
    auth: "session",
    roles: OPS,
    summary: "Accept a failing QA check with a reason, or sign QA",
    params: IdParams,
    body: z.union([
      z.strictObject({ accept: QaCheckId, reason: Reason }),
      z.strictObject({ sign: z.literal(true) }),
    ]),
    response: BuildDetail,
  }),
  opsBuildDecision: defineRoute({
    method: "POST",
    path: "/api/ops/builds/:id/decision",
    auth: "session",
    roles: OPS,
    summary:
      "Go (the build is live once its agent is) or no-go (back to a phase, the reason an open item)",
    params: IdParams,
    body: z.union([
      z.strictObject({ go: z.literal(true) }),
      z.strictObject({ go: z.literal(false), to: BuildPhase, reason: Reason }),
    ]),
    response: BuildDetail,
  }),
  opsAddBuildItem: defineRoute({
    method: "POST",
    path: "/api/ops/builds/:id/items",
    auth: "session",
    roles: OPS,
    summary: "Add an open item to a build",
    params: IdParams,
    body: NewBuildItem,
    response: BuildDetail,
  }),
  opsUpdateBuildItem: defineRoute({
    method: "PATCH",
    path: "/api/ops/builds/:id/items/:itemId",
    auth: "session",
    roles: OPS,
    summary: "Change an open item: who has it, its state, its words",
    params: ItemParams,
    body: UpdateBuildItem,
    response: BuildDetail,
  }),
  // docs/builder-plan.md §4: the operator marks one of the Builder's decisions discussed or
  // confirmed (a high-risk one must be looked at before the client test).
  opsBuildDecisionStatus: defineRoute({
    method: "PATCH",
    path: "/api/ops/builds/:id/decisions/:decisionId",
    auth: "session",
    roles: OPS,
    summary:
      "Mark one of the Builder's decisions discussed or confirmed, or back to never discussed",
    params: z.object({ id: Id, decisionId: z.string().min(1).max(40) }),
    body: z.strictObject({ status: DecisionOperatorStatus }),
    response: BuildDetail,
  }),
  opsStopBuild: defineRoute({
    method: "POST",
    path: "/api/ops/builds/:id/stop",
    auth: "session",
    roles: OPS,
    summary: "Stop a build (its draft and records stay)",
    params: IdParams,
    body: z.strictObject({ reason: Reason }),
    response: BuildDetail,
  }),
} as const;
