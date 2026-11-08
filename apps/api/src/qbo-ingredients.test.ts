// P-2: QuickBooks ingredients through the API (docs/plan.md §1.64, M35), against the fake
// QuickBooks: a new vendor and a purchase order for it wait for approval and are written once, the
// order using the new vendor's id from the step before; with the connection's create on auto, a
// step that doesn't need approval and an agent that acts, the order goes on its own; and with
// purchase orders turned off on the connection it is refused before anything is written.

import {
  ContentStore,
  createQboConnector,
  generateEncryptionKey,
  QBO_TOOLS,
} from "@countersign/connectors";
import { FAKE_QBO_CLIENT, FAKE_QBO_REALM, fakeQbo } from "@countersign/connectors/testing";
import { AgentBundle, type AgentBundleInput, DEFAULT_PERMISSIONS } from "@countersign/core";
import { agent, connection, externalAction, inboxItem } from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  FakeWorkflowStep,
  OPERATOR,
} from "./api.test-helper";
import { MemoryQboSyncInstances } from "./qbo/instances";
import { credentialsFor, executeRun } from "./runs/execute";
import { cloudflareStepRunner } from "./runs/step-runner";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const ENCRYPTION_KEY = generateEncryptionKey();
const ORIGIN = "https://staging.mezonas.test";
const qbo = fakeQbo();

const h = await createApiHarness({
  connectors: () => [
    createQboConnector({
      ...FAKE_QBO_CLIENT,
      environment: "sandbox",
      webhookVerifier: "qbo-verifier",
      fetch: qbo.fetch,
      sleep: async () => {},
    }),
  ],
  env: {
    ENCRYPTION_KEY,
    OAUTH_STATE_SECRET: "state-secret-".repeat(4),
    APP_ORIGIN: ORIGIN,
    QBO_WEBHOOK_VERIFIER: "qbo-verifier",
  },
  qboSync: new MemoryQboSyncInstances(),
});
afterAll(() => h?.close());

const ORDER = {
  docNumber: "PO-2001",
  txnDate: "2026-11-06",
  dueDate: "2026-11-20",
  expectedTotal: "1125.00",
  lines: [
    {
      itemId: "22",
      qty: "120",
      unitPrice: "8.75",
      amount: "1050.00",
      classId: "5000000000000301",
      customerId: "8",
      billable: true,
    },
    { accountId: "81", description: "Delivery", amount: "75.00" },
  ],
};

describe.skipIf(!h)("QuickBooks ingredients through the API", () => {
  const H = h as ApiHarness;
  let connectionId = "";
  let bundleCount = 0;

  const runDeps = () => ({
    db: H.db,
    platform: H.platform,
    transport: new FakeModel(),
    instances: H.instances,
    credentials: credentialsFor(H.db, { current: ENCRYPTION_KEY }),
    documents: { content: new ContentStore(H.objects) },
  });

  /** Approves every item the run waits on, as client A's admin; `before` runs first. */
  function approver(before: () => Promise<void> | void = () => {}) {
    return new FakeWorkflowStep(async (_name, type) => {
      await before();
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
  }

  async function makeAgent(
    steps: unknown[],
    tools: string[],
    mode: "act" | "suggest_only",
    /** Runs after the version is published, before the run starts. */
    published: () => Promise<unknown> = async () => {},
  ) {
    bundleCount += 1;
    const b = AgentBundle.parse({
      schemaVersion: 1,
      definition: {
        schemaVersion: 2,
        identity: { name: "Buyer", role: "orders materials", mission: "order what the shop needs" },
        kind: "functional",
        model: { id: "claude-opus-5-5", maxTokens: 1024 },
        instructions: "Only do what the workflow says.",
        skills: [],
        extraTools: tools,
        canCommand: [],
        permissions: { mode },
        budgets: { maxSteps: 6, maxCostUsd: "0.10" },
        memory: { enabled: false },
      },
      workflows: [
        {
          slug: "main",
          name: "Main",
          workflow: {
            schemaVersion: 3,
            trigger: { id: "trg", on: { type: "manual", input: {} } },
            steps,
          },
        },
      ],
    } as AgentBundleInput);
    const created = await H.call(OPERATOR, "POST", `/api/ops/clients/${H.A.tenantId}/agents`, {
      slug: `buyer-${bundleCount}`,
      bundle: b,
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    const id = j(created.json).agent.id as string;
    const bound = await H.call(OPERATOR, "PATCH", `/api/ops/agents/${id}/operation`, {
      bindings: { qbo: connectionId },
    });
    expect(bound.status, JSON.stringify(bound.json)).toBe(200);
    const pub = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${id}/versions/${j(created.json).version.id}/publish`,
    );
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
    await H.t.db.update(agent).set({ runStatus: "active", stage: "live" }).where(eq(agent.id, id));
    await published();
    const res = await H.call(OPERATOR, "POST", `/api/ops/agents/${id}/run`, { workflow: "main" });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const params = H.instances.started.get(j(res.json).runId);
    if (!params) throw new Error("not started");
    return params;
  }

  const actionsOf = (runId: string) =>
    H.t.db
      .select()
      .from(externalAction)
      .where(eq(externalAction.runId, runId))
      .orderBy(asc(externalAction.createdAt));

  beforeAll(async () => {
    const offer = await H.call(OPERATOR, "PUT", `/api/ops/clients/${H.A.tenantId}/connectors`, {
      offered: ["qbo"],
    });
    expect(offer.status, JSON.stringify(offer.json)).toBe(200);
    const start = await H.call(admin("a"), "POST", "/api/connections/qbo/authorize");
    const state = new URL(j(start.json).redirectUrl).searchParams.get("state") ?? "";
    const done = await H.call(admin("a"), "POST", "/api/connections/qbo/callback", {
      params: { code: "fixture-code", state, realmId: FAKE_QBO_REALM },
    });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    connectionId = j(done.json).connection.connection.id;
    await H.settle();
  });

  it("adds a vendor and orders from it, each once and only after approval", async () => {
    const params = await makeAgent(
      [
        {
          id: "vendor",
          name: "Add the vendor",
          kind: "action",
          tool: QBO_TOOLS.vendorCreate,
          input: { displayName: "Rogue Valley Veneers", email: "ap@roguevalley.example" },
          approval: { required: "required" },
          client: { visible: true, label: "Added the vendor" },
        },
        {
          id: "order",
          name: "Order the walnut",
          kind: "action",
          tool: QBO_TOOLS.purchaseOrderCreate,
          input: { ...ORDER, vendorId: "{{steps.vendor.output.id}}" },
          approval: { required: "required" },
          client: { visible: true, label: "Ordered the walnut" },
        },
      ],
      [QBO_TOOLS.vendorCreate, QBO_TOOLS.purchaseOrderCreate],
      "act",
    );
    const atWait: [number, number][] = [];
    const step = approver(() => {
      atWait.push([
        qbo.apiCalls("POST", "vendor").length,
        qbo.apiCalls("POST", "purchaseorder").length,
      ]);
    });
    expect(await executeRun(runDeps(), params, cloudflareStepRunner(step))).toEqual({
      status: "succeeded",
    });
    // Nothing was written while each waited.
    expect(atWait).toEqual([
      [0, 0],
      [1, 0],
    ]);
    const [vendor, order] = await actionsOf(params.runId);
    expect(vendor).toMatchObject({ status: "done", approvedBy: H.A.admin });
    expect(vendor?.before).toEqual({ existing: null, billingAddress: null, terms: null });
    const vendorId = j(vendor?.result).id as string;
    expect(qbo.get("Vendor", vendorId)).toMatchObject({ DisplayName: "Rogue Valley Veneers" });
    expect(order).toMatchObject({ status: "done", approvedBy: H.A.admin });
    expect(order?.before).toEqual({
      vendor: { id: vendorId, name: "Rogue Valley Veneers" },
      names: {
        items: { "22": "White oak 4/4 FAS" },
        accounts: { "81": "Job Materials:Freight In" },
        classes: { "5000000000000301": "Shop" },
        customers: { "8": "Lakeside Builders" },
      },
      shipTo: null,
    });
    expect(order?.result).toMatchObject({ docNumber: "PO-2001", status: "Open" });
    // A replayed run writes nothing more.
    await executeRun(runDeps(), params, cloudflareStepRunner(step));
    expect(qbo.apiCalls("POST", "vendor")).toHaveLength(1);
    expect(qbo.apiCalls("POST", "purchaseorder")).toHaveLength(1);
  });

  it("orders on its own only when the connection, the step and the agent all allow it; off refuses", async () => {
    const auto = { ...DEFAULT_PERMISSIONS, create: "auto" as const };
    await H.t.db
      .update(connection)
      .set({ permissions: auto })
      .where(eq(connection.id, connectionId));
    const step = (docNumber: string) => ({
      id: "order",
      name: "Order the walnut",
      kind: "action",
      tool: QBO_TOOLS.purchaseOrderCreate,
      input: { ...ORDER, vendorId: "57", docNumber },
      approval: { required: "not_required" },
      client: { visible: true, label: "Ordered the walnut" },
    });
    const posts = () => qbo.apiCalls("POST", "purchaseorder").length;
    const start = posts();

    // Acting, not required, create on auto: it goes without anyone asked.
    const params = await makeAgent([step("PO-2002")], [QBO_TOOLS.purchaseOrderCreate], "act");
    const free = new FakeWorkflowStep();
    expect(await executeRun(runDeps(), params, cloudflareStepRunner(free))).toEqual({
      status: "succeeded",
    });
    expect(free.waits).toHaveLength(0);
    expect(posts()).toBe(start + 1);
    expect((await actionsOf(params.runId))[0]).toMatchObject({ status: "done", approvedBy: null });

    // An agent that only suggests: the same step waits for a person.
    const suggests = await makeAgent(
      [step("PO-2003")],
      [QBO_TOOLS.purchaseOrderCreate],
      "suggest_only",
    );
    const signer = approver(() => {
      expect(posts()).toBe(start + 1);
    });
    expect(await executeRun(runDeps(), suggests, cloudflareStepRunner(signer))).toEqual({
      status: "succeeded",
    });
    expect(signer.waits).toHaveLength(1);
    expect(posts()).toBe(start + 2);

    // The client turns purchase orders off after the agent was published: the call is refused,
    // nothing written, nobody asked.
    const turnOff = (on: string) =>
      H.t.db
        .update(connection)
        .set({ permissions: { ...auto, entities: { purchase_order: { create: "off" } } } })
        .where(eq(connection.id, on));
    const off = await makeAgent([step("PO-2004")], [QBO_TOOLS.purchaseOrderCreate], "act", () =>
      turnOff(connectionId),
    );
    const none = new FakeWorkflowStep();
    const result = await executeRun(runDeps(), off, cloudflareStepRunner(none));
    expect(result.status).toBe("failed");
    expect(none.waits).toHaveLength(0);
    expect(posts()).toBe(start + 2);
    const items = await H.t.db.select().from(inboxItem).where(eq(inboxItem.runId, off.runId));
    expect(items.filter((i) => i.kind === "external_action")).toEqual([]);
    // And a new agent that orders can't be published on that connection now (W4-B's check).
    await expect(
      makeAgent([step("PO-2005")], [QBO_TOOLS.purchaseOrderCreate], "act"),
    ).rejects.toThrow(/entity_off/);
  });
});
