// Speed run 6.2 and 6.4 (docs/audit-plan.md): the portal's run page and overview ask their reads
// together, read the run row once, and a run page can poll a light status route. Pins the
// statements each answer costs, that the answers agree with the routes beside them, and that the
// status route shows nothing the portal may not (invariant 11) and only the client's own live runs
// (invariant 1).

import { FORBIDDEN_PORTAL_FIELD } from "@countersign/core";
import { contact, type Db, inboxItem, reachOut, run, stepRun, withTenant } from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
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
import { portalRunStatus, portalRunView } from "./routes/portal";
import { executeRun } from "./runs/execute";
import { cloudflareStepRunner } from "./runs/step-runner";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

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

describe.skipIf(!h)("portal reads (speed run 6.2, 6.4)", () => {
  const H = h as ApiHarness;
  let agentId = "";
  let runId = "";
  let testRunId = "";
  // A client of its own that logs every statement it sends, as cs_worker (RLS on).
  let counted: { db: Db; end: () => Promise<void>; n: number } | null = null;
  afterAll(() => counted?.end());

  const deps = () => ({
    db: H.db,
    platform: H.platform,
    transport: new FakeModel(),
    instances: H.instances,
  });
  const resolveAs = (who: string) => async (_name: string, type: string) => {
    const items = await H.t.db.select().from(inboxItem).where(eq(inboxItem.status, "open"));
    const item = items.find((i) => `inbox-${i.id.replace(/-/g, "")}` === type);
    if (!item) throw new Error(`no open item for ${type}`);
    const path =
      who === OPERATOR ? `/api/ops/inbox/${item.id}/resolve` : `/api/inbox/${item.id}/resolve`;
    const res = await H.call(who, "POST", path, { decision: "approve" });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const sent = H.instances.events.find((e) => e.event.type === type);
    if (!sent) throw new Error(`no event ${type} was sent`);
    return sent.event.payload;
  };

  /** Statements one call sends inside its scoped transaction. */
  async function statements<T>(fn: (tx: Parameters<Parameters<Db["transaction"]>[0]>[0]) => T) {
    const c = counted as NonNullable<typeof counted>;
    return withTenant(c.db, H.A.tenantId, async (tx) => {
      const from = c.n;
      const out = await fn(tx);
      return { out, n: c.n - from };
    });
  }

  beforeAll(async () => {
    const u = new URL(H.t.url);
    u.searchParams.set("options", "-c role=cs_worker");
    const box = { n: 0 };
    const client = postgres(u.toString(), {
      max: 1,
      fetch_types: false,
      onnotice: () => {},
      // The scope (`set_config`, sent once the transaction's first query goes), begin and
      // commit are the same for every route: only the handler's own statements count.
      debug: (_c: number, q: string) => {
        if (!/^\s*(begin|commit|rollback|select\s+set_config)\b/i.test(q)) box.n++;
      },
    });
    counted = {
      db: drizzle({ client }) as unknown as Db,
      end: () => client.end(),
      get n() {
        return box.n;
      },
    };

    await H.call(admin("a"), "POST", "/api/connections/testkit/authorize");
    const tpl = await H.call(OPERATOR, "POST", "/api/ops/templates", {
      slug: "records-clerk",
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
    const v1 = j(fork.json).version.id;
    await H.call(OPERATOR, "PATCH", `/api/ops/agents/${agentId}/operation`, {
      bindings: { testkit: H.A.connectionId },
    });
    await H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/versions/${v1}/publish`);
    const test = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${agentId}/versions/${v1}/test-run`,
      { workflow: "fix-record" },
    );
    testRunId = j(test.json).runId;
    const testParams = H.instances.started.get(testRunId);
    if (!testParams) throw new Error("the test run was not started");
    await executeRun(
      deps(),
      testParams,
      cloudflareStepRunner(new FakeWorkflowStep(resolveAs(OPERATOR))),
    );
    expect((await H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/activate`)).status).toBe(
      200,
    );
    const res = await H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/run`, {
      workflow: "fix-record",
    });
    runId = j(res.json).runId;
    const params = H.instances.started.get(runId);
    if (!params) throw new Error("not started");
    expect(
      await executeRun(
        deps(),
        params,
        cloudflareStepRunner(new FakeWorkflowStep(resolveAs(admin("a")))),
      ),
    ).toEqual({ status: "succeeded" });
  });

  it("answers the run page as the run list does, with approvals and changes, in 9 statements", async () => {
    const res = await H.call(admin("a"), "GET", `/api/runs/${runId}`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(forbiddenKeys(res.json)).toEqual([]);
    const body = j(res.json);
    // The summary is the one the run list shows for the same run.
    const list = j((await H.call(admin("a"), "GET", "/api/runs")).json).runs;
    expect(body.run).toEqual(list.find((r: { id: string }) => r.id === runId));
    expect(body.run).toMatchObject({
      service: { id: agentId, name: "Record keeping" },
      status: "succeeded",
      waitingOnYou: false,
    });
    expect(body.approvals.map((a: { status: string }) => a.status)).toEqual([
      "resolved",
      "resolved",
    ]);
    expect(body.approvals.every((a: { approved: boolean }) => a.approved)).toBe(true);
    // The change item is named by its step, from the workflow the view read once.
    expect(body.approvals[0].title).not.toContain("testkit.record.update");
    expect(body.actions).toEqual([
      expect.objectContaining({
        status: "done",
        display: { connectorName: "Testkit", tool: null },
        executedAt: expect.any(String),
      }),
    ]);
    // Only the columns the view shows: never the change's before state or input.
    expect(Object.keys(body.actions[0]).sort()).toEqual(
      ["description", "display", "executedAt", "id", "status", "tool"].sort(),
    );

    // Before 6.2 the same call sent 13: the run row three times, the whole bundle twice.
    const { out, n } = await statements((tx) =>
      portalRunView(tx, H.A.tenantId, runId, H.platform, { userId: "x", role: "client_admin" }),
    );
    expect(JSON.parse(JSON.stringify(out))).toEqual({ ...body, run: out.run });
    expect(n).toBe(9);
  });

  it("serves a run's status in one statement, and a new key whenever the page would change", async () => {
    const res = await H.call(user("a"), "GET", `/api/runs/${runId}/status`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(forbiddenKeys(res.json)).toEqual([]);
    const status = j(res.json);
    const view = j((await H.call(user("a"), "GET", `/api/runs/${runId}`)).json);
    expect(status).toEqual({
      id: runId,
      status: view.run.status,
      waitingOnYou: view.run.waitingOnYou,
      updatedAt: expect.any(String),
      changeKey: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
    // Nothing on the page is later than the status says.
    const times = [
      view.run.startedAt,
      view.run.finishedAt,
      ...view.steps.flatMap((s: { startedAt: string; finishedAt: string }) => [
        s.startedAt,
        s.finishedAt,
      ]),
      ...view.approvals.map((a: { resolvedAt: string }) => a.resolvedAt),
      ...view.actions.map((a: { executedAt: string }) => a.executedAt),
    ].filter((t): t is string => typeof t === "string");
    for (const t of times)
      expect(Date.parse(status.updatedAt)).toBeGreaterThanOrEqual(Date.parse(t));
    // Asked again with nothing changed: the same key.
    expect(j((await H.call(user("a"), "GET", `/api/runs/${runId}/status`)).json)).toEqual(status);

    const { n } = await statements((tx) => portalRunStatus(tx, H.A.tenantId, runId));
    expect(n).toBe(1);

    // A step's summary changes with no timestamp moving: the key changes, so the page reloads.
    const [step] = await H.t.db
      .select({ id: stepRun.id, summary: stepRun.summary })
      .from(stepRun)
      .where(and(eq(stepRun.runId, runId), eq(stepRun.nodeId, "update")));
    if (!step) throw new Error("no step");
    await H.t.db
      .update(stepRun)
      .set({ summary: "Corrected the record: amount 12.00" })
      .where(eq(stepRun.id, step.id));
    const after = j((await H.call(user("a"), "GET", `/api/runs/${runId}/status`)).json);
    expect(after.changeKey).not.toBe(status.changeKey);
    expect(after.updatedAt).toBe(status.updatedAt);
    await H.t.db.update(stepRun).set({ summary: step.summary }).where(eq(stepRun.id, step.id));
    expect(j((await H.call(user("a"), "GET", `/api/runs/${runId}/status`)).json).changeKey).toBe(
      status.changeKey,
    );
  });

  it("gives a new key when a step goes waiting, a step finishes, or a conversation replies", async () => {
    const key = async () =>
      j((await H.call(user("a"), "GET", `/api/runs/${runId}/status`)).json).changeKey as string;
    const [step] = await H.t.db
      .select({ id: stepRun.id, status: stepRun.status, finishedAt: stepRun.finishedAt })
      .from(stepRun)
      .where(and(eq(stepRun.runId, runId), eq(stepRun.nodeId, "update")));
    if (!step) throw new Error("no step");
    const seen = new Set([await key()]);
    const fresh = async () => {
      const k = await key();
      expect(seen.has(k), "the key did not change").toBe(false);
      seen.add(k);
    };

    // Running, then waiting: no timestamp moves.
    await H.t.db
      .update(stepRun)
      .set({ status: "running", finishedAt: null })
      .where(eq(stepRun.id, step.id));
    await fresh();
    await H.t.db.update(stepRun).set({ status: "waiting" }).where(eq(stepRun.id, step.id));
    await fresh();
    // The step finishes.
    await H.t.db
      .update(stepRun)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(stepRun.id, step.id));
    await fresh();

    // A conversation on the run: it starts, then the person replies (status and times may stay).
    const [person] = await H.t.db
      .insert(contact)
      .values({ tenantId: H.A.tenantId, name: "Dana", email: "dana@example.com" })
      .returning({ id: contact.id });
    const [r] = await H.t.db
      .select({ agentVersionId: run.agentVersionId })
      .from(run)
      .where(eq(run.id, runId));
    if (!person || !r) throw new Error("no contact or run");
    const [talk] = await H.t.db
      .insert(reachOut)
      .values({
        tenantId: H.A.tenantId,
        agentId,
        agentVersionId: r.agentVersionId,
        runId,
        nodeId: "update",
        contactId: person.id,
        subject: `reach:${runId}:test`,
        purpose: "Confirm the amount",
        urgency: "normal",
        plan: {},
        status: "open",
      })
      .returning({ id: reachOut.id, updatedAt: reachOut.updatedAt });
    if (!talk) throw new Error("no conversation");
    await fresh();
    await H.t.db
      .update(reachOut)
      .set({ reply: { text: "Yes, 12.00", rawRecordId: null }, updatedAt: talk.updatedAt })
      .where(eq(reachOut.id, talk.id));
    await fresh();
    // The page itself still answers with the conversation on the run.
    expect((await H.call(user("a"), "GET", `/api/runs/${runId}`)).status).toBe(200);
    await H.t.db.delete(reachOut).where(eq(reachOut.id, talk.id));
  });

  it("hides test runs and other clients' runs from the status route", async () => {
    const [test] = await H.t.db.select({ mode: run.mode }).from(run).where(eq(run.id, testRunId));
    expect(test?.mode).toBe("test");
    expect((await H.call(admin("a"), "GET", `/api/runs/${testRunId}/status`)).status).toBe(404);
    expect((await H.call(admin("b"), "GET", `/api/runs/${runId}/status`)).status).toBe(404);
    expect(
      (await H.call(admin("a"), "GET", `/api/runs/${crypto.randomUUID()}/status`)).status,
    ).toBe(404);
  });

  it("answers the overview with a count of open items, its reads asked together", async () => {
    const res = await H.call(admin("a"), "GET", "/api/overview");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(forbiddenKeys(res.json)).toEqual([]);
    const body = j(res.json);
    const inbox = j((await H.call(admin("a"), "GET", "/api/inbox")).json).items;
    expect(body.needsYou).toEqual({ inbox: inbox.length });
    expect(body.services).toEqual([
      expect.objectContaining({ id: agentId, name: "Record keeping", status: "active" }),
    ]);
    const list = j((await H.call(admin("a"), "GET", "/api/runs?limit=5")).json).runs;
    // The overview's recent runs carry no subject (it never asked for one).
    expect(body.recentRuns).toEqual(list.map(({ subject: _s, ...r }: { subject?: unknown }) => r));
  });
});
