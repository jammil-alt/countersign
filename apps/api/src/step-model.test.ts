// The step model (docs/step-model-plan.md, wave 1, stream A): a client agent whose bundle holds a
// v5 workflow publishes and runs end to end, with the real agents runtime and the QuickBooks fake.
// A Tell tells the client's team; its End delivers a write to the accounting system (Accounting ›
// Create bill, resolved to QuickBooks from the agent's binding) once, after the client approves
// (invariant 8), and passes on what other agents' hand-off triggers receive.

import { createQboConnector, generateEncryptionKey } from "@countersign/connectors";
import { FAKE_QBO_CLIENT, FAKE_QBO_REALM, fakeQbo } from "@countersign/connectors/testing";
import { agent, externalAction, stepRun } from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  allowForAgent,
  createApiHarness,
  FakeWorkflowStep,
  OPERATOR,
} from "./api.test-helper";
import { credentialsFor, executeRun } from "./runs/execute";
import { cloudflareStepRunner } from "./runs/step-runner";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const ENCRYPTION_KEY = generateEncryptionKey();
const qbo = fakeQbo();

const h = await createApiHarness({
  connectors: () => [
    createQboConnector({
      ...FAKE_QBO_CLIENT,
      environment: "sandbox",
      fetch: qbo.fetch,
      sleep: async () => {},
    }),
  ],
  env: {
    ENCRYPTION_KEY,
    OAUTH_STATE_SECRET: "state-secret-".repeat(4),
    APP_ORIGIN: "https://staging.mezonas.test",
  },
});
afterAll(() => h?.close());

const QBO_VENDOR = "57";

const bundle = {
  schemaVersion: 1,
  definition: {
    schemaVersion: 2,
    identity: { name: "AP clerk", role: "enters bills", mission: "Bills in on time." },
    kind: "functional",
    model: { id: "claude-opus-5-5", maxTokens: 1024 },
    instructions: "Only do what the workflow says.",
    skills: [],
    extraTools: [],
    canCommand: [],
    // Even in act mode, a write waits for approval (invariant 8).
    permissions: { mode: "act" },
    budgets: { maxSteps: 4, maxCostUsd: "0.10" },
    memory: { enabled: false },
  },
  workflows: [
    {
      slug: "main",
      name: "Main",
      workflow: {
        schemaVersion: 5,
        triggers: [{ id: "trg-manual", on: { type: "manual", input: {} } }],
        outputs: [
          {
            id: "o_bill",
            name: "Bill entered",
            kind: "write",
            action: {
              action: "accounting.bill.create",
              input: {
                vendorId: QBO_VENDOR,
                invoiceNumber: "INV-51001",
                date: "2026-11-05",
                dueDate: "2026-12-05",
                currency: "USD",
                total: "640.40",
                lines: [{ description: "Plywood", amount: "640.40", account: "80" }],
              },
            },
          },
          {
            id: "o_pass",
            name: "Passed on",
            kind: "pass_on",
            passOn: { output: { invoice: "INV-51001" } },
          },
        ],
        steps: [
          {
            id: "s_tell",
            kind: "do",
            name: "Tell AP",
            doneBy: "rules",
            uses: { type: "tell" },
            tell: { to: ["client_admin"], message: "Entering INV-51001" },
          },
          { id: "s_end", kind: "end", name: "Entered", outputs: ["o_bill", "o_pass"] },
        ],
      },
    },
  ],
};

describe.skipIf(!h)("a v5 workflow through the API", () => {
  const H = h as ApiHarness;
  let qboA = "";

  const approver = () =>
    new FakeWorkflowStep(async (_name, type) => {
      const res = await H.call(admin("a"), "GET", "/api/inbox");
      const item = j(res.json).items.find(
        (i: { id: string }) => `inbox-${i.id.replace(/-/g, "")}` === type,
      );
      if (!item) throw new Error(`no open item for ${type}`);
      const done = await H.call(admin("a"), "POST", `/api/inbox/${item.id}/resolve`, {
        decision: "approve",
      });
      expect(done.status, JSON.stringify(done.json)).toBe(200);
      return H.instances.events.find((e) => e.event.type === type)?.event.payload;
    });

  beforeAll(async () => {
    await H.call(OPERATOR, "PUT", `/api/ops/clients/${H.A.tenantId}/connectors`, {
      offered: ["testkit", "qbo"],
    });
    const start = await H.call(admin("a"), "POST", "/api/connections/qbo/authorize");
    const state = new URL(j(start.json).redirectUrl).searchParams.get("state") ?? "";
    const done = await H.call(admin("a"), "POST", "/api/connections/qbo/callback", {
      params: { code: "fixture-code", state, realmId: FAKE_QBO_REALM },
    });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    qboA = j(done.json).connection.connection.id;
    await H.settle();
    qbo.put("Vendor", { Id: QBO_VENDOR, SyncToken: "0", DisplayName: "Acme Lumber", Active: true });
  });

  it("publishes, runs, and writes the bill once after the client approves", async () => {
    const created = await H.call(OPERATOR, "POST", `/api/ops/clients/${H.A.tenantId}/agents`, {
      slug: "v5-clerk",
      bundle,
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    const id = j(created.json).agent.id as string;
    const version = j(created.json).version.id as string;
    const op = await H.call(OPERATOR, "PATCH", `/api/ops/agents/${id}/operation`, {
      bindings: { qbo: qboA },
    });
    expect(op.status, JSON.stringify(op.json)).toBe(200);
    await allowForAgent(H, admin("a"), qboA, id);
    const pub = await H.call(OPERATOR, "POST", `/api/ops/agents/${id}/versions/${version}/publish`);
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);

    await H.t.db.update(agent).set({ runStatus: "active" }).where(eq(agent.id, id));
    const res = await H.call(OPERATOR, "POST", `/api/ops/agents/${id}/run`, { workflow: "main" });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const params = H.instances.started.get(j(res.json).runId);
    if (!params) throw new Error("not started");
    const deps = {
      db: H.db,
      platform: H.platform,
      transport: new FakeModel(),
      instances: H.instances,
      credentials: credentialsFor(H.db, { current: ENCRYPTION_KEY }),
    };
    const posts = () => qbo.apiCalls("POST", "bill").length;
    const before = posts();
    const result = await executeRun(deps, params, cloudflareStepRunner(approver()));
    expect(result).toMatchObject({
      status: "succeeded",
      nodeId: "s_end",
      passedOn: { output: { invoice: "INV-51001" }, sources: [] },
    });
    expect(posts()).toBe(before + 1);
    const actions = await H.t.db
      .select()
      .from(externalAction)
      .where(eq(externalAction.runId, params.runId));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      status: "done",
      tool: "qbo.bill.create",
      connectionId: qboA,
      approvedBy: H.A.admin,
    });
    const rows = await H.t.db
      .select({ nodeId: stepRun.nodeId, nodeType: stepRun.nodeType, status: stepRun.status })
      .from(stepRun)
      .where(and(eq(stepRun.runId, params.runId)));
    expect(rows).toEqual(
      expect.arrayContaining([
        { nodeId: "s_tell", nodeType: "notify", status: "succeeded" },
        { nodeId: "s_end:out:o_bill", nodeType: "write", status: "succeeded" },
        { nodeId: "s_end", nodeType: "stop", status: "succeeded" },
      ]),
    );
    // Retried from the start: the action's key makes it once.
    await executeRun(deps, params, cloudflareStepRunner(approver()));
    expect(posts()).toBe(before + 1);
  });
});
