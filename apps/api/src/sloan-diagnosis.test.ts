// Sloan v3 (docs/plan.md §1.54 "Sloan", ARCHITECTURE §10.11): when a run fails after the failing
// agent reviewed it itself, `run.failed` carries the agent's diagnosis, and Sloan reports it as the
// operator's note without a model call of its own; without one, Sloan triages as before. A client's
// Sloan on v2 moves to v3 by the usual reviewed update merge, its step ids kept.

import { AgentBundle as AgentBundleSchema, type Workflow } from "@countersign/core";
import { agent, agentVersion, inboxItem, stepRun, withTenant } from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { emit } from "@countersign/senses";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ApiHarness, createApiHarness, FakeWorkflowStep, OPERATOR } from "./api.test-helper";
import { dispatchEvents } from "./runs/dispatch";
import { executeRun } from "./runs/execute";
import type { RunParams } from "./runs/instances";
import { cloudflareStepRunner } from "./runs/step-runner";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const h = await createApiHarness();
afterAll(() => h?.close());

describe.skipIf(!h)("Sloan reads the failing agent's own diagnosis", () => {
  const H = h as ApiHarness;
  let sloanId = "";
  const DIAGNOSIS =
    "The vendor name had a trailing space; we tried again and QuickBooks refused it.";
  const NOTE = "Sloan's own look: the connection refuses updates.";

  const execute = (params: RunParams, transport = new FakeModel()) =>
    executeRun(
      { db: H.db, platform: H.platform, transport, instances: H.instances },
      params,
      cloudflareStepRunner(new FakeWorkflowStep()),
    );

  /** Emits a `run.failed` for another agent of client A and returns the Sloan run it started. */
  async function fail(stepId: string, diagnosis?: string): Promise<RunParams> {
    const before = H.instances.started.size;
    const payload = {
      runId: crypto.randomUUID(),
      agentId: crypto.randomUUID(),
      agentVersionId: crypto.randomUUID(),
      workflowSlug: "fix-record",
      stepId,
      error: "refused: update is off",
      ...(diagnosis ? { diagnosis } : {}),
    };
    const row = await withTenant(H.db, H.A.tenantId, (tx) =>
      emit(
        tx,
        { tenantId: H.A.tenantId, type: "run.failed", payload },
        { registry: H.platform.events },
      ),
    );
    if (row) await dispatchEvents({ db: H.db, instances: H.instances }, [row]);
    const started = [...H.instances.started.values()]
      .slice(before)
      .filter((p) => p.agentId === sloanId);
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ workflowSlug: "run-failed" });
    return started[0] as RunParams;
  }

  /** The operator's finding about a step, and the step rows of the Sloan run that made it. */
  async function outcome(params: RunParams, stepId: string) {
    const [operator] = await H.t.db
      .select()
      .from(inboxItem)
      .where(
        and(
          eq(inboxItem.tenantId, H.A.tenantId),
          eq(inboxItem.assigneeRole, "operator"),
          sql`${inboxItem.payload}->'details'->>'stepId' = ${stepId}`,
        ),
      );
    const steps = await H.t.db
      .select({ nodeId: stepRun.nodeId, status: stepRun.status })
      .from(stepRun)
      .where(eq(stepRun.runId, params.runId));
    return { note: j(operator?.payload)?.note, steps: steps.map((s) => s.nodeId).sort() };
  }

  beforeAll(async () => {
    // Sloan as clients have it today: the supervisor's v2, forked into the client.
    const v2 = await H.call(OPERATOR, "POST", "/api/ops/platform-templates/supervisor/install", {
      version: 2,
    });
    expect(v2.status, JSON.stringify(v2.json)).toBe(200);
    const fork = await H.call(OPERATOR, "POST", `/api/ops/clients/${H.A.tenantId}/supervisor`, {});
    expect(fork.status, JSON.stringify(fork.json)).toBe(200);
    sloanId = j(fork.json).supervisor.id;
    await H.t.db
      .update(agent)
      .set({ runStatus: "active", stage: "live" })
      .where(eq(agent.id, sloanId));
  });

  it("moves a client's Sloan from v2 to v3 by a clean update merge, step ids kept", async () => {
    const v3 = await H.call(OPERATOR, "POST", "/api/ops/platform-templates/supervisor/install", {
      version: 3,
    });
    expect(v3.status, JSON.stringify(v3.json)).toBe(200);
    expect(j(v3.json)).toMatchObject({ version: { version: 3, status: "live" }, installed: true });

    const preview = await H.call(OPERATOR, "GET", `/api/ops/agents/${sloanId}/update-preview`);
    expect(preview.status, JSON.stringify(preview.json)).toBe(200);
    expect(j(preview.json).conflicts).toEqual([]);
    const update = await H.call(OPERATOR, "POST", `/api/ops/agents/${sloanId}/update`, {
      resolutions: [],
    });
    expect(update.status, JSON.stringify(update.json)).toBe(200);
    const versionId = j(update.json).version.id;
    const pub = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${sloanId}/versions/${versionId}/publish`,
    );
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);

    const [row] = await H.t.db.select().from(agentVersion).where(eq(agentVersion.id, versionId));
    const bundle = AgentBundleSchema.parse(row?.bundle);
    const runFailed = bundle.workflows.find((w) => w.slug === "run-failed")?.workflow as Workflow;
    expect(runFailed.steps).toMatchObject([
      {
        id: "run-diagnosed",
        kind: "fork",
        paths: [{ id: "run-diagnosed-yes", steps: [{ id: "run-report-diagnosed" }] }],
        otherwise: { id: "run-diagnosed-no", steps: [{ id: "run-triage" }, { id: "run-report" }] },
      },
    ]);
  });

  it("reports the agent's diagnosis as the operator's note, with no model call", async () => {
    const params = await fail("update", DIAGNOSIS);
    // No scripted turns: any model call would fail the run.
    const model = new FakeModel([]);
    expect(await execute(params, model)).toEqual({ status: "succeeded" });
    expect(model.requests).toHaveLength(0);
    const { note, steps } = await outcome(params, "update");
    expect(note).toBe(DIAGNOSIS);
    expect(steps).toContain("run-report-diagnosed");
    expect(steps).not.toContain("run-triage");
  });

  it("triages as before when the failure carries no diagnosis", async () => {
    const params = await fail("lookup");
    const model = new FakeModel([
      { toolUse: { name: "finish", input: { note: NOTE, sources: [H.A.connectionId] } } },
    ]);
    expect(await execute(params, model)).toEqual({ status: "succeeded" });
    expect(model.requests).toHaveLength(1);
    const { note, steps } = await outcome(params, "lookup");
    expect(note).toBe(NOTE);
    expect(steps).toEqual(expect.arrayContaining(["run-triage", "run-report"]));
    expect(steps).not.toContain("run-report-diagnosed");
  });
});
