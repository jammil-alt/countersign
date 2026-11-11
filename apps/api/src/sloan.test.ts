// Sloan on by default (docs/plan.md §1.47 "On by default", 2026-11-10): a new client starts with
// Sloan, the account agent, turned on (active and live, no test run needed); the operator may
// untick it; the cron's hourly pass turns it on for clients made before, and leaves alone a Sloan
// the operator paused. What Sloan may do is unchanged: the guard still refuses it any write tool.

import { ACCOUNT_AGENT_SERVICE_NAME, SUPERVISOR_SLUG } from "@countersign/core";
import { agent, agentChange, run, tenant, withOperator } from "@countersign/db";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { SLOAN_SETTING, SLOAN_SWEEP_MINUTE, sloanTick } from "./account/sloan";
import { type ApiHarness, createApiHarness, OPERATOR } from "./api.test-helper";
import { addSupervisor } from "./routes/supervisor";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const h = await createApiHarness();
afterAll(() => h?.close());

const tick = (minute = SLOAN_SWEEP_MINUTE) => new Date(Date.UTC(2026, 10, 10, 9, minute));

describe.skipIf(!h)("Sloan, on by default", () => {
  const H = h as ApiHarness;

  const sloans = (tenantId: string) =>
    H.t.db
      .select()
      .from(agent)
      .where(
        and(
          eq(agent.tenantId, tenantId),
          eq(agent.slug, SUPERVISOR_SLUG),
          eq(agent.kind, "client"),
          isNotNull(agent.templateId),
        ),
      );

  it("the hourly pass turns it on for clients made before, once, and only at its minute", async () => {
    // Clients A, B and C were made before: none has Sloan.
    for (const c of [H.A, H.B, H.C]) expect(await sloans(c.tenantId)).toEqual([]);
    await sloanTick(H.db, H.platform, tick(SLOAN_SWEEP_MINUTE + 1));
    expect(await sloans(H.A.tenantId)).toEqual([]);

    // B's was added before this change but never turned on: a draft.
    const draft = await withOperator(H.db, [H.B.tenantId], (tx) =>
      addSupervisor(tx, { tenantId: H.B.tenantId, actorId: null, platform: H.platform }),
    );
    expect(draft.agent.runStatus).toBe("draft");

    await sloanTick(H.db, H.platform, tick());
    for (const c of [H.A, H.B, H.C]) {
      const rows = await sloans(c.tenantId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ runStatus: "active", stage: "live" });
    }
    expect((await sloans(H.B.tenantId))[0]?.id).toBe(draft.agent.id);

    // The platform turned them on: no person in the log.
    const [change] = await H.t.db
      .select({ actorId: agentChange.actorId })
      .from(agentChange)
      .where(
        and(
          eq(agentChange.agentId, draft.agent.id),
          sql`${agentChange.change} ->> 'kind' = 'run_status'`,
        ),
      );
    expect(change?.actorId).toBeNull();
  });

  it("a new client starts with Sloan on: active and live, without a test run", async () => {
    const res = await H.call(OPERATOR, "POST", "/api/ops/clients", { name: "Fresh client" });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const id = j(res.json).client.id as string;
    const [sloan, ...more] = await sloans(id);
    expect(more).toEqual([]);
    expect(sloan).toMatchObject({
      runStatus: "active",
      stage: "live",
      serviceName: ACCOUNT_AGENT_SERVICE_NAME,
      testCopy: false,
    });
    expect(sloan?.liveVersionId).toBeTruthy();
    // No test run was needed, and none ran.
    const runs = await H.t.db
      .select()
      .from(run)
      .where(eq(run.agentId, sloan?.id as string));
    expect(runs).toEqual([]);
    // The log shows who turned it on, and why it skipped trial and signoff.
    const log = await H.t.db
      .select({ change: agentChange.change })
      .from(agentChange)
      .where(eq(agentChange.agentId, sloan?.id as string));
    const kinds = log.map((l) => (l.change as { kind: string }).kind);
    expect(kinds).toEqual(expect.arrayContaining(["fork", "publish", "run_status", "stage"]));
    const health = await H.call(OPERATOR, "GET", `/api/ops/clients/${id}/health`);
    expect(j(health.json).supervisor).toMatchObject({ runStatus: "active" });
  });

  it("unticked, the client has none, and the hourly pass leaves it so", async () => {
    const res = await H.call(OPERATOR, "POST", "/api/ops/clients", {
      name: "Without Sloan",
      supervisor: false,
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const id = j(res.json).client.id as string;
    expect(await sloans(id)).toEqual([]);
    const [t] = await H.t.db.select().from(tenant).where(eq(tenant.id, id));
    expect((t?.settings as Record<string, unknown> | undefined)?.[SLOAN_SETTING]).toBe("off");
    await sloanTick(H.db, H.platform, tick());
    expect(await sloans(id)).toEqual([]);
  });

  it("a Sloan the operator paused stays paused", async () => {
    const [sloan] = await sloans(H.A.tenantId);
    const paused = await H.call(OPERATOR, "POST", `/api/ops/agents/${sloan?.id}/pause`);
    expect(paused.status, JSON.stringify(paused.json)).toBe(200);
    await sloanTick(H.db, H.platform, tick());
    const rows = await sloans(H.A.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.runStatus).toBe("paused");
  });

  it("the Sandbox gets none: it has no client people", async () => {
    const [sandbox] = await H.t.db
      .insert(tenant)
      .values({ name: "Sandbox", settings: { sandbox: true } })
      .returning();
    await sloanTick(H.db, H.platform, tick());
    expect(await sloans(sandbox?.id as string)).toEqual([]);
  });

  it("still refuses Sloan a write tool: turning it on loosens nothing (invariant 11)", async () => {
    const [sloan] = await sloans(H.B.tenantId);
    const res = await H.call(OPERATOR, "GET", `/api/ops/agents/${sloan?.id}`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    // Everything it may call is the platform's own (no connector, no external tool).
    const [row] = await H.t.db
      .select({ bindings: agent.bindings })
      .from(agent)
      .where(eq(agent.id, sloan?.id as string));
    expect(row?.bindings).toEqual({});
  });
});
