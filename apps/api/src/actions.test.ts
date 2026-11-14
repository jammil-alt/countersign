// Skill model (2026-11-10), Wave B item 9: action write steps through the API, with the real agents
// runtime and the QuickBooks, BILL and email fakes. A `create_bill` action on a QuickBooks-bound
// agent and on a BILL-bound agent each resolves to that connector's tool and runs as one external
// action behind the client's approval; `send_email` with no channel of the agent's own goes out on
// the account's (Mezonas' sending); publish refuses an action with no accounting connection, or two
// without `via`.

import {
  BILLCOM_TOOLS,
  createBillcomConnector,
  createQboConnector,
  createResendConnector,
  generateEncryptionKey,
} from "@countersign/connectors";
import {
  FAKE_BILLCOM,
  FAKE_QBO_CLIENT,
  FAKE_QBO_REALM,
  FAKE_RESEND_MAIN,
  fakeBillcom,
  fakeQbo,
  fakeResend,
} from "@countersign/connectors/testing";
import { routes } from "@countersign/core";
import { agent, externalAction, run as runRow, stepRun, toolCall } from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  FakeWorkflowStep,
  OPERATOR,
} from "./api.test-helper";
import { quietNever } from "./quiet-hours.test-helper";
import { credentialsFor, executeRun } from "./runs/execute";
import { cloudflareStepRunner } from "./runs/step-runner";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const ENCRYPTION_KEY = generateEncryptionKey();
const ORIGIN = "https://staging.mezonas.test";
const qbo = fakeQbo();
const bill = fakeBillcom();
const resend = fakeResend();

const h = await createApiHarness({
  connectors: () => [
    createQboConnector({
      ...FAKE_QBO_CLIENT,
      environment: "sandbox",
      fetch: qbo.fetch,
      sleep: async () => {},
    }),
    createBillcomConnector({ devKey: FAKE_BILLCOM.devKey, fetch: bill.fetch }),
    createResendConnector({ fetch: resend.fetch }),
  ],
  env: {
    ENCRYPTION_KEY,
    OAUTH_STATE_SECRET: "state-secret-".repeat(4),
    APP_ORIGIN: ORIGIN,
    RESEND_API_KEY: FAKE_RESEND_MAIN.apiKey,
    RESEND_FALLBACK_DOMAIN: "mail.mezonas.test",
    EMAIL_FORWARDING_DOMAIN: "in.mezonas.test",
  },
  fetch: resend.fetch,
});
afterAll(() => h?.close());

const QBO_VENDOR = "57";

function processBundle(steps: unknown[], extraTools: string[] = []) {
  return {
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: { name: "AP clerk", role: "enters bills", mission: "Bills in on time." },
      kind: "functional",
      model: { id: "claude-opus-5-5", maxTokens: 1024 },
      instructions: "Only do what the process says.",
      skills: [],
      extraTools,
      canCommand: [],
      // Even in act mode, an action's write waits for approval (invariant 8).
      permissions: { mode: "act" },
      budgets: { maxSteps: 4, maxCostUsd: "0.10" },
      memory: { enabled: false },
    },
    workflows: [
      {
        slug: "main",
        name: "Main",
        workflow: {
          schemaVersion: 4,
          triggers: [{ id: "trg-manual", on: { type: "manual", input: {} } }],
          steps,
        },
      },
    ],
  };
}

const createBill = (
  vendorId: string,
  invoiceNumber: string,
  extra: Record<string, unknown> = {},
) => ({
  id: "bill",
  kind: "write",
  name: "Create bill",
  action: "create_bill",
  input: {
    vendorId,
    invoiceNumber,
    date: "2026-11-05",
    dueDate: "2026-12-05",
    currency: "USD",
    total: "640.40",
    lines: [{ description: "Plywood", amount: "640.40", account: "80" }],
  },
  ...extra,
});

describe.skipIf(!h)("action write steps through the API", () => {
  const H = h as ApiHarness;
  const conn = { qboA: "", billA: "", billB: "", emailA: "" };
  let sam = "";

  const deps = () => ({
    db: H.db,
    platform: H.platform,
    transport: new FakeModel(),
    instances: H.instances,
    credentials: credentialsFor(H.db, { current: ENCRYPTION_KEY }),
  });

  /** Approves every item the run waits on, as the client's admin. */
  const approver = (client: "a" | "b", seen: string[] = []) =>
    new FakeWorkflowStep(async (_name, type) => {
      const res = await H.call(admin(client), "GET", "/api/inbox");
      const item = j(res.json).items.find(
        (i: { id: string }) => `inbox-${i.id.replace(/-/g, "")}` === type,
      );
      if (!item) throw new Error(`no open item for ${type}`);
      seen.push(item.title);
      const done = await H.call(admin(client), "POST", `/api/inbox/${item.id}/resolve`, {
        decision: "approve",
      });
      expect(done.status, JSON.stringify(done.json)).toBe(200);
      return H.instances.events.find((e) => e.event.type === type)?.event.payload;
    });

  async function vaultBill(client: "a" | "b", tenantId: string, offered: string[]) {
    await H.call(OPERATOR, "PUT", `/api/ops/clients/${tenantId}/connectors`, { offered });
    const res = await H.call(admin(client), "PUT", "/api/connections/billcom/credentials", {
      values: {
        username: FAKE_BILLCOM.username,
        password: FAKE_BILLCOM.password,
        organizationId: FAKE_BILLCOM.organizationId,
      },
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return routes.portalSetCredentials.response.parse(res.json).item.connectionId;
  }

  /** A client agent of `steps`, bound as given; returns its id, version and publish response. */
  async function agentWith(
    tenantId: string,
    slug: string,
    steps: unknown[],
    bindings: Record<string, string>,
    extraTools: string[] = [],
  ) {
    const created = await H.call(OPERATOR, "POST", `/api/ops/clients/${tenantId}/agents`, {
      slug,
      bundle: processBundle(steps, extraTools),
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    const id = j(created.json).agent.id as string;
    const version = j(created.json).version.id as string;
    if (Object.keys(bindings).length > 0) {
      const op = await H.call(OPERATOR, "PATCH", `/api/ops/agents/${id}/operation`, { bindings });
      expect(op.status, JSON.stringify(op.json)).toBe(200);
    }
    const pub = await H.call(OPERATOR, "POST", `/api/ops/agents/${id}/versions/${version}/publish`);
    return { id, version, pub };
  }

  async function run(agentId: string, client: "a" | "b", seen: string[] = []) {
    await H.t.db.update(agent).set({ runStatus: "active" }).where(eq(agent.id, agentId));
    const res = await H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/run`, {
      workflow: "main",
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const params = H.instances.started.get(j(res.json).runId);
    if (!params) throw new Error("not started");
    const result = await executeRun(deps(), params, cloudflareStepRunner(approver(client, seen)));
    return { params, result };
  }

  const actionsOf = (runId: string) =>
    H.t.db.select().from(externalAction).where(eq(externalAction.runId, runId));

  beforeAll(async () => {
    // Client A: QuickBooks (connected by its admin), BILL too, and Mezonas' sending for email.
    await H.call(OPERATOR, "PUT", `/api/ops/clients/${H.A.tenantId}/connectors`, {
      offered: ["testkit", "qbo", "billcom"],
    });
    const start = await H.call(admin("a"), "POST", "/api/connections/qbo/authorize");
    const state = new URL(j(start.json).redirectUrl).searchParams.get("state") ?? "";
    const done = await H.call(admin("a"), "POST", "/api/connections/qbo/callback", {
      params: { code: "fixture-code", state, realmId: FAKE_QBO_REALM },
    });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    conn.qboA = j(done.json).connection.connection.id;
    await H.settle();
    qbo.put("Vendor", { Id: QBO_VENDOR, SyncToken: "0", DisplayName: "Acme Lumber", Active: true });
    conn.billA = await vaultBill("a", H.A.tenantId, ["testkit", "qbo", "billcom"]);
    // Client B: BILL only.
    conn.billB = await vaultBill("b", H.B.tenantId, ["testkit", "billcom"]);

    const msg = `/api/ops/clients/${H.A.tenantId}/messaging`;
    expect((await H.call(OPERATOR, "PUT", msg, { quietHours: quietNever() })).status).toBe(200);
    const made = await H.call(OPERATOR, "POST", `/api/ops/clients/${H.A.tenantId}/email`, {
      domain: "shop.example",
      localPart: "orders",
    });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    conn.emailA = j(made.json).setup.connection.connectionId;
    sam = j(
      (
        await H.call(admin("a"), "POST", "/api/contacts", {
          name: "Sam Roe",
          email: "sam@vendor.example",
          consent: { channels: ["email"], source: "signed the vendor agreement" },
        })
      ).json,
    ).contact.id;
    expect(sam).toBeTruthy();
  });

  it("create_bill on a QuickBooks-bound agent: QuickBooks' tool, once, after the client approves", async () => {
    const a = await agentWith(H.A.tenantId, "qbo-clerk", [createBill(QBO_VENDOR, "INV-41001")], {
      qbo: conn.qboA,
    });
    expect(a.pub.status, JSON.stringify(a.pub.json)).toBe(200);
    const posts = () => qbo.apiCalls("POST", "bill").length;
    const before = posts();
    const seen: string[] = [];
    const { params, result } = await run(a.id, "a", seen);
    expect(result).toEqual({ status: "succeeded" });
    expect(seen).toHaveLength(1);
    expect(posts()).toBe(before + 1);
    const [action] = await actionsOf(params.runId);
    expect(action).toMatchObject({
      status: "done",
      tool: "qbo.bill.create",
      connectionId: conn.qboA,
      approvedBy: H.A.admin,
    });
    // The tool's input, mapped from the action's: money stays a decimal string.
    expect(action?.input).toMatchObject({
      vendorId: QBO_VENDOR,
      docNumber: "INV-41001",
      txnDate: "2026-11-05",
      expectedTotal: "640.40",
      lines: [{ description: "Plywood", amount: "640.40", accountId: "80" }],
    });
    const [row] = await H.t.db
      .select()
      .from(stepRun)
      .where(and(eq(stepRun.runId, params.runId), eq(stepRun.nodeId, "bill")));
    expect(row).toMatchObject({ nodeType: "write", status: "succeeded" });
    // Retried from the start: the stored resolution and the action's key make it once.
    await executeRun(deps(), params, cloudflareStepRunner(approver("a")));
    expect(posts()).toBe(before + 1);
  });

  it("a test run's bill hands its attach step a stand-in id: it passes, and nothing is written", async () => {
    const steps = [
      {
        id: "bill",
        kind: "write",
        name: "Create the bill in QuickBooks",
        tool: "qbo.bill.create",
        input: {
          vendorId: QBO_VENDOR,
          docNumber: "INV-41010",
          txnDate: "2026-11-05",
          expectedTotal: "640.40",
          lines: [{ description: "Plywood", amount: "640.40", accountId: "80" }],
        },
      },
      {
        id: "attach",
        kind: "write",
        name: "Attach the invoice to the bill",
        tool: "qbo.attachable.upload",
        input: {
          documentId: crypto.randomUUID(),
          entity: "Bill",
          entityId: "{{steps.bill.output.id}}",
        },
      },
    ];
    const a = await agentWith(H.A.tenantId, "qbo-test-run", steps, { qbo: conn.qboA }, [
      "qbo.bill.create",
      "qbo.attachable.upload",
    ]);
    expect(a.pub.status, JSON.stringify(a.pub.json)).toBe(200);
    const writes = () => qbo.apiCalls("POST").length;
    const before = writes();
    const res = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${a.id}/versions/${a.version}/test-run`,
      {
        workflow: "main",
      },
    );
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const params = H.instances.started.get(j(res.json).runId);
    if (!params) throw new Error("not started");
    const result = await executeRun(deps(), params, cloudflareStepRunner(approver("a")));
    expect(result).toEqual({ status: "succeeded" });
    expect(writes()).toBe(before);
    const [row] = await H.t.db.select().from(runRow).where(eq(runRow.id, params.runId));
    expect(row).toMatchObject({ mode: "test", status: "succeeded", agentVersionId: a.version });
    // Both writes recorded as proposed, never made; the attach names the bill's stand-in id.
    const actions = await actionsOf(params.runId);
    expect(actions.map((x) => [x.tool, x.status]).sort()).toEqual([
      ["qbo.attachable.upload", "proposed"],
      ["qbo.bill.create", "proposed"],
    ]);
    expect(actions.find((x) => x.tool === "qbo.attachable.upload")?.input).toMatchObject({
      entity: "Bill",
      entityId: "0",
    });
    const rows = await H.t.db.select().from(stepRun).where(eq(stepRun.runId, params.runId));
    const bill = rows.find((r) => r.nodeId === "bill");
    expect(bill).toMatchObject({
      status: "succeeded",
      output: { id: "0", standIn: true, wouldHaveDone: true },
      summary: "Would create the bill in QuickBooks (test run, not written; stand-in values)",
    });
    // The attach has no stand-in of its own: it says what it would have done, as before.
    const attach = rows.find((r) => r.nodeId === "attach");
    expect(attach).toMatchObject({
      status: "succeeded",
      output: { wouldHaveDone: true },
      summary: "Would attach the invoice to the bill (test run, not written)",
    });
    expect(attach?.output).not.toHaveProperty("standIn");
    const calls = await H.t.db
      .select()
      .from(toolCall)
      .where(eq(toolCall.stepRunId, bill?.id ?? ""));
    expect(calls[0]?.output).toMatchObject({ status: "would_have_done", standIn: true });
  });

  it("create_bill on a BILL-bound agent: BILL's tool, behind the client's approval", async () => {
    const b = await agentWith(
      H.B.tenantId,
      "bill-clerk",
      [createBill(FAKE_BILLCOM.vendors.acme, "INV-41002")],
      { billcom: conn.billB },
    );
    expect(b.pub.status, JSON.stringify(b.pub.json)).toBe(200);
    const { params, result } = await run(b.id, "b");
    expect(result).toEqual({ status: "succeeded" });
    const made = bill.bills.filter(
      (x) => (x.invoice as { invoiceNumber?: string }).invoiceNumber === "INV-41002",
    );
    expect(made).toHaveLength(1);
    const [action] = await actionsOf(params.runId);
    expect(action).toMatchObject({
      status: "done",
      tool: BILLCOM_TOOLS.billCreate,
      connectionId: conn.billB,
      approvedBy: H.B.admin,
    });
    expect(action?.input).toMatchObject({ invoiceNumber: "INV-41002", invoiceDate: "2026-11-05" });
  });

  it("publish refuses an action with no accounting connection, or two without via", async () => {
    const none = await agentWith(H.A.tenantId, "no-books", [createBill(QBO_VENDOR, "X-1")], {});
    expect(none.pub.status).toBe(422);
    expect(JSON.stringify(none.pub.json)).toContain("action_no_connection");
    const two = await agentWith(H.A.tenantId, "two-books", [createBill(QBO_VENDOR, "X-2")], {
      qbo: conn.qboA,
      billcom: conn.billA,
    });
    expect(two.pub.status).toBe(422);
    expect(JSON.stringify(two.pub.json)).toContain("action_needs_via");
    const via = await agentWith(
      H.A.tenantId,
      "via-books",
      [createBill(QBO_VENDOR, "X-3", { via: "qbo" })],
      { qbo: conn.qboA, billcom: conn.billA },
    );
    expect(via.pub.status, JSON.stringify(via.pub.json)).toBe(200);
  });

  it("send_email with no channel of the agent's own goes out on the account's, approved", async () => {
    const e = await agentWith(
      H.A.tenantId,
      "mailer",
      [
        {
          id: "mail",
          kind: "write",
          name: "Send email",
          action: "send_email",
          input: { to: "sam@vendor.example", subject: "Your bill", body: "We entered your bill." },
        },
      ],
      {},
    );
    expect(e.pub.status, JSON.stringify(e.pub.json)).toBe(200);
    const sent = resend.emails.length;
    const seen: string[] = [];
    const { params, result } = await run(e.id, "a", seen);
    expect(result).toEqual({ status: "succeeded" });
    expect(seen).toHaveLength(1);
    expect(resend.emails.length).toBe(sent + 1);
    const [action] = await actionsOf(params.runId);
    expect(action).toMatchObject({
      status: "done",
      tool: "email.send",
      connectionId: conn.emailA,
      approvedBy: H.A.admin,
    });
    expect(action?.input).toMatchObject({
      to: "sam@vendor.example",
      text: "We entered your bill.",
    });
  });
});
