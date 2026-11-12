// v0.17 O4 (ARCHITECTURE §10.15, docs/plan.md §1.96): a client's area owners through the API. The
// back office lists them (creating one for each area in use), saves a version with a model of any
// priced provider and notes, renames them and forgets a memory note; a process moves to another
// area; the portal sees names and areas only, and only the client admin renames.

import { agent, areaOwner, memoryNote } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  OPERATOR,
  OTHER_OPERATOR,
  user,
} from "./api.test-helper";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const h = await createApiHarness();
afterAll(() => h?.close());

describe.skipIf(!h)("area owners through the API", () => {
  const H = h as ApiHarness;
  /** Client A's one process here: a client agent with no version yet (its area: general). */
  let agentId = "";

  beforeAll(async () => {
    const [made] = await H.t.db
      .insert(agent)
      .values({
        tenantId: H.A.tenantId,
        kind: "client",
        slug: "owners-clerk",
        name: "Owners clerk",
        stage: "bench",
      })
      .returning({ id: agent.id });
    agentId = made?.id ?? "";
  });

  const owners = async () => {
    const res = await H.call(OPERATOR, "GET", `/api/ops/clients/${H.A.tenantId}/owners`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return j(res.json).owners as {
      id: string;
      area: string;
      name: string;
      version: number;
      model: { id: string } | null;
      notes: string;
      processes: { agentId: string }[];
      memory: { id: string; note: string }[];
    }[];
  };

  it("lists one owner for each area the client's processes are in", async () => {
    const list = await owners();
    expect(list.length).toBeGreaterThan(0);
    expect(new Set(list.map((o) => o.area)).size).toBe(list.length);
    // Every process the client has is some owner's.
    const listed = list.flatMap((o) => o.processes.map((p) => p.agentId));
    expect(listed).toContain(agentId);
    // Another operator who doesn't serve A sees nothing of it.
    const other = await H.call(OTHER_OPERATOR, "GET", `/api/ops/clients/${H.A.tenantId}/owners`);
    expect(other.status).toBe(404);
  });

  it("saves the owner's model and notes as its next version, and refuses a model we can't price", async () => {
    const [first] = await owners();
    if (!first) throw new Error("no owner");
    const saved = await H.call(OPERATOR, "POST", `/api/ops/owners/${first.id}/versions`, {
      model: { id: "xai:grok-4.7", maxTokens: 2048 },
      notes: "## Acme\nFreight under $20 needs no question.",
      oversight: { review: "failures", maxPerRun: 2, maxCostUsd: "0.20" },
      changeNote: "Grok for this area",
    });
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    expect(j(saved.json).owner).toMatchObject({
      version: first.version + 1,
      model: { id: "xai:grok-4.7" },
      notes: "## Acme\nFreight under $20 needs no question.",
    });
    const unknown = await H.call(OPERATOR, "POST", `/api/ops/owners/${first.id}/versions`, {
      model: { id: "made-up-model" },
      notes: "",
      oversight: null,
    });
    expect(unknown.status).toBe(422);
    const detail = j((await H.call(OPERATOR, "GET", `/api/ops/owners/${first.id}`)).json);
    expect(detail.versions[0]).toMatchObject({
      version: first.version + 1,
      authorType: "operator",
    });
  });

  it("renames an owner, never to Sloan or a sibling's name", async () => {
    const [first] = await owners();
    if (!first) throw new Error("no owner");
    const ok = await H.call(OPERATOR, "PATCH", `/api/ops/owners/${first.id}`, { name: "Pip" });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(j(ok.json).owner.name).toBe("Pip");
    const sloan = await H.call(OPERATOR, "PATCH", `/api/ops/owners/${first.id}`, { name: "Sloan" });
    expect([sloan.status, j(sloan.json).error?.code ?? j(sloan.json).code]).toEqual([
      422,
      "name_reserved",
    ]);
  });

  it("shows the portal names and areas only, and lets only the client admin rename", async () => {
    const res = await H.call(admin("a"), "GET", "/api/owners");
    expect(res.status).toBe(200);
    const list = j(res.json).owners as { id: string; name: string; area: string }[];
    expect(list.length).toBeGreaterThan(0);
    const body = JSON.stringify(res.json);
    for (const hidden of ["model", "notes", "grok", "Freight", "oversight", "memory"]) {
      expect(body).not.toContain(hidden);
    }
    const id = list[0]?.id as string;
    const byUser = await H.call(user("a"), "PATCH", `/api/owners/${id}`, { name: "Wren" });
    expect(byUser.status).toBe(403);
    const byAdmin = await H.call(admin("a"), "PATCH", `/api/owners/${id}`, { name: "Wren" });
    expect(byAdmin.status, JSON.stringify(byAdmin.json)).toBe(200);
    expect(j(byAdmin.json).owner).toEqual({
      id,
      name: "Wren",
      area: list[0]?.area,
      avatar: null,
    });
    // Client B can't touch A's owner.
    const fromB = await H.call(admin("b"), "PATCH", `/api/owners/${id}`, { name: "Kit" });
    expect(fromB.status).toBe(404);
  });

  it("moves a process to another area, whose owner is created for it", async () => {
    const res = await H.call(OPERATOR, "PATCH", `/api/ops/agents/${agentId}/area`, {
      area: "receivables",
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(j(res.json)).toEqual({ agentId: agentId, area: "receivables" });
    const list = await owners();
    const receivables = list.find((o) => o.area === "receivables");
    expect(receivables?.processes.map((p) => p.agentId)).toContain(agentId);
    // Its first owner shares no first letter with the client's others.
    const firsts = list.map((o) => o.name[0]);
    expect(new Set(firsts).size).toBe(firsts.length);
    await H.call(OPERATOR, "PATCH", `/api/ops/agents/${agentId}/area`, { area: null });
    const [row] = await H.t.db
      .select({ area: agent.area })
      .from(agent)
      .where(eq(agent.id, agentId));
    expect(row?.area).toBeNull();
  });

  it("forgets one of an owner's memory notes", async () => {
    const [first] = await owners();
    if (!first) throw new Error("no owner");
    const [note] = await H.t.db
      .insert(memoryNote)
      .values({ tenantId: H.A.tenantId, ownerId: first.id, note: "Wrong: Acme pays on the 1st" })
      .returning();
    const res = await H.call(OPERATOR, "DELETE", `/api/ops/owners/${first.id}/memory/${note?.id}`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const left = await H.t.db
      .select()
      .from(memoryNote)
      .where(and(eq(memoryNote.ownerId, first.id), eq(memoryNote.id, note?.id as string)));
    expect(left).toEqual([]);
    const again = await H.call(
      OPERATOR,
      "DELETE",
      `/api/ops/owners/${first.id}/memory/${note?.id}`,
    );
    expect(again.status).toBe(404);
    const [still] = await H.t.db.select().from(areaOwner).where(eq(areaOwner.id, first.id));
    expect(still).toBeDefined();
  });
});
