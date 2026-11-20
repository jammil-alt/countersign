// SEC lens: Sloan (the client's account agent) and a client user limited to some agents
// (docs/plan.md §1.122). Sloan's account tools read through `dbAccountPort` (packages/agents) and
// apps/api's `accountViews`, the path `runs/execute.ts` wires for every Sloan run; a limited person
// reaches Sloan by email or text (account/reach.ts takes any client person proven by DMARC).
import { dbAccountPort } from "@countersign/agents";
import { ACCOUNT_AGENT_SLUG } from "@countersign/core";
import { agent, appUser, membership, run } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { accountViews } from "../account/views";
import { createApiHarness, OPERATOR, testBundle, user } from "../api.test-helper";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const h = await createApiHarness();
afterAll(() => h?.close());

describe.skipIf(!h)("SEC: Sloan for a person limited to some agents", () => {
  const H = h as NonNullable<typeof h>;

  async function clientAgent(slug: string, serviceName: string) {
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
      clientId: H.A.tenantId,
      serviceName,
    });
    expect(fork.status, JSON.stringify(fork.json)).toBe(200);
    const id = j(fork.json).agent.id as string;
    await H.t.db.update(agent).set({ runStatus: "active" }).where(eq(agent.id, id));
    return { id, version: j(fork.json).version.id as string };
  }

  async function liveRun(
    a: { id: string; version: string },
    trigger: Record<string, unknown> = {},
  ) {
    const [row] = await H.t.db
      .insert(run)
      .values({
        tenantId: H.A.tenantId,
        agentId: a.id,
        agentVersionId: a.version,
        workflowSlug: "fix-record",
        status: "succeeded",
        trigger,
      })
      .returning({ id: run.id });
    return row?.id as string;
  }

  it("SEC-8: Sloan shows a limited client user only their agents' runs, as the portal does", async () => {
    const mine = await clientAgent("sec-invoices", "Invoices");
    const notMine = await clientAgent("sec-payroll", "Payroll");
    const sloan = await clientAgent("sec-sloan", "Sloan");
    await H.t.db.update(agent).set({ slug: ACCOUNT_AGENT_SLUG }).where(eq(agent.id, sloan.id));
    const mineRun = await liveRun(mine);
    const notMineRun = await liveRun(notMine);
    const [u] = await H.t.db
      .select()
      .from(appUser)
      .where(eq(appUser.email, user("a")));
    const uid = u?.id as string;
    await H.t.db
      .update(membership)
      .set({ agentIds: [mine.id] })
      .where(and(eq(membership.tenantId, H.A.tenantId), eq(membership.userId, uid)));
    // Sloan's run, answering this person's message in their account conversation.
    const sloanRun = await liveRun(sloan, {
      type: "event",
      eventType: "thread.message_posted",
      payload: {
        threadId: "0190f5e8-8a3c-7d6e-8f00-0000000000a1",
        subjectType: "account",
        subjectId: null,
        messageId: "0190f5e8-8a3c-7d6e-8f00-0000000000a2",
        senderType: "user",
        senderId: uid,
        audience: "client",
      },
    });
    // The portal itself refuses them the other agent's run.
    const portal = await H.call(user("a"), "GET", `/api/runs/${notMineRun}`);
    expect(portal.status).toBe(404);

    const port = dbAccountPort(H.db, accountViews(H.platform));
    const call = {
      agentId: sloan.id,
      agentVersionId: sloan.version,
      runId: sloanRun,
      stepId: "answer",
      mode: "live" as const,
    };
    const runs = await port.runs(H.A.tenantId, call, { limit: 50 });
    const ids = runs.map((r) => (r as { id: string }).id);
    expect(ids).toContain(mineRun);
    expect(ids).not.toContain(notMineRun);
    const services = await port.services(H.A.tenantId, call);
    expect(services.map((s) => s.name)).not.toContain("Payroll");
  });
});
