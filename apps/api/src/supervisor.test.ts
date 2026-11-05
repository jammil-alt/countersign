// The supervisor end to end (docs/plan.md §1.28), with the model faked: the template validates and
// is added to a client from the back office (once), tested and activated; a live run fails, which
// emits `run.failed` in the run's own transaction; the supervisor runs on it and reports once to
// the client admin (plain steps) and once to the operator (details); the same failure again adds
// nothing; a test run of the failing agent emits nothing; the daily check at 08:00 in the client's
// timezone writes the summary the portal's overview shows; and the portal never sees internals.

import { FORBIDDEN_PORTAL_FIELD, validateBundle } from "@countersign/core";
import { agent, connection, event, inboxItem, run, tenant } from "@countersign/db";
import { loadSeedTemplates } from "@countersign/db/seed";
import { FakeModel } from "@countersign/llm";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  FakeWorkflowStep,
  OPERATOR,
  testBundle,
  user,
} from "./api.test-helper";
import { cronTick } from "./runs/dispatch";
import { executeRun } from "./runs/execute";
import type { RunParams } from "./runs/instances";
import { cloudflareStepRunner } from "./runs/step-runner";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

/** Every key in a JSON value that a portal response may never carry. */
function forbiddenKeys(value: unknown, at = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => forbiddenKeys(v, `${at}[${i}]`));
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([k, v]) => [
    ...(FORBIDDEN_PORTAL_FIELD.test(k) ? [`${at}.${k}`] : []),
    ...forbiddenKeys(v, `${at}.${k}`),
  ]);
}

const h = await createApiHarness();
afterAll(() => h?.close());

describe.skipIf(!h)("the supervisor", () => {
  const H = h as ApiHarness;
  let workerId = "";
  let workerV1 = "";
  let supervisorId = "";
  const NOTE = "The testkit connection has update switched off; the operator should check it.";

  const triageModel = () =>
    new FakeModel([
      { toolUse: { name: "finish", input: { note: NOTE, sources: [H.A.connectionId] } } },
    ]);
  const deps = (transport = new FakeModel()) => ({
    db: H.db,
    platform: H.platform,
    transport,
    instances: H.instances,
  });
  const execute = (params: RunParams, transport = new FakeModel()) =>
    executeRun(deps(transport), params, cloudflareStepRunner(new FakeWorkflowStep()));

  /** Runs started since `before` (a count of `instances.started`), optionally of one agent. */
  const startedSince = (before: number, agentId?: string) =>
    [...H.instances.started.values()]
      .slice(before)
      .filter((p) => !agentId || p.agentId === agentId);

  const findings = () =>
    H.t.db
      .select()
      .from(inboxItem)
      .where(
        and(
          eq(inboxItem.tenantId, H.A.tenantId),
          sql`${inboxItem.payload}->>'fingerprint' is not null`,
        ),
      );

  /** Starts the worker's live run and executes it: it fails at its `update` step. */
  async function failWorker() {
    const before = H.instances.started.size;
    const res = await H.call(OPERATOR, "POST", `/api/ops/agents/${workerId}/run`, {
      workflow: "fix-record",
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const params = H.instances.started.get(j(res.json).runId) as RunParams;
    const result = await execute(params);
    expect(result).toMatchObject({ status: "failed", nodeId: "update" });
    return { runId: params.runId, before };
  }

  beforeAll(async () => {
    // The supervisor template, installed as the seed installs it.
    const seeded = (await loadSeedTemplates()).find((t) => t.slug === "supervisor");
    if (!seeded) throw new Error("no supervisor seed");
    const tpl = await H.call(OPERATOR, "POST", "/api/ops/templates", {
      slug: "supervisor",
      bundle: seeded.bundle,
    });
    expect(tpl.status, JSON.stringify(tpl.json)).toBe(200);
    const pub = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${j(tpl.json).agent.id}/versions/${j(tpl.json).version.id}/publish`,
    );
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);

    // A worker whose change is refused (update is off on its connection), so its run fails.
    const w = await H.call(OPERATOR, "POST", "/api/ops/templates", {
      slug: "records-clerk",
      bundle: testBundle(),
    });
    const wid = j(w.json).agent.id;
    await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${wid}/versions/${j(w.json).version.id}/publish`,
    );
    const fork = await H.call(OPERATOR, "POST", `/api/ops/templates/${wid}/fork`, {
      clientId: H.A.tenantId,
      serviceName: "Record keeping",
    });
    workerId = j(fork.json).agent.id;
    workerV1 = j(fork.json).version.id;
    await H.call(OPERATOR, "PATCH", `/api/ops/agents/${workerId}/operation`, {
      bindings: { testkit: H.A.connectionId },
    });
    await H.call(OPERATOR, "POST", `/api/ops/agents/${workerId}/versions/${workerV1}/publish`);
    // Activation is tested elsewhere; this agent just has to run live.
    await H.t.db.update(agent).set({ runStatus: "active" }).where(eq(agent.id, workerId));
    await H.t.db
      .update(connection)
      .set({ permissions: { read: "auto", create: "approval", update: "off", delete: "off" } })
      .where(eq(connection.id, H.A.connectionId));
  });

  it("the template validates against the platform, like every bundle", async () => {
    const seeded = (await loadSeedTemplates()).find((t) => t.slug === "supervisor");
    if (!seeded) throw new Error("no supervisor seed");
    const result = validateBundle(seeded.bundle, {
      skills: Object.fromEntries(H.platform.catalog.list().map((s) => [s.id, s])),
      tools: H.platform.tools.specs(),
      events: H.platform.events.byType(),
    });
    expect(result.errors).toEqual([]);
    const def = seeded.bundle.definition;
    expect(def.kind).toBe("platform");
    expect(def.permissions.mode).toBe("suggest_only");
    // It writes only internal records: none of its tools can write to a client's tool.
    for (const s of def.skills) {
      const skill = H.platform.catalog.get(s.skill);
      for (const t of [...(skill?.tools ?? []), ...(skill?.handler ? [skill.handler] : [])]) {
        expect(H.platform.tools.get(t)?.spec.sideEffect, t).not.toBe("external");
      }
    }
    const triggers = seeded.bundle.workflows.map((w) => w.workflow.trigger.on);
    expect(triggers).toEqual([
      { type: "event", event: "run.failed" },
      { type: "event", event: "connection.needs_attention" },
      { type: "schedule", cron: "0 8 * * *" },
    ]);
  });

  it("is added to a client from the back office once, forked and published", async () => {
    const res = await H.call(OPERATOR, "POST", `/api/ops/clients/${H.A.tenantId}/supervisor`, {});
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(j(res.json)).toMatchObject({ created: true, supervisor: { slug: "supervisor" } });
    supervisorId = j(res.json).supervisor.id;
    expect(j(res.json).supervisor.liveVersionId).toBeTruthy();
    const again = await H.call(OPERATOR, "POST", `/api/ops/clients/${H.A.tenantId}/supervisor`, {});
    expect(j(again.json)).toMatchObject({ created: false, supervisor: { id: supervisorId } });
    // Clients can't add one, and an operator only to the clients they serve (others don't exist
    // for them).
    expect(
      (await H.call(admin("a"), "POST", `/api/ops/clients/${H.A.tenantId}/supervisor`, {})).status,
    ).toBe(403);
    expect(
      (await H.call(OPERATOR, "POST", `/api/ops/clients/${H.C.tenantId}/supervisor`, {})).status,
    ).toBe(404);
  });

  it("onboarding offers it: a new client can start with the supervisor", async () => {
    const res = await H.call(OPERATOR, "POST", "/api/ops/clients", {
      name: "Onboarded with a supervisor",
      supervisor: true,
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const health = await H.call(
      OPERATOR,
      "GET",
      `/api/ops/clients/${j(res.json).client.id}/health`,
    );
    expect(j(health.json).supervisor).toMatchObject({ slug: "supervisor", runStatus: "draft" });
  });

  it("test-runs without writing anything, then activates", async () => {
    const [row] = await H.t.db
      .select({ live: agent.liveVersionId })
      .from(agent)
      .where(eq(agent.id, supervisorId));
    const live = row?.live;
    const res = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${supervisorId}/versions/${live}/test-run`,
      { workflow: "daily-check" },
    );
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const params = H.instances.started.get(j(res.json).runId) as RunParams;
    const itemsBefore = (await findings()).length;
    expect(await execute(params)).toEqual({ status: "succeeded" });
    expect((await findings()).length).toBe(itemsBefore);
    const summaries = await H.t.db
      .select()
      .from(event)
      .where(and(eq(event.tenantId, H.A.tenantId), eq(event.type, "health.checked")));
    expect(summaries).toEqual([]);
    const act = await H.call(OPERATOR, "POST", `/api/ops/agents/${supervisorId}/activate`);
    expect(act.status, JSON.stringify(act.json)).toBe(200);
  });

  it("a failed run is reported once to the client admin and once to the operator", async () => {
    const { runId, before } = await failWorker();
    // `run.failed`, from the run's own finish.
    const [failed] = await H.t.db
      .select()
      .from(event)
      .where(and(eq(event.type, "run.failed"), eq(event.subjectId, runId)));
    expect(failed?.payload).toMatchObject({
      runId,
      agentId: workerId,
      agentVersionId: workerV1,
      workflowSlug: "fix-record",
      stepId: "update",
    });
    // It started the supervisor's `run-failed` workflow (dispatched after the commit).
    const [sup] = startedSince(before, supervisorId);
    expect(sup).toMatchObject({ workflowSlug: "run-failed", payload: { runId } });
    expect(await execute(sup as RunParams, triageModel())).toEqual({ status: "succeeded" });

    const items = await findings();
    expect(items).toHaveLength(2);
    const client = items.find((i) => i.assigneeRole === "client_admin");
    const operator = items.find((i) => i.assigneeRole === "operator");
    expect(client?.title).toBe("Record keeping could not finish its work");
    expect(j(client?.payload).finding.steps).toEqual([
      "Nothing for you to do yet: we have the details and are on it.",
      "To see what it did finish: Runs, Record keeping.",
    ]);
    expect(operator?.title).toMatch(/^Record keeping failed at update: refused/);
    expect(j(operator?.payload)).toMatchObject({
      details: { agentId: workerId, agentVersionId: workerV1, stepId: "update", runId },
      note: NOTE,
    });
    expect(j(operator?.payload).sources).toEqual(
      expect.arrayContaining([runId, workerV1, H.A.connectionId]),
    );
  });

  it("the same failure again adds no duplicate", async () => {
    const { before } = await failWorker();
    const [sup] = startedSince(before, supervisorId);
    expect(await execute(sup as RunParams, triageModel())).toEqual({ status: "succeeded" });
    const items = await findings();
    expect(items).toHaveLength(2);
    expect(items.every((i) => j(i.payload).finding.occurrences === 2)).toBe(true);
  });

  it("a test run's failure emits nothing and starts no supervisor", async () => {
    const before = H.instances.started.size;
    // The operator's test-run route refuses a version that can't pass with update off, so the
    // test run is started as that route would start it.
    const params: RunParams = {
      runId: crypto.randomUUID(),
      tenantId: H.A.tenantId,
      agentId: workerId,
      agentVersionId: workerV1,
      workflowSlug: "fix-record",
      mode: "test",
      trigger: { triggerId: "trg-manual", type: "manual" },
      payload: {},
    };
    const result = await execute(params);
    expect(result).toMatchObject({ status: "failed", nodeId: "update" });
    const emitted = await H.t.db
      .select()
      .from(event)
      .where(and(eq(event.type, "run.failed"), eq(event.subjectId, params.runId)));
    expect(emitted).toEqual([]);
    expect(startedSince(before, supervisorId)).toEqual([]);
  });

  it("the daily check runs at 08:00 in the client's timezone and writes the summary", async () => {
    await H.t.db
      .update(tenant)
      .set({ timezone: "America/Chicago" })
      .where(eq(tenant.id, H.A.tenantId));
    const before = H.instances.started.size;
    // 08:00 in Chicago on 2026-11-06 is 14:00 UTC.
    await cronTick({ db: H.db, instances: H.instances }, new Date("2026-11-06T14:00:20Z"));
    const daily = startedSince(before, supervisorId);
    expect(daily.map((p) => p.workflowSlug)).toEqual(["daily-check"]);
    expect(await execute(daily[0] as RunParams)).toEqual({ status: "succeeded" });
    const [summary] = await H.t.db
      .select()
      .from(event)
      .where(and(eq(event.tenantId, H.A.tenantId), eq(event.type, "health.checked")));
    expect(summary?.payload).toMatchObject({
      runs: { failed: 2 },
      agents: { active: 2 },
      openFindings: 1,
    });
    // Still one issue: the check found the same failure open.
    expect(await findings()).toHaveLength(2);
  });

  it("the portal's overview shows the summary and the finding's steps, never internals", async () => {
    const res = await H.call(admin("a"), "GET", "/api/overview");
    expect(res.status).toBe(200);
    const health = j(res.json).health;
    expect(health.summary).toMatchObject({ state: "attention", runs: { failed: 2 } });
    expect(health.findings).toHaveLength(1);
    expect(health.findings[0]).toMatchObject({
      kind: "run_failed",
      title: "Record keeping could not finish its work",
    });
    expect(Object.keys(health.findings[0]).sort()).toEqual([
      "createdAt",
      "id",
      "kind",
      "remindedAt",
      "steps",
      "title",
    ]);
    for (const path of ["/api/overview", "/api/inbox"]) {
      const body = await H.call(admin("a"), "GET", path);
      const text = JSON.stringify(body.json);
      expect(forbiddenKeys(body.json), path).toEqual([]);
      for (const internal of [workerV1, NOTE, "refused", '"stepId"', '"details"', '"note"']) {
        expect(text, `${path}: ${internal}`).not.toContain(internal);
      }
    }
    // A client user sees no finding meant for the client admin.
    const asUser = await H.call(user("a"), "GET", "/api/overview");
    expect(j(asUser.json).health.findings).toEqual([]);
    // Another client sees none of A's.
    const other = await H.call(admin("b"), "GET", "/api/overview");
    expect(j(other.json).health).toEqual({ summary: null, findings: [] });
  });

  it("the back office shows each client's findings with the operator's details", async () => {
    const res = await H.call(OPERATOR, "GET", `/api/ops/clients/${H.A.tenantId}/health`);
    expect(res.status).toBe(200);
    const body = j(res.json);
    expect(body.supervisor).toMatchObject({ id: supervisorId, runStatus: "active" });
    expect(body.summary).toMatchObject({ state: "attention" });
    const op = body.findings.find((f: { audience: string }) => f.audience === "operator");
    const cl = body.findings.find((f: { audience: string }) => f.audience === "client_admin");
    expect(op).toMatchObject({ kind: "run_failed", note: NOTE, occurrences: 3 });
    expect(op.details).toMatchObject({ stepId: "update", agentVersionId: workerV1 });
    expect(cl).toMatchObject({ details: null, note: null });
    expect(cl.steps).toHaveLength(2);
    // Resolving the client's item in the portal closes it; the operator's stays open.
    const done = await H.call(admin("a"), "POST", `/api/inbox/${cl.id}/resolve`, {
      decision: "approve",
    });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    const after = await H.call(OPERATOR, "GET", `/api/ops/clients/${H.A.tenantId}/health`);
    expect(j(after.json).findings.map((f: { audience: string }) => f.audience)).toEqual([
      "operator",
    ]);
    const portal = await H.call(admin("a"), "GET", "/api/overview");
    expect(j(portal.json).health.findings).toEqual([]);
    // Ops-only.
    expect(
      (await H.call(admin("a"), "GET", `/api/ops/clients/${H.A.tenantId}/health`)).status,
    ).toBe(403);
  });

  it("never runs on its own run's failure", async () => {
    const [sup] = await H.t.db.select().from(agent).where(eq(agent.id, supervisorId));
    // A failing triage: the model is gone.
    const before = H.instances.started.size;
    const { before: b2 } = await failWorker();
    const [next] = startedSince(b2, supervisorId);
    const result = await execute(next as RunParams, new FakeModel([]));
    expect(result.status).toBe("failed");
    const [own] = await H.t.db
      .select()
      .from(event)
      .where(and(eq(event.type, "run.failed"), eq(event.subjectId, (next as RunParams).runId)));
    expect(own?.payload).toMatchObject({ agentId: sup?.id });
    // Its own failure was dispatched and started nothing of its own.
    const mine = startedSince(before, supervisorId).filter(
      (p) => p.runId !== (next as RunParams).runId,
    );
    expect(mine).toEqual([]);
    const runs = await H.t.db.select().from(run).where(eq(run.agentId, supervisorId));
    expect(runs.some((r) => r.status === "failed")).toBe(true);
  });
});
