// docs/agent-assurance-plan.md: an agent's security checks. Run for a live client agent, each result
// is kept as a `control_check` row; a check in review opens one issue for us that says nothing of
// what it found; the client reads every check's result without the evidence (invariant 11); a
// team member who doesn't work with the agent can't read it; the nightly tick runs every live agent.

import { CHECKS } from "@countersign/core";
import { agent, auditEvent, controlCheck, issue } from "@countersign/db";
import { and, eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  forbiddenKeys,
  OPERATOR,
  testBundle,
  user,
} from "./api.test-helper";
import { assuranceTick } from "./assurance/run";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const h = await createApiHarness();
afterAll(() => h?.close());

describe.skipIf(!h)("agent assurance (docs/agent-assurance-plan.md)", () => {
  const H = h as ApiHarness;
  const ids = { mine: "", other: "" };

  async function clientAgent(
    tenantId: string,
    connectionId: string,
    slug: string,
    serviceName: string,
  ) {
    const tpl = await H.call(OPERATOR, "POST", "/api/ops/templates", {
      slug,
      bundle: testBundle(serviceName),
    });
    expect(tpl.status, JSON.stringify(tpl.json)).toBe(200);
    const tid = j(tpl.json).agent.id as string;
    await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${tid}/versions/${j(tpl.json).version.id}/publish`,
    );
    const fork = await H.call(OPERATOR, "POST", `/api/ops/templates/${tid}/fork`, {
      clientId: tenantId,
      serviceName,
    });
    expect(fork.status, JSON.stringify(fork.json)).toBe(200);
    await H.call(OPERATOR, "PATCH", `/api/ops/agents/${j(fork.json).agent.id}/operation`, {
      bindings: { testkit: connectionId },
    });
    const pub = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${j(fork.json).agent.id}/versions/${j(fork.json).version.id}/publish`,
    );
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
    await H.t.db
      .update(agent)
      .set({ runStatus: "active", stage: "live" })
      .where(eq(agent.id, j(fork.json).agent.id));
    return j(fork.json).agent.id as string;
  }

  const rows = (agentId: string) =>
    H.t.db.select().from(controlCheck).where(eq(controlCheck.agentId, agentId));

  beforeAll(async () => {
    ids.mine = await clientAgent(H.A.tenantId, H.A.connectionId, "assure-mine", "Bills in");
    ids.other = await clientAgent(H.B.tenantId, H.B.connectionId, "assure-other", "Elsewhere");
  });

  it("reads every check as not yet checked before its first run", async () => {
    const res = await H.call(admin("a"), "GET", `/api/services/${ids.mine}/assurance`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const view = j(res.json);
    expect(view.checks).toHaveLength(CHECKS.length);
    expect(view.counts.notChecked).toBe(CHECKS.length);
    expect(view.architecture.zones.map((z: { key: string }) => z.key)).toContain("mezonas");
    expect(forbiddenKeys(view)).toEqual([]);
  });

  it("runs the checks when an operator asks, keeping one row per built check", async () => {
    const res = await H.call(OPERATOR, "POST", `/api/ops/agents/${ids.mine}/assurance/run`, {});
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const view = j(res.json);
    const built = CHECKS.filter((c) => c.built).length;
    expect(await rows(ids.mine)).toHaveLength(built);
    expect(view.counts.notChecked).toBe(CHECKS.length - built);
    expect(view.checks.find((c: { id: string }) => c.id === "version_approved").result).toBe(
      "verified",
    );
    // Ours carries the evidence.
    expect(view.checks.find((c: { id: string }) => c.id === "delete_off").evidence).toBeTruthy();
    // The test harness has no second factor configured: in review, with one issue for us.
    const review = view.checks.find((c: { id: string }) => c.id === "second_factor");
    expect(review.result).toBe("in_review");
    expect(review.issueId).toBeTruthy();
    const opened = await H.t.db
      .select()
      .from(issue)
      .where(and(eq(issue.agentId, ids.mine), eq(issue.source, "assurance")));
    expect(opened.map((i) => i.title)).toEqual([
      "Security check in review: Your team signs in with a second factor",
    ]);
    expect(opened[0]?.title).toBe(
      "Security check in review: Your team signs in with a second factor",
    );
    expect(opened[0]?.description).not.toContain("isn't required");
  });

  it("keeps one issue while a check stays in review", async () => {
    await H.call(OPERATOR, "POST", `/api/ops/agents/${ids.mine}/assurance/run`, {});
    const opened = await H.t.db
      .select()
      .from(issue)
      .where(and(eq(issue.agentId, ids.mine), eq(issue.source, "assurance")));
    expect(opened).toHaveLength(1);
    const kept = (await rows(ids.mine)).filter((r) => r.checkId === "second_factor");
    expect(kept).toHaveLength(2);
    expect(new Set(kept.map((r) => r.issueId)).size).toBe(1);
  });

  it("shows the client what was verified, and a check in review only since when", async () => {
    const res = await H.call(admin("a"), "GET", `/api/services/${ids.mine}/assurance`);
    expect(res.status).toBe(200);
    const view = j(res.json);
    expect(forbiddenKeys(view)).toEqual([]);
    const review = view.checks.find((c: { id: string }) => c.id === "second_factor");
    expect(review).toMatchObject({ result: "in_review", found: "" });
    expect(review.since).toBeTruthy();
    expect(review).not.toHaveProperty("evidence");
    expect(review).not.toHaveProperty("issueId");
    expect(view.checks.find((c: { id: string }) => c.id === "delete_off").found).toBeTruthy();
    // SOC 2 references; no HIPAA sections for a client outside HIPAA mode.
    expect(view.checks.every((c: { hipaa: string[] }) => c.hipaa.length === 0)).toBe(true);
    expect(view.checks.find((c: { id: string }) => c.id === "delete_off").soc2).toContain("CC8.1");
  });

  it("is another client's agent: not found; and a team member reads the agents they work with", async () => {
    expect((await H.call(admin("a"), "GET", `/api/services/${ids.other}/assurance`)).status).toBe(
      404,
    );
    expect((await H.call(user("a"), "GET", `/api/services/${ids.mine}/assurance`)).status).toBe(
      200,
    );
    expect(
      (await H.call(OPERATOR, "POST", `/api/ops/agents/${ids.mine}/assurance/run`, {})).status,
    ).toBe(200);
  });

  it("runs every live client agent at its hour, and nothing at any other", async () => {
    const before = (await rows(ids.other)).length;
    await assuranceTick(
      H.db,
      H.platform,
      { covered: "", secondFactorOn: true },
      new Date("2026-11-22T09:23:00Z"),
    );
    expect((await rows(ids.other)).length).toBe(before);
    await assuranceTick(
      H.db,
      H.platform,
      { covered: "", secondFactorOn: true },
      new Date("2026-11-22T08:23:00Z"),
    );
    const after = await rows(ids.other);
    expect(after.length).toBe(before + CHECKS.filter((c) => c.built).length);
    expect(after.every((r) => r.trigger === "nightly")).toBe(true);
    expect(after.find((r) => r.checkId === "second_factor")?.result).toBe("verified");
  });

  it("exports the evidence per period, agent and client, as a page and CSV, audited (§1.231.3)", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await H.call(
      OPERATOR,
      "GET",
      `/api/ops/assurance/evidence?client=${H.A.tenantId}&agent=${ids.mine}&to=${today}`,
    );
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const out = j(res.json);
    expect(out.truncated).toBe(false);
    expect(out.rows.length).toBe((await rows(ids.mine)).length);
    expect(out.rows.every((r: { agent: { id: string } }) => r.agent.id === ids.mine)).toBe(true);
    const delOff = out.rows.find((r: { checkId: string }) => r.checkId === "delete_off");
    expect(delOff).toMatchObject({
      number: "K3",
      result: "verified",
      client: { id: H.A.tenantId },
    });
    expect(delOff.soc2).toContain("CC8.1");
    expect(delOff.evidence).toBeTruthy();
    expect(forbiddenKeys(out)).toEqual([]);

    const csv = await H.call(
      OPERATOR,
      "GET",
      `/api/ops/assurance/evidence.csv?client=${H.A.tenantId}&agent=${ids.mine}`,
    );
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(csv.headers.get("content-disposition")).toMatch(/mezonas-security-evidence-.*\.csv/);
    const lines = String(csv.json).trim().split("\r\n");
    expect(lines[0]).toContain("checked at,client,agent,version,check");
    expect(lines).toHaveLength(out.rows.length + 1);

    const audited = await H.t.db
      .select({ action: auditEvent.action })
      .from(auditEvent)
      .where(like(auditEvent.action, "GET /api/ops/assurance/evidence%"));
    expect(audited.length).toBeGreaterThanOrEqual(2);

    // A bad period, a client not served, and anyone but an operator: refused.
    expect(
      (await H.call(OPERATOR, "GET", "/api/ops/assurance/evidence?from=2026-11-20&to=2026-11-01"))
        .status,
    ).toBe(400);
    expect(
      (
        await H.call(
          OPERATOR,
          "GET",
          `/api/ops/assurance/evidence?client=0199a000-0000-7000-8000-00000000dead`,
        )
      ).status,
    ).not.toBe(200);
    expect((await H.call(admin("a"), "GET", "/api/ops/assurance/evidence")).status).toBe(403);
    expect((await H.call(admin("a"), "GET", "/api/ops/assurance/rollup")).status).toBe(403);
  });

  it("rolls up per control across the clients served (§1.231.3)", async () => {
    const res = await H.call(OPERATOR, "GET", "/api/ops/assurance/rollup");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const out = j(res.json);
    expect(out.clients).toBe(2);
    expect(out.agents).toBe(2);
    const acc2 = out.controls.find((c: { id: string }) => c.id === "ACC-2");
    // Ours was in review (no second factor in the harness); the other's verified at night.
    expect(acc2).toMatchObject({ agents: 2, inReview: 1, verified: 1 });
    expect(out.controls.find((c: { id: string }) => c.id === "GOV-1")).toBeUndefined();
  });
});
