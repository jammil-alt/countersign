// The platform's health pass (observability/health.ts): failures grouped by error key, what is
// stuck, per client and only for the clients asked.

import { connection, externalAction, inboxItem, run } from "@countersign/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ApiHarness, createApiHarness, OPERATOR, testBundle } from "./api.test-helper";
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
