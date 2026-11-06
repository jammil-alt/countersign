// QuickBooks accounts receivable and create bill through the API (ARCHITECTURE §6.2 v0.12,
// docs/plan.md §1.41, M18), against the fake QuickBooks: invoices sync into `receivable` (customers
// and payments stay raw records), linked to the organization that carries the customer's id; no
// events for history, then `receivable.updated` and `receivable.paid` when a payment lands and a
// deleted invoice keeps its row; the aging report cites the receivables; a note lands on one
// invoice's private note only, and a bill is created once, both only after approval; a duplicate
// bill is refused before anyone is asked.

import {
  ContentStore,
  createQboConnector,
  generateEncryptionKey,
  QBO_TOOLS,
} from "@countersign/connectors";
import { FAKE_QBO_CLIENT, FAKE_QBO_REALM, fakeQbo } from "@countersign/connectors/testing";
import { AgentBundle, type AgentBundleInput } from "@countersign/core";
import {
  agent,
  event,
  externalAction,
  inboxItem,
  organization,
  rawRecord,
  receivable,
  withTenant,
} from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { and, asc, eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  FakeWorkflowStep,
  OPERATOR,
} from "./api.test-helper";
import { MemoryQboSyncInstances } from "./qbo/instances";
import { runQboSync } from "./qbo/sync";
import { credentialsFor, executeRun } from "./runs/execute";
import { cloudflareStepRunner } from "./runs/step-runner";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const ENCRYPTION_KEY = generateEncryptionKey();
const ORIGIN = "https://staging.mezonas.test";
const qbo = fakeQbo();
const syncs = new MemoryQboSyncInstances();

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
  qboSync: syncs,
});
afterAll(() => h?.close());

describe.skipIf(!h)("QuickBooks accounts receivable and create bill through the API", () => {
  const H = h as ApiHarness;
  let connectionId = "";
  let lakeside = "";
  let bundleCount = 0;

  const sync = () =>
    runQboSync(
      {
        db: H.db,
        platform: H.platform,
        content: new ContentStore(H.objects),
        credentials: credentialsFor(H.db, { current: ENCRYPTION_KEY }),
      },
      { tenantId: H.A.tenantId, connectionId, reason: "operator" },
      { do: <T>(_name: string, fn: () => Promise<T>) => fn() },
    );

  const runDeps = () => ({
    db: H.db,
    platform: H.platform,
    transport: new FakeModel(),
    instances: H.instances,
    credentials: credentialsFor(H.db, { current: ENCRYPTION_KEY }),
    documents: { content: new ContentStore(H.objects) },
  });

  const receivables = () =>
    H.t.db
      .select()
      .from(receivable)
      .where(eq(receivable.tenantId, H.A.tenantId))
      .orderBy(asc(receivable.externalId));

  const arEvents = () =>
    H.t.db
      .select()
      .from(event)
      .where(and(eq(event.tenantId, H.A.tenantId), like(event.type, "receivable.%")))
      .orderBy(asc(event.createdAt));

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

  async function makeAgent(steps: unknown[], extraTools: string[], skills: string[]) {
    bundleCount += 1;
    const b = AgentBundle.parse({
      schemaVersion: 1,
      definition: {
        schemaVersion: 2,
        identity: { name: "AR clerk", role: "keeps the books", mission: "collect and pay" },
        kind: "functional",
        model: { id: "claude-opus-5-5", maxTokens: 1024 },
        instructions: "Only do what the workflow says.",
        skills: skills.map((skill) => ({ skill, settings: {} })),
        extraTools,
        canCommand: [],
        permissions: { mode: "suggest_only" },
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
      slug: `ar-${bundleCount}`,
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
    await H.t.db.update(agent).set({ runStatus: "active" }).where(eq(agent.id, id));
    const res = await H.call(OPERATOR, "POST", `/api/ops/agents/${id}/run`, { workflow: "main" });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const params = H.instances.started.get(j(res.json).runId);
    if (!params) throw new Error("not started");
    return params;
  }

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
    // The client's directory already knows Lakeside Builders by its QuickBooks customer id.
    lakeside = await withTenant(H.db, H.A.tenantId, async (tx) => {
      const [row] = await tx
        .insert(organization)
        .values({
          tenantId: H.A.tenantId,
          name: "Lakeside Builders",
          kinds: ["customer"],
          externalRefs: { qbo: "8" },
          source: "manual",
        })
        .returning();
      return row?.id ?? "";
    });
  });

  it("syncs invoices into receivables; customers and payments stay raw; history raises nothing", async () => {
    const first = await sync();
    expect(first.skipped).toBeUndefined();
    const rows = await receivables();
    expect(
      rows.map((r) => [r.externalId, r.docNumber, r.status, r.total, r.balance, r.organizationId]),
    ).toEqual([
      ["130", "1041", "open", "5100.0000", "5100.0000", lakeside],
      ["131", "1042", "paid", "2400.0000", "0.0000", null],
      ["132", "1043", "open", "2280.5000", "2280.5000", lakeside],
      ["133", "1044", "open", "1840.0000", "1840.0000", null],
      ["134", "1045", "void", "0.0000", "0.0000", null],
    ]);
    // Outside the 365 days of history: not read.
    expect(rows.find((r) => r.externalId === "120")).toBeUndefined();
    expect(rows[2]).toMatchObject({
      customerExternalId: "8",
      customerName: "Lakeside Builders",
      txnDate: "2026-10-20",
      dueDate: "2026-11-19",
      currency: "USD",
      privateNote: "Deposit received by check",
    });
    const raws = await H.t.db
      .select({ entity: rawRecord.entityType })
      .from(rawRecord)
      .where(eq(rawRecord.tenantId, H.A.tenantId));
    const entities = new Set(raws.map((r) => r.entity));
    expect(entities).toContain("Customer");
    expect(entities).toContain("Payment");
    expect(await arEvents()).toEqual([]);
    // Client B sees none of it (RLS).
    const other = await withTenant(H.db, H.B.tenantId, (tx) => tx.select().from(receivable));
    expect(other).toEqual([]);
  });

  it("a payment moves its invoice's balance and raises updated and paid; a deletion keeps the row", async () => {
    qbo.receivePayment("133", "1840");
    qbo.remove("Invoice", "134");
    await sync();
    const rows = await receivables();
    expect(rows.find((r) => r.externalId === "133")).toMatchObject({
      balance: "0.0000",
      status: "paid",
    });
    expect(rows.find((r) => r.externalId === "134")?.status).toBe("deleted");
    const events = await arEvents();
    const r133 = rows.find((r) => r.externalId === "133")?.id;
    expect(events.map((e) => [e.type, e.subjectId])).toEqual(
      expect.arrayContaining([
        ["receivable.updated", r133],
        ["receivable.paid", r133],
      ]),
    );
    expect(
      events.find((e) => e.type === "receivable.updated" && e.subjectId === r133)?.payload,
    ).toMatchObject({
      source: "qbo",
      balance: { amount: "0.0000", currency: "USD" },
      status: "paid",
      changed: ["balance", "status"],
    });
    expect(events.filter((e) => e.type === "receivable.paid")).toHaveLength(1);
  });

  it("reads the aging report with the receivables as sources, and notes one invoice after approval", async () => {
    const r130 = (await receivables()).find((r) => r.externalId === "130");
    const params = await makeAgent(
      [
        {
          id: "aging",
          name: "Read the aging report",
          kind: "skill",
          skill: QBO_TOOLS.agingReport,
          input: {},
          client: { visible: true, label: "Read the aging report" },
        },
        {
          id: "note",
          name: "Note the call",
          kind: "action",
          tool: QBO_TOOLS.invoiceAddNote,
          input: { invoiceId: "130", note: "Called Pat, check promised Friday", syncToken: "1" },
          approval: { required: "required" },
          client: { visible: true, label: "Noted the call" },
        },
      ],
      [QBO_TOOLS.invoiceAddNote],
      [QBO_TOOLS.agingReport],
    );
    const atWait: number[] = [];
    const step = approver(() => {
      atWait.push(qbo.apiCalls("POST", "invoice").length);
    });
    const result = await executeRun(runDeps(), params, cloudflareStepRunner(step));
    expect(result).toEqual({ status: "succeeded" });
    expect(atWait).toEqual([0]);
    const actions = await H.t.db
      .select()
      .from(externalAction)
      .where(eq(externalAction.runId, params.runId));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ status: "done", approvedBy: H.A.admin });
    expect(actions[0]?.before).toMatchObject({
      docNumber: "1041",
      customer: { id: "8", name: "Lakeside Builders" },
      privateNote: null,
    });
    const inv = qbo.get("Invoice", "130");
    expect(inv?.PrivateNote).toMatch(/^\d{4}-\d{2}-\d{2}: Called Pat, check promised Friday$/);
    expect(inv?.TotalAmt).toBe(5100);
    // The aging step's output cites the receivable it rests on.
    const run = await H.call(OPERATOR, "GET", `/api/ops/runs/${params.runId}`);
    expect(JSON.stringify(run.json)).toContain(r130?.id ?? "missing");
  });

  it("creates a bill once after approval, and refuses a duplicate before anyone is asked", async () => {
    const bill = {
      vendorId: "58",
      docNumber: "PHF-3301",
      txnDate: "2026-11-04",
      expectedTotal: "212.50",
      lines: [
        { itemId: "23", qty: "50", unitPrice: "3.25", amount: "162.50" },
        { accountId: "81", description: "Freight", amount: "50.00" },
      ],
    };
    const action = (input: unknown) => ({
      id: "create",
      name: "Create the bill",
      kind: "action",
      tool: QBO_TOOLS.billCreate,
      input,
      approval: { required: "required" },
      client: { visible: true, label: "Created the bill" },
    });
    const params = await makeAgent([action(bill)], [QBO_TOOLS.billCreate], []);
    const atWait: number[] = [];
    const step = approver(() => {
      atWait.push(qbo.apiCalls("POST", "bill").length);
    });
    expect(await executeRun(runDeps(), params, cloudflareStepRunner(step))).toEqual({
      status: "succeeded",
    });
    expect(atWait).toEqual([0]);
    expect(qbo.apiCalls("POST", "bill")).toHaveLength(1);
    const [done] = await H.t.db
      .select()
      .from(externalAction)
      .where(eq(externalAction.runId, params.runId));
    expect(done).toMatchObject({ status: "done", approvedBy: H.A.admin });
    expect(done?.before).toEqual({
      vendor: { id: "58", name: "Pacific Hardware & Finishes" },
      names: {
        items: { "23": "Euro hinge 110 degree" },
        accounts: { "81": "Job Materials:Freight In" },
      },
    });
    expect(done?.result).toMatchObject({ docNumber: "PHF-3301", total: "212.5000" });
    // A replayed run writes nothing more.
    await executeRun(runDeps(), params, cloudflareStepRunner(step));
    expect(qbo.apiCalls("POST", "bill")).toHaveLength(1);

    // The bill syncs like any other; proposing it again is refused before anyone is asked.
    await sync();
    const again = await makeAgent([action(bill)], [QBO_TOOLS.billCreate], []);
    const step2 = approver();
    const result = await executeRun(runDeps(), again, cloudflareStepRunner(step2));
    expect(result.status).toBe("failed");
    expect(step2.waits).toHaveLength(0);
    const items = await H.t.db.select().from(inboxItem).where(eq(inboxItem.runId, again.runId));
    expect(items.filter((i) => i.kind === "external_action")).toEqual([]);
    expect(qbo.apiCalls("POST", "bill")).toHaveLength(1);
  });
});
