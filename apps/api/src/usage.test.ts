// Usage and reports (docs/plan.md §1.15) over a throwaway database: the usage_daily rollup sums
// cost as decimals and counts documents per client agent; the back office's usage is per client,
// client agent and template, by month, and an operator sees only the clients they serve; the
// portal's activity report and service page count live work in the client's own days and carry no
// cost, tokens or prompts.

import { createHash } from "node:crypto";
import {
  rollupUsageDays,
  rollupUsageForRun,
  USAGE_ROLLUP_MAX_DAYS,
  utcDaysBetween,
} from "@countersign/agents";
import { FORBIDDEN_PORTAL_FIELD } from "@countersign/core";
import {
  agent,
  agentVersion,
  docExtraction,
  document,
  externalAction,
  run,
  stepRun,
  tenant,
  usageDaily,
  withTenant,
} from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  admin,
  createApiHarness,
  OPERATOR,
  OTHER_OPERATOR,
  testBundle,
  user,
} from "./api.test-helper";
import { monthStart, monthsBetween, todayIn } from "./routes/usage";
import { cronTick, USAGE_SWEEP_MINUTE, usageSweepDays } from "./runs/dispatch";

const h = await createApiHarness();
afterAll(() => h?.close());

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

/** Every key in a JSON value that a portal response may never carry. */
function forbiddenKeys(value: unknown, at = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => forbiddenKeys(v, `${at}[${i}]`));
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([k, v]) => [
    ...(FORBIDDEN_PORTAL_FIELD.test(k) || /token|prompt|model/i.test(k) ? [`${at}.${k}`] : []),
    ...forbiddenKeys(v, `${at}.${k}`),
  ]);
}

const DAYS = ["2026-10-15", "2026-11-01", "2026-11-02", "2026-11-03"];

describe("utc days", () => {
  it("lists every day between two, inclusive, keeping the newest when capped", () => {
    expect(utcDaysBetween("2026-10-30", "2026-11-02")).toEqual([
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
    ]);
    expect(utcDaysBetween("2026-11-02", "2026-11-02")).toEqual(["2026-11-02"]);
    expect(utcDaysBetween("2026-11-03", "2026-11-02")).toEqual([]);
    const long = utcDaysBetween("2026-01-01", "2026-12-31");
    expect(long).toHaveLength(USAGE_ROLLUP_MAX_DAYS);
    expect(long.at(-1)).toBe("2026-12-31");
    expect(usageSweepDays(new Date("2026-11-01T00:07:00Z"))).toEqual(["2026-10-31", "2026-11-01"]);
  });

  it("knows months and days in a time zone", () => {
    expect(monthsBetween("2026-10-15", "2027-01-02")).toEqual([
      "2026-10",
      "2026-11",
      "2026-12",
      "2027-01",
    ]);
    expect(monthStart("2026-03-31", 5)).toBe("2025-10-01");
    expect(todayIn("America/Chicago", new Date("2026-11-01T03:00:00Z"))).toBe("2026-10-31");
    expect(todayIn("Not/AZone", new Date("2026-11-01T03:00:00Z"))).toBe("2026-11-01");
  });
});

describe.skipIf(!h)("usage and reports", () => {
  const H = h as NonNullable<typeof h>;
  const call = H.call.bind(H);
  const db = H.t.db;
  const ids = {} as Record<"tpl" | "aA" | "aA2" | "aB" | "aC" | "r2" | "copy", string>;
  const versions = {} as Record<"aA" | "aA2" | "aB" | "aC", string>;

  async function clientAgent(
    key: "aA" | "aA2" | "aB" | "aC",
    tenantId: string,
    values: Partial<typeof agent.$inferInsert>,
  ) {
    const [a] = await db
      .insert(agent)
      .values({ tenantId, kind: "client", slug: key.toLowerCase(), name: key, ...values })
      .returning();
    if (!a) throw new Error("no agent");
    const [v] = await db
      .insert(agentVersion)
      .values({
        tenantId,
        agentId: a.id,
        version: 1,
        bundle: testBundle(),
        bundleHash: `hash-${key}`,
        status: "live",
        authorType: "operator",
      })
      .returning();
    if (!v) throw new Error("no version");
    ids[key] = a.id;
    versions[key] = v.id;
  }

  /** A run with its steps (cost as decimal strings) and done actions. */
  async function addRun(
    key: "aA" | "aA2" | "aB" | "aC",
    tenantId: string,
    o: {
      at: string;
      mode?: "live" | "test";
      status: "succeeded" | "failed" | "waiting";
      steps: { cost: string; at?: string; tokensIn?: number; tokensOut?: number }[];
      actions?: { at: string; connectionId: string }[];
    },
  ): Promise<string> {
    const [r] = await db
      .insert(run)
      .values({
        tenantId,
        agentId: ids[key],
        agentVersionId: versions[key],
        workflowSlug: "fix-record",
        mode: o.mode ?? "live",
        status: o.status,
        startedAt: new Date(o.at),
        createdAt: new Date(o.at),
      })
      .returning();
    if (!r) throw new Error("no run");
    await db.insert(stepRun).values(
      o.steps.map((s, i) => ({
        tenantId,
        runId: r.id,
        nodeId: `step-${i}`,
        nodeType: "skill",
        status: "succeeded" as const,
        costUsd: s.cost,
        tokensIn: s.tokensIn ?? 0,
        tokensOut: s.tokensOut ?? 0,
        startedAt: new Date(s.at ?? o.at),
      })),
    );
    for (const [i, a] of (o.actions ?? []).entries()) {
      await db.insert(externalAction).values({
        tenantId,
        connectionId: a.connectionId,
        tool: "testkit.record.update",
        runId: r.id,
        idempotencyKey: `${r.id}:update:${i}`,
        status: "done",
        executedAt: new Date(a.at),
      });
    }
    return r.id;
  }

  async function addDocument(name: string, at: string, readBy: (string | null)[]) {
    const [d] = await db
      .insert(document)
      .values({
        tenantId: H.A.tenantId,
        source: "upload",
        storageKey: `tenants/a/${name}`,
        mimeType: "application/pdf",
        filename: name,
        sizeBytes: 10,
        sha256: createHash("sha256").update(name).digest("hex"),
        receivedAt: new Date(at),
      })
      .returning();
    if (!d) throw new Error("no document");
    for (const [i, versionId] of readBy.entries()) {
      await db.insert(docExtraction).values({
        tenantId: H.A.tenantId,
        documentId: d.id,
        model: "replay",
        agentVersionId: versionId,
        header: {},
        currency: "USD",
        subtotal: "10.0000",
        total: "10.0000",
        linesSum: "10.0000",
        totalsMatch: true,
        createdAt: new Date(new Date(at).getTime() + (i + 1) * 60_000),
      });
    }
  }

  async function rollupAll() {
    for (const c of [H.A, H.B, H.C]) {
      await withTenant(H.db, c.tenantId, (tx) =>
        rollupUsageDays(tx, { tenantId: c.tenantId, days: DAYS }),
      );
    }
  }

  beforeAll(async () => {
    // Client A's days are Chicago's: 2026-11-01T03:00Z is still October 31 there.
    await db.update(tenant).set({ timezone: "America/Chicago" }).where(eq(tenant.id, H.A.tenantId));
    const [tpl] = await db
      .insert(agent)
      .values({ kind: "template", slug: "records", name: "Records clerk" })
      .returning();
    if (!tpl) throw new Error("no template");
    ids.tpl = tpl.id;
    const fork = { templateId: tpl.id, runStatus: "active" as const };
    await clientAgent("aA", H.A.tenantId, {
      ...fork,
      name: "Records clerk",
      serviceName: "Record keeping",
      serviceDescription: "Keeps your records right.",
    });
    await clientAgent("aA2", H.A.tenantId, { name: "Notes", runStatus: "paused" });
    await clientAgent("aB", H.B.tenantId, fork);
    await clientAgent("aC", H.C.tenantId, fork);
    const [copy] = await db
      .insert(agent)
      .values({
        tenantId: H.A.tenantId,
        kind: "client",
        slug: "records-test",
        name: "Records clerk (test)",
        templateId: tpl.id,
        testCopy: true,
      })
      .returning();
    ids.copy = copy?.id as string;

    const A = H.A.tenantId;
    await addRun("aA", A, {
      at: "2026-10-15T12:00:00Z",
      status: "succeeded",
      // 0.1 + 0.2 is the float trap: the rollup must give exactly 0.3000.
      steps: [
        { cost: "0.1000", tokensIn: 100, tokensOut: 50 },
        { cost: "0.2000", tokensIn: 200, tokensOut: 25 },
      ],
      actions: [{ at: "2026-10-15T12:01:00Z", connectionId: H.A.connectionId }],
    });
    // Waits overnight: its last step and its change land on the next day.
    ids.r2 = await addRun("aA", A, {
      at: "2026-11-02T14:00:00Z",
      status: "waiting",
      steps: [
        { cost: "0.0001" },
        { cost: "0.0002" },
        { cost: "0.0004", at: "2026-11-03T15:00:00Z" },
      ],
      actions: [{ at: "2026-11-03T15:00:05Z", connectionId: H.A.connectionId }],
    });
    await addRun("aA", A, {
      at: "2026-11-02T15:00:00Z",
      mode: "test",
      status: "succeeded",
      steps: [{ cost: "0.0500" }],
    });
    await addRun("aA2", A, {
      at: "2026-11-03T16:00:00Z",
      status: "failed",
      steps: [{ cost: "0.0700" }],
    });
    await addRun("aA2", A, {
      at: "2026-11-01T03:00:00Z",
      status: "succeeded",
      steps: [{ cost: "0.0100" }],
    });
    await addRun("aB", H.B.tenantId, {
      at: "2026-11-01T12:00:00Z",
      status: "succeeded",
      steps: [{ cost: "0.4000" }],
    });
    await addRun("aC", H.C.tenantId, {
      at: "2026-11-01T12:00:00Z",
      status: "succeeded",
      steps: [{ cost: "9.0000" }],
    });
    // Read twice by the service (one document), and one read in the background (no agent).
    await addDocument("invoice-1.pdf", "2026-11-02T14:10:00Z", [versions.aA, versions.aA]);
    await addDocument("invoice-2.pdf", "2026-11-02T16:00:00Z", [null]);
    await rollupAll();
  });

  const usageOf = async (tenantId: string, agentId: string, day: string) => {
    const [row] = await db
      .select()
      .from(usageDaily)
      .where(
        and(
          eq(usageDaily.tenantId, tenantId),
          eq(usageDaily.agentId, agentId),
          eq(usageDaily.day, day),
        ),
      );
    return row;
  };

  it("rolls up per client agent and UTC day, summing cost as decimals", async () => {
    expect(await usageOf(H.A.tenantId, ids.aA, "2026-10-15")).toMatchObject({
      runs: 1,
      steps: 2,
      externalActions: 1,
      documents: 0,
      tokensIn: 300,
      tokensOut: 75,
      costUsd: "0.3000",
    });
    // The live run and the test run (test runs cost the operator too); one document read twice.
    expect(await usageOf(H.A.tenantId, ids.aA, "2026-11-02")).toMatchObject({
      runs: 2,
      steps: 3,
      documents: 1,
      externalActions: 0,
      costUsd: "0.0503",
    });
    expect(await usageOf(H.A.tenantId, ids.aA, "2026-11-03")).toMatchObject({
      runs: 0,
      steps: 1,
      externalActions: 1,
      costUsd: "0.0004",
    });
    // The background read belongs to no agent.
    const nov2 = await db.select().from(usageDaily).where(eq(usageDaily.day, "2026-11-02"));
    expect(nov2.reduce((n, r) => n + r.documents, 0)).toBe(1);
    // Recomputing changes nothing.
    const before = await db.select().from(usageDaily);
    await rollupAll();
    expect(await db.select().from(usageDaily)).toEqual(before);
  });

  it("rolls up every day a finished run touched", async () => {
    await db.delete(usageDaily).where(eq(usageDaily.tenantId, H.A.tenantId));
    await withTenant(H.db, H.A.tenantId, (tx) =>
      rollupUsageForRun(tx, {
        tenantId: H.A.tenantId,
        runId: ids.r2,
        now: new Date("2026-11-03T20:00:00Z"),
      }),
    );
    expect((await usageOf(H.A.tenantId, ids.aA, "2026-11-02"))?.costUsd).toBe("0.0503");
    expect((await usageOf(H.A.tenantId, ids.aA, "2026-11-03"))?.costUsd).toBe("0.0004");
    await rollupAll();
  });

  it("sweeps today and yesterday from the cron once an hour", async () => {
    const now = new Date();
    now.setUTCMinutes(USAGE_SWEEP_MINUTE + 1, 0, 0);
    const today = now.toISOString().slice(0, 10);
    await addRun("aB", H.B.tenantId, {
      at: new Date(now.getTime() - 60_000).toISOString(),
      status: "waiting",
      steps: [{ cost: "0.0010" }],
    });
    const deps = { db: H.db, instances: H.instances };
    await cronTick(deps, now);
    expect(await usageOf(H.B.tenantId, ids.aB, today)).toBeUndefined();
    const sweep = new Date(now);
    sweep.setUTCMinutes(USAGE_SWEEP_MINUTE);
    await cronTick(deps, sweep);
    expect((await usageOf(H.B.tenantId, ids.aB, today))?.costUsd).toBe("0.0010");
  });

  const RANGE = "from=2026-10-01&to=2026-11-03";

  it("reports usage per client, client agent and template, by month, for the clients served", async () => {
    const res = await call(OPERATOR, "GET", `/api/ops/usage?${RANGE}`);
    expect(res.status).toBe(200);
    const u = j(res.json);
    expect(u.months).toEqual(["2026-10", "2026-11"]);
    expect(u.total).toMatchObject({ runs: 6, steps: 9, documents: 1, costUsd: "0.8307" });
    expect(u.byMonth.map((m: { figures: { costUsd: string } }) => m.figures.costUsd)).toEqual([
      "0.3000",
      "0.5307",
    ]);
    // Client C is served by another operator: never here.
    expect(u.clients.map((c: { name: string; total: { costUsd: string } }) => c)).toMatchObject([
      { id: H.A.tenantId, name: "Client A", total: { costUsd: "0.4307", runs: 5 } },
      { id: H.B.tenantId, name: "Client B", total: { costUsd: "0.4000", runs: 1 } },
    ]);
    expect(u.clients[0].byMonth).toMatchObject([
      { month: "2026-10", figures: { costUsd: "0.3000" } },
      { month: "2026-11", figures: { costUsd: "0.1307" } },
    ]);
    expect(u.agents).toMatchObject([
      {
        id: ids.aB,
        client: { id: H.B.tenantId },
        template: { id: ids.tpl },
        total: { costUsd: "0.4000" },
      },
      {
        id: ids.aA,
        name: "Records clerk",
        template: { id: ids.tpl, name: "Records clerk" },
        testCopy: false,
        total: { costUsd: "0.3507", externalActions: 2, tokensIn: 300 },
      },
      { id: ids.aA2, template: null, total: { costUsd: "0.0800" } },
    ]);
    expect(u.templates).toEqual([
      expect.objectContaining({
        id: ids.tpl,
        slug: "records",
        clients: 2,
        agents: 2,
        total: expect.objectContaining({ runs: 4, costUsd: "0.7507" }),
      }),
    ]);
    expect(JSON.stringify(u)).not.toContain(H.C.tenantId);
  });

  it("filters by client, client agent and template, and refuses clients not served", async () => {
    const a = j(
      (await call(OPERATOR, "GET", `/api/ops/usage?${RANGE}&client=${H.A.tenantId}`)).json,
    );
    expect(a.clients.map((c: { id: string }) => c.id)).toEqual([H.A.tenantId]);
    expect(a.total.costUsd).toBe("0.4307");
    const t = j((await call(OPERATOR, "GET", `/api/ops/usage?${RANGE}&template=${ids.tpl}`)).json);
    expect(t.agents.map((x: { id: string }) => x.id).sort()).toEqual([ids.aA, ids.aB].sort());
    expect(t.total.costUsd).toBe("0.7507");
    const one = j((await call(OPERATOR, "GET", `/api/ops/usage?${RANGE}&agent=${ids.aA2}`)).json);
    expect(one.agents.map((x: { id: string }) => x.id)).toEqual([ids.aA2]);
    expect(one.templates).toEqual([]);
    // Another client's agent id finds nothing, and another client is refused outright.
    const other = j((await call(OPERATOR, "GET", `/api/ops/usage?${RANGE}&agent=${ids.aC}`)).json);
    expect(other.total.costUsd).toBe("0.0000");
    expect((await call(OPERATOR, "GET", `/api/ops/usage?client=${H.C.tenantId}`)).status).toBe(403);
    const c = j((await call(OTHER_OPERATOR, "GET", `/api/ops/usage?${RANGE}`)).json);
    expect(c.clients.map((x: { id: string }) => x.id)).toEqual([H.C.tenantId]);
    expect(c.total.costUsd).toBe("9.0000");
    // Cost is operator-only.
    for (const who of [admin("a"), user("a")]) {
      expect((await call(who, "GET", "/api/ops/usage")).status).toBe(403);
    }
  });

  it("checks the range", async () => {
    const bad = async (q: string) => (await call(OPERATOR, "GET", `/api/ops/usage?${q}`)).status;
    expect(await bad("from=2026-11-03&to=2026-11-01")).toBe(422);
    expect(await bad("from=2020-01-01&to=2026-11-01")).toBe(422);
    expect(await bad("from=2026-02-30")).toBe(400);
    expect(await bad("from=yesterday")).toBe(400);
    const d = j((await call(OPERATOR, "GET", "/api/ops/usage")).json);
    expect(d.months).toHaveLength(6);
    expect(d.from).toBe(`${d.months[0]}-01`);
  });

  it("reports a client's live activity in its own days, with no cost", async () => {
    const res = await call(
      admin("a"),
      "GET",
      "/api/reports/activity?from=2026-11-01&to=2026-11-03",
    );
    expect(res.status).toBe(200);
    const r = j(res.json);
    expect(forbiddenKeys(r)).toEqual([]);
    expect(JSON.stringify(r)).not.toMatch(/cost|0\.0503|usd/i);
    expect(r).toMatchObject({
      from: "2026-11-01",
      to: "2026-11-03",
      timezone: "America/Chicago",
      // The test run is not the client's; the 03:00Z run was October 31 in Chicago.
      runs: { total: 2, waiting: 1, failed: 1, succeeded: 0 },
      documents: { received: 2, read: 2 },
      actions: { total: 1, byConnector: [{ connector: "testkit", name: "Testkit", count: 1 }] },
      packs: [],
    });
    expect(r.services).toMatchObject([
      {
        id: ids.aA,
        name: "Record keeping",
        runs: { total: 1, waiting: 1 },
        documentsRead: 1,
        actions: 1,
      },
      { id: ids.aA2, name: "Notes", runs: { total: 1, failed: 1 }, documentsRead: 0, actions: 0 },
    ]);
    const oct31 = j(
      (await call(user("a"), "GET", "/api/reports/activity?from=2026-10-31&to=2026-10-31")).json,
    );
    expect(oct31.runs).toMatchObject({ total: 1, succeeded: 1 });
    // One service only; another client's service is not found.
    const svc = j(
      (await call(admin("a"), "GET", `/api/reports/activity?${RANGE}&service=${ids.aA}`)).json,
    );
    expect(svc.services.map((s: { id: string }) => s.id)).toEqual([ids.aA]);
    expect(svc.runs.total).toBe(2);
    expect(svc.documents.read).toBe(1);
    expect((await call(admin("a"), "GET", `/api/reports/activity?service=${ids.aB}`)).status).toBe(
      404,
    );
    // Client B sees its own only.
    const b = j(
      (await call(admin("b"), "GET", "/api/reports/activity?from=2026-11-01&to=2026-11-03")).json,
    );
    expect(b.services.map((s: { id: string }) => s.id)).toEqual([ids.aB]);
    expect(b.runs.total).toBe(1);
    expect(b.documents).toEqual({ received: 0, read: 0 });
  });

  it("shows a service: what it does, this month, and its live runs", async () => {
    const res = await call(user("a"), "GET", `/api/services/${ids.aA}`);
    expect(res.status).toBe(200);
    const s = j(res.json);
    expect(forbiddenKeys(s)).toEqual([]);
    expect(s.service).toEqual({
      id: ids.aA,
      name: "Record keeping",
      description: "Keeps your records right.",
      status: "active",
    });
    const today = todayIn("America/Chicago");
    expect(s.thisMonth).toMatchObject({ from: monthStart(today), to: today });
    // Live runs only, newest first: the test run is not the client's.
    expect(s.recentRuns.map((r: { id: string }) => r.id)[0]).toBe(ids.r2);
    expect(s.recentRuns).toHaveLength(2);
    expect(s.recentRuns.every((r: { service: { id: string } }) => r.service.id === ids.aA)).toBe(
      true,
    );
    for (const id of [ids.aB, ids.copy]) {
      expect((await call(user("a"), "GET", `/api/services/${id}`)).status).toBe(404);
    }
    expect((await call(OPERATOR, "GET", `/api/services/${ids.aA}`)).status).toBe(403);
  });
});
