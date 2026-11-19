// QA (integration fragility): when the test bench's job can't be started (the TestSuiteWorkflow
// binding refuses `create`: Cloudflare Workflows down, a quota), the suite run row is left
// "running" for ever. `opsRunTests` starts the job in an after-commit task (routes/testbench.ts),
// whose failure is only reported (http.ts runAfterCommit), and nothing ever finishes the row.
// A build's try then shows "Running" for ever (TryCard offers neither Try again nor Discard while
// running), and the build's POC says "The test cases are running." for ever.

import type { BuildDetail } from "@countersign/core";
import { build, tenant, testSuiteRun } from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type ApiHarness, createApiHarness, OPERATOR, testBundle } from "../api.test-helper";
import type { TestSuiteJobs } from "../testbench/instances";

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

/** The Workflows binding refusing every `create`. */
const down: TestSuiteJobs = {
  async start() {
    throw new Error("503 Service Unavailable: workflows.create failed");
  },
};
const h = await createApiHarness({ llm: new FakeModel(), testSuites: down });
afterAll(() => h?.close());

describe.skipIf(!h)("a test bench job that can't be started (QA integ)", () => {
  const H = h as ApiHarness;
  let buildId = "";

  beforeAll(async () => {
    await H.t.db
      .update(tenant)
      .set({
        settings: { connectors_offered: ["testkit"], approvals: { undoSeconds: 0 }, sandbox: true },
      })
      .where(eq(tenant.id, H.B.tenantId));
    const created = await H.call(OPERATOR, "POST", "/api/ops/templates", {
      slug: "integ-suite-clerk",
      bundle: testBundle(),
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    const templateId = (created.json as { agent: { id: string } }).agent.id;
    const [row] = await H.t.db
      .insert(build)
      .values({ kind: "agent", title: "Integ suite clerk", phase: "poc", agentId: templateId })
      .returning();
    buildId = row?.id as string;
  });

  it("never leaves a try running for ever when its test couldn't start", async () => {
    const res = await H.call(OPERATOR, "POST", `/api/ops/builds/${buildId}/tries`, {
      input: { note: "an example" },
    });
    await H.settle();
    const detail =
      res.status === 200
        ? (res.json as BuildDetail)
        : ((await H.call(OPERATOR, "GET", `/api/ops/builds/${buildId}`)).json as BuildDetail);
    const tried = detail.poc?.tries[0];
    // Either the request says the test couldn't start, or the try says it stopped: never a try
    // that shows "Running" with no way to try it again or discard it.
    expect
      .soft(tried?.status, `answered ${res.status}: ${JSON.stringify(tried)}`)
      .not.toBe("running");
    const suites = await H.t.db
      .select({ id: testSuiteRun.id, status: testSuiteRun.status })
      .from(testSuiteRun);
    expect(
      suites.filter((s) => s.status === "running"),
      "suite runs left running with no job behind them",
    ).toEqual([]);
  });
});
