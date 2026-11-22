// R4: a report per agent (docs/reporting-plan.md §3 R4, docs/plan.md §1.214), against a real
// database as cs_worker. Both surfaces' figures for one agent's live runs in a period, compared
// with the period before; each figure's filter opens exactly its runs on that surface's runs
// list; the portal carries no cost, bundle, instructions or errors, nothing from a step its
// timeline doesn't show, and only its own client (invariants 1 and 11); and the CSVs.

import { TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import { runFilterQuery } from "@countersign/core";
import {
  agent,
  agentVersion,
  appUser,
  externalAction,
  inboxItem,
  membership,
  run,
  runSubject,
  stepRun,
  vendor,
} from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  forbiddenKeys,
  OPERATOR,
  testBundle,
  user,
} from "./api.test-helper";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const h = await createApiHarness();
afterAll(() => h?.close());

/** Keys a portal answer here may never carry, beyond the contract's. */
const PORTAL_EXTRA =
  /^(template|templateId|templates|tenantId|clients|bundle|instructions?|prompts?|input|output|mode|errors?|errorKey|spend|.*[cC]ost.*|tokens.*)$/;

const PERIOD = "from=2026-11-01&to=2026-11-30";
const at = (day: number, hour: number, minute = 0) =>
  new Date(Date.UTC(2026, 10, day, hour, minute));

describe.skipIf(!h)("the report per agent", () => {
  const H = h as ApiHarness;
  const owner = H.t.db;
  const ids = {} as Record<"agentA" | "otherA" | "agentB" | "adminA" | "operator", string>;
  /**
   * r1: done on the 2nd, a change signed by A's admin; r2: failed on the 3rd, with a step its
   * timeline hides; r3: waiting on the 4th; r4: a test run; r5: another agent's; r6: October's;
   * rB: client B's.
   */
  const runs = {} as Record<"r1" | "r2" | "r3" | "r4" | "r5" | "r6" | "rB", string>;
  let keys = 0;

  async function addAgent(tenantId: string, slug: string, name: string) {
    const [a] = await owner
      .insert(agent)
      .values({
        tenantId,
        kind: "client",
        slug,
        name,
        serviceName: name,
        runStatus: "active",
        stage: "live",
      })
      .returning();
    if (!a) throw new Error("no agent");
    const [v] = await owner
      .insert(agentVersion)
      .values({
        tenantId,
        agentId: a.id,
        version: 1,
        bundle: testBundle(name),
        bundleHash: `hash-${slug}`,
        status: "live",
        authorType: "operator",
      })
      .returning();
    if (!v) throw new Error("no version");
    await owner.update(agent).set({ liveVersionId: v.id }).where(eq(agent.id, a.id));
    return { id: a.id, version: v.id };
  }

  async function addRun(
    tenantId: string,
    a: { id: string; version: string },
    values: Partial<typeof run.$inferInsert> & { createdAt: Date },
  ) {
    const [r] = await owner
      .insert(run)
      .values({
        tenantId,
        agentId: a.id,
        agentVersionId: a.version,
        workflowSlug: "fix-record",
        mode: "live",
        status: "succeeded",
        trigger: { type: "manual" },
        startedAt: values.createdAt,
        ...values,
      })
      .returning();
    if (!r) throw new Error("no run");
    return r.id;
  }

  async function addStep(tenantId: string, runId: string, summary: string) {
    keys += 1;
    const [s] = await owner
      .insert(stepRun)
      .values({
        tenantId,
        runId,
        nodeId: `step-${keys}`,
        nodeType: "tool",
        status: "succeeded",
        summary,
        tokensIn: 900,
        tokensOut: 300,
      })
      .returning();
    if (!s) throw new Error("no step");
    return s.id;
  }

  async function change(tenantId: string, connectionId: string, runId: string, amount: string) {
    keys += 1;
    const [item] = await owner
      .insert(inboxItem)
      .values({
        tenantId,
        kind: "external_action",
        runId,
        title: "Change the record",
        assigneeRole: "client_admin",
        status: "resolved",
        resolution: { approved: true, answer: null, by: ids.adminA },
        resolvedBy: ids.adminA,
        createdAt: at(2, 9, 1),
        resolvedAt: at(2, 9, 31),
      })
      .returning();
    await owner.insert(externalAction).values({
      tenantId,
      connectionId,
      tool: TESTKIT_UPDATE_TOOL,
      runId,
      idempotencyKey: `${runId}:update:${keys}`,
      input: { id: "R-1001", amount },
      status: "done",
      inboxItemId: item?.id,
      approvedBy: ids.adminA,
      executedAt: at(2, 9, 32),
    });
  }

  beforeAll(async () => {
    const A = H.A.tenantId;
    const B = H.B.tenantId;
    const [adminA] = await owner
      .select()
      .from(appUser)
      .where(eq(appUser.email, admin("a")));
    const [operator] = await owner.select().from(appUser).where(eq(appUser.email, OPERATOR));
    ids.adminA = adminA?.id as string;
    ids.operator = operator?.id as string;
    const a = await addAgent(A, "report-clerk", "Report clerk");
    const other = await addAgent(A, "other-clerk", "Other clerk");
    const b = await addAgent(B, "report-clerk", "Report clerk");
    ids.agentA = a.id;
    ids.otherA = other.id;
    ids.agentB = b.id;
    const [acme] = await owner
      .insert(vendor)
      .values({ tenantId: A, name: "Acme Supply", normalizedName: "acme supply" })
      .returning();
    const [hidden] = await owner
      .insert(vendor)
      .values({ tenantId: A, name: "Hidden Vendor", normalizedName: "hidden vendor" })
      .returning();
    if (!acme || !hidden) throw new Error("no vendors");

    runs.r1 = await addRun(A, a, {
      createdAt: at(2, 9),
      finishedAt: at(2, 9, 40),
      costUsd: "0.2500",
    });
    const read = await addStep(A, runs.r1, "Read the invoice from Acme Supply");
    await owner.insert(runSubject).values({
      tenantId: A,
      runId: runs.r1,
      stepRunId: read,
      kind: "vendor",
      role: "read",
      recordId: acme.id,
      label: "Acme Supply",
      clientVisible: true,
    });
    await change(A, H.A.connectionId, runs.r1, "120.50");

    runs.r2 = await addRun(A, a, {
      createdAt: at(3, 10),
      finishedAt: at(3, 10, 5),
      status: "failed",
      error: { key: "testkit.timeout", reason: "The tool timed out" },
      costUsd: "0.5000",
    });
    const secret = await addStep(A, runs.r2, "Checked the secret price list");
    await owner.insert(runSubject).values({
      tenantId: A,
      runId: runs.r2,
      stepRunId: secret,
      kind: "vendor",
      role: "read",
      recordId: hidden.id,
      label: "Hidden Vendor",
      clientVisible: false,
    });
    // We stepped in on one of its items: the portal never names our person.
    await owner.insert(inboxItem).values({
      tenantId: A,
      kind: "approval",
      runId: runs.r2,
      title: "Is the price right?",
      assigneeRole: "client_admin",
      status: "resolved",
      payload: {
        steppedIn: { action: "decide", reason: "Urgent", at: at(3, 10, 2).toISOString() },
      },
      resolution: { approved: false, steppedIn: { by: ids.operator } },
      resolvedBy: ids.operator,
      createdAt: at(3, 10, 1),
      resolvedAt: at(3, 10, 2),
    });

    runs.r3 = await addRun(A, a, { createdAt: at(4, 11), status: "waiting" });
    await owner.insert(inboxItem).values({
      tenantId: A,
      kind: "approval",
      runId: runs.r3,
      title: "Approve the change",
      assigneeRole: "client_admin",
      createdAt: at(4, 11, 1),
    });
    runs.r4 = await addRun(A, a, { createdAt: at(5, 9), mode: "test" });
    runs.r5 = await addRun(A, other, { createdAt: at(5, 9) });
    runs.r6 = await addRun(A, a, {
      createdAt: new Date(Date.UTC(2026, 9, 20, 9)),
      finishedAt: new Date(Date.UTC(2026, 9, 20, 9, 1)),
    });
    runs.rB = await addRun(B, b, { createdAt: at(2, 9), finishedAt: at(2, 9, 10) });
  });

  const get = async (who: string, path: string) => {
    const res = await H.call(who, "GET", path);
    expect(res.status, `${path}: ${JSON.stringify(res.json)}`).toBe(200);
    return j(res.json);
  };
  const portalRuns = async (filter: Record<string, unknown>) => {
    const q = new URLSearchParams({ ...runFilterQuery(filter as never), limit: "100" });
    return (j(await get(admin("a"), `/api/runs?${q}`)).runs as { id: string }[])
      .map((r) => r.id)
      .sort();
  };
  const opsRuns = async (filter: Record<string, unknown>) => {
    const q = new URLSearchParams({ ...runFilterQuery(filter as never), limit: "100" });
    return (j(await get(OPERATOR, `/api/ops/runs?${q}`)).runs as { id: string }[])
      .map((r) => r.id)
      .sort();
  };
  const sorted = (...list: string[]) => [...list].sort();

  it("counts the portal one agent's live runs in the period, by outcome and day", async () => {
    const body = await get(admin("a"), `/api/services/${ids.agentA}/report?${PERIOD}`);
    expect(body.service).toEqual({ id: ids.agentA, name: "Report clerk" });
    expect(body.runs.count).toBe(3);
    expect(body.outcomes.done.count).toBe(1);
    expect(body.outcomes.failed.count).toBe(1);
    expect(body.outcomes.waiting.count).toBe(1);
    expect(body.perDay).toHaveLength(30);
    expect(body.perDay[1]).toMatchObject({ day: "2026-11-02", done: { count: 1 } });
    expect(body.timeToFinish).toMatchObject({ runs: { count: 1 }, medianMs: 40 * 60_000 });
    expect(body.waitingOnPeople).toMatchObject({ answered: 2, open: 1 });
    expect(body.approvals).toMatchObject({ signed: 1, edited: 0, turnedDown: 1 });
    const us = body.approvals.byPerson.find((p: { steppedIn: boolean }) => p.steppedIn);
    expect(us).toMatchObject({ person: null, filter: null, turnedDown: 1 });
    expect(body.changes.total.count).toBe(1);
    expect(body.changes.amounts).toEqual([{ currency: "USD", total: "120.5000" }]);
    expect(body.changes.byConnector[0]).toMatchObject({
      connector: "testkit",
      count: 1,
      entities: [{ entity: "record", count: 1 }],
    });
    // What it handled: only the steps the client's timeline shows.
    expect(body.handled).toHaveLength(1);
    expect(body.handled[0]).toMatchObject({ kind: "vendor", records: 1, runs: 1 });
    expect(body.handled[0].top[0]).toMatchObject({ label: "Acme Supply", runs: 1 });
    // October's run is the period before: last month, the whole of it.
    expect(body.previous).toMatchObject({ from: "2026-10-02", to: "2026-10-31", runs: 1 });
    expect(body.headline).toMatchObject({ runs: 3, done: 1, failed: 1, changes: 1, approvals: 2 });
  });

  it("opens exactly each figure's runs on the portal's runs list", async () => {
    const body = await get(admin("a"), `/api/services/${ids.agentA}/report?${PERIOD}`);
    expect(await portalRuns(body.runs.filter)).toEqual(sorted(runs.r1, runs.r2, runs.r3));
    expect(await portalRuns(body.outcomes.done.filter)).toEqual([runs.r1]);
    expect(await portalRuns(body.outcomes.failed.filter)).toEqual([runs.r2]);
    expect(await portalRuns(body.outcomes.waiting.filter)).toEqual([runs.r3]);
    expect(await portalRuns(body.perDay[2].failed.filter)).toEqual([runs.r2]);
    expect(await portalRuns(body.perDay[2].done.filter)).toEqual([]);
    expect(await portalRuns(body.timeToFinish.runs.filter)).toEqual([runs.r1]);
    expect(await portalRuns(body.changes.byConnector[0].filter)).toEqual([runs.r1]);
    const mine = body.approvals.byPerson.find(
      (p: { person: { id: string } | null }) => p.person?.id === ids.adminA,
    );
    expect(mine).toMatchObject({ signed: 1 });
    expect(await portalRuns(mine.filter)).toEqual([runs.r1]);
    expect(await portalRuns(body.handled[0].filter)).toEqual([runs.r1]);
    expect(await portalRuns(body.handled[0].top[0].filter)).toEqual([runs.r1]);
  });

  it("carries no cost, bundle, instructions, errors or hidden step on the portal", async () => {
    for (const who of [admin("a"), user("a")]) {
      const body = await get(who, `/api/services/${ids.agentA}/report?${PERIOD}`);
      expect(forbiddenKeys(body, PORTAL_EXTRA)).toEqual([]);
      const text = JSON.stringify(body);
      for (const hidden of ["Hidden Vendor", "secret", "testkit.timeout", ids.operator, runs.rB]) {
        expect(text).not.toContain(hidden);
      }
    }
    const csv = await H.call(admin("a"), "GET", `/api/services/${ids.agentA}/report.csv?${PERIOD}`);
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(String(csv.json)).toContain("section,item,figure,value,currency");
    expect(String(csv.json)).toContain("changes,,amount,120.5000,USD");
    expect(String(csv.json)).toContain("handled,vendor: Acme Supply,runs,1,");
    for (const hidden of ["cost", "tokens", "Hidden Vendor", "testkit.timeout"]) {
      expect(String(csv.json)).not.toContain(hidden);
    }
  });

  it("answers only for the client's own services, and a limited person's", async () => {
    for (const [who, id] of [
      [admin("b"), ids.agentA],
      [admin("a"), ids.agentB],
    ] as const) {
      expect((await H.call(who, "GET", `/api/services/${id}/report`)).status).toBe(404);
      expect((await H.call(who, "GET", `/api/services/${id}/report.csv`)).status).toBe(404);
    }
    const b = await get(admin("b"), `/api/services/${ids.agentB}/report?${PERIOD}`);
    expect(b.runs.count).toBe(1);
    expect(JSON.stringify(b)).not.toContain(runs.r1);

    const [person] = await owner
      .select()
      .from(appUser)
      .where(eq(appUser.email, user("a")));
    const limit = async (agentIds: string[] | null) =>
      owner
        .update(membership)
        .set({ agentIds })
        .where(
          and(eq(membership.tenantId, H.A.tenantId), eq(membership.userId, person?.id as string)),
        );
    await limit([ids.otherA]);
    try {
      const mine = await H.call(user("a"), "GET", `/api/services/${ids.otherA}/report?${PERIOD}`);
      expect(mine.status).toBe(200);
      expect(j(mine.json).runs.count).toBe(1);
      expect((await H.call(user("a"), "GET", `/api/services/${ids.agentA}/report`)).status).toBe(
        404,
      );
    } finally {
      await limit(null);
    }
  });

  it("gives the back office the same figures with its errors and cost", async () => {
    const body = await get(OPERATOR, `/api/ops/agents/${ids.agentA}/report?${PERIOD}`);
    expect(body.client).toEqual({ id: H.A.tenantId, name: expect.any(String) });
    expect(body.runs.count).toBe(3);
    expect(body.outcomes.done.count).toBe(1);
    expect(body.errors).toEqual([
      {
        key: "testkit.timeout",
        count: 1,
        filter: expect.objectContaining({ errorKey: "testkit.timeout" }),
      },
    ]);
    expect(body.spend).toMatchObject({
      runs: 3,
      costUsd: "0.7500",
      costPerRunUsd: "0.2500",
      tokensIn: 1800,
      tokensOut: 600,
      tokensPerRun: 800,
    });
    // The back office names who stepped in, and reads every step's subjects.
    const us = body.approvals.byPerson.find((p: { steppedIn: boolean }) => p.steppedIn);
    expect(us.person.id).toBe(ids.operator);
    expect(body.handled[0]).toMatchObject({ kind: "vendor", records: 2, runs: 2 });
    // Each filter opens exactly its runs on the back office's list (test runs left out).
    expect(await opsRuns(body.runs.filter)).toEqual(sorted(runs.r1, runs.r2, runs.r3));
    expect(await opsRuns(body.errors[0].filter)).toEqual([runs.r2]);
    expect(await opsRuns(body.spend.filter)).toEqual(sorted(runs.r1, runs.r2, runs.r3));
    expect(await opsRuns(body.outcomes.waiting.filter)).toEqual([runs.r3]);
    expect(await opsRuns(body.handled[0].filter)).toEqual(sorted(runs.r1, runs.r2));

    const csv = await H.call(OPERATOR, "GET", `/api/ops/agents/${ids.agentA}/report.csv?${PERIOD}`);
    expect(csv.status).toBe(200);
    expect(String(csv.json)).toContain("errors,testkit.timeout,count,1,");
    expect(String(csv.json)).toContain("cost,,cost_usd,0.7500,USD");
  });

  it("refuses the back office's route to a client, and the portal's to the operator", async () => {
    expect((await H.call(admin("a"), "GET", `/api/ops/agents/${ids.agentA}/report`)).status).toBe(
      403,
    );
    expect((await H.call(OPERATOR, "GET", `/api/services/${ids.agentA}/report`)).status).not.toBe(
      200,
    );
    expect(
      (
        await H.call(
          admin("a"),
          "GET",
          `/api/services/${ids.agentA}/report?from=2026-11-30&to=2026-11-01`,
        )
      ).status,
    ).toBe(422);
  });
});
