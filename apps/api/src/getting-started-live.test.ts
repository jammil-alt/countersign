// Getting started's Go live through the API (docs/setup-plan.md §7; docs/plan.md §1.206, SU6): the
// scope in the client's words (what it does, reads and may change, who signs and answers, their
// open requests), nothing of ours (invariant 11); only the client admin signs, once per version,
// and a new version is signed again; signing starts nothing; the overview's "Sign the scope"
// line; another client sees none of it (invariant 1).
import { TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import { agent, connection, withOperator, withTenant } from "@countersign/db";
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
import { createIssue } from "./work/issues";

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const h = await createApiHarness();
afterAll(() => h?.close());

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const SEATS = [
  { role: "bill-approver", kind: "signs", label: "Approves bills", required: true },
  { role: "job-codes", kind: "answers", label: "Answers questions about job codes" },
];

function bundle(name: string): unknown {
  return {
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: { name, role: "Bills", mission: "Enter bills." },
      kind: "functional",
      model: { id: "test-model", maxTokens: 1024 },
      instructions: "Be brief and secret-instructions-here.",
      skills: [],
      extraTools: [TESTKIT_UPDATE_TOOL],
      permissions: { mode: "suggest_only" },
    },
    people: SEATS,
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
              id: "ask",
              name: "Which job?",
              kind: "do",
              doneBy: "person",
              person: {
                mode: "ask",
                who: "seat:job-codes",
                question: "Which job?",
                show: {},
                deadline: { after: "1 day", hours: "clock", ifNoAnswer: "stop" },
                channel: "inbox",
                onReject: "stop",
              },
            },
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

describe.skipIf(!h)("Go live", () => {
  const H = h as ApiHarness;
  const A = () => H.A.tenantId;
  const ids: Record<string, string> = {};
  let id = "";

  it("reads the scope in the client's words, with its seats and nothing of ours", async () => {
    await withOperator(H.db, [A()], (tx) =>
      tx.update(connection).set({ status: "connected" }).where(eq(connection.id, H.A.connectionId)),
    );
    const created = await H.call(OPERATOR, "POST", `/api/ops/clients/${A()}/agents`, {
      slug: "bills",
      bundle: bundle("Bill clerk"),
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    id = j(created.json).agent.id;
    await H.call(OPERATOR, "PATCH", `/api/ops/agents/${id}/operation`, {
      bindings: { testkit: H.A.connectionId },
    });
    const pub = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${id}/versions/${j(created.json).version.id}/publish`,
    );
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
    for (const u of j((await H.call(admin("a"), "GET", "/api/users")).json).users) {
      ids[u.email] = u.userId;
    }
    const seat = await H.call(admin("a"), "PUT", "/api/getting-started/people/bill-approver", {
      userIds: [ids[user("a")]],
      backupUserIds: [ids[admin("a")]],
    });
    expect(seat.status, JSON.stringify(seat.json)).toBe(200);

    const res = await H.call(admin("a"), "GET", `/api/getting-started/agents/${id}/scope`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const scope = j(res.json).scope;
    expect(scope).toMatchObject({
      agentId: id,
      name: "Bill clerk",
      version: 1,
      signed: null,
      canSign: true,
      trialDays: 14,
      choices: [],
      open: [],
    });
    expect(scope.does).toEqual(expect.any(String));
    expect(scope.signs).toEqual(["Approves bills: Client A user, with Client A admin as backup"]);
    expect(scope.answers).toEqual([
      "Answers questions about job codes: nobody yet, so your admin is asked",
    ]);
    // What it may change, from the SOP: the write waits for a signature (invariant 8).
    expect(scope.changes).toEqual([
      "Change records in your Testkit. Each change waits for a signature.",
    ]);
    // Nothing of ours (invariant 11): no bundle, instructions, seat role names.
    expect(forbiddenKeys(res.json)).toEqual([]);
    const text = JSON.stringify(res.json);
    for (const ours of [
      "seat:",
      "bill-approver",
      "job-codes",
      "secret-instructions",
      "test-model",
    ]) {
      expect(text).not.toContain(ours);
    }
  });

  it("puts Sign the scope on the overview for the client admin", async () => {
    const res = await H.call(admin("a"), "GET", "/api/getting-started");
    const bills = j(res.json).agents.find((a: { agentId: string }) => a.agentId === id);
    const line = bills.left.find((l: { key: string }) => l.key === "scope");
    expect(line).toMatchObject({ chapter: "live", label: "Sign the scope", who: { me: true } });
    expect(j(res.json).chapters.find((c: { key: string }) => c.key === "live")).toMatchObject({
      state: "not_started",
      done: 0,
      total: 1,
    });
  });

  it("lets only the client admin sign, once per version, and starts nothing", async () => {
    const asUser = await H.call(user("a"), "GET", `/api/getting-started/agents/${id}/scope`);
    expect(asUser.status).toBe(200);
    expect(j(asUser.json).scope.canSign).toBe(false);
    expect(
      (await H.call(user("a"), "POST", `/api/getting-started/agents/${id}/scope/sign`)).status,
    ).toBe(403);

    const signed = await H.call(admin("a"), "POST", `/api/getting-started/agents/${id}/scope/sign`);
    expect(signed.status, JSON.stringify(signed.json)).toBe(200);
    expect(j(signed.json).scope).toMatchObject({
      canSign: false,
      signed: { version: 1, byName: "Client A admin" },
    });
    const again = await H.call(admin("a"), "POST", `/api/getting-started/agents/${id}/scope/sign`);
    expect(again.status).toBe(409);
    expect(j(again.json).error.code).toBe("already_signed");

    // The trial is the operator's to start (§7): the stage is as it was.
    const [row] = await withOperator(H.db, [A()], (tx) =>
      tx.select().from(agent).where(eq(agent.id, id)),
    );
    expect(row?.stage === null || row?.stage === "bench").toBe(true);
    expect((row?.stageState as { trial?: unknown } | undefined)?.trial).toBeUndefined();

    const overview = j((await H.call(admin("a"), "GET", "/api/getting-started")).json);
    const bills = overview.agents.find((a: { agentId: string }) => a.agentId === id);
    expect(bills.left.map((l: { key: string }) => l.key)).not.toContain("scope");
    expect(overview.chapters.find((c: { key: string }) => c.key === "live").state).toBe("done");
  });

  it("asks for a new signature on a new version, and lists the client's open requests", async () => {
    const v2 = await H.call(OPERATOR, "POST", `/api/ops/agents/${id}/versions`, {
      bundle: bundle("Bill clerk v2"),
      changeNote: "Renamed",
    });
    expect(v2.status, JSON.stringify(v2.json)).toBe(200);
    const pub = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${id}/versions/${j(v2.json).version.id}/publish`,
    );
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
    // As the walkthrough's "We do it differently" files it: an issue the client raised.
    await withTenant(H.db, A(), (tx) =>
      createIssue(tx, {
        tenantId: A(),
        title: "Freight should go to overhead, not the job.",
        agentId: id,
        source: "portal",
        raisedBy: ids[admin("a")] as string,
        actor: "client",
        userId: ids[admin("a")] as string,
      }),
    );

    const res = j(
      (await H.call(admin("a"), "GET", `/api/getting-started/agents/${id}/scope`)).json,
    );
    expect(res.scope).toMatchObject({ version: 2, canSign: true, signed: { version: 1 } });
    expect(res.scope.open).toHaveLength(1);
    expect(res.scope.open[0]).toContain("Freight should go to overhead");
    // A client user reads only the requests they raised.
    const mine = j(
      (await H.call(user("a"), "GET", `/api/getting-started/agents/${id}/scope`)).json,
    );
    expect(mine.scope.open).toEqual([]);

    const signed = await H.call(admin("a"), "POST", `/api/getting-started/agents/${id}/scope/sign`);
    expect(signed.status, JSON.stringify(signed.json)).toBe(200);
    expect(j(signed.json).scope.signed).toMatchObject({ version: 2 });
  });

  it("keeps one client's scope from another (invariant 1)", async () => {
    const other = await H.call(admin("b"), "GET", `/api/getting-started/agents/${id}/scope`);
    expect(other.status).toBe(404);
    const sign = await H.call(admin("b"), "POST", `/api/getting-started/agents/${id}/scope/sign`);
    expect(sign.status).toBe(404);
  });
});
