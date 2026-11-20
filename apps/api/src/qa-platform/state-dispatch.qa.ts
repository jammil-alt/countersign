// STATE lens: schedule dispatch under two cron passes at once. `startRun` checks for the run row,
// then inserts it; a second pass asking for the same tick (the 15-minute lookback asks for it every
// minute, and Cloudflare may overlap a slow pass with the next) races the first.
import { agent, run, withTenant } from "@countersign/db";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { type ApiHarness, createApiHarness, OPERATOR, testBundle } from "../api.test-helper";
import { createRunRow, startRun } from "../runs/dispatch";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const h = await createApiHarness();
afterAll(() => h?.close());

describe.skipIf(!h)("STATE: schedule start races", () => {
  const H = h as ApiHarness;

  it("STATE-1: a second cron pass starting the same schedule tick does not throw (no PK error aborting the client's pass)", async () => {
    for (const level of ["warn", "error"] as const) {
      vi.spyOn(console, level).mockImplementation(() => {});
    }
    const created = await H.call(OPERATOR, "POST", `/api/ops/clients/${H.A.tenantId}/agents`, {
      slug: "state-1-sched",
      bundle: testBundle(),
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    const agentId = j(created.json).agent.id as string;
    const versionId = j(created.json).version.id as string;
    await H.call(OPERATOR, "PATCH", `/api/ops/agents/${agentId}/operation`, {
      bindings: { testkit: H.A.connectionId },
    });
    const pub = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${agentId}/versions/${versionId}/publish`,
    );
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
    await H.t.db.update(agent).set({ runStatus: "active" }).where(eq(agent.id, agentId));

    const request = {
      runId: crypto.randomUUID(),
      tenantId: H.A.tenantId,
      agentId,
      agentVersionId: versionId,
      workflowSlug: "fix-record",
      mode: "live" as const,
      trigger: { type: "schedule", scheduledAt: "2026-11-20T10:00:00.000Z" },
      payload: {},
    } as unknown as Parameters<typeof startRun>[1];

    // Pass 1 has written the run row and not committed yet (its transaction is open).
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let inserted: () => void = () => {};
    const rowWritten = new Promise<void>((r) => {
      inserted = r;
    });
    const pass1 = withTenant(H.db, H.A.tenantId, async (tx) => {
      await createRunRow(tx, request);
      inserted();
      await gate;
    });
    await rowWritten;
    // Pass 2 reads no row (read committed), then its insert waits on pass 1's unique key.
    const pass2 = startRun({ db: H.db, instances: H.instances }, request).then(
      () => "ok",
      (error: unknown) =>
        `threw: ${String((error as { cause?: { message?: string } }).cause?.message ?? error)}`,
    );
    await new Promise((r) => setTimeout(r, 300));
    release();
    await pass1;
    const outcome = await pass2;

    // One run row, and the second pass treats the tick as already started.
    const rows = await H.t.db.select().from(run).where(eq(run.id, request.runId));
    expect(rows).toHaveLength(1);
    expect(outcome).toBe("ok");
  });
});
