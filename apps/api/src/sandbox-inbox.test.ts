// The Sandbox client's inbox (docs/plan.md §1.5) against a real database as cs_worker: the Sandbox
// has no client people, so on a live run the operator resolves every item there (the client
// admin's approval of a change, a person step) and the run resumes; in a real client the same items
// stay the client's (403 `not_assignee`), and a client that delegated its approvals to the operator
// behaves as before. `resolvableByOperator` says the same on every back-office inbox item, and the
// default "Assigned to you" list shows the Sandbox's items.

import { TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import { externalAction, inboxItem, membership, tenant } from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  FakeWorkflowStep,
  OPERATOR,
  testBundle,
} from "./api.test-helper";
import { executeRun } from "./runs/execute";
import { cloudflareStepRunner } from "./runs/step-runner";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;
const code = (res: { json: unknown }) => j(res.json).error?.code;

type Item = typeof inboxItem.$inferSelect;

const h = await createApiHarness();
afterAll(() => h?.close());

describe.skipIf(!h)("the Sandbox's inbox", () => {
  const H = h as ApiHarness;
  let templateId = "";
  let templateV1 = "";
  let sandboxId = "";
  let sandboxConnection = "";
  const deps = () => ({
    db: H.db,
    platform: H.platform,
    transport: new FakeModel(),
    instances: H.instances,
  });

  /** Resolves each item a run waits on through the API, as whoever `who(item)` names. */
  const resolveWith = (who: (item: Item) => Promise<string>) => {
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

  /**
   * The operator's view of an item: the flag in the "All clients" list and in the run view, and
   * whether the default "Assigned to you" list shows it.
   */
  async function flags(item: Item) {
    const list = j((await H.call(OPERATOR, "GET", "/api/ops/inbox?assigned=all")).json).items;
    const listed = list.find((i: { id: string }) => i.id === item.id);
    const view = j((await H.call(OPERATOR, "GET", `/api/ops/runs/${item.runId}`)).json).inbox;
    const inRun = view.find((i: { id: string }) => i.id === item.id);
    const mine = j((await H.call(OPERATOR, "GET", "/api/ops/inbox")).json).items;
    const assigned = mine.some((i: { id: string }) => i.id === item.id);
    return [listed?.resolvableByOperator, inRun?.resolvableByOperator, assigned];
  }

  /** A live client agent from the template in this client, bound, test-run and activated. */
  async function liveAgent(clientId: string, connectionId: string): Promise<string> {
    const fork = await H.call(OPERATOR, "POST", `/api/ops/templates/${templateId}/fork`, {
      clientId,
      serviceName: "Record keeping",
    });
    expect(fork.status, JSON.stringify(fork.json)).toBe(200);
    const agentId = j(fork.json).agent.id;
    const v1 = j(fork.json).version.id;
    await H.call(OPERATOR, "PATCH", `/api/ops/agents/${agentId}/operation`, {
      bindings: { testkit: connectionId },
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
    // A test run's person steps already go to the operator.
    await executeRun(
      deps(),
      testParams,
      cloudflareStepRunner(new FakeWorkflowStep(resolveWith(async () => OPERATOR))),
    );
    const act = await H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/activate`);
    expect(act.status, JSON.stringify(act.json)).toBe(200);
    return agentId;
  }

  async function liveRun(agentId: string, who: (item: Item) => Promise<string>) {
    const res = await H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/run`, {
      workflow: "fix-record",
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const runId: string = j(res.json).runId;
    const params = H.instances.started.get(runId);
    if (!params) throw new Error("not started");
    const outcome = await executeRun(
      deps(),
      params,
      cloudflareStepRunner(new FakeWorkflowStep(resolveWith(who))),
    );
    return { runId, outcome };
  }

  beforeAll(async () => {
    const tpl = await H.call(OPERATOR, "POST", "/api/ops/templates", {
      slug: "records-clerk",
      bundle: testBundle(),
    });
    templateId = j(tpl.json).agent.id;
    templateV1 = j(tpl.json).version.id;
    await H.call(OPERATOR, "POST", `/api/ops/agents/${templateId}/versions/${templateV1}/publish`);

    // The Sandbox: served by the operator, no client people, its testkit connected from the back
    // office.
    const [sandbox] = await H.t.db
      .insert(tenant)
      .values({ name: "Sandbox", settings: {
          sandbox: true,
          connectors_offered: ["testkit"],
          // v0.12 W1-D: the undo window is off here, so an approval reaches its run at once.
          approvals: { undoSeconds: 0 },
        }, })
      .returning();
    if (!sandbox) throw new Error("no sandbox");
    sandboxId = sandbox.id;
    await H.t.db
      .insert(membership)
      .values({ tenantId: sandbox.id, userId: H.operator, role: "operator" });
    const conn = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/clients/${sandbox.id}/connections/testkit/connect`,
    );
    expect(conn.status, JSON.stringify(conn.json)).toBe(200);
    sandboxConnection = j(conn.json).connection.id;
    H.backend.seed(sandboxConnection, [{ id: "r1", name: "Pine board", amount: "10.00" }]);

    await H.call(admin("a"), "POST", "/api/connections/testkit/authorize");
    await H.call(admin("b"), "POST", "/api/connections/testkit/authorize");
  });

  it("lets the operator resolve the client admin's approval and person step, and the run resumes", async () => {
    const agentId = await liveAgent(sandboxId, sandboxConnection);
    const seen: { kind: string; assigneeRole: string | null; flags: unknown[] }[] = [];
    const { runId, outcome } = await liveRun(agentId, async (item) => {
      seen.push({ kind: item.kind, assigneeRole: item.assigneeRole, flags: await flags(item) });
      return OPERATOR;
    });
    expect(outcome).toEqual({ status: "succeeded" });
    // Both items were the client admin's, and the operator's to resolve in the Sandbox.
    expect(seen).toEqual([
      { kind: "external_action", assigneeRole: "client_admin", flags: [true, true, true] },
      { kind: "approval", assigneeRole: "client_admin", flags: [true, true, true] },
    ]);
    // Recorded as the operator; the change was made once.
    const items = await H.t.db.select().from(inboxItem).where(eq(inboxItem.runId, runId));
    expect(items.map((i) => [i.kind, i.status, i.resolvedBy])).toEqual([
      ["external_action", "resolved", H.operator],
      ["approval", "resolved", H.operator],
    ]);
    const [action] = await H.t.db
      .select()
      .from(externalAction)
      .where(eq(externalAction.runId, runId));
    expect(action).toMatchObject({
      tool: TESTKIT_UPDATE_TOOL,
      status: "done",
      approvedBy: H.operator,
    });
    expect(H.backend.get(sandboxConnection, "r1")?.amount).toBe("12.00");
    // The resolve answer carries the flag too.
    const [first] = items;
    const again = await H.call(OPERATOR, "POST", `/api/ops/inbox/${first?.id}/resolve`, {
      decision: "approve",
    });
    expect(again.status, JSON.stringify(again.json)).toBe(200);
    expect(j(again.json).item).toMatchObject({ status: "resolved", resolvableByOperator: true });
  });

  it("keeps a real client's approval and person step with the client: 403 not_assignee", async () => {
    const agentId = await liveAgent(H.A.tenantId, H.A.connectionId);
    const seen: { kind: string; flags: unknown[] }[] = [];
    const { outcome } = await liveRun(agentId, async (item) => {
      expect(item.assigneeRole).toBe("client_admin");
      seen.push({ kind: item.kind, flags: await flags(item) });
      const res = await H.call(OPERATOR, "POST", `/api/ops/inbox/${item.id}/resolve`, {
        decision: "approve",
      });
      expect([res.status, code(res)]).toEqual([403, "not_assignee"]);
      return admin("a");
    });
    expect(outcome).toEqual({ status: "succeeded" });
    expect(seen).toEqual([
      { kind: "external_action", flags: [false, false, false] },
      { kind: "approval", flags: [false, false, false] },
    ]);
    expect(H.backend.get(H.A.connectionId, "r1")?.amount).toBe("12.00");
  });

  it("leaves a real client that delegated approvals to the operator as before", async () => {
    await H.t.db
      .update(tenant)
      .set({
        settings: {
          connectors_offered: ["testkit"],
          approvals: { external_actions: "operator", undoSeconds: 0 },
        },
      })
      .where(eq(tenant.id, H.B.tenantId));
    const agentId = await liveAgent(H.B.tenantId, H.B.connectionId);
    const seen: { kind: string; assigneeRole: string | null; flags: unknown[] }[] = [];
    const { outcome } = await liveRun(agentId, async (item) => {
      seen.push({ kind: item.kind, assigneeRole: item.assigneeRole, flags: await flags(item) });
      if (item.kind === "external_action") return OPERATOR;
      // The person step is still the client admin's.
      const res = await H.call(OPERATOR, "POST", `/api/ops/inbox/${item.id}/resolve`, {
        decision: "approve",
      });
      expect([res.status, code(res)]).toEqual([403, "not_assignee"]);
      return admin("b");
    });
    expect(outcome).toEqual({ status: "succeeded" });
    expect(seen).toEqual([
      { kind: "external_action", assigneeRole: "operator", flags: [true, true, true] },
      { kind: "approval", assigneeRole: "client_admin", flags: [false, false, false] },
    ]);
    expect(H.backend.get(H.B.connectionId, "r1")?.amount).toBe("12.00");
  });
});
