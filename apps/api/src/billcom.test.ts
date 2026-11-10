// §1.87: BILL through the API, against the fake (docs/plan.md §1.87). The client admin enters a
// BILL user's login in the vault (stored under the client's own key, never shown back, not to the
// operator either); the connection starts with approval on and payments off; the back office lists
// BILL with its tools and default access; a bill made in a workflow waits for the client's approval,
// is made once however often the run is retried, and nothing the run kept holds the password; and a
// client in HIPAA mode is refused BILL's tools without a BAA.

import {
  BILLCOM_TOOLS,
  createBillcomConnector,
  generateEncryptionKey,
} from "@countersign/connectors";
import { FAKE_BILLCOM, fakeBillcom } from "@countersign/connectors/testing";
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
const bill = fakeBillcom();

const h = await createApiHarness({
  connectors: () => [createBillcomConnector({ devKey: FAKE_BILLCOM.devKey, fetch: bill.fetch })],
  env: { ENCRYPTION_KEY },
});
afterAll(() => h?.close());

describe("BILL and HIPAA mode", () => {
  it("refuses BILL's tools to a client in HIPAA mode until BILL has a BAA", async () => {
    const hipaa = async () => ({ hipaa: true });
    const without = hipaaToolPolicy(hipaa, parseCoveredProcessors("cloudflare,neon,workos"));
    expect(
      await without.refuseTool({
        tenantId: "t",
        toolId: BILLCOM_TOOLS.billGet,
        connectorId: "billcom",
      }),
    ).toBe(
      "billcom.bill.get sends data to BILL, which has no signed BAA; this client is in HIPAA mode",
    );
    const covered = hipaaToolPolicy(
      hipaa,
      parseCoveredProcessors("cloudflare,neon,workos,billcom"),
    );
    expect(
      await covered.refuseTool({
        tenantId: "t",
        toolId: BILLCOM_TOOLS.billGet,
        connectorId: "billcom",
      }),
    ).toBeNull();
  });
});

describe.skipIf(!h)("BILL through the API", () => {
  const H = h as ApiHarness;
  let connectionId = "";

  it("is in the back office's connectors with its tools, and payments off by default", async () => {
    const res = await H.call(OPERATOR, "GET", "/api/ops/connectors");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const billcom = j(res.json).connectors.find((c: { id: string }) => c.id === "billcom");
    expect(billcom).toMatchObject({
      name: "BILL",
      available: true,
      permissionEntities: [{ id: "vendor" }, { id: "bill" }, { id: "payment" }, { id: "document" }],
      defaultAccess: {
        matrix: {
          read: "auto",
          create: "approval",
          update: "approval",
          delete: "off",
          entities: { payment: { create: "off" } },
        },
      },
    });
    expect(billcom.tools.map((t: { id: string }) => t.id)).toEqual(
      expect.arrayContaining(Object.values(BILLCOM_TOOLS)),
    );
  });

  it("the client admin enters the BILL user's login; it is stored under the client's key and never shown", async () => {
    const offer = await H.call(OPERATOR, "PUT", `/api/ops/clients/${H.B.tenantId}/connectors`, {
      offered: ["testkit", "billcom"],
    });
    expect(offer.status, JSON.stringify(offer.json)).toBe(200);
    const access = routes.portalAccess.response.parse(
      (await H.call(admin("b"), "GET", routes.portalAccess.path)).json,
    );
    expect(access.setup.find((s) => s.connector === "billcom")?.fields.map((f) => f.name)).toEqual([
      "username",
      "password",
      "organizationId",
    ]);
    const res = await H.call(admin("b"), "PUT", "/api/connections/billcom/credentials", {
      values: {
        username: FAKE_BILLCOM.username,
        password: FAKE_BILLCOM.password,
        organizationId: FAKE_BILLCOM.organizationId,
      },
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const { item } = routes.portalSetCredentials.response.parse(res.json);
    connectionId = item.connectionId;
    expect(item).toMatchObject({ kind: "api_key", status: "connected" });
    expect(item.secret.fields).toEqual([
      expect.objectContaining({ name: "username", value: FAKE_BILLCOM.username }),
      expect.objectContaining({ name: "password", set: true, value: null }),
      expect.objectContaining({ name: "organizationId", value: FAKE_BILLCOM.organizationId }),
    ]);
    const [row] = await H.t.db.select().from(connection).where(eq(connection.id, connectionId));
    expect(row?.connectedBy).toBe(H.B.admin);
    expect(row?.permissions).toMatchObject({
      create: "approval",
      update: "approval",
      delete: "off",
      entities: { payment: { create: "off" } },
    });
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
    expect(seen).not.toContain(FAKE_BILLCOM.password);
  });

  it("makes a bill in a workflow once, after the client approves, and keeps no password anywhere", async () => {
    const bundle = AgentBundle.parse({
      schemaVersion: 1,
      definition: {
        schemaVersion: 2,
        identity: { name: "AP clerk", role: "enters bills", mission: "bills into BILL" },
        kind: "functional",
        model: { id: "claude-opus-5-5", maxTokens: 1024 },
        instructions: "Only do what the workflow says.",
        skills: [{ skill: BILLCOM_TOOLS.vendorGet, settings: {} }],
        extraTools: [BILLCOM_TOOLS.billCreate],
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
                id: "vendor",
                name: "Read the vendor",
                kind: "skill",
                skill: BILLCOM_TOOLS.vendorGet,
                input: { id: FAKE_BILLCOM.vendors.acme },
                client: { visible: true, label: "Read the vendor" },
              },
              {
                id: "bill",
                name: "Enter the bill",
                kind: "action",
                tool: BILLCOM_TOOLS.billCreate,
                input: {
                  vendorId: "{{steps.vendor.output.vendor.id}}",
                  invoiceNumber: "INV-30001",
                  invoiceDate: "2026-11-05",
                  dueDate: "2026-12-05",
                  currency: "USD",
                  expectedTotal: "640.40",
                  lines: [{ amount: "640.40", description: "Plywood" }],
                },
                client: { visible: true, label: "Entered the bill in BILL" },
              },
            ],
          },
        },
      ],
    } as AgentBundleInput);
    const created = await H.call(OPERATOR, "POST", `/api/ops/clients/${H.B.tenantId}/agents`, {
      slug: "bill-clerk",
      bundle,
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    expect(j(created.json).errors ?? [], JSON.stringify(created.json)).toEqual([]);
    const id = j(created.json).agent.id;
    const op = await H.call(OPERATOR, "PATCH", `/api/ops/agents/${id}/operation`, {
      bindings: { billcom: connectionId },
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
    const made = () =>
      bill.bills.filter(
        (b) => (b.invoice as { invoiceNumber?: string }).invoiceNumber === "INV-30001",
      );
    expect(made()).toHaveLength(1);
    expect(made()[0]).toMatchObject({ vendorId: FAKE_BILLCOM.vendors.acme, amount: 640.4 });
    const [action] = await H.t.db
      .select()
      .from(externalAction)
      .where(eq(externalAction.runId, params.runId));
    expect(action).toMatchObject({
      status: "done",
      tool: BILLCOM_TOOLS.billCreate,
      approvedBy: H.B.admin,
      before: { vendor: { id: FAKE_BILLCOM.vendors.acme, name: "Acme Lumber Supply" } },
    });
    expect(action?.result).toMatchObject({ amount: { amount: "640.4000", currency: "USD" } });
    // The run is retried from the start: the bill is not made again.
    await executeRun(deps, params, cloudflareStepRunner(approver));
    expect(made()).toHaveLength(1);
    // Every sign-in was signed out again; the password is in no row the run or the API kept.
    expect(bill.logouts()).toBe(bill.logins());
    const kept = JSON.stringify([
      await H.t.db.select().from(externalAction),
      await H.t.db.select().from(toolCall),
      await H.t.db.select().from(stepRun),
      await H.t.db.select().from(inboxItem),
      await H.t.db.select().from(auditEvent),
      (await H.call(admin("b"), "GET", "/api/inbox")).json,
    ]);
    expect(kept).not.toContain(FAKE_BILLCOM.password);
    expect(kept).not.toContain("sess-");
  });
});
