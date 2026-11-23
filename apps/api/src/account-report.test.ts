// R5: a report per account, and every account side by side (docs/reporting-plan.md §3 R5,
// docs/plan.md §1.235), against a real database as cs_worker. One client's period across its
// agents (R4's headline per agent), what waits now, failed runs nobody has looked at, connections
// that need attention, usage, and "Needs us"; each figure's filter opens exactly its runs; the
// portal carries no cost, errors or Needs us and only its own client (invariants 1 and 11); the
// operator's list has every client it serves, those that need us first.

import { runFilterQuery } from "@countersign/core";
import {
  agent,
  agentVersion,
  connection,
  connectionChange,
  inboxItem,
  membership,
  run,
  tenant,
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
  /^(template|templateId|templates|tenantId|clients|bundle|instructions?|prompts?|input|output|mode|errors?|errorKey|spend|needsUs|.*[cC]ost.*|tokens.*)$/;

// October 2026: a whole past month, so the runs made "now" below never fall in it.
const PERIOD = "from=2026-10-01&to=2026-10-31";
const oct = (day: number, hour: number, minute = 0) =>
  new Date(Date.UTC(2026, 9, day, hour, minute));
const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000);

describe.skipIf(!h)("the report per account", () => {
  const H = h as ApiHarness;
  const owner = H.t.db;
  const ids = {} as Record<"clerk" | "other" | "clerkB", string>;
  /**
   * r1, r2: the clerk's, done and failed in October; r3: the other agent's, done in October; r4:
   * a test run; r5: September's; rWait: the clerk's, waiting now; rFail: failed an hour ago, not
   * tried again; rTried: failed and tried again (rRetry); rB: client B's.
   */
  const runs = {} as Record<
    "r1" | "r2" | "r3" | "r4" | "r5" | "rWait" | "rFail" | "rTried" | "rRetry" | "rB",
    string
  >;

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

  beforeAll(async () => {
    const A = H.A.tenantId;
    const B = H.B.tenantId;
    const clerk = await addAgent(A, "account-clerk", "Account clerk");
    const other = await addAgent(A, "account-other", "Other clerk");
    const clerkB = await addAgent(B, "account-clerk", "Account clerk");
    ids.clerk = clerk.id;
    ids.other = other.id;
    ids.clerkB = clerkB.id;

    runs.r1 = await addRun(A, clerk, { createdAt: oct(2, 9), finishedAt: oct(2, 9, 20) });
    runs.r2 = await addRun(A, clerk, {
      createdAt: oct(3, 9),
      finishedAt: oct(3, 9, 5),
      status: "failed",
      error: { key: "testkit.timeout", reason: "The tool timed out" },
      costUsd: "0.5000",
    });
    runs.r3 = await addRun(A, other, { createdAt: oct(4, 9), finishedAt: oct(4, 9, 10) });
    runs.r4 = await addRun(A, clerk, { createdAt: oct(5, 9), mode: "test" });
    runs.r5 = await addRun(A, clerk, {
      createdAt: new Date(Date.UTC(2026, 8, 20, 9)),
      finishedAt: new Date(Date.UTC(2026, 8, 20, 9, 1)),
    });

    // Waiting on the client for two days: past a day.
    runs.rWait = await addRun(A, clerk, { createdAt: ago(49), status: "waiting" });
    await owner.insert(inboxItem).values({
      tenantId: A,
      kind: "approval",
      runId: runs.rWait,
      title: "Approve the change",
      assigneeRole: "client_admin",
      createdAt: ago(48),
    });
    // An item for us, which the portal doesn't count.
    await owner.insert(inboxItem).values({
      tenantId: A,
      kind: "review",
      title: "Check the reading",
      assigneeRole: "operator",
      createdAt: ago(2),
    });
    runs.rFail = await addRun(A, other, {
      createdAt: ago(1),
      finishedAt: ago(1),
      status: "failed",
    });
    runs.rTried = await addRun(A, other, {
      createdAt: ago(3),
      finishedAt: ago(3),
      status: "failed",
    });
    runs.rRetry = await addRun(A, other, {
      createdAt: ago(2),
      finishedAt: ago(2),
      retryOf: runs.rTried,
    });

    // QuickBooks in error; Gmail connected but failing to renew our access (C4.2); Slack fine.
    await owner.insert(connection).values({ tenantId: A, connector: "qbo", status: "error" });
    const [gmail] = await owner
      .insert(connection)
      .values({ tenantId: A, connector: "gmail", status: "connected" })
      .returning();
    await owner.insert(connectionChange).values({
      tenantId: A,
      connectionId: gmail?.id as string,
      change: { kind: "needs_attention", reason: "refresh_failing" },
    });
    await owner.insert(connection).values({ tenantId: A, connector: "slack", status: "connected" });

    runs.rB = await addRun(B, clerkB, { createdAt: oct(2, 9), finishedAt: oct(2, 9, 10) });
  });

  const get = async (who: string, path: string) => {
    const res = await H.call(who, "GET", path);
    expect(res.status, `${path}: ${JSON.stringify(res.json)}`).toBe(200);
    return j(res.json);
  };
  const list = async (who: string, path: string, filter: Record<string, unknown>) => {
    const q = new URLSearchParams({ ...runFilterQuery(filter as never), limit: "100" });
    return (j(await get(who, `${path}?${q}`)).runs as { id: string }[]).map((r) => r.id).sort();
  };
  const portalRuns = (filter: Record<string, unknown>) => list(admin("a"), "/api/runs", filter);
  const opsRuns = (filter: Record<string, unknown>) => list(OPERATOR, "/api/ops/runs", filter);
  const sorted = (...l: string[]) => [...l].sort();

  it("gives the portal a line per agent with R4's headline, and the month before", async () => {
    const body = await get(admin("a"), `/api/reports/account?${PERIOD}`);
    expect(body.client).toEqual({ id: H.A.tenantId, name: expect.any(String) });
    expect(body.headline).toMatchObject({ runs: 3, done: 2, failed: 1 });
    // R4's rule: a period asked for is compared with as many days just before it.
    expect(body.previous).toMatchObject({ from: "2026-08-31", to: "2026-09-30", runs: 1 });
    const clerk = body.agents.find((a: { service: { id: string } }) => a.service.id === ids.clerk);
    expect(clerk).toMatchObject({
      service: { name: "Account clerk" },
      headline: { runs: 2, done: 1, failed: 1, finishMedianMs: 20 * 60_000 },
      previous: { runs: 1 },
      waiting: { count: 1 },
    });
    const other = body.agents.find((a: { service: { id: string } }) => a.service.id === ids.other);
    expect(other).toMatchObject({ headline: { runs: 1, done: 1 }, waiting: { count: 0 } });
    // The most runs first.
    expect(body.agents[0].service.id).toBe(ids.clerk);
  });

  it("opens exactly each figure's runs on the portal's runs list", async () => {
    const body = await get(admin("a"), `/api/reports/account?${PERIOD}`);
    expect(await portalRuns(body.runs.filter)).toEqual(sorted(runs.r1, runs.r2, runs.r3));
    expect(await portalRuns(body.done.filter)).toEqual(sorted(runs.r1, runs.r3));
    expect(await portalRuns(body.failed.filter)).toEqual([runs.r2]);
    expect(await portalRuns(body.waiting.runs.filter)).toEqual([runs.rWait]);
    const clerk = body.agents.find((a: { service: { id: string } }) => a.service.id === ids.clerk);
    expect(await portalRuns(clerk.runs.filter)).toEqual(sorted(runs.r1, runs.r2));
    expect(await portalRuns(clerk.failed.filter)).toEqual([runs.r2]);
    expect(await portalRuns(clerk.waiting.filter)).toEqual([runs.rWait]);
  });

  it("shows what waits now, failed runs nobody has looked at and connections", async () => {
    const body = await get(admin("a"), `/api/reports/account?${PERIOD}`);
    // The portal counts the client's own item, not ours.
    expect(body.waiting).toMatchObject({ runs: { count: 1 }, items: 1, overdue: 1 });
    expect(Date.parse(body.waiting.oldestSince)).toBeLessThan(Date.now() - 47 * 3_600_000);
    // Failed and not tried again; the one tried again is left out.
    expect(body.failedUnseen).toMatchObject({ count: 1, filter: null });
    expect(
      body.connections.map((c: { connector: string; attention: string }) => [
        c.connector,
        c.attention,
      ]),
    ).toEqual([
      ["gmail", "refresh_failing"],
      ["qbo", "error"],
    ]);
    expect(body.usage).toBeNull();

    const ops = await get(OPERATOR, `/api/ops/clients/${H.A.tenantId}/report?${PERIOD}`);
    expect(ops.waiting).toMatchObject({ items: 2, overdue: 1 });
    // S4.6 (D5): Home's Needs us for A: the approval past a day, the failed run, the item for us.
    // QuickBooks in error is used by no agent and Gmail is still connected, so neither needs us.
    expect(ops.needsUs).toEqual(["waiting", "failed", "item"]);
    expect(await opsRuns(ops.runs.filter)).toEqual(sorted(runs.r1, runs.r2, runs.r3));
    expect(await opsRuns(ops.waiting.runs.filter)).toEqual([runs.rWait]);
  });

  it("carries no cost, errors or Needs us on the portal, and only its own client", async () => {
    for (const who of [admin("a"), user("a")]) {
      const body = await get(who, `/api/reports/account?${PERIOD}`);
      expect(forbiddenKeys(body, PORTAL_EXTRA)).toEqual([]);
      const text = JSON.stringify(body);
      for (const hidden of ["testkit.timeout", "Check the reading", runs.rB, ids.clerkB]) {
        expect(text).not.toContain(hidden);
      }
    }
    const b = await get(admin("b"), `/api/reports/account?${PERIOD}`);
    expect(b.headline.runs).toBe(1);
    expect(b.connections).toEqual([]);
    expect(JSON.stringify(b)).not.toContain(ids.clerk);

    const csv = await H.call(admin("a"), "GET", `/api/reports/account.csv?${PERIOD}`);
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    const text = String(csv.json);
    expect(text).toContain("section,item,figure,value,currency");
    expect(text).toContain("agent,Account clerk,runs,2,");
    expect(text).toContain("failed not looked at,,runs,1,");
    for (const hidden of ["cost", "needs us", "testkit.timeout"]) {
      expect(text).not.toContain(hidden);
    }
  });

  it("refuses a person limited to some agents, and each surface's route to the other", async () => {
    const [person] = await owner
      .select({ id: membership.userId })
      .from(membership)
      .where(and(eq(membership.tenantId, H.A.tenantId), eq(membership.role, "client_user")));
    const limit = (agentIds: string[] | null) =>
      owner
        .update(membership)
        .set({ agentIds })
        .where(
          and(eq(membership.tenantId, H.A.tenantId), eq(membership.userId, person?.id as string)),
        );
    await limit([ids.other]);
    try {
      expect((await H.call(user("a"), "GET", "/api/reports/account")).status).toBe(403);
    } finally {
      await limit(null);
    }
    expect((await H.call(admin("a"), "GET", "/api/ops/accounts")).status).toBe(403);
    expect(
      (await H.call(admin("a"), "GET", `/api/ops/clients/${H.A.tenantId}/report`)).status,
    ).toBe(403);
    expect((await H.call(OPERATOR, "GET", "/api/reports/account")).status).not.toBe(200);
    expect(
      (await H.call(admin("a"), "GET", "/api/reports/account?from=2026-10-31&to=2026-10-01"))
        .status,
    ).toBe(422);
  });

  it("lists every client the operator serves, those that need us first", async () => {
    // S4.6 (QA W4): B's QuickBooks in error, used by none of its agents: Home doesn't count it, so
    // neither does Accounts.
    const [unused] = await owner
      .insert(connection)
      .values({ tenantId: H.B.tenantId, connector: "qbo", status: "error" })
      .returning();
    const body = await get(OPERATOR, `/api/ops/accounts?${PERIOD}`).finally(() =>
      owner.delete(connection).where(eq(connection.id, unused?.id as string)),
    );
    const names = body.accounts.map((r: { client: { id: string } }) => r.client.id);
    expect(names).toContain(H.A.tenantId);
    expect(names).toContain(H.B.tenantId);
    const a = body.accounts.find((r: { client: { id: string } }) => r.client.id === H.A.tenantId);
    const b = body.accounts.find((r: { client: { id: string } }) => r.client.id === H.B.tenantId);
    expect(a).toMatchObject({
      agents: 2,
      headline: { runs: 3 },
      failedUnseen: { count: 1 },
      needsUs: ["waiting", "failed", "item"],
    });
    expect(a.connections).toHaveLength(2);
    expect(b).toMatchObject({ agents: 1, headline: { runs: 1 }, needsUs: [] });
    // S4.6 (QA W4): "2 clients need us" while Home said nothing did. A client needs us on
    // Accounts exactly when Needs us lists something of it.
    const home = j((await H.call(OPERATOR, "GET", "/api/ops/needs-us")).json);
    for (const row of body.accounts as { client: { id: string }; needsUs: string[] }[]) {
      const listed = (home.escalations as { client: { id: string } }[]).some(
        (e) => e.client.id === row.client.id,
      );
      expect(row.needsUs.length > 0, row.client.id).toBe(listed);
    }
    expect(names.indexOf(H.A.tenantId)).toBeLessThan(names.indexOf(H.B.tenantId));
    expect(await opsRuns(a.failed.filter)).toEqual([runs.r2]);
    expect(await opsRuns(b.runs.filter)).toEqual([runs.rB]);
  });

  it("reads usage against the allowance once the client is billed, for its admin only", async () => {
    const [t] = await owner.select().from(tenant).where(eq(tenant.id, H.A.tenantId));
    const settings = (t?.settings ?? {}) as Record<string, unknown>;
    await owner
      .update(tenant)
      .set({
        settings: {
          ...settings,
          billing: { customerId: "cus_test", email: null, setUpAt: "2026-09-01", setUpBy: null },
        },
      })
      .where(eq(tenant.id, H.A.tenantId));
    try {
      const ops = await get(OPERATOR, `/api/ops/clients/${H.A.tenantId}/report?${PERIOD}`);
      expect(ops.usage).toMatchObject({ used: expect.any(Number), included: expect.any(Number) });
      expect((await get(admin("a"), `/api/reports/account?${PERIOD}`)).usage).not.toBeNull();
      expect((await get(user("a"), `/api/reports/account?${PERIOD}`)).usage).toBeNull();
    } finally {
      await owner.update(tenant).set({ settings }).where(eq(tenant.id, H.A.tenantId));
    }
  });
});
