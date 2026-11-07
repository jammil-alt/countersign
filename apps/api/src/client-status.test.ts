// QA round 1 (client portal): one definition of a run's state and of the counts, over a
// throwaway database. A workflow run waiting on an approval keeps `status = 'running'`; the
// portal shows and counts it as waiting on you everywhere (Runs, its filter and chart, the Table,
// an agent's page, Reports), keeps its waiting time out of its working time, and counts the
// document that started a run as read by that agent.

import { createHash } from "node:crypto";
import {
  agent,
  agentVersion,
  docExtraction,
  document,
  inboxItem,
  run,
  tenant,
} from "@countersign/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, createApiHarness, testBundle, user } from "./api.test-helper";
import { todayIn } from "./routes/usage";
import { unionMs } from "./runs/client-status";

const h = await createApiHarness();
afterAll(() => h?.close());

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

describe("unionMs", () => {
  it("joins overlapping spans and sums the rest", () => {
    expect(unionMs([])).toBe(0);
    expect(
      unionMs([
        { from: 0, to: 10 },
        { from: 5, to: 15 },
        { from: 20, to: 25 },
        { from: 30, to: 30 },
      ]),
    ).toBe(20);
  });
});

describe.skipIf(!h)("a run as the client sees it", () => {
  const H = h as NonNullable<typeof h>;
  const db = H.t.db;
  const A = () => H.A.tenantId;
  const ids = {} as Record<
    "agent" | "version" | "waiting" | "done" | "ours" | "running" | "doc",
    string
  >;
  const HOUR = 3_600_000;
  const now = Date.now();

  beforeAll(async () => {
    // Late evening in Chicago is the next day in UTC: the chart buckets by the client's day.
    await db.update(tenant).set({ timezone: "America/Chicago" }).where(eq(tenant.id, A()));
    const [a] = await db
      .insert(agent)
      .values({
        tenantId: A(),
        kind: "client",
        slug: "bill-clerk",
        name: "Bill clerk",
        runStatus: "active",
        stage: "live",
      })
      .returning();
    if (!a) throw new Error("no agent");
    ids.agent = a.id;
    const [v] = await db
      .insert(agentVersion)
      .values({
        tenantId: A(),
        agentId: a.id,
        version: 1,
        bundle: testBundle("Bill clerk"),
        bundleHash: "hash-bill-clerk",
        status: "live",
        authorType: "operator",
      })
      .returning();
    if (!v) throw new Error("no version");
    ids.version = v.id;

    // Invoice 20418, read on upload (no agent), then matched by the Bill clerk's run.
    const [d] = await db
      .insert(document)
      .values({
        tenantId: A(),
        source: "upload",
        storageKey: "tenants/a/invoice-20418.pdf",
        mimeType: "application/pdf",
        filename: "invoice-20418.pdf",
        sizeBytes: 10,
        sha256: createHash("sha256").update("invoice-20418").digest("hex"),
        receivedAt: new Date(now - 23 * HOUR),
      })
      .returning();
    if (!d) throw new Error("no document");
    ids.doc = d.id;
    await db.insert(docExtraction).values({
      tenantId: A(),
      documentId: d.id,
      model: "replay",
      agentVersionId: null,
      header: {},
      currency: "USD",
      subtotal: "10.0000",
      total: "10.0000",
      linesSum: "10.0000",
      totalsMatch: true,
      createdAt: new Date(now - 23 * HOUR),
    });

    const addRun = async (o: {
      status: "running" | "succeeded";
      started: number;
      finished?: number;
      documentId?: string;
    }) => {
      const [r] = await db
        .insert(run)
        .values({
          tenantId: A(),
          agentId: ids.agent,
          agentVersionId: ids.version,
          workflowSlug: "invoice-read",
          mode: "live",
          status: o.status,
          trigger: o.documentId
            ? { type: "event", payload: { documentId: o.documentId } }
            : { type: "manual" },
          createdAt: new Date(o.started),
          startedAt: new Date(o.started),
          ...(o.finished ? { finishedAt: new Date(o.finished) } : {}),
        })
        .returning();
      if (!r) throw new Error("no run");
      return r.id;
    };

    // Running for 22 h, 21 of them waiting on the client's approval.
    ids.waiting = await addRun({ status: "running", started: now - 22 * HOUR, documentId: d.id });
    await db.insert(inboxItem).values({
      tenantId: A(),
      kind: "external_action",
      title: "Itemize bill 20418",
      runId: ids.waiting,
      agentId: ids.agent,
      assigneeRole: "client_admin",
      createdAt: new Date(now - 21 * HOUR),
    });
    // Finished: 3 h in all, 2 of them waiting on two overlapping approvals.
    ids.done = await addRun({
      status: "succeeded",
      started: now - 5 * HOUR,
      finished: now - 2 * HOUR,
    });
    for (const [from, to] of [
      [4, 2.5],
      [3.5, 2],
    ] as const) {
      await db.insert(inboxItem).values({
        tenantId: A(),
        kind: "approval",
        title: "Approve",
        runId: ids.done,
        agentId: ids.agent,
        assigneeRole: "client_admin",
        status: "resolved",
        createdAt: new Date(now - from * HOUR),
        resolvedAt: new Date(now - to * HOUR),
      });
    }
    // Waiting on us (an operator item): it is working, not waiting on the client.
    ids.ours = await addRun({ status: "running", started: now - HOUR });
    await db.insert(inboxItem).values({
      tenantId: A(),
      kind: "approval",
      title: "Escalated",
      runId: ids.ours,
      agentId: ids.agent,
      assigneeRole: "operator",
    });
  });

  it("lists a run waiting on an approval as waiting on you, with its wait kept apart", async () => {
    const res = await H.call(admin("a"), "GET", "/api/runs?limit=50");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const runs = j(res.json).runs as {
      id: string;
      status: string;
      waitingOnYou: boolean;
      waitedMs: number;
    }[];
    const byId = new Map(runs.map((r) => [r.id, r]));
    expect(byId.get(ids.waiting)).toMatchObject({ status: "running", waitingOnYou: true });
    expect(byId.get(ids.waiting)?.waitedMs).toBeGreaterThanOrEqual(21 * HOUR - 60_000);
    expect(byId.get(ids.ours)).toMatchObject({ waitingOnYou: false, waitedMs: 0 });
    // Two overlapping approvals (4 h–2.5 h and 3.5 h–2 h ago) are one 2 h wait.
    expect(byId.get(ids.done)).toMatchObject({ waitingOnYou: false, waitedMs: 2 * HOUR });
  });

  it("filters by the client's states: waiting on you is never running", async () => {
    const list = async (statuses: string) =>
      (
        j((await H.call(admin("a"), "GET", `/api/runs?statuses=${statuses}`)).json).runs as {
          id: string;
        }[]
      ).map((r) => r.id);
    const waiting = await list("waiting");
    expect(waiting).toContain(ids.waiting);
    expect(waiting).not.toContain(ids.ours);
    const going = await list("queued,running");
    expect(going).toContain(ids.ours);
    expect(going).not.toContain(ids.waiting);
    expect(await list("succeeded")).toContain(ids.done);
  });

  it("draws runs per day on the client's start day, by how each stands", async () => {
    const res = await H.call(admin("a"), "GET", `/api/runs?agents=${ids.agent}&perDay=1`);
    const perDay = j(res.json).perDay as {
      day: string;
      runs: number;
      failed: number;
      done: number;
      waiting: number;
      going: number;
      stopped: number;
    }[];
    const dayOf = (ms: number) =>
      new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date(ms));
    const sum = (k: "done" | "waiting" | "going" | "runs") => perDay.reduce((n, d) => n + d[k], 0);
    expect(sum("runs")).toBe(3);
    expect(sum("waiting")).toBe(1);
    expect(sum("going")).toBe(1);
    expect(sum("done")).toBe(1);
    // The waiting run sits on the day it started, as waiting, never as done.
    const started = perDay.find((d) => d.day === dayOf(now - 22 * HOUR));
    expect(started?.waiting).toBeGreaterThanOrEqual(1);
  });

  it("counts the same runs and documents on the Table, the agent's page and Reports", async () => {
    const table = j((await H.call(admin("a"), "GET", "/api/table")).json);
    const svc = j((await H.call(user("a"), "GET", `/api/services/${ids.agent}`)).json);
    const report = j(
      (await H.call(admin("a"), "GET", `/api/reports/activity?service=${ids.agent}`)).json,
    );
    // Near a month's or week's start the oldest run may fall before it; the counts still agree.
    const dayOf = (ms: number) =>
      new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date(ms));
    const inMonth = dayOf(now - 22 * HOUR).slice(0, 7) === todayIn("America/Chicago").slice(0, 7);
    const inWeek = new Date(now - 22 * HOUR) >= new Date(table.week.from);
    const clerk = table.services.find((s: { id: string }) => s.id === ids.agent);
    // The agent is waiting on you (any of its runs), and its latest run says why.
    expect(clerk.runsNow).toEqual({ running: 1, waitingOnYou: 1 });
    expect(table.figures.runs).toMatchObject({ waiting: inWeek ? 1 : 0 });
    expect(clerk.runs).toMatchObject({ waiting: inWeek ? 1 : 0, going: 1 });
    expect(clerk.runsDone).toBe(clerk.runs.succeeded);
    // UI cleanup: an agent built for this client alone has no template; the page knows whether
    // it reads documents (upload on its page).
    expect(svc.template).toBeNull();
    expect(typeof svc.readsDocuments).toBe("boolean");
    // The month (agent page) and Reports count the same way.
    expect(svc.thisMonth.runs).toEqual(report.services[0].runs);
    expect(svc.thisMonth.runs).toMatchObject({ waiting: inMonth ? 1 : 0, going: 1 });
    // Invoice 20418 was read on upload and worked on by the Bill clerk: it counts for both.
    expect(svc.thisMonth.documentsRead).toBe(inMonth ? 1 : 0);
    expect(report.services[0].documentsRead).toBe(svc.thisMonth.documentsRead);
    expect(report.documents.read).toBeGreaterThanOrEqual(report.services[0].documentsRead);
    // Its history says the same of the run: waiting on you, with its wait.
    const mine = svc.recentRuns.find((r: { id: string }) => r.id === ids.waiting);
    expect(mine).toMatchObject({ status: "running", waitingOnYou: true });
    expect(mine.waitedMs).toBeGreaterThan(0);
    // The sidebar's route carries the same state.
    const overview = j((await H.call(user("a"), "GET", "/api/overview")).json);
    const row = overview.services.find((s: { id: string }) => s.id === ids.agent);
    expect(row).toMatchObject({ stage: "live", runsNow: { running: 1, waitingOnYou: 1 } });
  });
});
