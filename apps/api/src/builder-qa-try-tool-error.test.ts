// A POC try whose run stopped because the client's tool refused it (an expired sign-in, a
// disconnected connection) says it stopped, never offers "Right or wrong?", and is never kept as a
// required case whose "right answer" is the tool's error. From the Builder QA (BUILDER_QA.md,
// PR #441): INTEG-1.

import type { BuildDetail } from "@countersign/core";
import { build, connection, tenant } from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type ApiHarness, createApiHarness, OPERATOR, testBundle } from "./api.test-helper";
import { MemoryTestSuiteJobs } from "./testbench/instances";
import { executeSuite, type SuiteParams } from "./testbench/suite";

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const jobs = new MemoryTestSuiteJobs();
const h = await createApiHarness({ llm: new FakeModel(), testSuites: jobs });
afterAll(() => h?.close());

describe.skipIf(!h)("a try whose run the client's tool refused", () => {
  const H = h as ApiHarness;
  let buildId = "";

  const runLatest = async () => {
    const params = jobs.started.at(-1) as SuiteParams;
    await executeSuite({ db: H.db, platform: H.platform, transport: new FakeModel() }, params, {
      do: (_name, fn) => fn(),
    });
  };

  beforeAll(async () => {
    // Client B is the Sandbox, as in build-tries.test.ts.
    await H.t.db
      .update(tenant)
      .set({
        settings: { connectors_offered: ["testkit"], approvals: { undoSeconds: 0 }, sandbox: true },
      })
      .where(eq(tenant.id, H.B.tenantId));
    const created = await H.call(OPERATOR, "POST", "/api/ops/templates", {
      slug: "integ-try-clerk",
      bundle: testBundle(),
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    const templateId = (created.json as { agent: { id: string } }).agent.id;
    const [row] = await H.t.db
      .insert(build)
      .values({ kind: "agent", title: "Integ try clerk", phase: "poc", agentId: templateId })
      .returning();
    buildId = row?.id as string;
  });

  // INTEG-1
  it("says a try stopped when the tool's sign-in expired, and refuses to keep it", async () => {
    await H.t.db
      .update(connection)
      .set({ status: "connected" })
      .where(eq(connection.id, H.B.connectionId));
    // The provider answers 401: the access token expired (QBO's, Gmail's, ...).
    const expired = vi.spyOn(H.backend, "get").mockImplementation(() => {
      throw Object.assign(new Error("401 Unauthorized: the access token expired"), {
        status: 401,
      });
    });
    try {
      const started = await H.call(OPERATOR, "POST", `/api/ops/builds/${buildId}/tries`, {
        input: { note: "an example" },
      });
      expect(started.status, JSON.stringify(started.json)).toBe(200);
      await runLatest();
    } finally {
      expired.mockRestore();
    }
    const res = await H.call(OPERATOR, "GET", `/api/ops/builds/${buildId}`);
    const tried = (res.json as BuildDetail).poc?.tries[0];
    expect(tried).toBeTruthy();
    // The run failed at the write step (run.status failed, step failed, key ...:unauthorized),
    // so the try stopped: it says why, and nobody is asked "Right or wrong?" about an error.
    expect.soft(tried?.status, JSON.stringify(tried)).toBe("error");
    expect.soft(tried?.why ?? "").toMatch(/expired|401|sign|connect/i);
    // Kept, the tool's error would become the expected answer of a required case: the POC gate
    // would then pass on a draft that never reached the client's tool.
    const keep = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/builds/${buildId}/tries/${tried?.caseId}`,
      {
        decide: "keep",
      },
    );
    const kept = keep.json as BuildDetail;
    expect(keep.status, `kept as a required case: ${JSON.stringify(kept.poc)}`).toBe(409);
  });
  // INTEG-1
  it("says a try stopped when the Sandbox's connection is disconnected", async () => {
    await H.t.db
      .update(connection)
      .set({ status: "disconnected" })
      .where(eq(connection.id, H.B.connectionId));
    try {
      const started = await H.call(OPERATOR, "POST", `/api/ops/builds/${buildId}/tries`, {
        input: { note: "another example" },
      });
      expect(started.status, JSON.stringify(started.json)).toBe(200);
      await runLatest();
    } finally {
      await H.t.db
        .update(connection)
        .set({ status: "connected" })
        .where(eq(connection.id, H.B.connectionId));
    }
    const res = await H.call(OPERATOR, "GET", `/api/ops/builds/${buildId}`);
    const tried = (res.json as BuildDetail).poc?.tries[0];
    expect(tried?.status, JSON.stringify(tried)).toBe("error");
  });

  // INTEG-1
  it("never passes the POC gate on a kept try whose run the tool refused", async () => {
    const expired = vi.spyOn(H.backend, "get").mockImplementation(() => {
      throw new Error("401 Unauthorized: the access token expired");
    });
    try {
      await H.call(OPERATOR, "POST", `/api/ops/builds/${buildId}/tries`, {
        input: { note: "a third example" },
      });
      await runLatest();
      const b = (await H.call(OPERATOR, "GET", `/api/ops/builds/${buildId}`)).json as BuildDetail;
      const [newest, ...older] = b.poc?.tries ?? [];
      for (const t of older) {
        await H.call(OPERATOR, "POST", `/api/ops/builds/${buildId}/tries/${t.caseId}`, {
          decide: "discard",
        });
      }
      // Whatever the route allows to be kept, as the operator would press "Right, keep it".
      await H.call(OPERATOR, "POST", `/api/ops/builds/${buildId}/tries/${newest?.caseId}`, {
        decide: "keep",
      });
      // The build's own test run, with the sign-in still expired.
      const run = await H.call(OPERATOR, "POST", `/api/ops/builds/${buildId}/run-tests`);
      // Refused (no case could be kept) is fine: then nothing passes either.
      if (run.status === 200) await runLatest();
    } finally {
      expired.mockRestore();
    }
    const b = (await H.call(OPERATOR, "GET", `/api/ops/builds/${buildId}`)).json as BuildDetail;
    // Every run of the draft failed at the client's tool: the POC can't count as passed.
    expect(
      { passed: b.poc?.passed, detail: b.poc?.detail, gate: b.gate.reasons },
      "the POC gate after a suite where every run failed with 401",
    ).toMatchObject({ passed: false });
  });
});
