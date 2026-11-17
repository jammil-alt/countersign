// The platform's health pass (observability/health.ts): failures grouped by error key, what is
// stuck, per client and only for the clients asked.

import {
  auditEvent,
  connection,
  event,
  externalAction,
  inboxItem,
  run,
  stepRun,
} from "@countersign/db";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ApiHarness, admin, createApiHarness, OPERATOR, testBundle } from "./api.test-helper";
import {
  HEALTH_DAILY_HOUR_UTC,
  HEALTH_MINUTE,
  type HealthFinding,
  healthFindings,
  healthTick,
  healthWindow,
} from "./observability/health";

// biome-ignore lint/suspicious/noExplicitAny: test JSON
const j = (v: unknown) => v as any;

const h = await createApiHarness();
afterAll(() => h?.close());

/** Two days out, at the daily pass: the window is the hour before, 12:00 to 13:00 UTC. */
const day = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
const at = (hhmm: string) => new Date(`${day}T${hhmm}:00Z`);
const DAILY = at(`${String(HEALTH_DAILY_HOUR_UTC).padStart(2, "0")}:${HEALTH_MINUTE}`);

describe("the health window", () => {
  it("covers the hour before the pass, with states once a day", () => {
    const w = healthWindow(DAILY);
    expect(w.from.toISOString()).toBe(at("12:00").toISOString());
    expect(w.to.toISOString()).toBe(at("13:00").toISOString());
    expect(w.states).toBe(true);
    expect(healthWindow(at(`15:${HEALTH_MINUTE}`)).states).toBe(false);
  });
});

describe.skipIf(!h)("platform health", () => {
  const H = h as ApiHarness;
  const ids = { failed: [] as string[], stuck: "", action: "", item: "" };

  async function agentFor(tenantId: string) {
    const created = await H.call(OPERATOR, "POST", `/api/ops/clients/${tenantId}/agents`, {
      slug: "clerk",
      bundle: testBundle(),
    });
    return { agentId: j(created.json).agent.id, agentVersionId: j(created.json).version.id };
  }

  beforeAll(async () => {
    const a = await agentFor(H.A.tenantId);
    const b = await agentFor(H.B.tenantId);
    const base = { workflowSlug: "fix-record", startedAt: at("11:00") };
    const failed = (key: string, finishedAt: Date, mode: "live" | "test" = "live") => ({
      ...base,
      ...a,
      tenantId: H.A.tenantId,
      mode,
      status: "failed" as const,
      finishedAt,
      error: { key, reason: "the tool said no" },
    });
    const rows = await H.t.db
      .insert(run)
      .values([
        failed("testkit.update:unauthorized", at("12:10")),
        failed("testkit.update:unauthorized", at("12:40")),
        failed("skill:escalated", at("12:50")),
        // Not counted: a test run, and a failure outside the window.
        failed("testkit.update:unauthorized", at("12:20"), "test"),
        failed("testkit.update:unauthorized", at("11:50")),
        // Stuck: still running three hours after it was created.
        {
          ...base,
          ...a,
          tenantId: H.A.tenantId,
          status: "running" as const,
          createdAt: at("10:00"),
        },
        // Client B's failure, never in client A's findings.
        {
          ...base,
          ...b,
          tenantId: H.B.tenantId,
          status: "failed" as const,
          finishedAt: at("12:30"),
        },
      ])
      .returning({ id: run.id });
    ids.failed = rows.slice(0, 3).map((r) => r.id);
    ids.stuck = rows[5]?.id as string;
    const [action] = await H.t.db
      .insert(externalAction)
      .values({
        tenantId: H.A.tenantId,
        connectionId: H.A.connectionId,
        tool: "testkit.update",
        runId: ids.failed[0],
        idempotencyKey: `${ids.failed[0]}:write:0`,
        status: "failed",
        approvedAt: at("12:05"),
        executedAt: at("12:06"),
        error: { message: "request timed out", unconfirmed: true },
      })
      .returning({ id: externalAction.id });
    ids.action = action?.id as string;
    const [item] = await H.t.db
      .insert(inboxItem)
      .values({
        tenantId: H.A.tenantId,
        kind: "approval",
        title: "Approve the change",
        runId: ids.stuck,
        status: "resolved",
        resolvedAt: at("12:00"),
      })
      .returning({ id: inboxItem.id });
    ids.item = item?.id as string;
    await H.t.db
      .update(connection)
      .set({ status: "error" })
      .where(eq(connection.id, H.B.connectionId));
  });

  const byKind = (found: HealthFinding[], kind: HealthFinding["kind"]) =>
    found.filter((f) => f.kind === kind);

  it("groups a client's failed live runs and writes by error key, and finds what is stuck", async () => {
    const found = await H.t.db.transaction((tx) =>
      healthFindings(tx, [H.A.tenantId], healthWindow(DAILY)),
    );
    expect(found.every((f) => f.tenantId === H.A.tenantId)).toBe(true);
    const runs = byKind(found, "run_failed");
    expect(runs.map((f) => [f.key, f.count]).sort()).toEqual([
      ["skill:escalated", 1],
      ["testkit.update:unauthorized", 2],
    ]);
    expect(runs.find((f) => f.count === 2)?.ids.sort()).toEqual(ids.failed.slice(0, 2).sort());
    expect(byKind(found, "action_failed")).toEqual([
      {
        kind: "action_failed",
        tenantId: H.A.tenantId,
        key: "testkit.update:timeout",
        count: 1,
        ids: [ids.action],
        unconfirmed: true,
      },
    ]);
    expect(byKind(found, "run_stuck")).toMatchObject([
      { key: "running:fix-record", ids: [ids.stuck] },
    ]);
    expect(byKind(found, "delivery_stuck")).toMatchObject([{ key: "approval", ids: [ids.item] }]);
    expect(byKind(found, "connection_broken")).toEqual([]);
  });

  it("reports only the window's failures outside the daily pass", async () => {
    const w = { ...healthWindow(DAILY), states: false };
    const found = await H.t.db.transaction((tx) => healthFindings(tx, [H.A.tenantId], w));
    expect(new Set(found.map((f) => f.kind))).toEqual(new Set(["run_failed", "action_failed"]));
  });

  it("sends each client's findings once an hour, at its minute", async () => {
    const sent: HealthFinding[] = [];
    expect(await healthTick(H.db, at("13:05"), (f) => sent.push(f))).toBe(0);
    const n = await healthTick(H.db, DAILY, (f) => sent.push(f));
    expect(n).toBe(sent.length);
    const b = sent.filter((f) => f.tenantId === H.B.tenantId);
    expect(b.map((f) => f.kind).sort()).toEqual(["connection_broken", "run_failed"]);
    expect(b.find((f) => f.kind === "run_failed")?.key).toBe("unknown");
    expect(b.find((f) => f.kind === "connection_broken")?.key).toBe("testkit:error");
    expect(sent.filter((f) => f.tenantId === H.A.tenantId)).toHaveLength(5);
  });
});

describe.skipIf(!h)("platform health: what is not stuck", () => {
  const H = h as ApiHarness;

  it("leaves out runs waiting on a person and runs that moved recently", async () => {
    const created = await H.call(OPERATOR, "POST", `/api/ops/clients/${H.A.tenantId}/agents`, {
      slug: "waiter",
      bundle: testBundle(),
    });
    const a = { agentId: j(created.json).agent.id, agentVersionId: j(created.json).version.id };
    const going = {
      ...a,
      tenantId: H.A.tenantId,
      workflowSlug: "waits",
      status: "running" as const,
      startedAt: at("09:00"),
      createdAt: at("09:00"),
    };
    const [waiting, moving, waitStep, stuck] = await H.t.db
      .insert(run)
      .values([going, going, going, going])
      .returning({ id: run.id });
    // Waiting on a client admin's approval since 09:00: it has its own deadline.
    await H.t.db.insert(inboxItem).values({
      tenantId: H.A.tenantId,
      kind: "approval",
      title: "Approve the change",
      runId: waiting?.id,
      status: "open",
    });
    // A step that started 20 minutes before the pass: the run is moving.
    await H.t.db.insert(stepRun).values([
      {
        tenantId: H.A.tenantId,
        runId: moving?.id as string,
        nodeId: "first",
        nodeType: "skill",
        status: "running",
        startedAt: at("12:52"),
      },
      // A step waiting on someone's reply (a reach-out), with no inbox item.
      {
        tenantId: H.A.tenantId,
        runId: waitStep?.id as string,
        nodeId: "ask",
        nodeType: "skill",
        status: "waiting",
        startedAt: at("09:05"),
      },
      // A step that finished at 09:10 and nothing since: stuck.
      {
        tenantId: H.A.tenantId,
        runId: stuck?.id as string,
        nodeId: "first",
        nodeType: "skill",
        status: "succeeded",
        startedAt: at("09:05"),
        finishedAt: at("09:10"),
      },
    ]);
    const found = await H.t.db.transaction((tx) =>
      healthFindings(tx, [H.A.tenantId], healthWindow(DAILY)),
    );
    const stuckRuns = found.filter((f) => f.kind === "run_stuck" && f.key === "running:waits");
    expect(stuckRuns.flatMap((f) => f.ids)).toEqual([stuck?.id]);
  });
});

describe.skipIf(!h)("events set aside after failing to dispatch", () => {
  const H = h as ApiHarness;
  const C = () => H.B.tenantId;
  const path = () => `/api/ops/clients/${C()}/events/set-aside`;

  it("shows them in the health findings and gives them back to the dispatcher on request", async () => {
    const old = new Date(Date.now() - 3 * 86_400_000);
    const rows = await H.t.db
      .insert(event)
      .values(
        [0, 1, 2].map((i) => ({
          tenantId: C(),
          type: "schedule.tick",
          payload: { scheduledAt: old.toISOString() },
          createdAt: new Date(old.getTime() + i * 60_000),
          dispatchAttempts: 5,
          dispatchError: "TypeError: bad payload",
          setAsideAt: new Date(old.getTime() + i * 60_000 + 300_000),
        })),
      )
      .returning();
    const ids = rows.map((r) => r.id);

    const found = await H.t.db.transaction((tx) => healthFindings(tx, [C()], healthWindow(DAILY)));
    expect(found.filter((f) => f.kind === "events_set_aside")).toEqual([
      {
        kind: "events_set_aside",
        tenantId: C(),
        key: "schedule.tick",
        count: 3,
        ids: [...ids].reverse(),
        oldest: old.toISOString(),
      },
    ]);
    // States only: the hourly pass outside the daily one leaves them out.
    const hourly = await H.t.db.transaction((tx) =>
      healthFindings(tx, [C()], { ...healthWindow(DAILY), states: false }),
    );
    expect(hourly.some((f) => f.kind === "events_set_aside")).toBe(false);

    const listed = await H.call(OPERATOR, "GET", path());
    expect(listed.status, JSON.stringify(listed.json)).toBe(200);
    expect(j(listed.json)).toMatchObject({ count: 3, oldest: old.toISOString() });
    expect(j(listed.json).events[0]).toMatchObject({
      id: ids[2],
      attempts: 5,
      error: "TypeError: bad payload",
    });
    // The operator's only: the client admin is refused.
    expect((await H.call(admin("b"), "GET", path())).status).toBe(403);
    expect((await H.call(admin("b"), "POST", `${path()}/retry`, {})).status).toBe(403);

    // One named event first, then the rest.
    const one = await H.call(OPERATOR, "POST", `${path()}/retry`, { eventIds: [ids[0]] });
    expect(one.status, JSON.stringify(one.json)).toBe(200);
    expect(j(one.json)).toEqual({ retried: 1 });
    const rest = await H.call(OPERATOR, "POST", `${path()}/retry`, {});
    expect(j(rest.json)).toEqual({ retried: 2 });
    const after = await H.t.db.select().from(event).where(inArray(event.id, ids));
    // Given back and dispatched after the commit (no agent starts on them here).
    expect(after.every((e) => e.setAsideAt === null && e.dispatchAttempts === 0)).toBe(true);
    expect(after.every((e) => e.dispatchedAt !== null)).toBe(true);
    expect(j((await H.call(OPERATOR, "GET", path())).json).count).toBe(0);
    // Audited, as every session route is.
    const audited = await H.t.db
      .select()
      .from(auditEvent)
      .where(
        and(
          eq(auditEvent.tenantId, C()),
          eq(auditEvent.action, "POST /api/ops/clients/:id/events/set-aside/retry"),
        ),
      );
    expect(audited.filter((a) => a.outcome === "ok")).toHaveLength(2);
  });
});
