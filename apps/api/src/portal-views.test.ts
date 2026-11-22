// R6: the portal's saved views (docs/reporting-plan.md §3 R6, docs/plan.md §1.236), against a real
// database as cs_worker. A view is its person's; a client admin shares one with the team, a client
// user can't; a shared view reaches the client's team and never another client (invariant 1); a
// limited client user neither saves nor sees a view on an agent off their list (§1.122); a view's
// filter is the portal's, so it can't carry the back office's keys (invariant 11).

import { agent, appUser, membership } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  forbiddenKeys,
  OPERATOR,
  user,
} from "./api.test-helper";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const h = await createApiHarness();
afterAll(() => h?.close());

describe.skipIf(!h)("the portal's saved views", () => {
  const H = h as ApiHarness;
  const owner = H.t.db;
  const ids = {} as Record<"one" | "two", string>;

  beforeAll(async () => {
    for (const slug of ["one", "two"] as const) {
      const [a] = await owner
        .insert(agent)
        .values({
          tenantId: H.A.tenantId,
          kind: "client",
          slug: `views-${slug}`,
          name: `Views ${slug}`,
          serviceName: `Views ${slug}`,
          runStatus: "active",
          stage: "live",
        })
        .returning();
      if (!a) throw new Error("no agent");
      ids[slug] = a.id;
    }
  });

  const views = async (who: string) => {
    const res = await H.call(who, "GET", "/api/views");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return j(res.json).views as {
      id: string;
      name: string;
      shared: boolean;
      mine: boolean;
      ownerName: string | null;
      filters: Record<string, unknown>;
    }[];
  };
  const save = (who: string, body: unknown) => H.call(who, "POST", "/api/views", body);

  it("keeps a view to its person until an admin shares one with the team", async () => {
    const mine = await save(user("a"), {
      name: "Waiting",
      filters: { statuses: ["waiting"] },
    });
    expect(mine.status, JSON.stringify(mine.json)).toBe(200);
    expect(j(mine.json).view).toMatchObject({ name: "Waiting", shared: false, mine: true });
    expect((await views(admin("a"))).map((v) => v.name)).not.toContain("Waiting");

    // A client user can't share, on saving or after.
    const shareIt = await save(user("a"), { name: "Ours", filters: {}, shared: true });
    expect(shareIt.status).toBe(403);
    expect(j(shareIt.json).error?.code ?? j(shareIt.json).code).toBe("not_admin");
    const id = j(mine.json).view.id as string;
    expect((await H.call(user("a"), "PATCH", `/api/views/${id}`, { shared: true })).status).toBe(
      403,
    );

    // An admin shares: the team sees it, by its owner's name, and can't change it.
    const team = await save(admin("a"), {
      name: "Failed this month",
      filters: { statuses: ["failed"], agents: [ids.one] },
      shared: true,
    });
    expect(team.status, JSON.stringify(team.json)).toBe(200);
    const teamId = j(team.json).view.id as string;
    const seen = (await views(user("a"))).find((v) => v.id === teamId);
    expect(seen).toMatchObject({ shared: true, mine: false, ownerName: expect.any(String) });
    expect(seen?.filters).toEqual({ statuses: ["failed"], agents: [ids.one] });
    expect(
      (await H.call(user("a"), "PATCH", `/api/views/${teamId}`, { name: "Mine now" })).status,
    ).toBe(404);
    expect((await H.call(user("a"), "DELETE", `/api/views/${teamId}`)).status).toBe(404);

    // Never another client's, nor the back office's.
    expect((await views(admin("b"))).map((v) => v.id)).not.toContain(teamId);
    expect((await H.call(admin("b"), "DELETE", `/api/views/${teamId}`)).status).toBe(404);
    expect((await H.call(OPERATOR, "GET", "/api/views")).status).toBe(403);

    // The owner stops sharing it; then it's theirs alone again.
    const unshared = await H.call(admin("a"), "PATCH", `/api/views/${teamId}`, { shared: false });
    expect(j(unshared.json).view.shared).toBe(false);
    expect((await views(user("a"))).map((v) => v.id)).not.toContain(teamId);
    // A person deletes their own.
    expect((await H.call(user("a"), "DELETE", `/api/views/${id}`)).status).toBe(200);
    expect((await views(user("a"))).map((v) => v.id)).not.toContain(id);
  });

  it("lets an admin delete a view the team shares, never a person's own", async () => {
    const [person] = await owner
      .select()
      .from(appUser)
      .where(eq(appUser.email, user("a")));
    const role = (r: "client_admin" | "client_user") =>
      owner
        .update(membership)
        .set({ role: r })
        .where(
          and(eq(membership.tenantId, H.A.tenantId), eq(membership.userId, person?.id as string)),
        );
    // A view another admin shared (who may since have left the team): an admin may delete it.
    await role("client_admin");
    let sharedId = "";
    try {
      const shared = await save(user("a"), { name: "Team view", filters: {}, shared: true });
      expect(shared.status, JSON.stringify(shared.json)).toBe(200);
      sharedId = j(shared.json).view.id as string;
    } finally {
      await role("client_user");
    }
    const own = await save(user("a"), { name: "Own view", filters: {} });
    const ownId = j(own.json).view.id as string;
    expect((await H.call(admin("a"), "DELETE", `/api/views/${ownId}`)).status).toBe(404);
    expect((await views(user("a"))).map((v) => v.id)).toContain(ownId);
    expect((await H.call(admin("a"), "DELETE", `/api/views/${sharedId}`)).status).toBe(200);
    expect((await views(user("a"))).map((v) => v.id)).not.toContain(sharedId);
  });

  it("refuses a second view of the same name, a blank name and the back office's keys", async () => {
    expect((await save(user("a"), { name: "Twice", filters: {} })).status).toBe(200);
    const dup = await save(user("a"), { name: "  Twice ", filters: {} });
    expect(dup.status).toBe(409);
    // Another person may use the name.
    expect((await save(admin("a"), { name: "Twice", filters: {} })).status).toBe(200);
    expect((await save(user("a"), { name: "   ", filters: {} })).status).toBe(400);
    for (const filters of [
      { costOver: "1" },
      { errorKey: "x" },
      { mode: "test" },
      { clients: [H.B.tenantId] },
    ]) {
      expect(
        (await save(user("a"), { name: "Nope", filters })).status,
        JSON.stringify(filters),
      ).toBe(400);
    }
  });

  it("keeps a limited user to views on the agents they see", async () => {
    const shared = await save(admin("a"), {
      name: "Two's runs",
      filters: { agents: [ids.two] },
      shared: true,
    });
    expect(shared.status).toBe(200);
    const [person] = await owner
      .select()
      .from(appUser)
      .where(eq(appUser.email, user("a")));
    const limit = (agentIds: string[] | null) =>
      owner
        .update(membership)
        .set({ agentIds })
        .where(
          and(eq(membership.tenantId, H.A.tenantId), eq(membership.userId, person?.id as string)),
        );
    await limit([ids.one]);
    try {
      expect((await views(user("a"))).map((v) => v.name)).not.toContain("Two's runs");
      expect((await save(user("a"), { name: "Two", filters: { agents: [ids.two] } })).status).toBe(
        404,
      );
      expect((await save(user("a"), { name: "One", filters: { agents: [ids.one] } })).status).toBe(
        200,
      );
    } finally {
      await limit(null);
    }
    expect((await views(user("a"))).map((v) => v.name)).toContain("Two's runs");
  });

  it("answers with nothing the portal may not show", async () => {
    for (const v of await views(user("a"))) {
      expect(forbiddenKeys(v, /^(tenantId|userId|clients|costOver|errorKey|mode)$/)).toEqual([]);
    }
  });
});
