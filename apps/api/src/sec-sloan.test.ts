// Sloan (the client's account agent) and a client user limited to some agents (docs/plan.md
// §1.122: a limited user has no Sloan). Sloan's account tools read through `dbAccountPort`
// (packages/agents) and apps/api's `accountViews`, the path `runs/execute.ts` wires for every
// Sloan run; a person reaches Sloan by email or text through account/reach.ts. A limited person
// is refused on both, so Sloan never shows them what the portal doesn't (PLATFORM_QA SEC-8).
import { AccountRefusal, dbAccountPort } from "@countersign/agents";
import { ACCOUNT_AGENT_SLUG } from "@countersign/core";
import { agent, appUser, membership, run, withTenant } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { clientPersonByEmail } from "./account/reach";
import { accountViews } from "./account/views";
import { admin, createApiHarness, OPERATOR, testBundle, user } from "./api.test-helper";

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

  const asked = (senderId: string) => ({
    type: "event",
    eventType: "thread.message_posted",
    payload: {
      threadId: "0190f5e8-8a3c-7d6e-8f00-0000000000a1",
      subjectType: "account",
      subjectId: null,
      messageId: "0190f5e8-8a3c-7d6e-8f00-0000000000a2",
      senderType: "user",
      senderId,
      audience: "client",
    },
  });

  const userId = async (email: string) => {
    const [u] = await H.t.db.select().from(appUser).where(eq(appUser.email, email));
    return u?.id as string;
  };

  it("(PLATFORM_QA SEC-8) Sloan shows a limited client user nothing the portal doesn't: they have no Sloan", async () => {
    const mine = await clientAgent("sec-invoices", "Invoices");
    const notMine = await clientAgent("sec-payroll", "Payroll");
    const sloan = await clientAgent("sec-sloan", "Sloan");
    await H.t.db.update(agent).set({ slug: ACCOUNT_AGENT_SLUG }).where(eq(agent.id, sloan.id));
    const mineRun = await liveRun(mine);
    const notMineRun = await liveRun(notMine);
    const uid = await userId(user("a"));
    await H.t.db
      .update(membership)
      .set({ agentIds: [mine.id] })
      .where(and(eq(membership.tenantId, H.A.tenantId), eq(membership.userId, uid)));
    // The portal itself refuses them the other agent's run.
    const portal = await H.call(user("a"), "GET", `/api/runs/${notMineRun}`);
    expect(portal.status).toBe(404);

    const port = dbAccountPort(H.db, accountViews(H.platform));
    const callFor = async (senderId: string) => ({
      agentId: sloan.id,
      agentVersionId: sloan.version,
      runId: await liveRun(sloan, asked(senderId)),
      stepId: "answer",
      mode: "live" as const,
    });

    // Sloan's run, answering the limited person's message in their account conversation.
    const limited = await callFor(uid);
    await expect(port.runs(H.A.tenantId, limited, { limit: 50 })).rejects.toThrow(AccountRefusal);
    await expect(port.services(H.A.tenantId, limited)).rejects.toThrow(AccountRefusal);
    // Their mail and texts to Sloan find no client person, so they are answered as a stranger's.
    const person = await withTenant(H.db, H.A.tenantId, (tx) =>
      clientPersonByEmail(tx, H.A.tenantId, user("a")),
    );
    expect(person).toBeNull();

    // The admin, who sees every agent in the portal, still has Sloan and every agent's runs.
    const full = await callFor(await userId(admin("a")));
    const ids = (await port.runs(H.A.tenantId, full, { limit: 50 })).map(
      (r) => (r as { id: string }).id,
    );
    expect(ids).toEqual(expect.arrayContaining([mineRun, notMineRun]));
    const services = await port.services(H.A.tenantId, full);
    expect(services.map((s) => s.name)).toContain("Payroll");
  });
});
