// UI cleanup (stream A): a run waiting on a person is "waiting for approval" on every run shape the
// back office reads (the runs list and its status filter, a run, search, the command center, the
// clients list), with who it waits on and since when; an approval waiting over a day, or one that
// nobody can act on, needs us; and the counts agree with each other.
import { inboxItem, run } from "@countersign/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ApiHarness, createApiHarness, OPERATOR, testBundle } from "./api.test-helper";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const h = await createApiHarness();
afterAll(() => h?.close());

describe.skipIf(!h)("waiting for approval", () => {
  const H = h as ApiHarness;
  const now = Date.now();
  const hoursAgo = (n: number) => new Date(now - n * 3_600_000);
  const ids = { agent: "", version: "", waiting: "", running: "", failed: "", named: "" };

  async function addRun(values: Partial<typeof run.$inferInsert>) {
    const [r] = await H.t.db
      .insert(run)
      .values({
        tenantId: H.A.tenantId,
        agentId: ids.agent,
        agentVersionId: ids.version,
        workflowSlug: "fix-record",
        mode: "live",
        status: "running",
        createdAt: hoursAgo(40),
        startedAt: hoursAgo(40),
        ...values,
      })
      .returning();
    return r?.id as string;
  }

  beforeAll(async () => {
    const tpl = await H.call(OPERATOR, "POST", "/api/ops/templates", {
      slug: "clerk",
      bundle: testBundle("Bill clerk"),
    });
    await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${j(tpl.json).agent.id}/versions/${j(tpl.json).version.id}/publish`,
    );
    const fork = await H.call(OPERATOR, "POST", `/api/ops/templates/${j(tpl.json).agent.id}/fork`, {
      clientId: H.A.tenantId,
      slug: "clerk",
      serviceName: "Bill clerk",
    });
    ids.agent = j(fork.json).agent.id;
    ids.version = j(fork.json).version.id;

    // Stored as running, with an approval open for 39 hours: waiting for approval.
    ids.waiting = await addRun({});
    await H.t.db.insert(inboxItem).values({
      tenantId: H.A.tenantId,
      kind: "approval",
      runId: ids.waiting,
      agentId: ids.agent,
      assigneeRole: "client_admin",
      title: "Itemize bill 20418",
      createdAt: hoursAgo(39),
    });
    // Running, nothing open.
    ids.running = await addRun({ createdAt: new Date(now), startedAt: new Date(now) });
    // Failed at the "update" step, today.
    ids.failed = await addRun({
      status: "failed",
      createdAt: new Date(now),
      finishedAt: new Date(now),
      error: { reason: "QuickBooks said 401", nodeId: "update" },
    });
    // Waiting on a named person, for an hour.
    ids.named = await addRun({ createdAt: hoursAgo(1) });
    await H.t.db.insert(inboxItem).values({
      tenantId: H.A.tenantId,
      kind: "approval",
      runId: ids.named,
      agentId: ids.agent,
      assigneeUserId: H.A.user,
      title: "Approve the payment",
      createdAt: hoursAgo(1),
    });
  });

  it("lists a run waiting on a person as waiting, with who and since when", async () => {
    const res = await H.call(OPERATOR, "GET", `/api/ops/runs?client=${H.A.tenantId}`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const runs = new Map(j(res.json).runs.map((r: { id: string }) => [r.id, r]));
    expect(j(runs.get(ids.waiting))).toMatchObject({
      status: "running",
      workflowName: "Fix a record",
      waiting: { on: "client_admin", person: null, items: 1, nobodyToAct: "no_email" },
    });
    expect(Date.parse(j(runs.get(ids.waiting)).waiting.since)).toBeCloseTo(
      hoursAgo(39).getTime(),
      -3,
    );
    expect(j(runs.get(ids.named)).waiting).toMatchObject({ on: "person", person: "Client A user" });
    expect(j(runs.get(ids.running)).waiting).toBeNull();
    expect(j(runs.get(ids.failed))).toMatchObject({ errorStep: "Update the record" });
  });

  it("filters by the state people see: waiting is never running", async () => {
    const list = async (q: string) =>
      j((await H.call(OPERATOR, "GET", `/api/ops/runs?${q}`)).json).runs.map(
        (r: { id: string }) => r.id,
      );
    expect((await list("status=waiting")).sort()).toEqual([ids.waiting, ids.named].sort());
    expect(await list("status=queued,running")).toEqual([ids.running]);
    expect(await list("status=failed")).toEqual([ids.failed]);
    const one = await H.call(OPERATOR, "GET", `/api/ops/runs/${ids.waiting}`);
    expect(j(one.json).run.waiting).toMatchObject({ on: "client_admin" });
  });

  it("counts it in the command center, and an approval over a day needs us", async () => {
    const cc = j((await H.call(OPERATOR, "GET", "/api/ops/command-center")).json);
    expect(cc.runningNow.runs).toBe(1);
    expect(cc.waitingForApproval).toMatchObject({ runs: 2, overdue: 1, nobodyToAct: 2 });
    expect(cc.failedToday).toEqual({ runs: 1 });
    const approvals = cc.escalations.filter((e: { kind: string }) => e.kind === "approval");
    expect(approvals.map((e: { runId: string }) => e.runId).sort()).toEqual(
      [ids.waiting, ids.named].sort(),
    );
    const agentRow = cc.agents.find((a: { id: string }) => a.id === ids.agent);
    expect(agentRow).toMatchObject({ openRuns: 3, waitingRuns: 2 });
    expect(agentRow.recentRuns.find((r: { id: string }) => r.id === ids.waiting).waiting).toBe(
      true,
    );

    // Needs us alone, and each client's count, agree with the command center.
    const needs = j((await H.call(OPERATOR, "GET", "/api/ops/needs-us")).json);
    expect(needs.count).toBe(cc.needUs.count);
    const clients = j((await H.call(OPERATOR, "GET", "/api/ops/clients")).json).clients;
    const a = clients.find((c: { id: string }) => c.id === H.A.tenantId);
    expect(a.needsUs).toBe(
      cc.escalations.filter((e: { client: { id: string } }) => e.client.id === H.A.tenantId).length,
    );
    expect(a.waitingRuns).toBe(2);
  });

  it("names the wait in search", async () => {
    const res = await H.call(OPERATOR, "GET", "/api/ops/search?q=Bill%20clerk");
    const hit = j(res.json).runs.find((r: { id: string }) => r.id === ids.waiting);
    expect(hit.waiting).toMatchObject({ on: "client_admin" });
  });

  it("stops needing us once the approval is answered", async () => {
    await H.t.db
      .update(inboxItem)
      .set({ status: "resolved", resolvedAt: new Date() })
      .where(eq(inboxItem.runId, ids.waiting));
    const cc = j((await H.call(OPERATOR, "GET", "/api/ops/command-center")).json);
    expect(cc.waitingForApproval.runs).toBe(1);
    expect(cc.runningNow.runs).toBe(2);
  });
});
