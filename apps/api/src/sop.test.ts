// docs/sop-plan.md S1: the agent's SOP. The portal's SOP tab reads a view made by code from the
// agent's setup now, never the bundle, instructions, prompts or cost (invariant 11); its first
// revision is recorded when it is first read; a change to what it says, made through a session
// route, records the next revision in the same transaction with who made it and where.

import { agent, sopRevision } from "@countersign/db";
import { and, eq } from "drizzle-orm";
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

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const h = await createApiHarness();
afterAll(() => h?.close());

describe.skipIf(!h)("the agent's SOP (docs/sop-plan.md)", () => {
  const H = h as ApiHarness;
  const ids = { mine: "", other: "" };

  async function clientAgent(tenantId: string, slug: string, serviceName: string) {
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
    await H.t.db
      .update(agent)
      .set({ runStatus: "active", stage: "live" })
      .where(eq(agent.id, j(fork.json).agent.id));
    return j(fork.json).agent.id as string;
  }

  const revisions = (agentId: string) =>
    H.t.db.select().from(sopRevision).where(eq(sopRevision.agentId, agentId));

  beforeAll(async () => {
    ids.mine = await clientAgent(H.A.tenantId, "sop-mine", "Bills in");
    ids.other = await clientAgent(H.B.tenantId, "sop-other", "Elsewhere");
  });

  it("reads as a view made by code, with its first revision, and nothing the portal may not carry", async () => {
    const res = await H.call(admin("a"), "GET", `/api/services/${ids.mine}/sop`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const view = j(res.json);
    expect(forbiddenKeys(view)).toEqual([]);
    expect(JSON.stringify(view)).not.toContain("Change records only when asked.");
    expect(view.code).toMatch(/^SOP-[A-Z]{3}-\d{2}$/);
    expect(view.agent.name).toBe("Bills in");
    expect(view.revision.number).toMatch(/^\d+\.0$/);
    expect(view.revision.changes[0].words).toBe("First revision of this SOP.");
    expect(view.history).toHaveLength(1);
    const steps = view.procedure.filter((l: { line: string }) => l.line === "step");
    expect(steps.map((s: { name: string }) => s.name)).toEqual([
      "Update the record",
      "Confirm",
      "Operator note",
    ]);
    expect(steps[1].method).toBe("person");
    expect(steps[1].who.name).toBe("Your admin");
    // The agent itself is never a column of who else takes part.
    expect(view.matrix.parties.map((p: { name: string }) => p.name)).not.toContain("Bills in");
    // The client admin reads what it learned; the reading made exactly one revision.
    expect(view.learned).toEqual([]);
    expect(await revisions(ids.mine)).toHaveLength(1);
  });

  it("makes no new revision when nothing it says changed", async () => {
    await H.call(admin("a"), "GET", `/api/services/${ids.mine}/sop`);
    await H.call(user("a"), "GET", `/api/services/${ids.mine}/sop`);
    expect(await revisions(ids.mine)).toHaveLength(1);
  });

  it("hides what it learned from a client user, and another client's agent is not found", async () => {
    const res = await H.call(user("a"), "GET", `/api/services/${ids.mine}/sop`);
    expect(res.status).toBe(200);
    expect(j(res.json).learned).toBeNull();
    expect((await H.call(admin("a"), "GET", `/api/services/${ids.other}/sop`)).status).toBe(404);
  });

  it("records the next revision at the change, with who made it and where", async () => {
    const set = await H.call(admin("a"), "PUT", "/api/settings/business-hours", {
      week: { mon: [{ from: "07:00", to: "15:00" }], tue: [{ from: "07:00", to: "15:00" }] },
      usHolidays: true,
      closed: [],
    });
    expect(set.status, JSON.stringify(set.json)).toBe(200);
    const rows = await H.t.db
      .select()
      .from(sopRevision)
      .where(and(eq(sopRevision.agentId, ids.mine), eq(sopRevision.source, "business_hours")));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.changedBySide).toBe("client");
    expect(rows[0]?.minor).toBe(1);

    const view = j((await H.call(admin("a"), "GET", `/api/services/${ids.mine}/sop`)).json);
    expect(view.revision.number).toMatch(/^\d+\.1$/);
    expect(view.previous.number).toMatch(/^\d+\.0$/);
    expect(view.revision.where).toBe("Business hours");
    expect(view.revision.by).toBeTruthy();
    expect(view.revision.changes.map((c: { words: string }) => c.words).join(" ")).toContain(
      "Business hours:",
    );
    expect(view.start.hours).toContain("Monday to Tuesday, 07:00 to 15:00");
    // The read found nothing new to record.
    expect(await revisions(ids.mine)).toHaveLength(2);
  });

  it("reads the same SOP in the back office, for clients the operator serves", async () => {
    const res = await H.call(OPERATOR, "GET", `/api/ops/agents/${ids.mine}/sop`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(j(res.json).agent.id).toBe(ids.mine);
    expect(j(res.json).learned).toEqual([]);
  });
});
