// v0.12 W2-C (M23): the test bench against a real database as cs_worker, with the FakeModel.
// A skill's 8 cases run on its draft and report 7 of 8 with precision and cost; the publish gate
// refuses until the 8th passes; turning the gate off needs a reason; a client's case never runs in
// another client or in a shared gate; a template case is a test run that writes nothing; the lab
// lists templates with behind counts and test results.

import { auditEvent, externalAction, tenant, testCaseResult } from "@countersign/db";
import { FakeModel, type FakeTurn, type LlmRequest } from "@countersign/llm";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  OPERATOR,
  OTHER_OPERATOR,
  testBundle,
} from "./api.test-helper";
import { MemoryTestSuiteJobs } from "./testbench/instances";
import { executeSuite, type SuiteParams } from "./testbench/suite";

const jobs = new MemoryTestSuiteJobs();
const h = await createApiHarness({ testSuites: jobs });
afterAll(() => h?.close());

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const skillDef = (instructions: string) => ({
  schemaVersion: 1,
  id: "custom:same-item",
  name: "Same item",
  description: "Says whether two descriptions name the same item",
  category: "matching",
  // Skill model (2026-11-10): new operator skills are AI skills (agent mode retired).
  mode: "task",
  model: { id: "claude-haiku-5-5" },
  instructions,
  tools: [],
  input: {
    type: "object",
    properties: { n: { type: "number" }, a: { type: "string" }, b: { type: "string" } },
    required: ["n"],
  },
  output: {
    type: "object",
    properties: { verdict: { type: "string" } },
    required: ["verdict"],
  },
});

/** Case n expects "same" except case 7. */
const expectedVerdict = (n: number) => (n === 7 ? "different" : "same");

/** The model answers each case right, except those in `wrong`. */
function model(cases: number, wrong: ReadonlySet<number> = new Set()): FakeModel {
  const turn = (req: LlmRequest): FakeTurn => {
    const first = req.messages[0]?.content;
    const text = typeof first === "string" ? first : JSON.stringify(first);
    const n = Number(/\\?"n\\?": (\d+)/.exec(text)?.[1]);
    const right = expectedVerdict(n);
    const verdict = wrong.has(n) ? (right === "same" ? "different" : "same") : right;
    return { toolUse: { name: "finish", input: { verdict } } };
  };
  return new FakeModel(Array.from({ length: cases }, () => turn));
}

async function runSuite(params: SuiteParams, transport: FakeModel) {
  const H = h as ApiHarness;
  return executeSuite({ db: H.db, platform: H.platform, transport }, params, {
    do: (_name, fn) => fn(),
  });
}

describe.skipIf(!h)("test bench (M23)", () => {
  const H = h as ApiHarness;
  let skillId = "";
  let v1 = "";
  const caseIds: string[] = [];
  let clientCase = "";

  beforeAll(async () => {
    const created = await H.call(OPERATOR, "POST", "/api/ops/skills", {
      definition: skillDef("Compare the two descriptions."),
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    skillId = j(created.json).skill.id;
    v1 = j(created.json).version.id;
    for (let n = 1; n <= 8; n++) {
      const c = await H.call(OPERATOR, "POST", "/api/ops/tests", {
        targetKind: "skill",
        targetId: skillId,
        name: `Pair ${n}`,
        input: { n, a: `Oak board ${n}`, b: `Oak bd ${n}` },
        expected: { verdict: expectedVerdict(n) },
        matcher: { kind: "label", label: { field: "verdict", positive: "same" } },
      });
      expect(c.status, JSON.stringify(c.json)).toBe(200);
      expect(j(c.json).case).toMatchObject({ clientId: null, required: true, source: "manual" });
      caseIds.push(j(c.json).case.id);
    }
    // A case made from client A's records: A's only.
    const mine = await H.call(OPERATOR, "POST", "/api/ops/tests", {
      targetKind: "skill",
      targetId: skillId,
      clientId: H.A.tenantId,
      name: "A's real pair",
      input: { n: 9, a: "A's walnut", b: "A's walnut slab" },
      expected: { verdict: "same" },
      source: "run",
    });
    expect(mine.status, JSON.stringify(mine.json)).toBe(200);
    clientCase = j(mine.json).case.id;
    const on = await H.call(OPERATOR, "PUT", `/api/ops/skills/${skillId}/require-tests`, {
      required: true,
    });
    expect(on.status, JSON.stringify(on.json)).toBe(200);
  });

  it("refuses to publish before the version is tested", async () => {
    const res = await H.call(OPERATOR, "POST", `/api/ops/skills/${skillId}/versions/${v1}/publish`);
    expect(res.status).toBe(422);
    expect(j(res.json).error.code).toBe("tests_failing");
  });

  it("runs 8 cases on the draft: 7 of 8, with precision and cost; the gate holds", async () => {
    const started = await H.call(OPERATOR, "POST", "/api/ops/tests/run", {
      targetKind: "skill",
      targetId: skillId,
      versionId: v1,
    });
    expect(started.status, JSON.stringify(started.json)).toBe(200);
    expect(j(started.json).suiteRun).toMatchObject({ status: "running", total: 8, version: 1 });
    const params = jobs.started.at(-1) as SuiteParams;
    // The shared suite holds the shared cases only: never client A's.
    expect(params.tenantId).toBeNull();
    expect(params.caseIds).toEqual(caseIds);
    expect(params.caseIds).not.toContain(clientCase);

    await runSuite(params, model(8, new Set([8])));
    const res = await H.call(OPERATOR, "GET", `/api/ops/tests/runs/${params.suiteRunId}`);
    expect(res.status).toBe(200);
    const suite = j(res.json).suiteRun;
    expect(suite).toMatchObject({ status: "done", total: 8, passed: 7, failed: 1 });
    expect(suite.metrics.passRate).toBe(0.875);
    // Case 8 expects "same" and got "different": a miss, not a false positive, so every "same"
    // it said was right (6 of 6).
    expect(suite.metrics.precision).toBe(1);
    expect(Number(suite.metrics.costPerCase)).toBeGreaterThan(0);
    expect(Number(suite.costUsd)).toBeGreaterThan(0);
    const failing = j(res.json).results.filter((r: { status: string }) => r.status !== "pass");
    expect(failing).toHaveLength(1);
    expect(failing[0]).toMatchObject({ name: "Pair 8", got: { verdict: "different" } });

    const publish = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/skills/${skillId}/versions/${v1}/publish`,
    );
    expect(publish.status).toBe(422);
    expect(j(publish.json).error).toMatchObject({
      code: "tests_failing",
      details: { failing: [caseIds[7]] },
    });
  });

  it("results are insert-only", async () => {
    const [r] = await H.db.select().from(testCaseResult).limit(1);
    await expect(
      H.t.db
        .update(testCaseResult)
        .set({ status: "pass" })
        .where(eq(testCaseResult.id, r?.id ?? "")),
    ).rejects.toThrow();
  });

  it("allows the publish once the fixed version passes every required case", async () => {
    const saved = await H.call(OPERATOR, "POST", `/api/ops/skills/${skillId}/versions`, {
      definition: skillDef("Compare the two descriptions; sizes in the name matter."),
    });
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    const v2 = j(saved.json).version.id;
    await H.call(OPERATOR, "POST", "/api/ops/tests/run", {
      targetKind: "skill",
      targetId: skillId,
      versionId: v2,
    });
    await runSuite(jobs.started.at(-1) as SuiteParams, model(8));
    const ok = await H.call(OPERATOR, "POST", `/api/ops/skills/${skillId}/versions/${v2}/publish`);
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(j(ok.json).version.status).toBe("live");
    // v1's own run still failed: the gate is per version.
    const v1Again = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/skills/${skillId}/versions/${v1}/publish`,
    );
    expect(v1Again.status).toBe(422);
  });

  it("a client's case runs only in its client, and never gates a shared skill", async () => {
    const started = await H.call(OPERATOR, "POST", "/api/ops/tests/run", {
      targetKind: "skill",
      targetId: skillId,
      versionId: v1,
      clientId: H.A.tenantId,
    });
    expect(started.status, JSON.stringify(started.json)).toBe(200);
    const params = jobs.started.at(-1) as SuiteParams;
    expect(params.tenantId).toBe(H.A.tenantId);
    expect(params.caseIds).toEqual([clientCase]);
    // A's case fails here; the shared gate never sees it.
    await runSuite(params, model(1, new Set([9])));
    const run = await H.call(OPERATOR, "GET", `/api/ops/tests/runs/${params.suiteRunId}`);
    expect(j(run.json).suiteRun).toMatchObject({ clientId: H.A.tenantId, passed: 0, failed: 1 });

    // An operator who doesn't serve A sees neither the case nor the run, and can't run it.
    const other = await H.call(OTHER_OPERATOR, "GET", `/api/ops/tests?target=skill:${skillId}`);
    expect(other.status).toBe(200);
    expect(j(other.json).cases.map((c: { id: string }) => c.id)).not.toContain(clientCase);
    expect(j(other.json).runs.every((r: { clientId: string | null }) => r.clientId === null)).toBe(
      true,
    );
    const peek = await H.call(OTHER_OPERATOR, "GET", `/api/ops/tests/runs/${params.suiteRunId}`);
    expect(peek.status).toBe(404);
    const theirs = await H.call(OTHER_OPERATOR, "POST", "/api/ops/tests/run", {
      targetKind: "skill",
      targetId: skillId,
      versionId: v1,
      clientId: H.A.tenantId,
    });
    expect(theirs.status).toBe(404);
    // Client B has no cases: nothing of A's runs there.
    const inB = await H.call(OPERATOR, "POST", "/api/ops/tests/run", {
      targetKind: "skill",
      targetId: skillId,
      versionId: v1,
      clientId: H.B.tenantId,
    });
    expect(inB.status).toBe(422);
    expect(j(inB.json).error.code).toBe("no_test_cases");
    // Clients never reach the bench.
    const portal = await H.call(admin("a"), "GET", `/api/ops/tests?target=skill:${skillId}`);
    expect(portal.status).toBe(403);
  });

  it("turning the gate off needs a reason, which is logged", async () => {
    const bare = await H.call(OPERATOR, "PUT", `/api/ops/skills/${skillId}/require-tests`, {
      required: false,
    });
    expect(bare.status).toBe(400);
    const off = await H.call(OPERATOR, "PUT", `/api/ops/skills/${skillId}/require-tests`, {
      required: false,
      reason: "Rewriting the cases this week",
    });
    expect(off.status, JSON.stringify(off.json)).toBe(200);
    const rows = await H.t.db
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.action, "skill.require_tests.off"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.target).toMatchObject({ skillId, reason: "Rewriting the cases this week" });
    // Off: an untested version publishes.
    const list = await H.call(OPERATOR, "GET", `/api/ops/tests?target=skill:${skillId}`);
    expect(j(list.json).requireTests).toBe(false);
    const ok = await H.call(OPERATOR, "POST", `/api/ops/skills/${skillId}/versions/${v1}/publish`);
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
  });

  it("archives a case instead of deleting it", async () => {
    const res = await H.call(OPERATOR, "DELETE", `/api/ops/tests/${caseIds[0]}`);
    expect(res.status).toBe(200);
    expect(j(res.json).case.archivedAt).not.toBeNull();
    const list = await H.call(OPERATOR, "GET", `/api/ops/tests?target=skill:${skillId}`);
    expect(j(list.json).cases.map((c: { id: string }) => c.id)).not.toContain(caseIds[0]);
  });

  describe("templates and the lab", () => {
    let templateId = "";
    let templateV1 = "";

    beforeAll(async () => {
      await H.t.db
        .update(tenant)
        .set({
          settings: {
            connectors_offered: ["testkit"],
            approvals: { undoSeconds: 0 },
            sandbox: true,
          },
        })
        .where(eq(tenant.id, H.B.tenantId));
      const created = await H.call(OPERATOR, "POST", "/api/ops/templates", {
        slug: "bench-clerk",
        bundle: testBundle(),
      });
      expect(created.status, JSON.stringify(created.json)).toBe(200);
      templateId = j(created.json).agent.id;
      templateV1 = j(created.json).version.id;
    });

    it("runs a template case as a test run in the Sandbox that writes nothing", async () => {
      const c = await H.call(OPERATOR, "POST", "/api/ops/tests", {
        targetKind: "template",
        targetId: templateId,
        name: "Fix r1",
        input: { workflow: "fix-record", payload: {} },
        expected: { update: { wouldHaveDone: true, before: { amount: "20.00" } } },
        matcher: { kind: "subset" },
      });
      expect(c.status, JSON.stringify(c.json)).toBe(200);
      const bad = await H.call(OPERATOR, "POST", "/api/ops/tests", {
        targetKind: "template",
        targetId: templateId,
        name: "No workflow",
        input: { payload: {} },
        expected: { update: {} },
      });
      expect(bad.status).toBe(422);

      const started = await H.call(OPERATOR, "POST", "/api/ops/tests/run", {
        targetKind: "template",
        targetId: templateId,
        versionId: templateV1,
      });
      expect(started.status, JSON.stringify(started.json)).toBe(200);
      const params = jobs.started.at(-1) as SuiteParams;
      expect(params.runTenantId).toBe(H.B.tenantId);
      await runSuite(params, new FakeModel());
      const res = await H.call(OPERATOR, "GET", `/api/ops/tests/runs/${params.suiteRunId}`);
      const [result] = j(res.json).results;
      expect(result.runId).toBeTruthy();
      expect(result.got).toHaveProperty("update");
      expect(j(res.json).suiteRun.total).toBe(1);
      // The write was recorded as proposed and never executed; the record is unchanged.
      const actions = await H.t.db
        .select()
        .from(externalAction)
        .where(
          and(eq(externalAction.runId, result.runId), eq(externalAction.tenantId, H.B.tenantId)),
        );
      expect(actions.every((a) => a.status !== "done" && a.status !== "executing")).toBe(true);
      expect(H.backend.get(H.B.connectionId, "r1")?.amount).toBe("20.00");
      // The step's output matched; the person step timed out at once (nothing waits on the bench).
      expect(result.status).toBe("pass");
      expect(result.diff.steps).toEqual([
        { id: "update", status: "succeeded" },
        { id: "confirm", status: "failed" },
      ]);
      expect(j(res.json).suiteRun).toMatchObject({ status: "done", passed: 1 });
    });

    it("lists templates with clients behind and test results", async () => {
      await H.call(
        OPERATOR,
        "POST",
        `/api/ops/agents/${templateId}/versions/${templateV1}/publish`,
      );
      const forked = await H.call(OPERATOR, "POST", `/api/ops/templates/${templateId}/fork`, {
        clientId: H.A.tenantId,
        serviceName: "Records",
      });
      expect(forked.status, JSON.stringify(forked.json)).toBe(200);
      const v2 = await H.call(OPERATOR, "POST", `/api/ops/agents/${templateId}/versions`, {
        bundle: testBundle("Records clerk v2"),
        changeNote: "renamed",
      });
      expect(v2.status, JSON.stringify(v2.json)).toBe(200);
      const pub = await H.call(
        OPERATOR,
        "POST",
        `/api/ops/agents/${templateId}/versions/${j(v2.json).version.id}/publish`,
        { releaseNote: "Renamed" },
      );
      expect(pub.status, JSON.stringify(pub.json)).toBe(200);

      const lab = await H.call(OPERATOR, "GET", "/api/ops/lab");
      expect(lab.status, JSON.stringify(lab.json)).toBe(200);
      const entry = j(lab.json).published.find(
        (t: { agent: { id: string } }) => t.agent.id === templateId,
      );
      expect(entry).toMatchObject({
        agent: { liveVersion: 2, latestVersion: 2 },
        clients: 1,
        behind: 1,
        maxBehind: 1,
        tests: { cases: 1, live: null },
      });
      // v1's suite run is not the live version's.
      expect(entry.tests.latest).toBeNull();
      const other = await H.call(OTHER_OPERATOR, "GET", "/api/ops/lab");
      const theirs = j(other.json).published.find(
        (t: { agent: { id: string } }) => t.agent.id === templateId,
      );
      expect(theirs).toMatchObject({ clients: 0, behind: 0 });
      expect((await H.call(admin("a"), "GET", "/api/ops/lab")).status).toBe(403);
    });
  });
});
