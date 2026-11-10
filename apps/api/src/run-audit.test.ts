// Wave 6 (docs/plan.md §1.86 "Run audit (wave 6)"): the run audit end to end in Node, through the
// API with the real runtime, the testkit connector and a fake WorkflowStep. A v4 run records the
// owner's check on its step and, having written, joins the audit queue; a v3 run records no check;
// a reviewer marks runs (insert only, audited); the sampling rule is set per client and agent; one
// run's trail exports as JSON and printable HTML, redacted, with AI prompts only when asked.

import { TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import { bundleHash, RunExport } from "@countersign/core";
import {
  agent,
  agentVersion,
  auditEvent,
  inboxItem,
  modelCall,
  ownerCheck,
  run,
  runAudit,
  runAuditMark,
  stepRun,
  tenant,
  tenantChange,
} from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { inboxEventType } from "@countersign/workflows";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  FakeWorkflowStep,
  OPERATOR,
  OTHER_OPERATOR,
  testBundle,
} from "./api.test-helper";
import { executeRun } from "./runs/execute";
import type { RunParams } from "./runs/instances";
import { cloudflareStepRunner } from "./runs/step-runner";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const TIMEOUT = () =>
  Object.assign(new Error("Execution timed out after 1ms"), { name: "WorkflowTimeoutError" });

const h = await createApiHarness();
afterAll(() => h?.close());

describe.skipIf(!h)("the run audit (wave 6)", () => {
  const H = h as ApiHarness;
  let agentId = "";
  let v3Version = "";
  let v4Version = "";
  const deps = () => ({
    db: H.db,
    platform: H.platform,
    transport: new FakeModel(),
    instances: H.instances,
  });

  const proc = (steps: unknown[]) => ({
    schemaVersion: 4,
    triggers: [{ id: "trg-manual", on: { type: "manual", input: {} } }],
    steps,
  });

  async function processVersion(process: unknown): Promise<string> {
    const bundle = testBundle();
    const stored = {
      ...bundle,
      workflows: [{ slug: "fix-record", name: "Fix a record", workflow: process }],
    };
    const versions = await H.t.db
      .select({ version: agentVersion.version })
      .from(agentVersion)
      .where(eq(agentVersion.agentId, agentId));
    const [row] = await H.t.db
      .insert(agentVersion)
      .values({
        tenantId: H.A.tenantId,
        agentId,
        version: Math.max(0, ...versions.map((v) => v.version)) + 1,
        // biome-ignore lint/suspicious/noExplicitAny: a v4 process is stored as written.
        bundle: stored as any,
        bundleHash: await bundleHash(stored),
        authorType: "operator",
      })
      .returning({ id: agentVersion.id });
    if (!row) throw new Error("no version");
    return row.id;
  }

  const params = (versionId: string): RunParams =>
    ({
      runId: crypto.randomUUID(),
      tenantId: H.A.tenantId,
      agentId,
      agentVersionId: versionId,
      workflowSlug: "fix-record",
      mode: "live",
      trigger: { type: "manual" },
      payload: {},
    }) as RunParams;

  /** Answers each item a wait is for, through the portal, as the client admin. */
  const answering = (decision: "approve" | "reject") =>
    new FakeWorkflowStep(async (_name, type) => {
      const items = await H.t.db.select().from(inboxItem).where(eq(inboxItem.status, "open"));
      const item = items.find((i) => inboxEventType(i.id) === type);
      if (!item) throw TIMEOUT();
      const res = await H.call(admin("a"), "POST", `/api/inbox/${item.id}/resolve`, { decision });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      return H.instances.events.find((e) => e.event.type === type)?.event.payload;
    });

  beforeAll(async () => {
    await H.call(admin("a"), "POST", "/api/connections/testkit/authorize");
    const tpl = await H.call(OPERATOR, "POST", "/api/ops/templates", {
      slug: "audited-clerk",
      bundle: testBundle(),
    });
    const tid = j(tpl.json).agent.id;
    await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${tid}/versions/${j(tpl.json).version.id}/publish`,
    );
    const fork = await H.call(OPERATOR, "POST", `/api/ops/templates/${tid}/fork`, {
      clientId: H.A.tenantId,
      serviceName: "Record keeping",
    });
    agentId = j(fork.json).agent.id;
    v3Version = j(fork.json).version.id;
    await H.call(OPERATOR, "PATCH", `/api/ops/agents/${agentId}/operation`, {
      bindings: { testkit: H.A.connectionId },
    });
    const pub = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${agentId}/versions/${v3Version}/publish`,
    );
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
    await H.t.db
      .update(agent)
      .set({ runStatus: "active", stage: "live", liveVersionId: v3Version })
      .where(eq(agent.id, agentId));
    // A v4 process: one write, signed by the client admin. No `oversight` saved, so the owner is
    // the new-agent default (failures reviewed) with its cheap watch on.
    v4Version = await processVersion(
      proc([
        {
          id: "update",
          kind: "write",
          name: "Update the record",
          tool: TESTKIT_UPDATE_TOOL,
          input: { id: "r1", amount: "12.00" },
          checks: {
            approval: {
              mode: "in_turn",
              approvers: [{ who: H.A.admin, deadline: { after: "1 day" } }],
            },
          },
        },
      ]),
    );
  });

  let wroteRun = "";

  it("records the owner's check on a v4 step and queues a run that wrote", async () => {
    H.backend.seed(H.A.connectionId, [{ id: "r1", name: "Oak board", amount: "10.00" }]);
    const p = params(v4Version);
    wroteRun = p.runId;
    expect(await executeRun(deps(), p, cloudflareStepRunner(answering("approve")))).toEqual({
      status: "succeeded",
    });
    const checks = await H.t.db.select().from(ownerCheck).where(eq(ownerCheck.runId, p.runId));
    expect(checks).toEqual([
      expect.objectContaining({
        nodeId: "update",
        attempt: 1,
        result: "clean",
        attemptOutcome: "succeeded",
        signals: [],
        agentVersionId: v4Version,
      }),
    ]);
    const queued = await H.t.db.select().from(runAudit).where(eq(runAudit.runId, p.runId));
    expect(queued).toEqual([
      expect.objectContaining({
        reason: "wrote",
        agentId,
        rule: expect.objectContaining({ writes: true, percent: 5, source: "default" }),
      }),
    ]);

    const view = await H.call(OPERATOR, "GET", `/api/ops/runs/${p.runId}`);
    expect(view.status, JSON.stringify(view.json)).toBe(200);
    expect(j(view.json).ownerChecks).toEqual([
      expect.objectContaining({
        nodeId: "update",
        result: "clean",
        words: "Owner checked: nothing off",
      }),
    ]);
    expect(j(view.json).audit).toMatchObject({
      queued: { reason: "wrote" },
      marks: [],
      latest: null,
    });
  });

  it("records no check for a v3 run, and still queues it when it wrote", async () => {
    H.backend.seed(H.A.connectionId, [{ id: "r1", name: "Oak board", amount: "10.00" }]);
    const p = params(v3Version);
    const step = new FakeWorkflowStep(async (_name, type) => {
      const items = await H.t.db.select().from(inboxItem).where(eq(inboxItem.status, "open"));
      const item = items.find((i) => inboxEventType(i.id) === type);
      if (!item) throw TIMEOUT();
      // The write's approval and the person step's question: yes to both.
      const res = await H.call(admin("a"), "POST", `/api/inbox/${item.id}/resolve`, {
        decision: "approve",
      });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      return H.instances.events.find((e) => e.event.type === type)?.event.payload;
    });
    await executeRun(deps(), p, cloudflareStepRunner(step));
    expect(await H.t.db.select().from(ownerCheck).where(eq(ownerCheck.runId, p.runId))).toEqual([]);
    expect([...step.results.keys()].some((n) => n.includes(":owner:"))).toBe(false);
    const [queued] = await H.t.db.select().from(runAudit).where(eq(runAudit.runId, p.runId));
    expect(queued?.reason).toBe("wrote");
  });

  it("lists queued runs, takes marks (insert only, audited) and opens an item for a problem", async () => {
    const list = await H.call(OPERATOR, "GET", `/api/ops/run-audit/queue?client=${H.A.tenantId}`);
    expect(list.status, JSON.stringify(list.json)).toBe(200);
    expect(j(list.json).runs.map((r: { runId: string }) => r.runId)).toContain(wroteRun);
    const before = j(list.json).counts.unaudited as number;

    const ok = await H.call(OPERATOR, "POST", `/api/ops/runs/${wroteRun}/audit-marks`, {
      verdict: "looks_right",
    });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(j(ok.json).audit.latest).toMatchObject({ verdict: "looks_right", note: null });

    const noNote = await H.call(OPERATOR, "POST", `/api/ops/runs/${wroteRun}/audit-marks`, {
      verdict: "problem",
    });
    expect(noNote.status).toBe(400);

    const bad = await H.call(OPERATOR, "POST", `/api/ops/runs/${wroteRun}/audit-marks`, {
      verdict: "problem",
      note: "The amount should have been 21.00.",
    });
    expect(bad.status, JSON.stringify(bad.json)).toBe(200);
    const audit = j(bad.json).audit;
    expect(audit.marks.map((m: { verdict: string }) => m.verdict)).toEqual([
      "problem",
      "looks_right",
    ]);
    expect(audit.latest.markedBy).toMatchObject({ email: OPERATOR });
    const itemId = audit.latest.inboxItemId as string;
    const [item] = await H.t.db.select().from(inboxItem).where(eq(inboxItem.id, itemId));
    expect(item).toMatchObject({
      kind: "review",
      assigneeRole: "operator",
      subjectType: "run",
      subjectId: wroteRun,
      runId: null,
    });
    // The client never sees it, nor any of the audit.
    const portal = await H.call(admin("a"), "GET", "/api/inbox?status=open");
    expect(j(portal.json).items.some((i: { id: string }) => i.id === itemId)).toBe(false);
    for (const path of [
      "/api/ops/run-audit/queue",
      "/api/ops/run-audit/stats",
      `/api/ops/runs/${wroteRun}/export`,
    ]) {
      expect((await H.call(admin("a"), "GET", path)).status).toBe(403);
    }
    const marked = await H.t.db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.action, "run.audit_mark"), eq(auditEvent.tenantId, H.A.tenantId)));
    expect(marked).toHaveLength(2);
    expect(marked[1]?.target).toMatchObject({ run: wroteRun, verdict: "problem", item: itemId });

    const problems = await H.call(
      OPERATOR,
      "GET",
      `/api/ops/run-audit/queue?client=${H.A.tenantId}&state=problem`,
    );
    expect(j(problems.json).runs).toEqual([
      expect.objectContaining({
        runId: wroteRun,
        marks: 2,
        latest: expect.objectContaining({ verdict: "problem" }),
      }),
    ]);
    expect(j(problems.json).counts).toMatchObject({
      unaudited: before - 1,
      problem: 1,
      audited: 1,
    });
    const unaudited = await H.call(
      OPERATOR,
      "GET",
      `/api/ops/run-audit/queue?client=${H.A.tenantId}`,
    );
    expect(j(unaudited.json).runs.map((r: { runId: string }) => r.runId)).not.toContain(wroteRun);

    const stats = await H.call(OPERATOR, "GET", `/api/ops/run-audit/stats?client=${H.A.tenantId}`);
    expect(stats.status, JSON.stringify(stats.json)).toBe(200);
    expect(j(stats.json).agents).toEqual([
      expect.objectContaining({
        agentId,
        agentName: expect.any(String),
        audited: 1,
        problems: 1,
        lastAuditedAt: expect.any(String),
      }),
    ]);
    expect(j(stats.json).clients).toEqual([
      expect.objectContaining({ tenantId: H.A.tenantId, agentId: null, problems: 1 }),
    ]);
  });

  it("refuses a mark on a run that hasn't finished, and adds a finished one by hand", async () => {
    const [running] = await H.t.db
      .insert(run)
      .values({
        tenantId: H.A.tenantId,
        agentId,
        agentVersionId: v4Version,
        workflowSlug: "fix-record",
        status: "running",
      })
      .returning();
    const refused = await H.call(OPERATOR, "POST", `/api/ops/runs/${running?.id}/audit-marks`, {
      verdict: "looks_right",
    });
    expect(refused.status).toBe(409);
    await H.t.db
      .update(run)
      .set({ status: "succeeded" })
      .where(eq(run.id, running?.id ?? ""));
    const ok = await H.call(OPERATOR, "POST", `/api/ops/runs/${running?.id}/audit-marks`, {
      verdict: "looks_right",
    });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(j(ok.json).audit.queued).toMatchObject({ reason: "by_hand", rule: null });
    // A mark is never changed or removed, even by the database's owner.
    await expect(
      H.t.db
        .update(runAuditMark)
        .set({ note: "changed" })
        .where(eq(runAuditMark.runId, running?.id ?? "")),
    ).rejects.toMatchObject({ cause: { code: "23001" } });
  });

  it("samples by the client's rule and an agent's override, and keeps the rest of the settings", async () => {
    const get = await H.call(OPERATOR, "GET", `/api/ops/clients/${H.A.tenantId}/run-audit`);
    expect(get.status, JSON.stringify(get.json)).toBe(200);
    expect(j(get.json)).toMatchObject({
      default: { writes: true, percent: 5 },
      rule: null,
      effective: { writes: true, percent: 5 },
    });
    const unknown = await H.call(OPERATOR, "PUT", `/api/ops/clients/${H.A.tenantId}/run-audit`, {
      agents: { [crypto.randomUUID()]: { writes: true, percent: 1 } },
    });
    expect(unknown.status).toBe(422);
    const off = await H.call(OPERATOR, "PUT", `/api/ops/clients/${H.A.tenantId}/run-audit`, {
      rule: { writes: false, percent: 0 },
    });
    expect(off.status, JSON.stringify(off.json)).toBe(200);
    expect(j(off.json).agents).toContainEqual(
      expect.objectContaining({ agentId, rule: null, effective: { writes: false, percent: 0 } }),
    );
    const [t] = await H.t.db
      .select({ settings: tenant.settings })
      .from(tenant)
      .where(eq(tenant.id, H.A.tenantId));
    expect(t?.settings).toMatchObject({
      connectors_offered: ["testkit"],
      runAudit: { rule: { writes: false, percent: 0 } },
    });
    const changes = await H.t.db
      .select()
      .from(tenantChange)
      .where(eq(tenantChange.tenantId, H.A.tenantId));
    expect(changes.some((c) => (c.change as { setting?: string }).setting === "runAudit")).toBe(
      true,
    );

    // Off: a run that wrote isn't queued.
    H.backend.seed(H.A.connectionId, [{ id: "r1", name: "Oak board", amount: "10.00" }]);
    const quiet = params(v4Version);
    await executeRun(deps(), quiet, cloudflareStepRunner(answering("approve")));
    expect(await H.t.db.select().from(runAudit).where(eq(runAudit.runId, quiet.runId))).toEqual([]);

    // The agent's override samples every run, even one that wrote nothing (turned down).
    const all = await H.call(OPERATOR, "PUT", `/api/ops/clients/${H.A.tenantId}/run-audit`, {
      agents: { [agentId]: { writes: false, percent: 100 } },
    });
    expect(all.status, JSON.stringify(all.json)).toBe(200);
    const declined = params(v4Version);
    const result = await executeRun(deps(), declined, cloudflareStepRunner(answering("reject")));
    expect(result.status).toBe("cancelled");
    const [sampled] = await H.t.db
      .select()
      .from(runAudit)
      .where(eq(runAudit.runId, declined.runId));
    expect(sampled).toMatchObject({
      reason: "sampled",
      rule: expect.objectContaining({ source: "agent", percent: 100 }),
    });
    // Clearing both puts the default back.
    const cleared = await H.call(OPERATOR, "PUT", `/api/ops/clients/${H.A.tenantId}/run-audit`, {
      rule: null,
      agents: { [agentId]: null },
    });
    expect(j(cleared.json)).toMatchObject({ rule: null, effective: { writes: true, percent: 5 } });
  });

  it("exports one run's trail as JSON and as printable HTML, redacted, and audits it", async () => {
    // An AI call on the run's step, its body in storage with a secret-like field and a card number.
    const [row] = await H.t.db
      .select({ id: stepRun.id })
      .from(stepRun)
      .where(and(eq(stepRun.runId, wroteRun), eq(stepRun.nodeId, "update")));
    const bodyKey = `tenants/${H.A.tenantId}/model-calls/${crypto.randomUUID()}.json`;
    await H.objects.put(
      bodyKey,
      new TextEncoder().encode(
        JSON.stringify({
          request: {
            messages: [{ role: "user", content: "Card 4111 1111 1111 1111" }],
            apiKey: "sk-live-123",
          },
          answer: { text: "Done" },
          error: null,
        }),
      ),
    );
    await H.t.db.insert(modelCall).values({
      tenantId: H.A.tenantId,
      runId: wroteRun,
      stepRunId: row?.id ?? "",
      agentVersionId: v4Version,
      provider: "anthropic",
      model: "claude-opus-5-5",
      tokensIn: 120,
      tokensOut: 30,
      costUsd: "0.0042",
      durationMs: 800,
      stopReason: "end_turn",
      bodyKey,
    });

    const json = await H.call(OPERATOR, "GET", `/api/ops/runs/${wroteRun}/export?format=json`);
    expect(json.status, JSON.stringify(json.json)).toBe(200);
    expect(json.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(json.headers.get("content-disposition")).toMatch(
      /attachment; filename="run-R-.*\.json"/,
    );
    const data = RunExport.parse(json.json);
    expect(data).toMatchObject({
      includesModelCalls: false,
      client: { id: H.A.tenantId },
      agentVersion: { id: v4Version },
      run: { id: wroteRun, status: "succeeded" },
      audit: { latest: { verdict: "problem" } },
    });
    const [update] = data.steps;
    expect(update).toMatchObject({
      nodeId: "update",
      name: "Update the record",
      ownerChecks: [expect.objectContaining({ words: "Owner checked: nothing off" })],
      actions: [expect.objectContaining({ status: "done", before: expect.anything() })],
      modelCalls: [expect.objectContaining({ model: "claude-opus-5-5", costUsd: "0.0042" })],
    });
    expect(update?.modelCalls[0]).not.toHaveProperty("body");
    expect(update?.checks?.approval?.approvers.length).toBeGreaterThan(0);
    expect(JSON.stringify(json.json)).not.toContain("sk-live-123");

    const full = await H.call(
      OPERATOR,
      "GET",
      `/api/ops/runs/${wroteRun}/export?format=json&modelCalls=1`,
    );
    const withBodies = RunExport.parse(full.json);
    expect(withBodies.includesModelCalls).toBe(true);
    const body = withBodies.steps[0]?.modelCalls[0]?.body as { request: Record<string, unknown> };
    expect(body.request.apiKey).toBe("[redacted]");
    const text = JSON.stringify(full.json);
    expect(text).not.toContain("sk-live-123");
    expect(text).not.toContain("4111 1111 1111 1111");

    const html = await H.call(OPERATOR, "GET", `/api/ops/runs/${wroteRun}/export?modelCalls=1`);
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const page = String(html.json);
    expect(page.startsWith("<!doctype html>")).toBe(true);
    expect(page).toContain("Owner checked: nothing off");
    expect(page).toContain("The amount should have been 21.00.");
    expect(page).toContain("Prompt");
    expect(page).not.toMatch(/<script|<link|src=/i);
    expect(page).not.toContain("sk-live-123");

    const exported = await H.t.db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.action, "run.export"), eq(auditEvent.tenantId, H.A.tenantId)));
    expect(exported.map((e) => e.target)).toEqual([
      { run: wroteRun, format: "json", modelCalls: "0" },
      { run: wroteRun, format: "json", modelCalls: "1" },
      { run: wroteRun, format: "html", modelCalls: "1" },
    ]);
    // Another operator who doesn't serve client A can't export its run.
    expect((await H.call(OTHER_OPERATOR, "GET", `/api/ops/runs/${wroteRun}/export`)).status).toBe(
      404,
    );
  });
});
