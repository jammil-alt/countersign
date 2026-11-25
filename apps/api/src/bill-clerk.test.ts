// The Bill clerk end to end (docs/plan.md §1.30, "Bill clerk"), as the seed holds it (its v1, in
// the step model), against the fake QuickBooks with the golden invoices read in replay and the
// model's choices faked: the seeded template validates against the platform and forks into a
// client; an invoice is read; its one bill is found by vendor, total, number and date; itemizing,
// attaching and the memo each wait for approval and are written once; a re-read invoice changes
// nothing; an invoice whose number is on a bill that doesn't match writes nothing and asks; an
// invoice with no bill gets one, for the vendor matched on our records, after approval; two equal
// bills write nothing and ask the client admin, with the candidates as sources; and a test run
// proposes everything and writes nothing.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { executeAction } from "@countersign/agents";
import {
  ContentStore,
  createQboConnector,
  generateEncryptionKey,
  QBO_TOOLS,
} from "@countersign/connectors";
import { FAKE_QBO_CLIENT, FAKE_QBO_REALM, fakeQbo } from "@countersign/connectors/testing";
import { processes, RECORD_INVOICE_TOOL, steps } from "@countersign/core";
import {
  agent,
  docExtraction,
  document,
  event,
  externalAction,
  inboxItem,
  message,
  stepRun,
  thread,
  transaction,
  vendor,
  withTenant,
} from "@countersign/db";
import { loadSeedTemplates } from "@countersign/db/seed";
import { extractDocument, storeDocument } from "@countersign/documents";
import { createLlmClient, FakeModel, knownModelIds } from "@countersign/llm";
import { DEFAULT_FIXTURE_DIR } from "@countersign/llm/node";
import { and, desc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  allowForAgent,
  createApiHarness,
  FakeWorkflowStep,
  OPERATOR,
} from "./api.test-helper";
import { defaultDeps } from "./http";
import { MemoryQboSyncInstances } from "./qbo/instances";
import { dispatchByIds, runQboSync } from "./qbo/sync";
import { extractInBackground } from "./routes/documents";
import { credentialsFor, executeRun, runtimeFor } from "./runs/execute";
import type { RunParams } from "./runs/instances";
import { cloudflareStepRunner } from "./runs/step-runner";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const ENCRYPTION_KEY = generateEncryptionKey();
const ORIGIN = "https://staging.mezonas.test";
const qbo = fakeQbo();
const syncs = new MemoryQboSyncInstances();
const INVOICES = resolve(DEFAULT_FIXTURE_DIR, "..", "invoices");

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
    APP_ORIGIN: ORIGIN,
  },
  qboSync: syncs,
});
afterAll(() => h?.close());

/** A bill in the fake company with one account line for its whole total. */
function bill(id: string, vendor: [string, string], total: number, date: string, doc?: string) {
  qbo.put("Vendor", {
    Id: vendor[0],
    SyncToken: "0",
    DisplayName: vendor[1],
    Active: true,
  });
  qbo.put("Bill", {
    Id: id,
    SyncToken: "0",
    ...(doc ? { DocNumber: doc } : {}),
    TxnDate: date,
    CurrencyRef: { value: "USD" },
    VendorRef: { value: vendor[0], name: vendor[1] },
    Line: [
      {
        Id: "1",
        Amount: total,
        DetailType: "AccountBasedExpenseLineDetail",
        AccountBasedExpenseLineDetail: { AccountRef: { value: "80", name: "Job Materials" } },
      },
    ],
    TotalAmt: total,
  });
}

const NORTHLINE: [string, string] = ["60", "Northline Panel Supply"];
const CEDAR: [string, string] = ["61", "Cedar Ridge Hardwoods"];
const KEYSTONE: [string, string] = ["62", "Keystone Hardware & Finishes"];

describe.skipIf(!h)("the Bill clerk", () => {
  const H = h as ApiHarness;
  let connectionId = "";
  let templateId = "";
  let clerkId = "";
  let clerkVersion = "";
  const docs: Record<"northline" | "cedar" | "keystone", string> = {
    northline: "",
    cedar: "",
    keystone: "",
  };

  const runDeps = (transport = new FakeModel()) => ({
    db: H.db,
    platform: H.platform,
    transport,
    instances: H.instances,
    credentials: credentialsFor(H.db, { current: ENCRYPTION_KEY }),
    documents: { content: new ContentStore(H.objects) },
  });

  /** The model's only part: one item or account per Northline line (they never restate amounts). */
  const mapModel = (documentId: string) =>
    new FakeModel([
      { toolUse: { name: "docs__get", input: { documentId } } },
      {
        toolUse: {
          name: "finish",
          input: {
            lines: [
              { lineNo: 1, itemId: "21" },
              { lineNo: 2, accountId: "80" },
              { lineNo: 3, accountId: "80" },
              { lineNo: 4, accountId: "80" },
              { lineNo: 5, accountId: "80" },
              { lineNo: 6, accountId: "80" },
            ],
            sources: [documentId, "150"],
          },
        },
      },
    ]);

  /**
   * What client A's admin read before signing: each card as the portal inbox sent it, with the
   * header's count (the overview's `needsYou.inbox`) and the inbox's open items at that moment.
   */
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
  const seen: { item: any; count: number; open: number }[] = [];

  /** Approves every item the run waits on, as client A's admin; `before` runs first. */
  function approver(before: () => void) {
    return new FakeWorkflowStep(async (_name, type) => {
      before();
      const res = await H.call(admin("a"), "GET", "/api/inbox");
      const item = j(res.json).items.find(
        (i: { id: string }) => `inbox-${i.id.replace(/-/g, "")}` === type,
      );
      if (!item) throw new Error(`no open item for ${type}`);
      const overview = await H.call(admin("a"), "GET", "/api/overview");
      seen.push({
        item,
        count: j(overview.json).needsYou.inbox,
        open: j(res.json).items.length,
      });
      const done = await H.call(admin("a"), "POST", `/api/inbox/${item.id}/resolve`, {
        decision: "approve",
      });
      expect(done.status, JSON.stringify(done.json)).toBe(200);
      return H.instances.events.find((e) => e.event.type === type)?.event.payload;
    });
  }

  /** Dispatches a document's pending `document.extracted` events: the runs they start. */
  async function dispatchExtracted(documentId: string): Promise<RunParams[]> {
    const before = H.instances.started.size;
    const rows = await H.t.db
      .select({ id: event.id })
      .from(event)
      .where(and(eq(event.type, "document.extracted"), eq(event.subjectId, documentId)));
    // The invoices were read (and their events dispatched, to nobody) before the clerk went
    // live; each case dispatches its invoice's event again as if it had just arrived.
    await H.t.db
      .update(event)
      .set({ dispatchedAt: null })
      .where(
        inArray(
          event.id,
          rows.map((r) => r.id),
        ),
      );
    await dispatchByIds(
      { db: H.db, instances: H.instances },
      H.A.tenantId,
      rows.map((r) => r.id),
    );
    return [...H.instances.started.values()].slice(before).filter((p) => p.agentId === clerkId);
  }

  // In the order they were proposed: the rows have no order of their own.
  const actionsOf = (runId: string) =>
    H.t.db
      .select()
      .from(externalAction)
      .where(eq(externalAction.runId, runId))
      .orderBy(externalAction.createdAt);
  const itemsOf = (runId: string) =>
    H.t.db.select().from(inboxItem).where(eq(inboxItem.runId, runId));
  const txnOf = async (externalId: string) =>
    (
      await H.t.db
        .select()
        .from(transaction)
        .where(and(eq(transaction.tenantId, H.A.tenantId), eq(transaction.externalId, externalId)))
    )[0];

  beforeAll(async () => {
    // QuickBooks, connected by the client admin.
    await H.call(OPERATOR, "PUT", `/api/ops/clients/${H.A.tenantId}/connectors`, {
      offered: ["testkit", "qbo"],
    });
    const start = await H.call(admin("a"), "POST", "/api/connections/qbo/authorize");
    const state = new URL(j(start.json).redirectUrl).searchParams.get("state") ?? "";
    const done = await H.call(admin("a"), "POST", "/api/connections/qbo/callback", {
      params: { code: "fixture-code", state, realmId: FAKE_QBO_REALM },
    });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    connectionId = j(done.json).connection.connection.id;
    await H.settle();

    // The bills the invoices belong to, synced before the invoices arrive.
    bill("150", NORTHLINE, 9742.35, "2026-10-28", "20418");
    // A Cedar Ridge bill with the invoice's number but not its total (5,800, not 5,843.35).
    bill("151", CEDAR, 5800, "2026-10-30", "CR-7731");
    bill("152", KEYSTONE, 8832.4, "2026-11-02"); // two equal bills, no numbers
    bill("153", KEYSTONE, 8832.4, "2026-11-04");
    const inline = { do: <T>(_name: string, fn: () => Promise<T>) => fn() };
    await runQboSync(
      {
        db: H.db,
        platform: H.platform,
        content: new ContentStore(H.objects),
        credentials: credentialsFor(H.db, { current: ENCRYPTION_KEY }),
      },
      { tenantId: H.A.tenantId, connectionId, reason: "operator" },
      inline,
    );
    expect((await txnOf("Bill:150"))?.total).toBe("9742.3500");

    // The template as the seed holds it (its v1, in the step model), installed from the back
    // office as the seed installs it, then forked into client A.
    const tpl = await H.call(OPERATOR, "POST", "/api/ops/platform-templates/bill-clerk/install", {
      version: 1,
    });
    expect(tpl.status, JSON.stringify(tpl.json)).toBe(200);
    templateId = j(tpl.json).template.id;
  });

  it("validates against the platform, with approval on every write", async () => {
    const seeded = (await loadSeedTemplates()).find((t) => t.slug === "bill-clerk");
    if (!seeded) throw new Error("no bill-clerk seed");
    const result = processes.validateAnyBundle(seeded.bundle, {
      skills: Object.fromEntries(H.platform.catalog.list().map((s) => [s.id, s])),
      tools: H.platform.tools.specs(),
      events: H.platform.events.byType(),
      models: knownModelIds(),
    });
    expect(result.errors).toEqual([]);
    const def = seeded.bundle.definition;
    expect(def.kind).toBe("platform");
    expect(def.permissions.mode).toBe("suggest_only");
    const w = steps.Workflow.parse(seeded.bundle.workflows[0]?.workflow);
    expect(w.triggers.map((t) => t.on)).toEqual([
      {
        type: "event",
        event: "document.extracted",
        filter: {
          match: "all",
          rules: [{ field: "{{trigger.totalsValid}}", op: "is", value: true }],
        },
      },
    ]);
    // Every step that can change the client's books is an action with approval required by the
    // bill approver (invariant 8); the model only chooses (the lines, and a new bill's layout).
    const writes: [string, string, string | undefined][] = [];
    const ai: string[] = [];
    steps.eachStep(w.steps, ({ step }) => {
      if (step.kind !== "do") return;
      if (step.doneBy === "ai") ai.push(step.id);
      if (step.uses?.type !== "action") return;
      const spec = H.platform.tools.get(step.uses.action)?.spec;
      if (spec?.sideEffect !== "external" && !steps.mergedAction(step.uses.action)) return;
      writes.push([step.id, step.uses.action, step.checks?.approval?.required]);
      expect(step.checks?.approval?.approvers, step.id).toEqual([{ who: "seat:bill-approver" }]);
    });
    expect(writes).toEqual([
      ["itemize", QBO_TOOLS.billUpdateLines, "required"],
      ["attach", QBO_TOOLS.attachableUpload, "required"],
      ["memo", QBO_TOOLS.billUpdateMemo, "required"],
      ["create", "accounting.bill.create", "required"],
      ["attach-new", QBO_TOOLS.attachableUpload, "required"],
    ]);
    expect(ai).toEqual(["map", "prepare"]);
  });

  it("forks into a client, binds its QuickBooks and publishes", async () => {
    const fork = await H.call(OPERATOR, "POST", `/api/ops/templates/${templateId}/fork`, {
      clientId: H.A.tenantId,
      serviceName: "Bills",
    });
    expect(fork.status, JSON.stringify(fork.json)).toBe(200);
    clerkId = j(fork.json).agent.id;
    clerkVersion = j(fork.json).version.id;
    // Without QuickBooks bound, the writes have no connection: it can't publish.
    const early = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${clerkId}/versions/${clerkVersion}/publish`,
    );
    expect(early.status).toBe(422);
    expect(JSON.stringify(early.json)).toContain("connection_missing");
    const bound = await H.call(OPERATOR, "PATCH", `/api/ops/agents/${clerkId}/operation`, {
      bindings: { qbo: connectionId },
    });
    expect(bound.status, JSON.stringify(bound.json)).toBe(200);
    // Bound, but QuickBooks started low risk: its bill updates are off until the client allows.
    const held = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${clerkId}/versions/${clerkVersion}/publish`,
    );
    expect(held.status).toBe(422);
    expect(JSON.stringify(held.json)).toContain("entity_off");
    // Connectors C4: the client admin allows what the clerk needs, asking first.
    await allowForAgent(H, admin("a"), connectionId, clerkId);
    const pub = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${clerkId}/versions/${clerkVersion}/publish`,
    );
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
  });

  it("reads the invoices as they arrive", async () => {
    for (const [key, file, mimeType] of [
      ["northline", "northline-20418.pdf", "application/pdf"],
      ["cedar", "cedar-ridge-7731.png", "image/png"],
      ["keystone", "keystone-55102.pdf", "application/pdf"],
    ] as const) {
      const stored = await withTenant(H.db, H.A.tenantId, (tx) =>
        storeDocument(tx, new ContentStore(H.objects), {
          tenantId: H.A.tenantId,
          source: "upload",
          connectionId: null,
          bytes: new Uint8Array(readFileSync(resolve(INVOICES, file))),
          filename: file,
          mimeType,
        }),
      );
      docs[key] = stored.document.id;
    }
    await extractInBackground(
      {
        db: H.db,
        env: H.env,
        deps: {
          ...defaultDeps,
          objects: () => H.objects,
          extractionTransport: () => H.extraction.transport,
        },
      },
      H.A.tenantId,
      Object.values(docs),
    );
    const read = await H.t.db
      .select()
      .from(event)
      .where(
        and(eq(event.type, "document.extracted"), inArray(event.subjectId, Object.values(docs))),
      );
    expect(read).toHaveLength(3);
    for (const e of read) expect(j(e.payload).totalsValid).toBe(true);
  });

  it("a test run proposes the changes and writes nothing", async () => {
    const [e] = await H.t.db
      .select()
      .from(event)
      .where(and(eq(event.type, "document.extracted"), eq(event.subjectId, docs.northline)));
    const res = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${clerkId}/versions/${clerkVersion}/test-run`,
      { workflow: "invoice-read", payload: e?.payload },
    );
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const params = H.instances.started.get(j(res.json).runId) as RunParams;
    expect(params.mode).toBe("test");
    const result = await executeRun(
      runDeps(mapModel(docs.northline)),
      params,
      cloudflareStepRunner(new FakeWorkflowStep()),
    );
    expect(result).toMatchObject({ status: "succeeded" });
    expect(qbo.apiCalls("POST")).toEqual([]);
    const actions = await actionsOf(params.runId);
    expect(actions.map((a) => [a.tool, a.status, a.inboxItemId])).toEqual(
      expect.arrayContaining([
        [QBO_TOOLS.billUpdateLines, "proposed", null],
        [QBO_TOOLS.attachableUpload, "proposed", null],
        [QBO_TOOLS.billUpdateMemo, "proposed", null],
      ]),
    );
    expect(actions).toHaveLength(3);
    expect((await itemsOf(params.runId)).filter((i) => i.assigneeRole !== "operator")).toEqual([]);

    // The timeline says what would have been done, with no empty slots, and the notice was
    // never posted: no thread message for the run, for anyone.
    const logged = await H.t.db
      .select({ nodeId: stepRun.nodeId, summary: stepRun.summary, output: stepRun.output })
      .from(stepRun)
      .where(eq(stepRun.runId, params.runId));
    const summary = (nodeId: string) => logged.find((s) => s.nodeId === nodeId)?.summary;
    expect(summary("itemize")).toBe("Would itemize the bill (test run, not written)");
    expect(summary("attach")).toBe("Would attach the invoice (test run, not written)");
    expect(summary("memo")).toBe("Would note the invoice on the bill (test run, not written)");
    // The End delivers its report as a step of its own: in a test run, never sent.
    expect(summary("done:out:out-itemized")).toContain("(test run, not sent)");
    expect(j(logged.find((s) => s.nodeId === "done:out:out-itemized")?.output)).toEqual({
      sent: false,
    });
    const posted = await H.t.db
      .select({ id: message.id })
      .from(message)
      .innerJoin(thread, eq(thread.id, message.threadId))
      .where(and(eq(thread.subjectType, "run"), eq(thread.subjectId, params.runId)));
    expect(posted).toEqual([]);

    const act = await H.call(OPERATOR, "POST", `/api/ops/agents/${clerkId}/activate`);
    expect(act.status, JSON.stringify(act.json)).toBe(200);
    const [row] = await H.t.db.select().from(agent).where(eq(agent.id, clerkId));
    expect(row?.runStatus).toBe("active");
  });

  it("itemizes, attaches and notes the matched bill only after approval, once", async () => {
    const [params, ...more] = await dispatchExtracted(docs.northline);
    expect(more).toEqual([]);
    if (!params) throw new Error("the invoice started no run");
    const model = mapModel(docs.northline);
    const atWaits: number[] = [];
    seen.length = 0;
    const step = approver(() => void atWaits.push(qbo.apiCalls("POST").length));
    expect(await executeRun(runDeps(model), params, cloudflareStepRunner(step))).toMatchObject({
      status: "succeeded",
    });
    // The mapping step's model calls are the run's, and account for all the tokens it spent.
    const calls = j(
      (await H.call(OPERATOR, "GET", `/api/ops/runs/${params.runId}/model-calls`)).json,
    );
    const [mapStep] = await H.t.db
      .select()
      .from(stepRun)
      .where(and(eq(stepRun.runId, params.runId), eq(stepRun.nodeId, "map")));
    expect(mapStep?.tokensIn).toBeGreaterThan(0);
    const mapCalls = calls.modelCalls.filter(
      (c: { stepRunId: string }) => c.stepRunId === mapStep?.id,
    );
    expect(mapCalls).toHaveLength(2);
    expect(mapCalls.reduce((n: number, c: { tokensIn: number }) => n + c.tokensIn, 0)).toBe(
      mapStep?.tokensIn,
    );
    expect(calls.unrecorded).toEqual([]);

    // The cards the client admin signed: each change named as the client knows the record, the
    // tool's display from the registry, the before state in full, no tool id in any title.
    const cards = seen.splice(0);
    expect(cards.map((c) => c.item.payload.tool)).toEqual([
      QBO_TOOLS.billUpdateLines,
      QBO_TOOLS.attachableUpload,
      QBO_TOOLS.billUpdateMemo,
    ]);
    for (const c of cards) {
      // The header's count includes the open approval (external actions count).
      expect(c.count).toBeGreaterThanOrEqual(1);
      expect(c.count).toBe(c.open);
      expect(c.item.title).not.toContain("qbo.");
      expect(c.item.display).toMatchObject({
        connectorName: "QuickBooks Online",
        tool: { number: "before.docNumber", subject: "before.vendor" },
      });
      expect(c.item.payload.before).toMatchObject({
        docNumber: "20418",
        vendor: { id: "60", name: "Northline Panel Supply" },
      });
    }
    const [lines, attach, memo] = cards.map((c) => c.item);
    expect(lines.title).toBe(
      "Replace the bill's lines with the items on the vendor's invoice. The total stays the same.",
    );
    expect(lines.display.tool.name).toMatchObject({
      en: "QuickBooks bill",
      es: expect.any(String),
    });
    expect(lines.payload.before).toMatchObject({
      total: "9742.3500",
      txnDate: "2026-10-28",
      names: {
        items: { "21": "Baltic birch 3/4in 5x5" },
        accounts: { "80": "Job Materials" },
      },
    });
    expect(attach.payload.before).toMatchObject({
      entity: "Bill",
      attachments: [],
      adding: { fileName: expect.stringMatching(/\.pdf$/), size: expect.any(Number) },
    });
    expect(memo.payload.before).toMatchObject({ memo: null, total: "9742.3500", currency: "USD" });
    // Nothing is written before its approval: at the first wait nothing, then one at a time.
    expect(atWaits).toEqual([0, 1, 2]);
    expect(qbo.apiCalls("POST", "bill")).toHaveLength(2);
    expect(qbo.apiCalls("POST", "upload")).toHaveLength(1);

    const after = j(qbo.get("Bill", "150"));
    expect(after.TotalAmt).toBe(9742.35);
    expect(after.Line).toHaveLength(6);
    expect(j(after.Line[0])).toMatchObject({
      Amount: 2740,
      DetailType: "ItemBasedExpenseLineDetail",
      ItemBasedExpenseLineDetail: { ItemRef: { value: "21" }, Qty: 40, UnitPrice: 68.5 },
    });
    expect(j(after.Line[5])).toMatchObject({
      Amount: 279,
      AccountBasedExpenseLineDetail: { AccountRef: { value: "80" } },
    });
    expect(after.PrivateNote).toBe("Northline Panel Supply invoice 20418, PO J-1182");

    const actions = await actionsOf(params.runId);
    expect(actions.map((a) => [a.tool, a.status, a.approvedBy])).toEqual(
      expect.arrayContaining([
        [QBO_TOOLS.billUpdateLines, "done", H.A.admin],
        [QBO_TOOLS.attachableUpload, "done", H.A.admin],
        [QBO_TOOLS.billUpdateMemo, "done", H.A.admin],
      ]),
    );
    expect(actions).toHaveLength(3);
    const itemize = actions.find((a) => a.tool === QBO_TOOLS.billUpdateLines);
    expect(itemize?.before).toMatchObject({ id: "150", total: "9742.3500", lines: [{ id: "1" }] });
    expect(j(itemize?.input).lines.map((l: { amount: string }) => l.amount)).toEqual([
      "2740.00",
      "1318.75",
      "2826.00",
      "838.00",
      "1740.60",
      "279.00",
    ]);

    // Untrusted invoice text reached the model only in a tool result (invariant 9): never in the
    // instructions, and in the messages only inside tool results (the task's input is read with
    // a tool, as every one-answer skill reads it).
    const [first] = model.requests;
    expect(JSON.stringify(first?.system)).not.toContain("Baltic Birch");
    const blocks = (first?.messages ?? []).flatMap((m): unknown[] =>
      Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }],
    );
    const isResult = (b: unknown) => (b as { type: string }).type === "tool_result";
    expect(JSON.stringify(blocks.filter((b) => !isResult(b)))).not.toContain("Baltic Birch");
    expect(JSON.stringify(blocks.filter(isResult))).toContain("Baltic Birch");

    // The notice cites the document, its reading and the bill.
    const txn150 = await txnOf("Bill:150");
    const [x] = await H.t.db
      .select()
      .from(docExtraction)
      .where(eq(docExtraction.documentId, docs.northline))
      .orderBy(desc(docExtraction.createdAt));
    const notices = await H.t.db
      .select()
      .from(message)
      .where(eq(message.tenantId, H.A.tenantId))
      .orderBy(desc(message.createdAt));
    // The End "done" delivers the report "The bill, itemized" as a step of its own.
    const notice = notices.find((m) => j(m.body).nodeId === "done:out:out-itemized");
    expect(j(notice?.body).text).toBe(
      "Bill 20418 now has the 6 lines of Northline Panel Supply invoice 20418. The total is unchanged at 9742.35 USD.",
    );
    expect(notice?.sources).toEqual([docs.northline, x?.id, txn150?.id]);
    expect(notice?.audience).toBe("client");

    // A retried Workflow, and the approvals handled again: nothing is written twice.
    await executeRun(runDeps(), params, cloudflareStepRunner(step));
    for (const a of actions) {
      const again = await executeAction(runtimeFor(runDeps()), {
        tenantId: H.A.tenantId,
        actionId: a.id,
      });
      expect(again.status).toBe("done");
    }
    expect(qbo.apiCalls("POST", "bill")).toHaveLength(2);
    expect(qbo.apiCalls("POST", "upload")).toHaveLength(1);
  });

  it("an invoice read again finds the bill done and changes nothing", async () => {
    await extractDocument(
      {
        db: H.db,
        content: new ContentStore(H.objects),
        llm: createLlmClient({ transport: H.extraction.transport as never }),
      },
      { tenantId: H.A.tenantId, documentId: docs.northline },
    );
    const runs = await dispatchExtracted(docs.northline);
    expect(runs).toHaveLength(1);
    const params = runs[0] as RunParams;
    const posts = qbo.apiCalls("POST").length;
    // No model call: the plan says the bill already has its lines.
    expect(
      await executeRun(
        runDeps(new FakeModel()),
        params,
        cloudflareStepRunner(new FakeWorkflowStep()),
      ),
    ).toMatchObject({ status: "succeeded" });
    expect(qbo.apiCalls("POST")).toHaveLength(posts);
    expect(await actionsOf(params.runId)).toEqual([]);
    const notes = await H.t.db.select().from(message).where(eq(message.tenantId, H.A.tenantId));
    expect(notes.some((m) => j(m.body).nodeId === "nothing:out:out-already-done")).toBe(true);
  });

  it("lists the invoice as matched to its bill, as the run found it", async () => {
    type Listed = {
      id: string;
      match: { transactionId: string; kind: string; number: string | null; by: string } | null;
    };
    const listed = async () =>
      j((await H.call(OPERATOR, "GET", `/api/ops/clients/${H.A.tenantId}/documents`)).json)
        .documents as Listed[];
    const bill150 = (await txnOf("Bill:150"))?.id;
    // Linked when it was read: a bill, never "a purchase".
    expect((await listed()).find((d) => d.id === docs.northline)?.match).toEqual({
      transactionId: bill150,
      kind: "bill",
      number: "20418",
      by: "link",
    });
    // With no link (another document held the bill), the run's own match still shows.
    const [held] = await H.t.db
      .update(document)
      .set({ transactionId: null })
      .where(eq(document.id, docs.northline))
      .returning({ transactionId: document.transactionId });
    expect(held?.transactionId).toBeNull();
    expect((await listed()).find((d) => d.id === docs.northline)?.match).toEqual({
      transactionId: bill150,
      kind: "bill",
      number: "20418",
      by: "run",
    });
    const detail = await H.call(
      OPERATOR,
      "GET",
      `/api/ops/clients/${H.A.tenantId}/documents/${docs.northline}`,
    );
    expect(j(detail.json).document.match).toMatchObject({ kind: "bill", by: "run" });
    await H.t.db
      .update(document)
      .set({ transactionId: bill150 ?? null })
      .where(eq(document.id, docs.northline));
  });

  it("reads a copy of an invoice already here as a duplicate, and starts no run", async () => {
    const original = new Uint8Array(readFileSync(resolve(INVOICES, "northline-20418.pdf")));
    // Saved again: other bytes (a new trailer), the same invoice.
    const copy = new Uint8Array([...original, ...new TextEncoder().encode("\n% copy\n")]);
    const stored = await withTenant(H.db, H.A.tenantId, (tx) =>
      storeDocument(tx, new ContentStore(H.objects), {
        tenantId: H.A.tenantId,
        source: "upload",
        connectionId: null,
        bytes: copy,
        filename: "northline-20418 copy.pdf",
        mimeType: "application/pdf",
      }),
    );
    expect(stored.created).toBe(true);
    const copyId = stored.document.id;
    const expected = JSON.parse(
      readFileSync(resolve(INVOICES, "northline-20418.expected.json"), "utf8"),
    );
    const before = H.extraction.transport;
    H.extraction.transport = new FakeModel([
      { toolUse: { name: RECORD_INVOICE_TOOL, input: expected } },
    ]);
    try {
      await extractInBackground(
        {
          db: H.db,
          env: H.env,
          deps: {
            ...defaultDeps,
            objects: () => H.objects,
            extractionTransport: () => H.extraction.transport,
          },
        },
        H.A.tenantId,
        [copyId],
      );
    } finally {
      H.extraction.transport = before;
    }
    const [row] = await H.t.db.select().from(document).where(eq(document.id, copyId));
    expect(row?.status).toBe("extracted");
    expect(j(row?.meta).duplicateOf).toEqual({
      documentId: docs.northline,
      filename: "northline-20418.pdf",
    });
    // No event, so no run, and no link: the original holds the bill.
    expect(
      await H.t.db
        .select()
        .from(event)
        .where(and(eq(event.type, "document.extracted"), eq(event.subjectId, copyId))),
    ).toEqual([]);
    expect(await dispatchExtracted(copyId)).toEqual([]);
    expect(row?.transactionId).toBeNull();
    // The lists say so, on both surfaces.
    const ops = j(
      (await H.call(OPERATOR, "GET", `/api/ops/clients/${H.A.tenantId}/documents`)).json,
    );
    expect(ops.documents.find((d: { id: string }) => d.id === copyId)).toMatchObject({
      duplicateOf: { documentId: docs.northline, filename: "northline-20418.pdf" },
      match: null,
    });
    const portal = j((await H.call(admin("a"), "GET", "/api/documents")).json);
    expect(portal.documents.find((d: { id: string }) => d.id === copyId).duplicateOf).toEqual({
      documentId: docs.northline,
      filename: "northline-20418.pdf",
    });
    // The original is not a duplicate of its copy.
    expect(ops.documents.find((d: { id: string }) => d.id === docs.northline).duplicateOf).toBe(
      null,
    );
  });

  // Cedar Ridge's invoice CR-7731 is for 5,843.35; their bill CR-7731 in QuickBooks is for 5,800.
  // No bill matches, and a new one with that number would be refused by QuickBooks as a duplicate:
  // the bill-questions seat (empty: the client admin) is asked, and nothing is written.
  it("an invoice whose number is on a bill that doesn't match writes nothing and asks", async () => {
    const posts = qbo.apiCalls("POST").length;
    const [params, ...more] = await dispatchExtracted(docs.cedar);
    expect(more).toEqual([]);
    if (!params) throw new Error("the invoice started no run");
    // Nobody answers within the week: the run ends, having written nothing.
    expect(
      await executeRun(
        runDeps(new FakeModel()),
        params,
        cloudflareStepRunner(new FakeWorkflowStep()),
      ),
    ).toMatchObject({ status: "succeeded", nodeId: "end-asked-same-number" });
    expect(await actionsOf(params.runId)).toEqual([]);
    expect(qbo.apiCalls("POST")).toHaveLength(posts);
    const bill151 = (await txnOf("Bill:151"))?.id as string;
    const [found] = await H.t.db
      .select({ output: stepRun.output })
      .from(stepRun)
      .where(and(eq(stepRun.runId, params.runId), eq(stepRun.nodeId, "match")));
    expect(j(found?.output)).toMatchObject({ status: "none", sameNumber: [bill151] });
    const [item] = await itemsOf(params.runId);
    expect(item).toMatchObject({ kind: "request", assigneeRole: "client_admin" });
    expect(item?.title).toBe(
      "A bill from Cedar Ridge Hardwoods already has the number CR-7731, but it doesn't match the invoice, so we didn't add another",
    );
    expect(j(item?.payload).sources).toEqual(expect.arrayContaining([docs.cedar, bill151]));
    // The vendor was never looked up: the question comes first.
    const ran = await H.t.db
      .select({ nodeId: stepRun.nodeId })
      .from(stepRun)
      .where(eq(stepRun.runId, params.runId));
    expect(ran.map((r) => r.nodeId)).not.toContain("vendor");
  });

  // The seed's Bill clerk takes an invoice with no bill down the new-bill path: the vendor matched
  // on our records (the Vendors profile) and its QuickBooks id read from the record (Get by id),
  // Prepare bill (the model lays the invoice out for that vendor), Check bill (rules veto the
  // model, invariant 7), then Create bill through the Accounting action, which runs on the
  // client's QuickBooks, and the invoice attached; each change waits for the bill approver (an
  // empty seat: the client admin), and the End reports the new bill.
  it("an invoice with no bill is added as a new one through Accounting, only after approval", async () => {
    // The client renumbers their other Cedar Ridge bill in QuickBooks; it syncs.
    const earlier = qbo.get("Bill", "151");
    if (!earlier) throw new Error("no bill 151");
    qbo.put("Bill", { ...earlier, SyncToken: "1", DocNumber: "CR-7702" });
    await runQboSync(
      {
        db: H.db,
        platform: H.platform,
        content: new ContentStore(H.objects),
        credentials: credentialsFor(H.db, { current: ENCRYPTION_KEY }),
      },
      { tenantId: H.A.tenantId, connectionId, reason: "operator" },
      { do: <T>(_name: string, fn: () => Promise<T>) => fn() },
    );
    expect(j((await txnOf("Bill:151"))?.ext).qbo.docNumber).toBe("CR-7702");
    // And sends the invoice again: it is read again, and its run finds no bill with its number.
    await extractDocument(
      {
        db: H.db,
        content: new ContentStore(H.objects),
        llm: createLlmClient({ transport: H.extraction.transport as never }),
      },
      { tenantId: H.A.tenantId, documentId: docs.cedar },
    );
    const [params, ...more] = await dispatchExtracted(docs.cedar);
    expect(more).toEqual([]);
    if (!params) throw new Error("the invoice started no run");
    const accounts = [
      ["1", '4/4 Hard Maple FAS S2S 13/16"', "1507.00"],
      ["2", "8/4 White Oak Qtr Sawn FAS Rough", "1596.00"],
      ["3", "4/4 Black Walnut Select & Better S2S", "1192.50"],
      ["4", '5/4 Poplar FAS S2S 1-1/16"', "504.00"],
      ["5", "4/4 Cherry FAS Rough", "667.50"],
      ["6", "Freight", "185.00"],
      ["7", "Fuel surcharge 3.5%", "191.35"],
    ].map(([, description, amount]) => ({ description, amount, account: "80" }));
    // The model's only part: the bill laid out from the invoice, the vendor and accounts given.
    const model = new FakeModel([
      {
        toolUse: {
          name: "finish",
          input: {
            vendorId: CEDAR[0],
            invoiceNumber: "CR-7731",
            date: "2026-10-30",
            dueDate: "2026-11-29",
            lines: accounts,
            total: "5843.35",
            currency: "USD",
            memo: "Cedar Ridge Hardwoods invoice CR-7731, PO J-1185",
            sources: [docs.cedar],
          },
        },
      },
    ]);
    const posts = qbo.apiCalls("POST").length;
    const atWaits: number[] = [];
    seen.length = 0;
    const step = approver(() => void atWaits.push(qbo.apiCalls("POST").length));
    expect(await executeRun(runDeps(model), params, cloudflareStepRunner(step))).toMatchObject({
      status: "succeeded",
    });
    // Nothing was written before its approval: one write after each signature.
    expect(atWaits).toEqual([posts, posts + 1]);
    expect(qbo.apiCalls("POST")).toHaveLength(posts + 2);
    const check = await H.t.db
      .select({ output: stepRun.output })
      .from(stepRun)
      .where(and(eq(stepRun.runId, params.runId), eq(stepRun.nodeId, "check-bill")));
    expect(j(check[0]?.output)).toMatchObject({ ok: true, problems: [] });
    // The vendor: matched on our records by name, then its QuickBooks id read from the record.
    const logged = await H.t.db
      .select({ nodeId: stepRun.nodeId, input: stepRun.input, output: stepRun.output })
      .from(stepRun)
      .where(eq(stepRun.runId, params.runId));
    const out = (nodeId: string) => j(logged.find((r) => r.nodeId === nodeId)?.output);
    const [cedar] = await H.t.db
      .select({ id: vendor.id })
      .from(vendor)
      .where(and(eq(vendor.tenantId, H.A.tenantId), eq(vendor.name, CEDAR[1])));
    expect(out("vendor").items).toEqual([
      expect.objectContaining({ matched: cedar?.id, how: "exact", unsure: false }),
    ]);
    expect(out("vendor-record")).toMatchObject({
      id: cedar?.id,
      name: CEDAR[1],
      externalRefs: { qbo: CEDAR[0] },
    });
    expect(j(logged.find((r) => r.nodeId === "prepare")?.input).vendors).toEqual([
      { id: CEDAR[0], name: CEDAR[1] },
    ]);
    // Create bill ran on QuickBooks, then the invoice was attached to the new bill: each one an
    // external action written once, after the client admin signed it.
    const actions = await actionsOf(params.runId);
    expect(actions.map((a) => [a.tool, a.status])).toEqual([
      [QBO_TOOLS.billCreate, "done"],
      [QBO_TOOLS.attachableUpload, "done"],
    ]);
    expect(seen.map((c) => c.item.payload.tool)).toEqual([
      QBO_TOOLS.billCreate,
      QBO_TOOLS.attachableUpload,
    ]);
    const created = actions[0];
    expect(j(created?.input)).toMatchObject({
      vendorId: CEDAR[0],
      docNumber: "CR-7731",
      expectedTotal: "5843.35",
    });
    // The End "created" reports the new bill to the client admin.
    const notes = await H.t.db.select().from(message).where(eq(message.tenantId, H.A.tenantId));
    const note = notes.find((m) => j(m.body).nodeId === "created:out:out-added");
    expect(j(note?.body).text).toBe(
      "We added bill CR-7731 from Cedar Ridge Hardwoods for 5843.35 USD, with its 7 lines.",
    );
  });

  it("two equal bills write nothing and ask the client admin which it is", async () => {
    const posts = qbo.apiCalls("POST").length;
    const [params] = await dispatchExtracted(docs.keystone);
    if (!params) throw new Error("the invoice started no run");
    // Nobody answers within the week: the run ends, having written nothing.
    expect(
      await executeRun(
        runDeps(new FakeModel()),
        params,
        cloudflareStepRunner(new FakeWorkflowStep()),
      ),
    ).toMatchObject({ status: "succeeded" });
    expect(await actionsOf(params.runId)).toEqual([]);
    const [item] = await itemsOf(params.runId);
    const candidates = [
      (await txnOf("Bill:152"))?.id as string,
      (await txnOf("Bill:153"))?.id as string,
    ];
    expect(item).toMatchObject({
      kind: "request",
      assigneeRole: "client_admin",
      title: "We couldn't match invoice 55102 from Keystone Hardware & Finishes to a bill",
    });
    expect(j(item?.payload).candidates).toEqual(candidates);
    expect(j(item?.payload).sources).toEqual(
      expect.arrayContaining([docs.keystone, ...candidates]),
    );
    expect(j(item?.payload).reason).toMatch(/^2 bills from Keystone/);
    expect(qbo.apiCalls("POST")).toHaveLength(posts);
  });
});
