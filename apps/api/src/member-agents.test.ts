// docs/plan.md §1.122: the client admin gives a client user some of the client's agents. A limited
// user sees only those agents, their runs and their items, and every portal route that isn't about
// their agents is refused (403 `not_assigned`); a list of null is every agent, as before. The admin
// (and the operator) change a person's role, signing and agents in place. The back office's Users
// screen lists, invites and removes operators within the clients the operator serves.

import { agent, appUser, inboxItem, membership, run } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  OPERATOR,
  OTHER_OPERATOR,
  testBundle,
  user,
} from "./api.test-helper";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;
const code = (v: unknown) => j(v)?.error?.code as string | undefined;

const h = await createApiHarness();
afterAll(() => h?.close());

describe.skipIf(!h)("agents a client user sees (§1.122)", () => {
  const H = h as ApiHarness;
  const ids = { one: "", two: "", other: "", runOne: "", runTwo: "", itemOne: "", itemTwo: "" };
  let userId = "";

  /** A client agent forked from a template of its own, active, with its live version id. */
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
    // The portal shows live agents: this one is made active here, without a test run first.
    await H.t.db
      .update(agent)
      .set({ runStatus: "active" })
      .where(eq(agent.id, j(fork.json).agent.id));
    return { id: j(fork.json).agent.id as string, version: j(fork.json).version.id as string };
  }

  async function liveRun(tenantId: string, a: { id: string; version: string }) {
    const [row] = await H.t.db
      .insert(run)
      .values({
        tenantId,
        agentId: a.id,
        agentVersionId: a.version,
        workflowSlug: "fix-record",
        status: "succeeded",
      })
      .returning({ id: run.id });
    return row?.id as string;
  }

  async function item(tenantId: string, agentId: string, runId: string, title: string) {
    const [row] = await H.t.db
      .insert(inboxItem)
      .values({ tenantId, agentId, runId, kind: "review", title, assigneeRole: "client_user" })
      .returning({ id: inboxItem.id });
    return row?.id as string;
  }

  beforeAll(async () => {
    const one = await clientAgent(H.A.tenantId, "access-one", "Invoices");
    const two = await clientAgent(H.A.tenantId, "access-two", "Collections");
    const other = await clientAgent(H.B.tenantId, "access-other", "Elsewhere");
    ids.one = one.id;
    ids.two = two.id;
    ids.other = other.id;
    ids.runOne = await liveRun(H.A.tenantId, one);
    ids.runTwo = await liveRun(H.A.tenantId, two);
    ids.itemOne = await item(H.A.tenantId, one.id, ids.runOne, "Check invoice 1");
    ids.itemTwo = await item(H.A.tenantId, two.id, ids.runTwo, "Chase customer 2");
    const [u] = await H.t.db
      .select()
      .from(appUser)
      .where(eq(appUser.email, user("a")));
    userId = u?.id as string;
  });

  afterAll(async () => {
    // Back to every agent, so other tests' client user is as the harness made them.
    await H.t.db
      .update(membership)
      .set({ agentIds: null, role: "client_user", canSign: true })
      .where(and(eq(membership.tenantId, H.A.tenantId), eq(membership.userId, userId)));
  });

  it("offers the client's agents and lists each person's (null: every agent)", async () => {
    const res = await H.call(admin("a"), "GET", "/api/users");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const names = j(res.json).agents.map((a: { name: string }) => a.name);
    expect(names).toEqual(expect.arrayContaining(["Invoices", "Collections"]));
    expect(names).not.toContain("Elsewhere");
    const me = j(res.json).users.find((u: { email: string }) => u.email === user("a"));
    expect(me.agentIds).toBeNull();
  });

  it("refuses another client's agent, and a list for an admin", async () => {
    const other = await H.call(admin("a"), "PATCH", `/api/users/${userId}`, {
      agentIds: [ids.other],
    });
    expect(other.status).toBe(422);
    expect(code(other.json)).toBe("unknown_agent");
    const forAdmin = await H.call(admin("a"), "PATCH", `/api/users/${userId}`, {
      role: "client_admin",
      agentIds: [ids.one],
    });
    expect(forAdmin.status).toBe(422);
    expect(code(forAdmin.json)).toBe("admin_sees_all");
  });

  it("limits a client user to their agents, their runs and their items", async () => {
    const set = await H.call(admin("a"), "PATCH", `/api/users/${userId}`, {
      agentIds: [ids.one],
    });
    expect(set.status, JSON.stringify(set.json)).toBe(200);
    expect(j(set.json).member.agentIds).toEqual([ids.one]);

    const session = j((await H.call(user("a"), "GET", "/api/session")).json);
    expect(session.assignedAgents).toEqual([ids.one]);

    const runs = j((await H.call(user("a"), "GET", "/api/runs")).json).runs;
    expect(runs.map((r: { id: string }) => r.id)).toContain(ids.runOne);
    expect(runs.map((r: { id: string }) => r.id)).not.toContain(ids.runTwo);

    expect((await H.call(user("a"), "GET", `/api/runs/${ids.runOne}`)).status).toBe(200);
    expect((await H.call(user("a"), "GET", `/api/runs/${ids.runTwo}`)).status).toBe(404);
    expect((await H.call(user("a"), "GET", `/api/runs/${ids.runTwo}/status`)).status).toBe(404);
    expect((await H.call(user("a"), "GET", `/api/services/${ids.one}`)).status).toBe(200);
    expect((await H.call(user("a"), "GET", `/api/services/${ids.two}`)).status).toBe(404);
    expect((await H.call(user("a"), "GET", `/api/services/${ids.two}/run-forms`)).status).toBe(404);

    const inbox = j((await H.call(user("a"), "GET", "/api/inbox")).json).items;
    expect(inbox.map((i: { id: string }) => i.id)).toContain(ids.itemOne);
    expect(inbox.map((i: { id: string }) => i.id)).not.toContain(ids.itemTwo);
    const resolve = await H.call(user("a"), "POST", `/api/inbox/${ids.itemTwo}/resolve`, {
      decision: "approve",
    });
    expect(resolve.status).toBe(404);

    const table = j((await H.call(user("a"), "GET", "/api/table")).json);
    expect(table.services.every((s: { id: string }) => s.id === ids.one)).toBe(true);
  });

  it("closes what isn't about their agents", async () => {
    for (const path of ["/api/connections", "/api/directory", "/api/records", "/api/threads"]) {
      const res = await H.call(user("a"), "GET", path);
      expect(res.status, path).toBe(403);
      expect(code(res.json), path).toBe("not_assigned");
    }
    // Their own settings stay open.
    expect((await H.call(user("a"), "GET", "/api/settings/my-hours")).status).toBe(200);
    // The admin and the other client's user are not limited.
    expect((await H.call(admin("a"), "GET", "/api/connections")).status).toBe(200);
    expect((await H.call(user("b"), "GET", "/api/directory")).status).toBe(200);
  });

  it("an empty list sees no agent; null sees them all again", async () => {
    await H.call(admin("a"), "PATCH", `/api/users/${userId}`, { agentIds: [] });
    expect((await H.call(user("a"), "GET", `/api/services/${ids.one}`)).status).toBe(404);
    const back = await H.call(admin("a"), "PATCH", `/api/users/${userId}`, { agentIds: null });
    expect(back.status).toBe(200);
    expect((await H.call(user("a"), "GET", `/api/services/${ids.two}`)).status).toBe(200);
    expect((await H.call(user("a"), "GET", "/api/directory")).status).toBe(200);
  });

  it("invites a client user with their agents", async () => {
    const res = await H.call(admin("a"), "POST", "/api/users", {
      email: "limited@a.example.com",
      role: "client_user",
      agentIds: [ids.two],
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(j(res.json).member.agentIds).toEqual([ids.two]);
  });

  it("changes role and signing in place, never your own, and keeps an admin", async () => {
    const self = await H.call(admin("a"), "PATCH", `/api/users/${userId}`, { canSign: false });
    expect(self.status).toBe(200);
    expect(j(self.json).member.canSign).toBe(false);
    const [me] = await H.t.db
      .select()
      .from(appUser)
      .where(eq(appUser.email, admin("a")));
    const mine = await H.call(admin("a"), "PATCH", `/api/users/${me?.id}`, {
      role: "client_user",
    });
    expect(mine.status).toBe(409);
    expect(code(mine.json)).toBe("self");
    // From the back office, the only admin can't be made a client user.
    const last = await H.call(
      OPERATOR,
      "PATCH",
      `/api/ops/clients/${H.A.tenantId}/members/${me?.id}`,
      {
        role: "client_user",
      },
    );
    expect(last.status).toBe(409);
    expect(code(last.json)).toBe("last_admin");
    const promote = await H.call(
      OPERATOR,
      "PATCH",
      `/api/ops/clients/${H.A.tenantId}/members/${userId}`,
      { role: "client_admin" },
    );
    expect(promote.status, JSON.stringify(promote.json)).toBe(200);
    expect(j(promote.json).member).toMatchObject({
      role: "client_admin",
      canSign: true,
      agentIds: null,
    });
  });

  it("a client user can't change anyone's access", async () => {
    const res = await H.call(user("b"), "PATCH", `/api/users/${userId}`, { canSign: false });
    expect(res.status).toBe(403);
  });
});

describe.skipIf(!h)("the back office's Users screen (§1.122)", () => {
  const H = h as ApiHarness;

  it("lists the operators who serve your clients, and no one else", async () => {
    const res = await H.call(OPERATOR, "GET", "/api/ops/operators");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const emails = j(res.json).operators.map((o: { email: string }) => o.email);
    expect(emails).toContain(OPERATOR);
    // The other operator serves only client C, which this operator doesn't.
    expect(emails).not.toContain(OTHER_OPERATOR);
    expect(j(res.json).operators.find((o: { you: boolean }) => o.you).email).toBe(OPERATOR);
  });

  it("invites an operator into the clients you serve, and removes them", async () => {
    const res = await H.call(OPERATOR, "POST", "/api/ops/operators", {
      email: "New.Op@Example.com",
      name: "New op",
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const body = j(res.json);
    const served = j((await H.call(OPERATOR, "GET", "/api/ops/operators")).json).clients;
    expect(body.operator).toMatchObject({ email: "new.op@example.com", clients: served });
    expect(body.added).toBe(served);

    // Inviting again adds nothing new.
    const again = await H.call(OPERATOR, "POST", "/api/ops/operators", {
      email: "new.op@example.com",
    });
    expect(j(again.json).added).toBe(0);

    const gone = await H.call(OPERATOR, "DELETE", `/api/ops/operators/${body.operator.userId}`);
    expect(gone.status, JSON.stringify(gone.json)).toBe(200);
    expect(j(gone.json).clients).toBe(served);
    const left = await H.t.db
      .select()
      .from(membership)
      .where(eq(membership.userId, body.operator.userId));
    expect(left).toEqual([]);
  });

  it("refuses a client's person, yourself, and client people calling", async () => {
    const person = await H.call(OPERATOR, "POST", "/api/ops/operators", { email: user("a") });
    expect(person.status).toBe(409);
    expect(code(person.json)).toBe("client_person");
    const [me] = await H.t.db.select().from(appUser).where(eq(appUser.email, OPERATOR));
    const self = await H.call(OPERATOR, "DELETE", `/api/ops/operators/${me?.id}`);
    expect(self.status).toBe(409);
    expect((await H.call(admin("a"), "GET", "/api/ops/operators")).status).toBe(403);
  });
});
