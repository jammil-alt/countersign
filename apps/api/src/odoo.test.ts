// §1.97: Odoo through the API, against the fake (docs/plan.md §1.97). The client admin enters the
// Odoo address, database, login and API key in the vault (stored under the client's own key, the
// key never shown back, not to the operator either); the connection starts with approval on and
// delete off; the back office lists Odoo with its tools; a purchase order confirmed in a workflow
// waits for the client's approval, is confirmed once however often the run is retried, and nothing
// the run kept holds the key. Odoo is the client's own tool: HIPAA mode doesn't refuse it.

import { createOdooConnector, generateEncryptionKey, ODOO_TOOLS } from "@countersign/connectors";
import { FAKE_ODOO, fakeOdoo } from "@countersign/connectors/testing";
import {
  AgentBundle,
  type AgentBundleInput,
  parseCoveredProcessors,
  routes,
} from "@countersign/core";
import {
  agent,
  auditEvent,
  connection,
  connectionChange,
  externalAction,
  inboxItem,
  stepRun,
  toolCall,
} from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  FakeWorkflowStep,
  OPERATOR,
} from "./api.test-helper";
import { hipaaToolPolicy } from "./compliance/policy";
import { credentialsFor, executeRun } from "./runs/execute";
import { cloudflareStepRunner } from "./runs/step-runner";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const ENCRYPTION_KEY = generateEncryptionKey();
const odoo = fakeOdoo();

const h = await createApiHarness({
  connectors: () => [createOdooConnector({ fetch: odoo.fetch })],
  env: { ENCRYPTION_KEY },
});
afterAll(() => h?.close());

describe("Odoo and HIPAA mode", () => {
  it("is the client's own tool, so HIPAA mode doesn't refuse it for a BAA of ours", async () => {
    const policy = hipaaToolPolicy(
      async () => ({ hipaa: true }),
      parseCoveredProcessors("cloudflare,neon,workos"),
    );
    expect(
      await policy.refuseTool({ tenantId: "t", toolId: ODOO_TOOLS.get, connectorId: "odoo" }),
    ).toBeNull();
  });
});

describe.skipIf(!h)("Odoo through the API", () => {
  const H = h as ApiHarness;
  let connectionId = "";

  it("is in the back office's connectors with its tools and approval on by default", async () => {
    const res = await H.call(OPERATOR, "GET", "/api/ops/connectors");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const c = j(res.json).connectors.find((x: { id: string }) => x.id === "odoo");
    expect(c).toMatchObject({
      name: "Odoo",
      available: true,
      defaultAccess: {
        matrix: { read: "auto", create: "approval", update: "approval", delete: "off" },
      },
    });
    expect(c.tools.map((t: { id: string }) => t.id)).toEqual(
      expect.arrayContaining(Object.values(ODOO_TOOLS)),
    );
  });

  it("the client admin enters the Odoo login and key; the key is stored under the client's key and never shown", async () => {
    const offer = await H.call(OPERATOR, "PUT", `/api/ops/clients/${H.B.tenantId}/connectors`, {
      offered: ["testkit", "odoo"],
    });
    expect(offer.status, JSON.stringify(offer.json)).toBe(200);
    const access = routes.portalAccess.response.parse(
      (await H.call(admin("b"), "GET", routes.portalAccess.path)).json,
    );
    expect(access.setup.find((s) => s.connector === "odoo")?.fields.map((f) => f.name)).toEqual([
      "url",
      "database",
      "login",
      "apiKey",
    ]);
    const res = await H.call(admin("b"), "PUT", "/api/connections/odoo/credentials", {
      values: {
        url: FAKE_ODOO.url,
        database: FAKE_ODOO.database,
        login: FAKE_ODOO.login,
        apiKey: FAKE_ODOO.apiKey,
      },
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const { item } = routes.portalSetCredentials.response.parse(res.json);
    connectionId = item.connectionId;
    expect(item).toMatchObject({ kind: "api_key", status: "connected" });
    expect(item.secret.fields).toEqual([
      expect.objectContaining({ name: "url", value: FAKE_ODOO.url }),
      expect.objectContaining({ name: "database", value: FAKE_ODOO.database }),
      expect.objectContaining({ name: "login", value: FAKE_ODOO.login }),
      expect.objectContaining({ name: "apiKey", set: true, value: null }),
    ]);
    const [row] = await H.t.db.select().from(connection).where(eq(connection.id, connectionId));
    expect(row?.connectedBy).toBe(H.B.admin);
    expect(row?.permissions).toMatchObject({ create: "approval", update: "approval", delete: "off" });
    const seen = JSON.stringify([
      res.json,
      row,
      await H.t.db
        .select()
        .from(connectionChange)
        .where(eq(connectionChange.connectionId, connectionId)),
      (await H.call(OPERATOR, "GET", `/api/ops/clients/${H.B.tenantId}/connections`)).json,
      (await H.call(OPERATOR, "GET", `/api/ops/clients/${H.B.tenantId}`)).json,
      (await H.call(admin("b"), "GET", routes.portalConnections.path)).json,
    ]);
    expect(seen).not.toContain(FAKE_ODOO.apiKey);
  });

  it("confirms a purchase order in a workflow once, after the client approves, and keeps no key anywhere", async () => {
    const bundle = AgentBundle.parse({
      schemaVersion: 1,
      definition: {
        schemaVersion: 2,
        identity: { name: "Buyer", role: "places orders", mission: "purchase orders in Odoo" },
        kind: "functional",
        model: { id: "claude-opus-5-5", maxTokens: 1024 },
        instructions: "Only do what the workflow says.",
        skills: [{ skill: ODOO_TOOLS.get, settings: {} }],
        extraTools: [ODOO_TOOLS.confirmOrder],
        canCommand: [],
        // Even in act mode, a new step's write waits for approval.
        permissions: { mode: "act" },
        budgets: { maxSteps: 4, maxCostUsd: "0.10" },
        memory: { enabled: false },
      },
      workflows: [
        {
          slug: "main",
          name: "Main",
          workflow: {
            schemaVersion: 3,
            trigger: { id: "trg-manual", on: { type: "manual", input: {} } },
            steps: [
              {
                id: "po",
                name: "Read the purchase order",
                kind: "skill",
                skill: ODOO_TOOLS.get,
                input: { model: "purchase.order", id: FAKE_ODOO.purchaseOrder },
                client: { visible: true, label: "Read the purchase order" },
              },
              {
                id: "confirm",
                name: "Confirm it",
                kind: "action",
                tool: ODOO_TOOLS.confirmOrder,
                input: {
                  model: "purchase.order",
                  id: "{{steps.po.output.record.id}}",
                  expectedTotal: "{{steps.po.output.record.fields.amount_total}}",
                  currency: "USD",
                },
                client: { visible: true, label: "Confirmed the purchase order in Odoo" },
              },
            ],
          },
        },
      ],
    } as AgentBundleInput);
    const created = await H.call(OPERATOR, "POST", `/api/ops/clients/${H.B.tenantId}/agents`, {
      slug: "buyer",
      bundle,
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    expect(j(created.json).errors ?? [], JSON.stringify(created.json)).toEqual([]);
    const id = j(created.json).agent.id;
    const op = await H.call(OPERATOR, "PATCH", `/api/ops/agents/${id}/operation`, {
      bindings: { odoo: connectionId },
    });
    expect(op.status, JSON.stringify(op.json)).toBe(200);
    const pub = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${id}/versions/${j(created.json).version.id}/publish`,
    );
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
    await H.t.db.update(agent).set({ runStatus: "active" }).where(eq(agent.id, id));
    const res = await H.call(OPERATOR, "POST", `/api/ops/agents/${id}/run`, { workflow: "main" });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const params = H.instances.started.get(j(res.json).runId);
    if (!params) throw new Error("not started");
    let asked = 0;
    const approver = new FakeWorkflowStep(async (_name, type) => {
      asked += 1;
      const inbox = await H.call(admin("b"), "GET", "/api/inbox");
      const item = j(inbox.json).items.find(
        (i: { id: string }) => `inbox-${i.id.replace(/-/g, "")}` === type,
      );
      if (!item) throw new Error(`no open item for ${type}`);
      const done = await H.call(admin("b"), "POST", `/api/inbox/${item.id}/resolve`, {
        decision: "approve",
      });
      expect(done.status, JSON.stringify(done.json)).toBe(200);
      return H.instances.events.find((e) => e.event.type === type)?.event.payload;
    });
    const deps = {
      db: H.db,
      platform: H.platform,
      transport: new FakeModel(),
      instances: H.instances,
      credentials: credentialsFor(H.db, { current: ENCRYPTION_KEY }),
    };
    expect(await executeRun(deps, params, cloudflareStepRunner(approver))).toEqual({
      status: "succeeded",
    });
    expect(asked).toBe(1);
    expect(odoo.row("purchase.order", FAKE_ODOO.purchaseOrder)?.state).toBe("purchase");
    const [action] = await H.t.db
      .select()
      .from(externalAction)
      .where(eq(externalAction.runId, params.runId));
    expect(action).toMatchObject({
      status: "done",
      tool: ODOO_TOOLS.confirmOrder,
      approvedBy: H.B.admin,
      before: { name: "P00061", state: "draft", total: "310.0000", partner: "Acme Lumber" },
    });
    // The run is retried from the start: the order is not confirmed again.
    await executeRun(deps, params, cloudflareStepRunner(approver));
    expect(odoo.writes()).toEqual([{ model: "purchase.order", method: "button_confirm" }]);
    const kept = JSON.stringify([
      await H.t.db.select().from(externalAction),
      await H.t.db.select().from(toolCall),
      await H.t.db.select().from(stepRun),
      await H.t.db.select().from(inboxItem),
      await H.t.db.select().from(auditEvent),
      (await H.call(admin("b"), "GET", "/api/inbox")).json,
    ]);
    expect(kept).not.toContain(FAKE_ODOO.apiKey);
  });
});
