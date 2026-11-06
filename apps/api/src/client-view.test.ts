// KPIs and the client view, credits running out, and the client's audit export through the API
// (docs/plan.md §1.50, M27): a template's KPIs show on its client agent (portal and back office),
// in the Table and in the Weekly Table, computed over live runs only, money exact; the portal never
// gets the definition; `pause` pauses billable agents (not Sloan) when the month's credits are
// used and the next month resumes them; `continue` tells the client admin per 2,500 credits; the
// audit export holds only the client's rows, its people by name and ours as Mezonas but the lead;
// a run's audit trail says who opened it and who signed.

import { TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import {
  type AgentBundleInput,
  AgentBundle as AgentBundleSchema,
  weekBounds,
  weekStartOf,
} from "@countersign/core";
import {
  agent,
  agentChange,
  appUser,
  auditEvent,
  externalAction,
  inboxItem,
  membership,
  notification,
  run,
  stepRun,
  tenant,
  usageDaily,
  withTenant,
} from "@countersign/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  forbiddenKeys,
  OPERATOR,
  OTHER_OPERATOR,
  testBundle,
  user,
} from "./api.test-helper";
import { billingTick } from "./billing/jobs";
import { csvRecords, text } from "./exports/zip.test-helper";
import { AUDIT_PAGE_ROWS } from "./routes/audit-export";
import { weeklyStats } from "./weekly/stats";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const h = await createApiHarness();
afterAll(() => h?.close());

const ORIGIN = "https://app.mezonas.test";

/** testBundle with a client view: money, a ratio of sums, runs, writes and a count. */
function viewBundle(): AgentBundleInput {
  const b = testBundle("Price clerk") as AgentBundleInput;
  return {
    ...b,
    definition: {
      ...b.definition,
      clientView: {
        kpis: [
          {
            id: "caught",
            label: { en: "Overcharges caught", es: "Sobrecargos detectados" },
            period: "month",
            format: "money",
            measure: { kind: "sum", step: "update", path: "overcharge.amount", money: true },
          },
          {
            id: "auto",
            label: "Items matched on their own",
            period: "30d",
            format: "percent",
            measure: {
              kind: "ratio",
              numerator: { kind: "sum", step: "update", path: "match.matched" },
              denominator: { kind: "sum", step: "update", path: "match.total" },
            },
          },
          {
            id: "done",
            label: "Runs done",
            period: "week",
            format: "count",
            measure: { kind: "runs", status: "succeeded", workflow: "fix-record" },
          },
          {
            id: "writes",
            label: "Changes made",
            period: "7d",
            format: "count",
            measure: {
              kind: "actions",
              tool: TESTKIT_UPDATE_TOOL,
              connector: "testkit",
              status: "done",
            },
          },
          {
            id: "items",
            label: "Bills checked",
            period: "30d",
            format: "count",
            measure: { kind: "count", step: "update", path: "match.matched" },
          },
        ],
        panels: [{ id: "main", kind: "kpis", kpis: ["caught", "auto", "done", "writes", "items"] }],
      },
    },
  };
}

describe.skipIf(!h)("KPIs, the client view, credits and the audit export", () => {
  const H = h as ApiHarness;

  async function ok(who: string, method: string, path: string, body?: unknown) {
    const res = await H.call(who, method, path, body);
    expect(res.status, `${who} ${method} ${path}: ${JSON.stringify(res.json)}`).toBe(200);
    return j(res.json);
  }

  async function download(email: string | null, path: string) {
    const res = await H.app.request(
      path,
      { headers: email ? { "x-countersign-dev-user": email } : {} },
      H.env,
    );
    return { res, body: text(new Uint8Array(await res.arrayBuffer())) };
  }

  let templateId = "";
  let agentId = "";
  let versionId = "";
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    // A template with a client view, published and forked into client A, bound and live.
    const tpl = await ok(OPERATOR, "POST", "/api/ops/templates", {
      slug: "price-clerk",
      bundle: AgentBundleSchema.parse(viewBundle()),
    });
    templateId = tpl.agent.id;
    await ok(OPERATOR, "POST", `/api/ops/agents/${templateId}/versions/${tpl.version.id}/publish`);
    const fork = await ok(OPERATOR, "POST", `/api/ops/templates/${templateId}/fork`, {
      clientId: H.A.tenantId,
      serviceName: "Price check",
    });
    agentId = fork.agent.id;
    versionId = fork.version.id;
    await ok(OPERATOR, "PATCH", `/api/ops/agents/${agentId}/operation`, {
      bindings: { testkit: H.A.connectionId },
    });
    await ok(OPERATOR, "POST", `/api/ops/agents/${agentId}/versions/${versionId}/publish`);
    await H.t.db.update(agent).set({ runStatus: "active" }).where(eq(agent.id, agentId));

    // Runs: three live ones that succeeded just now, one that failed, a test run and an old one.
    const just = new Date(Date.now() - 1000);
    const old = new Date(Date.now() - 40 * 86_400_000);
    const runRow = async (
      key: string,
      mode: "live" | "test",
      status: "succeeded" | "failed",
      at: Date,
      outputs: { node: string; output: Record<string, unknown> }[],
    ) => {
      const [r] = await H.t.db
        .insert(run)
        .values({
          tenantId: H.A.tenantId,
          agentId,
          agentVersionId: versionId,
          workflowSlug: "fix-record",
          mode,
          status,
          startedAt: at,
          finishedAt: at,
        })
        .returning();
      ids[key] = r?.id as string;
      for (const o of outputs) {
        await H.t.db.insert(stepRun).values({
          tenantId: H.A.tenantId,
          runId: r?.id as string,
          nodeId: o.node,
          nodeType: "action",
          status: "succeeded",
          output: o.output,
          startedAt: at,
          finishedAt: at,
        });
      }
    };
    const big = {
      overcharge: { amount: "900.0000", currency: "USD" },
      match: { matched: 90, total: 90 },
    };
    await runRow("l1", "live", "succeeded", just, [
      {
        node: "update",
        output: {
          overcharge: { amount: "12.3456", currency: "USD" },
          match: { matched: 3, total: 4 },
        },
      },
    ]);
    await runRow("l2", "live", "succeeded", just, [
      {
        node: "update",
        output: {
          overcharge: { amount: "0.0001", currency: "USD" },
          match: { matched: "5", total: "6" },
        },
      },
    ]);
    // Inside a loop: `<loop>:<i>:<step>`.
    await runRow("l3", "live", "succeeded", just, [
      { node: "loop:0:update", output: { match: { matched: 2, total: 2 } } },
    ]);
    await runRow("failed", "live", "failed", just, [{ node: "update", output: big }]);
    await runRow("test", "test", "succeeded", just, [{ node: "update", output: big }]);
    await runRow("old", "live", "succeeded", old, [{ node: "update", output: big }]);
    // Writes: one done by a live run, one only proposed.
    await H.t.db.insert(externalAction).values([
      {
        tenantId: H.A.tenantId,
        connectionId: H.A.connectionId,
        tool: TESTKIT_UPDATE_TOOL,
        runId: ids.l1,
        idempotencyKey: `${ids.l1}:update:0`,
        status: "done",
        executedAt: just,
      },
      {
        tenantId: H.A.tenantId,
        connectionId: H.A.connectionId,
        tool: TESTKIT_UPDATE_TOOL,
        runId: ids.l2,
        idempotencyKey: `${ids.l2}:update:0`,
        status: "proposed",
      },
    ]);
    const [done] = await H.t.db
      .select({ id: externalAction.id })
      .from(externalAction)
      .where(and(eq(externalAction.runId, ids.l1 as string), eq(externalAction.status, "done")));
    ids.write = done?.id as string;
  });

  // ── KPIs ───────────────────────────────────────────────────────────────────────────────────────

  describe("KPIs", () => {
    it("show a template's KPIs on its client agent, over live runs only, money exact", async () => {
      const view = await ok(user("a"), "GET", `/api/services/${agentId}/view`);
      expect(view.service).toEqual({ id: agentId, name: "Price check" });
      const by = Object.fromEntries(view.kpis.map((k: { id: string }) => [k.id, k]));
      expect(by.caught).toMatchObject({
        label: "Overcharges caught",
        format: "money",
        value: "12.3457",
        display: "$12.35",
        currency: "USD",
      });
      expect([...by.caught.sources].sort()).toEqual([ids.l1, ids.l2].sort());
      // (3 + 5 + 2) / (4 + 6 + 2): strings and numbers alike, the loop's step too.
      expect(by.auto).toMatchObject({ value: "0.8333", display: "83.3%" });
      expect([...by.auto.sources].sort()).toEqual([ids.l1, ids.l2, ids.l3].sort());
      expect(by.done).toMatchObject({ value: "3", display: "3" });
      expect(by.writes).toMatchObject({ value: "1", sources: [ids.write] });
      expect(by.items).toMatchObject({ value: "3" });
      // Neither the failed run, the test run nor the old one counted anywhere.
      const all = view.kpis.flatMap((k: { sources: string[] }) => k.sources);
      for (const key of ["failed", "test", "old"]) expect(all).not.toContain(ids[key]);
      expect(view.panels).toEqual([
        { id: "main", kind: "kpis", kpis: ["caught", "auto", "done", "writes", "items"] },
      ]);
    });

    it("never gives the portal the definition, a prompt or a cost", async () => {
      const res = await H.call(admin("a"), "GET", `/api/services/${agentId}/view`);
      expect(forbiddenKeys(res.json, /^(measure|clientView|path|step|kpiDefinition)$/)).toEqual([]);
      expect(JSON.stringify(res.json)).not.toContain("overcharge.amount");
    });

    it("answers in the reader's language", async () => {
      await H.t.db
        .update(tenant)
        .set({
          settings: sql`jsonb_set(${tenant.settings}, '{user_languages}', ${JSON.stringify({ [H.A.admin]: "es" })}::jsonb)`,
        })
        .where(eq(tenant.id, H.A.tenantId));
      const view = await ok(admin("a"), "GET", `/api/services/${agentId}/view`);
      expect(view.kpis[0].label).toBe("Sobrecargos detectados");
      expect(view.kpis[0].display).toMatch(/^12,35\sUS\$$/);
    });

    it("keeps other clients out", async () => {
      expect((await H.call(admin("b"), "GET", `/api/services/${agentId}/view`)).status).toBe(404);
      expect(
        (await H.call(OTHER_OPERATOR, "GET", `/api/ops/agents/${agentId}/client-view`)).status,
      ).toBe(404);
      expect(
        (await H.call(admin("a"), "GET", `/api/ops/agents/${agentId}/client-view`)).status,
      ).toBe(403);
    });

    it("gives the back office the definition and the values", async () => {
      const ops = await ok(OPERATOR, "GET", `/api/ops/agents/${agentId}/client-view`);
      expect(ops.agent).toMatchObject({ id: agentId, kind: "client", tenantId: H.A.tenantId });
      expect(ops.clientView.kpis.map((k: { id: string }) => k.id)).toEqual([
        "caught",
        "auto",
        "done",
        "writes",
        "items",
      ]);
      expect(ops.values.find((v: { id: string }) => v.id === "caught").value).toBe("12.3457");
      const tpl = await ok(OPERATOR, "GET", `/api/ops/agents/${templateId}/client-view`);
      expect(tpl.agent.kind).toBe("template");
      expect(tpl.clientView.kpis).toHaveLength(5);
      expect(tpl.values).toBeNull();
    });

    it("shows this week's KPIs on the Table and in the Weekly Table", async () => {
      const table = await ok(user("a"), "GET", "/api/table");
      const service = table.services.find((s: { id: string }) => s.id === agentId);
      const caught = service.kpis.find((k: { key: string }) => k.key === "caught");
      expect(caught).toMatchObject({ label: "Overcharges caught", value: "$12.35" });
      expect([...caught.sources].sort()).toEqual([ids.l1, ids.l2].sort());
      expect(forbiddenKeys(table)).toEqual([]);

      const now = new Date();
      const weekStart = weekStartOf(now, "UTC");
      const stats = await withTenant(H.db, H.A.tenantId, (tx) =>
        weeklyStats(tx, { tenantId: H.A.tenantId, timezone: "UTC", weekStart, now }),
      );
      const week = weekBounds(weekStart, "UTC");
      expect(week.from.getTime()).toBeLessThanOrEqual(now.getTime());
      const a = stats.agents.find((x) => x.id === agentId);
      expect(a?.kpis.map((k) => k.key)).toEqual(["caught", "auto", "done", "writes", "items"]);
      expect(a?.kpis.find((k) => k.key === "done")?.value).toBe("3");
    });

    it("refuses a client view that names a step the agent doesn't have", async () => {
      const bad = viewBundle();
      const kpis = (bad.definition as { clientView: { kpis: { measure: { step?: string } }[] } })
        .clientView.kpis;
      (kpis[0] as { measure: { step: string } }).measure.step = "nope";
      const tpl = await ok(OPERATOR, "POST", "/api/ops/templates", {
        slug: "bad-view",
        bundle: bad,
      });
      const pub = await H.call(
        OPERATOR,
        "POST",
        `/api/ops/agents/${tpl.agent.id}/versions/${tpl.version.id}/publish`,
      );
      expect(pub.status).toBe(422);
      expect(JSON.stringify(pub.json)).toContain("kpi_unknown_step");
    });
  });

  // ── Credits ────────────────────────────────────────────────────────────────────────────────────

  describe("credits running out", () => {
    const DEC = "2026-12-01";
    const at = (day: string) => new Date(`${day}T10:07:00.000Z`);
    const tick = (day: string) => billingTick({ db: H.db, stripe: null, origin: ORIGIN }, at(day));
    let clerk = "";
    let sloan = "";
    let bClerk = "";

    async function clientAgent(tenantId: string, slug: string) {
      const [row] = await H.t.db
        .insert(agent)
        .values({
          tenantId,
          kind: "client",
          slug,
          name: slug,
          runStatus: "active",
          stage: "live",
        })
        .returning();
      return row?.id as string;
    }

    async function usage(tenantId: string, agentId: string, day: string, costUsd: string) {
      await H.t.db
        .insert(usageDaily)
        .values({ tenantId, agentId, day, runs: 1, costUsd })
        .onConflictDoUpdate({
          target: [usageDaily.tenantId, usageDaily.day, usageDaily.agentId],
          set: { costUsd },
        });
    }

    const creditRows = (tenantId: string) =>
      H.t.db
        .select()
        .from(notification)
        .where(and(eq(notification.tenantId, tenantId), eq(notification.kind, "credits")));

    const statusOf = async (id: string) =>
      (await H.t.db.select().from(agent).where(eq(agent.id, id)))[0];

    beforeAll(async () => {
      // Only these clients are billed in this block: the KPI agent above stays out of it.
      await H.t.db.update(agent).set({ runStatus: "paused" }).where(eq(agent.id, agentId));
      for (const c of [H.A, H.B]) {
        await H.t.db
          .update(tenant)
          .set({
            settings: sql`jsonb_set(${tenant.settings}, '{billing}', ${JSON.stringify({
              customerId: `cus_${c.tenantId.slice(0, 8)}`,
              email: null,
              setUpAt: "2026-11-01T00:00:00.000Z",
              setUpBy: null,
            })}::jsonb)`,
          })
          .where(eq(tenant.id, c.tenantId));
      }
      clerk = await clientAgent(H.A.tenantId, "bill-clerk");
      sloan = await clientAgent(H.A.tenantId, "supervisor");
      bClerk = await clientAgent(H.B.tenantId, "b-clerk");
    });

    it("lets only the client admin choose, and defaults to continue", async () => {
      expect((await H.call(user("a"), "GET", "/api/billing/credits-out")).status).toBe(403);
      expect(
        (await H.call(OPERATOR, "PUT", "/api/billing/credits-out", { onCreditsOut: "pause" }))
          .status,
      ).toBe(403);
      expect(await ok(admin("a"), "GET", "/api/billing/credits-out")).toEqual({
        onCreditsOut: "continue",
        creditBlock: 2500,
        pausedForCredits: [],
      });
      expect(
        (await H.call(admin("a"), "PUT", "/api/billing/credits-out", { onCreditsOut: "stop" }))
          .status,
      ).toBe(400);
      const set = await ok(admin("a"), "PUT", "/api/billing/credits-out", {
        onCreditsOut: "pause",
      });
      expect(set.onCreditsOut).toBe("pause");
      const [t] = await H.t.db.select().from(tenant).where(eq(tenant.id, H.A.tenantId));
      // The rest of the billing record is untouched.
      expect(
        (t?.settings as { billing?: Record<string, unknown> } | undefined)?.billing,
      ).toMatchObject({
        customerId: expect.stringMatching(/^cus_/),
        onCreditsOut: "pause",
      });
    });

    it("pause: pauses the billable agents but Sloan once the included credits are used, and says so", async () => {
      // Two agents all month: 2 × 2,000 included credits. 3,999 used: nothing yet.
      await usage(H.A.tenantId, clerk, DEC, "39.99");
      await tick(DEC);
      expect((await statusOf(clerk))?.runStatus).toBe("active");
      expect(await creditRows(H.A.tenantId)).toEqual([]);

      await usage(H.A.tenantId, clerk, DEC, "40.00");
      await tick(DEC);
      const c = await statusOf(clerk);
      expect(c?.runStatus).toBe("paused");
      expect(c?.pause).toMatchObject({ side: "system", reason: "credits_out", by: null });
      expect((await statusOf(sloan))?.runStatus).toBe("active");
      const rows = await creditRows(H.A.tenantId);
      expect(rows.map((r) => [r.userId, r.dedupeKey, r.counts, r.link])).toEqual([
        [H.A.admin, `credits:2026-12:0:${H.A.admin}`, { block: 0 }, `${ORIGIN}/settings`],
      ]);
      const changes = await H.t.db
        .select({ change: agentChange.change })
        .from(agentChange)
        .where(eq(agentChange.agentId, clerk));
      expect(changes.map((x) => x.change)).toContainEqual(
        expect.objectContaining({ kind: "pause", side: "system", reason: "credits_out" }),
      );
      // Told once: another pass queues nothing more.
      await tick(DEC);
      expect(await creditRows(H.A.tenantId)).toHaveLength(1);
      // The client can't lift our pause; the portal names it.
      expect((await H.call(admin("a"), "POST", `/api/services/${clerk}/resume`)).status).toBe(403);
      const view = await ok(admin("a"), "GET", "/api/billing/credits-out");
      expect(view.pausedForCredits).toEqual([{ id: clerk, name: "bill-clerk" }]);
    });

    it("pause: the next month resumes them", async () => {
      await tick("2027-01-01");
      expect((await statusOf(clerk))?.runStatus).toBe("active");
      expect((await statusOf(clerk))?.pause).toBeNull();
      expect((await ok(admin("a"), "GET", "/api/billing/credits-out")).pausedForCredits).toEqual(
        [],
      );
    });

    it("choosing continue resumes them at once", async () => {
      await usage(H.A.tenantId, clerk, "2027-01-01", "41.00");
      await tick("2027-01-01");
      expect((await statusOf(clerk))?.runStatus).toBe("paused");
      const set = await ok(admin("a"), "PUT", "/api/billing/credits-out", {
        onCreditsOut: "continue",
      });
      expect(set.pausedForCredits).toEqual([]);
      expect((await statusOf(clerk))?.runStatus).toBe("active");
    });

    it("continue: never pauses, and tells the client admin per 2,500 credits beyond the included", async () => {
      // Client B: one agent, 2,000 included.
      await usage(H.B.tenantId, bClerk, DEC, "44.99"); // 4,499: 2,499 beyond
      await tick(DEC);
      expect(await creditRows(H.B.tenantId)).toEqual([]);
      await usage(H.B.tenantId, bClerk, DEC, "45.00"); // 2,500 beyond: block 1
      await tick(DEC);
      await usage(H.B.tenantId, bClerk, DEC, "69.99"); // still block 1
      await tick(DEC);
      expect((await creditRows(H.B.tenantId)).map((r) => r.counts)).toEqual([
        { block: 1, credits: 2500 },
      ]);
      await usage(H.B.tenantId, bClerk, DEC, "70.00"); // 5,000 beyond: block 2
      await tick(DEC);
      expect((await creditRows(H.B.tenantId)).map((r) => r.dedupeKey).sort()).toEqual(
        [`credits:2026-12:1:${H.B.admin}`, `credits:2026-12:2:${H.B.admin}`].sort(),
      );
      expect((await statusOf(bClerk))?.runStatus).toBe("active");
    });
  });

  // ── The audit export and a run's audit trail ───────────────────────────────────────────────────

  describe("the audit export", () => {
    let lead = "";

    beforeAll(async () => {
      const [l] = await H.t.db
        .insert(appUser)
        .values({ email: "lena@mezonas.example.com", name: "Lena Lead" })
        .returning();
      lead = l?.id as string;
      await H.t.db
        .insert(membership)
        .values({ tenantId: H.A.tenantId, userId: lead, role: "operator" });
      await H.t.db
        .update(tenant)
        .set({
          settings: sql`jsonb_set(${tenant.settings}, '{lead}', ${JSON.stringify({ userId: lead })}::jsonb)`,
        })
        .where(eq(tenant.id, H.A.tenantId));
      const base = { outcome: "ok" as const, target: {} };
      await H.t.db.insert(auditEvent).values([
        {
          ...base,
          tenantId: H.A.tenantId,
          actorKind: "user",
          actorUserId: H.A.admin,
          actorEmail: "admin@a.example.com",
          actorRole: "client_admin",
          action: "GET /api/inbox",
          ip: "198.51.100.7",
        },
        {
          ...base,
          tenantId: H.A.tenantId,
          actorKind: "user",
          actorUserId: H.operator,
          actorEmail: "operator@example.com",
          actorRole: "operator",
          action: "GET /api/ops/clients/:id",
          ip: "10.9.8.7",
          userAgent: "OperatorBrowser/1.0",
        },
        {
          ...base,
          tenantId: H.A.tenantId,
          actorKind: "user",
          actorUserId: lead,
          actorEmail: "lena@mezonas.example.com",
          actorRole: "operator",
          action: "POST /api/threads/:id/messages",
        },
        { ...base, tenantId: H.A.tenantId, actorKind: "system", action: "client.purge_files" },
        { ...base, tenantId: H.A.tenantId, actorKind: "user", action: "session.sign_in" },
        { ...base, tenantId: H.B.tenantId, actorKind: "user", action: "B-AUDIT-sentinel" },
        { ...base, tenantId: null, actorKind: "user", action: "NULL-TENANT-sentinel" },
      ]);
      // More rows than one page, so the stream reads several.
      await H.t.db.insert(auditEvent).values(
        Array.from({ length: AUDIT_PAGE_ROWS + 50 }, (_, i) => ({
          ...base,
          tenantId: H.A.tenantId,
          actorKind: "user" as const,
          actorUserId: H.A.user,
          actorRole: "client_user",
          action: `GET /api/runs#${i}`,
        })),
      );
    });

    const today = new Date().toISOString().slice(0, 10);
    const path = `/api/audit/export.csv?from=${today}&to=${today}`;

    it("is the client admin's, for at most 366 days", async () => {
      expect((await download(user("a"), path)).res.status).toBe(403);
      expect((await download(OPERATOR, path)).res.status).toBe(403);
      expect((await download(null, path)).res.status).toBe(401);
      const long = await download(
        admin("a"),
        "/api/audit/export.csv?from=2025-01-01&to=2026-01-03",
      );
      expect(long.res.status).toBe(400);
    });

    it("holds only the client's rows, its people by name and ours as Mezonas but the lead", async () => {
      const got = await download(admin("a"), path);
      expect(got.res.status).toBe(200);
      expect(got.res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
      expect(got.res.headers.get("content-disposition")).toContain("attachment");
      await H.settle();
      const rows = csvRecords(got.body);
      const actions = rows.map((r) => r.action);
      expect(actions).not.toContain("B-AUDIT-sentinel");
      expect(actions).not.toContain("NULL-TENANT-sentinel");
      expect(actions).not.toContain("session.sign_in");
      // Every page, each row once.
      expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
      expect(rows.filter((r) => r.action?.startsWith("GET /api/runs#"))).toHaveLength(
        AUDIT_PAGE_ROWS + 50,
      );
      const by = (action: string) => rows.find((r) => r.action === action);
      expect(by("GET /api/inbox")).toMatchObject({
        who: "Client A admin",
        side: "client",
        role: "client_admin",
        ip: "198.51.100.7",
      });
      expect(by("GET /api/ops/clients/:id")).toMatchObject({
        who: "Mezonas",
        side: "mezonas",
        role: "",
        ip: "",
        user_agent: "",
      });
      expect(by("POST /api/threads/:id/messages")).toMatchObject({
        who: "Lena Lead",
        role: "lead",
      });
      expect(by("client.purge_files")).toMatchObject({ who: "Mezonas" });
      expect(rows.find((r) => r.action?.startsWith("GET /api/runs#"))).toMatchObject({
        who: "Client A user",
        role: "client_user",
      });
      // Nothing names our people or where they work from.
      for (const needle of ["operator@example.com", "10.9.8.7", "OperatorBrowser", "lena@"]) {
        expect(got.body).not.toContain(needle);
      }
      // The export itself is in the log, with what it covered.
      expect(by("export.audit")).toMatchObject({ who: "Client A admin" });
    });

    it("gives a run's audit trail: who opened it and who signed, in order", async () => {
      const runId = ids.l1 as string;
      const [item] = await H.t.db
        .insert(inboxItem)
        .values({
          tenantId: H.A.tenantId,
          kind: "approval",
          runId,
          title: "Is the price right?",
          assigneeRole: "client_admin",
        })
        .returning();
      const [ours] = await H.t.db
        .insert(inboxItem)
        .values({
          tenantId: H.A.tenantId,
          kind: "review",
          runId,
          title: "Operator review",
          assigneeRole: "operator",
        })
        .returning();
      await ok(admin("a"), "GET", `/api/runs/${runId}`);
      await ok(admin("a"), "GET", `/api/runs/${runId}`);
      await ok(OPERATOR, "GET", `/api/ops/runs/${runId}?client=${H.A.tenantId}`);
      await H.t.db
        .update(inboxItem)
        .set({
          status: "resolved",
          resolution: { approved: true },
          resolvedBy: H.A.admin,
          resolvedAt: new Date(Date.now() + 1000),
        })
        .where(eq(inboxItem.id, item?.id as string));
      // A row on the operator's own item never shows.
      await H.t.db.insert(auditEvent).values({
        tenantId: H.A.tenantId,
        actorKind: "user",
        actorUserId: H.operator,
        actorRole: "operator",
        action: "POST /api/ops/inbox/:id/undo",
        outcome: "ok",
        target: { id: ours?.id as string },
      });
      const trail = await ok(user("a"), "GET", `/api/runs/${runId}/audit`);
      expect(
        trail.entries.map((e: Record<string, unknown>) => [
          e.who,
          e.side,
          e.kind,
          e.itemId,
          e.times,
        ]),
      ).toEqual([
        ["Client A admin", "client", "opened_run", null, 2],
        ["Mezonas", "mezonas", "opened_run", null, 1],
        ["Client A admin", "client", "signed", item?.id, 1],
      ]);
      expect(JSON.stringify(trail)).not.toContain("operator@example.com");
      // Another client's people never see it; a test run has no trail.
      expect((await H.call(admin("b"), "GET", `/api/runs/${runId}/audit`)).status).toBe(404);
      expect((await H.call(admin("a"), "GET", `/api/runs/${ids.test}/audit`)).status).toBe(404);
    });
  });
});
