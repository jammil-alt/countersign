// Getting started through the API (docs/setup-plan.md; docs/plan.md §1.206): the overview's line
// per agent and its chapters, and Your people's seats, merged across the agents that share one,
// filled by the client admin with checks on each person (a member who can sign, for a seat that
// signs), and the lead told when who signs changes after a trial has started. No portal answer
// carries anything of ours (invariant 11); one client never sees another's (invariant 1).
import { TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import { forbiddenPortalFields, gettingStartedRoutes } from "@countersign/core";
import { agent, todo, withOperator } from "@countersign/db";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  forbiddenKeys,
  OPERATOR,
  user,
} from "./api.test-helper";

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const h = await createApiHarness();
afterAll(() => h?.close());

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const SEATS = [
  {
    role: "bill-approver",
    kind: "signs",
    label: "Approves bills",
    required: true,
    description: "Signs each change in your books.",
  },
  { role: "job-codes", kind: "answers", label: "Answers questions about job codes" },
  { role: "summary", kind: "told", label: "Gets the weekly summary" },
];

function bundle(name: string, people = SEATS, onlyApprover = false): unknown {
  return {
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: { name, role: "Bills", mission: "Enter bills." },
      kind: "functional",
      model: { id: "test-model", maxTokens: 1024 },
      instructions: "Be brief.",
      skills: [],
      extraTools: [TESTKIT_UPDATE_TOOL],
      permissions: { mode: "suggest_only" },
    },
    people,
    workflows: [
      {
        slug: "main",
        name: "Main",
        workflow: {
          schemaVersion: 5,
          triggers: [{ id: "t", on: { type: "manual", input: {} } }],
          outputs: [{ id: "out-done", name: "Done", kind: "nothing" }],
          steps: [
            {
              id: "update",
              name: "Update the record",
              checks: {
                approval: { required: "required", approvers: [{ who: "seat:bill-approver" }] },
              },
              kind: "do",
              doneBy: "rules",
              uses: { type: "action", action: TESTKIT_UPDATE_TOOL },
              input: { id: "r1", amount: "12.00" },
            },
            { id: "end", kind: "end", name: "Done", outputs: ["out-done"] },
          ],
        },
      },
    ],
  };
}

describe.skipIf(!h)("Getting started", () => {
  const H = h as ApiHarness;
  const A = () => H.A.tenantId;
  const ids: Record<string, string> = {};
  const agents: string[] = [];

  async function makeAgent(slug: string, name: string, people = SEATS) {
    const created = await H.call(OPERATOR, "POST", `/api/ops/clients/${A()}/agents`, {
      slug,
      bundle: bundle(name, people, people.length === 1),
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    expect(j(created.json).errors ?? []).toEqual([]);
    const id = j(created.json).agent.id as string;
    const bound = await H.call(OPERATOR, "PATCH", `/api/ops/agents/${id}/operation`, {
      bindings: { testkit: H.A.connectionId },
    });
    expect(bound.status, JSON.stringify(bound.json)).toBe(200);
    const pub = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${id}/versions/${j(created.json).version.id}/publish`,
    );
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
    agents.push(id);
    return id;
  }

  it("refuses to publish a version that names a seat it doesn't declare", async () => {
    const bad = await H.call(OPERATOR, "POST", `/api/ops/clients/${A()}/agents`, {
      slug: "no-seats",
      bundle: bundle("No seats", []),
    });
    const id = j(bad.json).agent.id as string;
    await H.call(OPERATOR, "PATCH", `/api/ops/agents/${id}/operation`, {
      bindings: { testkit: H.A.connectionId },
    });
    const pub = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${id}/versions/${j(bad.json).version.id}/publish`,
    );
    expect(pub.status).toBe(422);
    expect(JSON.stringify(pub.json)).toContain("unknown_seat");
    await H.call(OPERATOR, "POST", `/api/ops/agents/${id}/retire`);
  });

  it("declares no portal answer with forbidden fields", () => {
    for (const r of Object.values(gettingStartedRoutes)) {
      if (r.path.startsWith("/api/ops/")) continue;
      expect(forbiddenPortalFields(r.response), r.path).toEqual([]);
    }
  });

  it("lists each seat once across the agents that share it, with the client's people", async () => {
    await makeAgent("bills", "Bill clerk");
    await makeAgent("contracts", "Vendor contracts", [SEATS[0] as (typeof SEATS)[number]]);
    const users = await H.call(admin("a"), "GET", "/api/users");
    for (const u of j(users.json).users) ids[u.email] = u.userId;

    const res = await H.call(admin("a"), "GET", "/api/getting-started/people");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const people = j(res.json).people;
    expect(people.canEdit).toBe(true);
    expect(people.seats.map((s: { role: string }) => s.role)).toEqual([
      "bill-approver",
      "job-codes",
      "summary",
    ]);
    const approver = people.seats[0];
    expect(approver).toMatchObject({ kind: "signs", label: "Approves bills", filled: false });
    expect(approver.agents.map((a: { name: string }) => a.name).sort()).toEqual([
      "Bill clerk",
      "Vendor contracts",
    ]);
    expect(people.members.map((m: { email: string }) => m.email).sort()).toEqual(
      [admin("a"), user("a")].sort(),
    );
    expect(forbiddenKeys(res.json)).toEqual([]);
    expect(JSON.stringify(res.json)).not.toContain("seat:");
  });

  it("lets only the client admin fill a seat, and only with people who may sit in it", async () => {
    const put = (who: string, role: string, body: unknown) =>
      H.call(who, "PUT", `/api/getting-started/people/${role}`, body);
    expect((await put(user("a"), "bill-approver", { userIds: [ids[admin("a")]] })).status).toBe(
      403,
    );
    expect((await put(admin("a"), "nobody", { userIds: [ids[admin("a")]] })).status).toBe(404);

    // A viewer never signs (invariant 8).
    const view = await H.call(admin("a"), "PATCH", `/api/users/${ids[user("a")]}`, {
      canSign: false,
    });
    expect(view.status, JSON.stringify(view.json)).toBe(200);
    const viewer = await put(admin("a"), "bill-approver", { userIds: [ids[user("a")]] });
    expect(viewer.status).toBe(422);
    expect(j(viewer.json).error.code).toBe("not_a_signer");
    // A contact can't sit in a seat that answers.
    const contacts = await put(admin("a"), "job-codes", {
      contactIds: ["01a00000-0000-7000-8000-000000000001"],
    });
    expect(contacts.status).toBe(422);
    await H.call(admin("a"), "PATCH", `/api/users/${ids[user("a")]}`, { canSign: true });

    const ok = await put(admin("a"), "bill-approver", {
      userIds: [ids[user("a")]],
      backupUserIds: [ids[admin("a")]],
    });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(j(ok.json).people.seats[0]).toMatchObject({
      filled: true,
      userIds: [ids[user("a")]],
      backupUserIds: [ids[admin("a")]],
    });
    // Both agents that declare the seat hold the same people.
    for (const id of agents) {
      const [row] = await withOperator(H.db, [A()], (tx) =>
        tx.select({ people: agent.people }).from(agent).where(eq(agent.id, id)),
      );
      expect(row?.people["bill-approver"]).toMatchObject({ userIds: [ids[user("a")]] });
    }
    // Another client sees none of it.
    const other = await H.call(admin("b"), "GET", "/api/getting-started/people");
    expect(j(other.json).people.seats).toEqual([]);
  });

  it("shows each agent's line of what is left and the chapters, and Looks right on people", async () => {
    const res = await H.call(admin("a"), "GET", "/api/getting-started");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const view = j(res.json);
    const bills = view.agents.find((a: { name: string }) => a.name === "Bill clerk");
    // The approver is filled; job codes still waits on the client admin.
    expect(bills.left.map((l: { key: string }) => l.key)).toContain("seat:job-codes");
    expect(bills.left.map((l: { key: string }) => l.key)).not.toContain("seat:bill-approver");
    expect(bills.left.find((l: { key: string }) => l.key === "seat:job-codes").who).toMatchObject({
      me: true,
    });
    expect(view.chapters.map((c: { key: string }) => c.key)).toEqual([
      "business",
      "tools",
      "people",
      "see",
      "live",
    ]);
    expect(view.chapters.find((c: { key: string }) => c.key === "people")).toMatchObject({
      state: "open",
      total: 3,
    });
    expect(view.minutesLeft).toBeGreaterThan(0);
    expect(forbiddenKeys(res.json)).toEqual([]);

    const confirmed = await H.call(admin("a"), "POST", "/api/getting-started/people/confirm");
    expect(confirmed.status, JSON.stringify(confirmed.json)).toBe(200);
    expect(j(confirmed.json).people.confirmed).toMatchObject({ byName: expect.any(String) });
  });

  it("tells the lead when who signs changes once a trial has started (owner, §1.206 q1)", async () => {
    await withOperator(H.db, [A()], (tx) =>
      tx
        .update(agent)
        .set({ stage: "trial" })
        .where(eq(agent.id, agents[0] as string)),
    );
    // Adding a backup tells nobody.
    await H.call(admin("a"), "PUT", "/api/getting-started/people/bill-approver", {
      backupUserIds: [ids[admin("a")]],
    });
    await H.settle();
    const before = await withOperator(H.db, [A()], (tx) =>
      tx.select().from(todo).where(eq(todo.clientId, A())),
    );
    expect(before.filter((t) => t.title.includes("changed who signs"))).toEqual([]);
    // Replacing the person who signs does.
    const res = await H.call(admin("a"), "PUT", "/api/getting-started/people/bill-approver", {
      userIds: [ids[admin("a")]],
      backupUserIds: [],
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    await H.settle();
    const after = await withOperator(H.db, [A()], (tx) =>
      tx.select().from(todo).where(eq(todo.clientId, A())),
    );
    expect(after.filter((t) => t.title.includes("changed who signs: Approves bills"))).toHaveLength(
      1,
    );
  });
});
