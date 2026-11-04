// Approver rules (docs/plan.md §1.20) against a real database as cs_worker: the operator sets a
// served client's ordered rules with a reason; the client admin only tightens them (every way of
// loosening is refused on the server); another client's rules are out of reach; and a change
// routed by an amount rule lands with the named person, who alone can approve it.

import { TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import { inboxItem, run, tenantChange } from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  FakeWorkflowStep,
  OPERATOR,
  OTHER_OPERATOR,
  testBundle,
  user,
} from "./api.test-helper";
import { executeRun } from "./runs/execute";
import { cloudflareStepRunner } from "./runs/step-runner";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const h = await createApiHarness();
afterAll(() => h?.close());

const OPS_PATH = (id: string) => `/api/ops/clients/${id}/approver-rules`;
const PORTAL_PATH = "/api/approver-rules";
const code = (res: { json: unknown }) => j(res.json).error?.code;

describe.skipIf(!h)("approver rules: who sets them", () => {
  const H = h as ApiHarness;
  const path = () => OPS_PATH(H.B.tenantId);

  it("lets the operator set a served client's rules, with a reason, logged", async () => {
    const empty = await H.call(OPERATOR, "GET", path());
    expect(empty.status, JSON.stringify(empty.json)).toBe(200);
    expect(j(empty.json)).toMatchObject({
      revision: 0,
      rules: [],
      changes: [],
      clientDefault: null,
    });
    expect(j(empty.json).people.map((p: { email: string }) => p.email)).toEqual([
      "admin@b.example.com",
      "user@b.example.com",
    ]);
    const testkit = j(empty.json).connectors.find((c: { id: string }) => c.id === "testkit");
    expect(testkit.tools).toEqual([
      expect.objectContaining({ id: TESTKIT_UPDATE_TOOL, verb: "update", amount: true }),
    ]);

    const rules = [
      {
        match: { tool: TESTKIT_UPDATE_TOOL, amountOver: { value: "1000", currency: "USD" } },
        approver: { kind: "operator" },
      },
      { match: { verb: "update" }, approver: { kind: "role", role: "client_user" } },
    ];
    expect((await H.call(OPERATOR, "PUT", path(), { revision: 0, rules })).status).toBe(400);
    expect(
      (await H.call(OPERATOR, "PUT", path(), { revision: 0, rules, reason: "  " })).status,
    ).toBe(400);
    const saved = await H.call(OPERATOR, "PUT", path(), {
      revision: 0,
      rules,
      reason: "Big changes come to us first",
    });
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    expect(j(saved.json).revision).toBe(1);
    expect(j(saved.json).rules).toMatchObject([
      { setBy: "operator", approver: { kind: "operator" } },
      { setBy: "operator", approver: { kind: "role", role: "client_user" } },
    ]);
    expect(j(saved.json).changes).toMatchObject([
      { side: "operator", by: "Operator", reason: "Big changes come to us first", revision: 1 },
    ]);
    const [logged] = await H.t.db
      .select()
      .from(tenantChange)
      .where(eq(tenantChange.tenantId, H.B.tenantId));
    expect(logged?.actorId).toBe(H.operator);
    expect(logged?.change).toMatchObject({
      setting: "approver_rules",
      side: "operator",
      from: { revision: 0, rules: [] },
      to: { revision: 1 },
    });

    // An editor that started before this save is refused; saving the same again is a no-op.
    const stale = await H.call(OPERATOR, "PUT", path(), { revision: 0, rules, reason: "x" });
    expect([stale.status, code(stale)]).toEqual([409, "stale"]);
    const same = await H.call(OPERATOR, "PUT", path(), {
      revision: 1,
      rules: j(saved.json).rules,
      reason: "x",
    });
    expect([same.status, code(same)]).toEqual([409, "no_op"]);
  });

  it("refuses rules that name what isn't the client's or can never match", async () => {
    const bad = async (rule: unknown) => {
      const res = await H.call(OPERATOR, "PUT", path(), {
        revision: 1,
        rules: [rule],
        reason: "x",
      });
      return [res.status, code(res)];
    };
    const invalid = [422, "invalid_rule"];
    // Client A's admin is not one of client B's people.
    expect(await bad({ match: {}, approver: { kind: "user", userId: H.A.admin } })).toEqual(
      invalid,
    );
    expect(
      await bad({
        match: { agentId: "00000000-0000-4000-8000-000000000999" },
        approver: { kind: "client_admin" },
      }),
    ).toEqual(invalid);
    expect(
      await bad({ match: { tool: "nope.thing.do" }, approver: { kind: "client_admin" } }),
    ).toEqual(invalid);
    expect(
      await bad({
        match: { connector: "upload", tool: TESTKIT_UPDATE_TOOL },
        approver: { kind: "client_admin" },
      }),
    ).toEqual(invalid);
    expect(
      await bad({
        match: { tool: TESTKIT_UPDATE_TOOL, verb: "create" },
        approver: { kind: "client_admin" },
      }),
    ).toEqual(invalid);
    // A malformed amount is refused before anything else.
    expect(
      await bad({
        match: { amountOver: { value: "12.5.0", currency: "USD" } },
        approver: { kind: "client_admin" },
      }),
    ).toEqual([400, "invalid_request"]);
  });

  it("is the operator's for the clients they serve only, and clients can't use it", async () => {
    expect((await H.call(OTHER_OPERATOR, "GET", path())).status).toBe(404);
    expect(
      (await H.call(OTHER_OPERATOR, "PUT", path(), { revision: 1, rules: [], reason: "x" })).status,
    ).toBe(404);
    expect((await H.call(admin("b"), "GET", path())).status).toBe(403);
    expect(
      (await H.call(admin("b"), "PUT", path(), { revision: 1, rules: [], reason: "x" })).status,
    ).toBe(403);
    // The portal answers only the session's own client's rules.
    const a = await H.call(admin("a"), "GET", PORTAL_PATH);
    expect(j(a.json)).toMatchObject({ revision: 0, rules: [] });
    const b = await H.call(user("b"), "GET", PORTAL_PATH);
    expect(j(b.json)).toMatchObject({ revision: 1, canTighten: false });
    expect(j(b.json).rules).toHaveLength(2);
    // The portal calls the operator's side "we", unnamed, and shows no agent internals.
    expect(j(b.json).changes).toMatchObject([{ side: "operator", by: null }]);
    expect(j(b.json)).not.toHaveProperty("clientDefault");
    expect(
      (await H.call(user("b"), "PUT", PORTAL_PATH, { revision: 1, rules: [], reason: "x" })).status,
    ).toBe(403);
    expect(
      (await H.call(OPERATOR, "PUT", PORTAL_PATH, { revision: 1, rules: [], reason: "x" })).status,
    ).toBe(403);
  });

  it("lets the client admin only tighten, and refuses every way of loosening", async () => {
    const view = j((await H.call(admin("b"), "GET", PORTAL_PATH)).json);
    const [big, updates] = view.rules;
    const put = (rules: unknown[], reason = "Tightening") =>
      H.call(admin("b"), "PUT", PORTAL_PATH, { revision: view.revision, rules, reason });
    const refused = async (rules: unknown[]) => {
      const res = await put(rules);
      return [res.status, code(res)];
    };
    const loosening = [403, "loosening"];
    expect(await refused([updates])).toEqual(loosening); // removing an operator rule
    expect(await refused([updates, big])).toEqual(loosening); // reordering
    expect(
      await refused([
        { ...big, match: { ...big.match, amountOver: { value: "5000", currency: "USD" } } },
        updates,
      ]),
    ).toEqual(loosening); // changing what it matches
    expect(await refused([big, { ...updates, approver: { kind: "operator" } }])).toEqual(loosening);
    expect(
      await refused([{ match: {}, approver: { kind: "role", role: "client_user" } }, big, updates]),
    ).toEqual(loosening);
    expect(await refused([{ match: {}, approver: { kind: "operator" } }, big, updates])).toEqual(
      loosening,
    );
    const res = await put([big, updates]);
    expect(res.status).toBe(409); // nothing changed

    // Take the big changes back from the operator to a named person, narrow updates to the admin,
    // and add a rule of their own on top.
    const ok = await put(
      [
        { match: { verb: "create" }, approver: { kind: "client_admin" }, setBy: "operator" },
        { ...big, approver: { kind: "user", userId: H.B.user } },
        { ...updates, approver: { kind: "client_admin" } },
      ],
      "We approve our own changes",
    );
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(j(ok.json).revision).toBe(2);
    expect(j(ok.json).rules).toMatchObject([
      { setBy: "client", approver: { kind: "client_admin" } },
      { id: big.id, setBy: "operator", approver: { kind: "user", userId: H.B.user } },
      { id: updates.id, setBy: "operator", approver: { kind: "client_admin" } },
    ]);
    expect(j(ok.json).changes[0]).toMatchObject({
      side: "client",
      by: "Client B admin",
      reason: "We approve our own changes",
    });
    // Once narrowed to a person, it can't go back to "anyone in the client".
    const back = await H.call(admin("b"), "PUT", PORTAL_PATH, {
      revision: 2,
      rules: [
        j(ok.json).rules[0],
        { ...j(ok.json).rules[1], approver: { kind: "role", role: "client_user" } },
        j(ok.json).rules[2],
      ],
      reason: "x",
    });
    expect([back.status, code(back)]).toEqual([403, "loosening"]);
    // The operator may still loosen.
    const ops = await H.call(OPERATOR, "PUT", path(), { revision: 2, rules: [], reason: "Reset" });
    expect(ops.status).toBe(200);
  });
});

describe.skipIf(!h)("approver rules: where they apply", () => {
  const H = h as ApiHarness;
  let agentId = "";
  const deps = () => ({
    db: H.db,
    platform: H.platform,
    transport: new FakeModel(),
    instances: H.instances,
  });

  /** Resolves each item the run waits on as whoever `who(kind)` names. */
  const resolveWith = (who: (item: typeof inboxItem.$inferSelect) => Promise<string>) => {
    return async (_name: string, type: string) => {
      const items = await H.t.db.select().from(inboxItem).where(eq(inboxItem.status, "open"));
      const item = items.find((i) => `inbox-${i.id.replace(/-/g, "")}` === type);
      if (!item) throw new Error(`no open item for ${type}`);
      const email = await who(item);
      const res = await H.call(
        email,
        "POST",
        email === OPERATOR ? `/api/ops/inbox/${item.id}/resolve` : `/api/inbox/${item.id}/resolve`,
        { decision: "approve" },
      );
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      const sent = H.instances.events.find((e) => e.event.type === type);
      if (!sent) throw new Error(`no event ${type} was sent`);
      return sent.event.payload;
    };
  };

  beforeAll(async () => {
    await H.call(admin("a"), "POST", "/api/connections/testkit/authorize");
    const tpl = await H.call(OPERATOR, "POST", "/api/ops/templates", {
      slug: "records-clerk",
      bundle: testBundle(),
    });
    const tid = j(tpl.json).agent.id;
    await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${tid}/versions/${j(tpl.json).version.id}/publish`,
    );
    const fork = await H.call(OPERATOR, "POST", `/api/ops/templates/${tid}/fork`, {
      clientId: H.A.tenantId,
      serviceName: "Record keeping",
    });
    agentId = j(fork.json).agent.id;
    const v1 = j(fork.json).version.id;
    // The agent sends its approvals to the operator; the client's rules come first.
    await H.call(OPERATOR, "PATCH", `/api/ops/agents/${agentId}/operation`, {
      bindings: { testkit: H.A.connectionId },
      approver: "operator",
    });
    await H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/versions/${v1}/publish`);
    const test = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${agentId}/versions/${v1}/test-run`,
      { workflow: "fix-record" },
    );
    const testParams = H.instances.started.get(j(test.json).runId);
    if (!testParams) throw new Error("the test run was not started");
    await executeRun(
      deps(),
      testParams,
      cloudflareStepRunner(new FakeWorkflowStep(resolveWith(async () => OPERATOR))),
    );
    const act = await H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/activate`);
    expect(act.status, JSON.stringify(act.json)).toBe(200);
  });

  it("routes a change over the amount to the named person, who alone can approve it", async () => {
    const rules = await H.call(OPERATOR, "PUT", OPS_PATH(H.A.tenantId), {
      revision: 0,
      rules: [
        // The bundle changes the record to 12.00 USD.
        {
          match: { connector: "testkit", amountOver: { value: "11.99", currency: "USD" } },
          approver: { kind: "user", userId: H.A.user },
        },
        {
          match: { amountOver: { value: "11.99", currency: "EUR" } },
          approver: { kind: "operator" },
        },
      ],
      reason: "Record changes over 11.99 go to the user",
    });
    expect(rules.status, JSON.stringify(rules.json)).toBe(200);
    const ruleId = j(rules.json).rules[0].id;
    const view = j((await H.call(OPERATOR, "GET", OPS_PATH(H.A.tenantId))).json);
    expect(view.agents).toEqual([{ id: agentId, name: "Record keeping", approver: "operator" }]);

    const started = await H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/run`, {
      workflow: "fix-record",
    });
    const runId = j(started.json).runId;
    const params = H.instances.started.get(runId);
    if (!params) throw new Error("not started");
    const seen: string[] = [];
    const step = new FakeWorkflowStep(
      resolveWith(async (item) => {
        seen.push(item.kind);
        if (item.kind !== "external_action") return admin("a");
        expect(item).toMatchObject({ assigneeRole: null, assigneeUserId: H.A.user });
        expect(item.payload).toMatchObject({
          tool: TESTKIT_UPDATE_TOOL,
          approverRoute: { source: "rule", ruleId, revision: 1 },
        });
        // Only that person: not the client admin, not the operator.
        for (const [who, p] of [
          [admin("a"), `/api/inbox/${item.id}/resolve`],
          [OPERATOR, `/api/ops/inbox/${item.id}/resolve`],
        ] as const) {
          const res = await H.call(who, "POST", p, { decision: "approve" });
          expect([res.status, code(res)], who).toEqual([403, "not_assignee"]);
        }
        // The client admin sees it waiting on that person, and can only watch.
        const adminInbox = j((await H.call(admin("a"), "GET", "/api/inbox")).json).items;
        expect(adminInbox.map((i: { id: string }) => i.id)).toContain(item.id);
        return user("a");
      }),
    );
    expect(await executeRun(deps(), params, cloudflareStepRunner(step))).toEqual({
      status: "succeeded",
    });
    expect(seen).toEqual(["external_action", "approval"]);
    const [r] = await H.t.db.select().from(run).where(eq(run.id, runId));
    expect(r?.config).toMatchObject({ approverRules: { revision: 1 } });
    expect(H.backend.get(H.A.connectionId, "r1")?.amount).toBe("12.00");
  });

  it("without a matching rule, falls back to the agent's approver", async () => {
    await H.call(OPERATOR, "PUT", OPS_PATH(H.A.tenantId), {
      revision: 1,
      rules: [
        {
          match: { amountOver: { value: "12.00", currency: "USD" } },
          approver: { kind: "user", userId: H.A.user },
        },
      ],
      reason: "Only over 12.00 now",
    });
    const started = await H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/run`, {
      workflow: "fix-record",
    });
    const params = H.instances.started.get(j(started.json).runId);
    if (!params) throw new Error("not started");
    const step = new FakeWorkflowStep(
      resolveWith(async (item) => {
        if (item.kind !== "external_action") return admin("a");
        expect(item).toMatchObject({ assigneeRole: "operator", assigneeUserId: null });
        expect(item.payload).toMatchObject({ approverRoute: { source: "agent", ruleId: null } });
        return OPERATOR;
      }),
    );
    expect(await executeRun(deps(), params, cloudflareStepRunner(step))).toEqual({
      status: "succeeded",
    });
  });
});
