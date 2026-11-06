import { z } from "zod";
import { isUuid } from "../ids";
import {
  Fixture,
  Matcher,
  TestCaseFields,
  TestCaseSource,
  TestResultStatus,
  TestSuiteStatus,
  TestTargetKind,
} from "../testbench/case";
import { defineRoute } from "./contract";

// v0.12 W2-C: the test bench, skill tests and the agent lab (ARCHITECTURE §9.10, §14 "Tests";
// docs/plan.md §1.46). Every route here is the back office's: cases, results and costs never
// reach the portal (invariant 11). A client's cases show only to operators who serve that client.

const Id = z.string().refine((v) => isUuid(v), "not an id");
const IdParams = z.object({ id: Id });
const OPS = ["operator"] as const;

/** `skill:<id>` or `template:<id>`: what a list of cases is for. */
export const TestTargetRef = z
  .string()
  .regex(/^(skill|template):[0-9a-fA-F-]{36}$/, "skill:<id> or template:<id>")
  .transform((v) => {
    const at = v.indexOf(":");
    return { kind: v.slice(0, at) as TestTargetKind, id: v.slice(at + 1).toLowerCase() };
  })
  .refine((t) => isUuid(t.id), "not an id");

export const TestCaseView = z.object({
  id: z.string(),
  /** The client whose records the case was made from; null for a shared (synthetic) case. */
  clientId: z.string().nullable(),
  clientName: z.string().nullable(),
  targetKind: TestTargetKind,
  targetId: z.string(),
  name: z.string(),
  input: z.unknown(),
  fixtures: z.array(Fixture),
  expected: z.unknown(),
  matcher: Matcher,
  required: z.boolean(),
  source: TestCaseSource,
  sourceRef: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  archivedAt: z.string().nullable(),
});
export type TestCaseView = z.infer<typeof TestCaseView>;

export const LabelPrecisionView = z.object({
  field: z.string(),
  positive: z.union([z.string(), z.number(), z.boolean()]),
  truePositives: z.number().int(),
  falsePositives: z.number().int(),
  precision: z.number().nullable(),
});

export const SuiteMetricsView = z.object({
  passRate: z.number(),
  precision: z.number().nullable().optional(),
  labels: z.array(LabelPrecisionView).optional(),
  costPerCase: z.string(),
});

export const SuiteRunView = z.object({
  id: z.string(),
  clientId: z.string().nullable(),
  targetKind: TestTargetKind,
  targetId: z.string(),
  versionId: z.string(),
  /** The version's number (skill or template), when it still resolves. */
  version: z.number().int().nullable(),
  status: TestSuiteStatus,
  total: z.number().int(),
  passed: z.number().int(),
  failed: z.number().int(),
  metrics: SuiteMetricsView.nullable(),
  costUsd: z.string(),
  startedBy: z.string().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type SuiteRunView = z.infer<typeof SuiteRunView>;

export const CaseResultView = z.object({
  id: z.string(),
  testCaseId: z.string(),
  name: z.string(),
  required: z.boolean(),
  status: TestResultStatus,
  got: z.unknown(),
  diff: z.unknown(),
  costUsd: z.string(),
  /** A template case's test run. */
  runId: z.string().nullable(),
  createdAt: z.string(),
});
export type CaseResultView = z.infer<typeof CaseResultView>;

export const CreateTestCaseBody = TestCaseFields.extend({
  targetKind: TestTargetKind,
  targetId: Id,
  /** The client whose records the case comes from; absent: a shared case (synthetic data). */
  clientId: Id.optional(),
  source: TestCaseSource.default("manual"),
  sourceRef: z.string().trim().min(1).max(200).optional(),
});

export const UpdateTestCaseBody = z
  .strictObject({
    name: TestCaseFields.shape.name.optional(),
    input: z.unknown().optional(),
    fixtures: TestCaseFields.shape.fixtures.optional(),
    expected: z.unknown().optional(),
    matcher: Matcher.optional(),
    required: z.boolean().optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), "nothing to change");

export const RunTestsBody = z.strictObject({
  targetKind: TestTargetKind,
  targetId: Id,
  /** The skill or template version under test. */
  versionId: Id,
  /**
   * Runs that client's cases, in its scope; absent: the shared cases (an operator transaction
   * naming no client). A client's own skill always runs in its client.
   */
  clientId: Id.optional(),
});

/** Turning the gate off needs a reason (logged); turning it on doesn't. */
export const RequireTestsBody = z
  .strictObject({
    required: z.boolean(),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .refine((b) => b.required || b.reason !== undefined, {
    message: "say why the tests are no longer required",
    path: ["reason"],
  });

/** A suite run as the lab shows it next to a version. */
export const LabTestSummary = z.object({
  cases: z.number().int(),
  live: SuiteRunView.nullable(),
  latest: SuiteRunView.nullable(),
});

export const LabAgent = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  kind: z.enum(["template", "client"]),
  liveVersion: z.number().int().nullable(),
  latestVersion: z.number().int().nullable(),
  latestVersionId: z.string().nullable(),
  liveVersionId: z.string().nullable(),
});

export const LabTemplate = z.object({
  agent: LabAgent,
  /** Client agents forked from it, in the clients this operator serves (test copies aside). */
  clients: z.number().int(),
  /** Of those, linked ones based on an older version than its live one. */
  behind: z.number().int(),
  /** The most versions any of them is behind. */
  maxBehind: z.number().int(),
  tests: LabTestSummary,
});
export type LabTemplate = z.infer<typeof LabTemplate>;

export const LabClientAgent = z.object({
  agent: LabAgent,
  client: z.object({ id: z.string(), name: z.string() }),
});

export const LabResponse = z.object({
  /** Templates with a published version. */
  published: z.array(LabTemplate),
  /** Templates never published (drafts). */
  drafts: z.array(LabTemplate),
  /** Client agents made for one client, from no template. */
  clientOnly: z.array(LabClientAgent),
});
export type LabResponse = z.infer<typeof LabResponse>;

export const testbenchRoutes = {
  opsTests: defineRoute({
    method: "GET",
    path: "/api/ops/tests",
    auth: "session",
    roles: OPS,
    summary:
      "A skill's or template's test cases (shared and the served clients'), its recent suite runs and whether publishing needs them",
    query: z.object({
      target: TestTargetRef,
      client: Id.optional(),
      archived: z.enum(["true", "false"]).optional(),
    }),
    response: z.object({
      cases: z.array(TestCaseView),
      runs: z.array(SuiteRunView),
      /** Skills only: publishing needs the required cases to pass. */
      requireTests: z.boolean().nullable(),
    }),
  }),
  opsCreateTest: defineRoute({
    method: "POST",
    path: "/api/ops/tests",
    auth: "session",
    roles: OPS,
    summary:
      "Add a test case: shared (synthetic data) or a client's (its records; runs and shows in that client only)",
    body: CreateTestCaseBody,
    response: z.object({ case: TestCaseView }),
  }),
  opsUpdateTest: defineRoute({
    method: "PUT",
    path: "/api/ops/tests/:id",
    auth: "session",
    roles: OPS,
    summary: "Change a test case (its scope and target stay)",
    params: IdParams,
    body: UpdateTestCaseBody,
    response: z.object({ case: TestCaseView }),
  }),
  opsArchiveTest: defineRoute({
    method: "DELETE",
    path: "/api/ops/tests/:id",
    auth: "session",
    roles: OPS,
    summary: "Archive a test case: it no longer runs; its past results stay",
    params: IdParams,
    response: z.object({ case: TestCaseView }),
  }),
  opsRunTests: defineRoute({
    method: "POST",
    path: "/api/ops/tests/run",
    auth: "session",
    roles: OPS,
    summary:
      "Run every case of a skill or template version (never writes): pass rate, precision on label fields, cost per case",
    body: RunTestsBody,
    response: z.object({ suiteRun: SuiteRunView }),
  }),
  opsTestSuiteRun: defineRoute({
    method: "GET",
    path: "/api/ops/tests/runs/:id",
    auth: "session",
    roles: OPS,
    summary: "A suite run with each case's result: what it got and how it differed",
    params: IdParams,
    response: z.object({ suiteRun: SuiteRunView, results: z.array(CaseResultView) }),
  }),
  opsSkillRequireTests: defineRoute({
    method: "PUT",
    path: "/api/ops/skills/:id/require-tests",
    auth: "session",
    roles: OPS,
    summary:
      "Require a skill's tests to pass before it publishes; turning it off needs a reason (logged)",
    params: IdParams,
    body: RequireTestsBody,
    response: z.object({ skillId: z.string(), requireTests: z.boolean() }),
  }),
  opsLab: defineRoute({
    method: "GET",
    path: "/api/ops/lab",
    auth: "session",
    roles: OPS,
    summary:
      "The agent lab: templates (published and drafts) with their clients, versions behind and test results; client-only agents",
    response: LabResponse,
  }),
} as const;
