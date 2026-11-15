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
  BuildStatus,
  FitGap,
  QaCheck,
  QaCheckId,
  QaRecord,
  TestPlan,
} from "../build/build";
import { isUuid } from "../ids";
import { AgentStage } from "../lifecycle/stage";
import { defineRoute } from "./contract";

const Id = z.string().refine((v) => isUuid(v), "not an id");
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
  createdAt: z.string(),
});
export type BuildMessageView = z.infer<typeof BuildMessageView>;

export const BuildItemRef = z.object({
  testCaseId: z.string().optional(),
  runId: z.string().optional(),
  actionId: z.string().optional(),
  /** A skill's build made for this one. */
  buildId: z.string().optional(),
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
    }),
  ),
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
});
export type BuildDetail = z.infer<typeof BuildDetail>;

export const StartBuild = z.strictObject({
  kind: BuildKind,
  title: z.string().trim().min(1).max(200),
  /** For one client (a client agent, that client's skill); else for everyone. */
  clientId: Id.optional(),
});

export const UpdateBuild = z.strictObject({
  title: z.string().trim().min(1).max(200).optional(),
  brief: Brief.optional(),
  fitgap: FitGap.optional(),
  testPlan: TestPlan.optional(),
});

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
    summary: "Your words in the build's conversation, and the Builder's answer for the phase",
    params: IdParams,
    body: z.strictObject({ text: z.string().trim().min(1).max(BUILD_TEXT_MAX) }),
    response: BuildDetail,
  }),
  opsMoveBuild: defineRoute({
    method: "POST",
    path: "/api/ops/builds/:id/phase",
    auth: "session",
    roles: OPS,
    summary:
      "Move a build to the next phase when its gate passes (a client test may move on with a reason), or back to any earlier phase with a reason",
    params: IdParams,
    body: z.strictObject({ to: BuildPhase, reason: Reason.optional() }),
    response: BuildDetail,
  }),
  opsDraftBuild: defineRoute({
    method: "POST",
    path: "/api/ops/builds/:id/draft",
    auth: "session",
    roles: OPS,
    summary:
      "Agree the direction: the Builder drafts the agent (or starts the skill) from the brief and fit-gap",
    params: IdParams,
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
    summary: "Run the draft's test cases; each failing required case becomes an open item",
    params: IdParams,
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
