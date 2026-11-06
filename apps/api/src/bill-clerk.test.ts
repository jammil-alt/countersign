// The Bill clerk end to end (docs/plan.md §1.30, "Bill clerk"), against the fake QuickBooks with
// the golden invoices read in replay and the line mapping's model faked: the seeded template
// validates against the platform and forks into a client; an invoice is read; its one bill is
// found by vendor, total, number and date; itemizing, attaching and the memo each wait for
// approval and are written once; a re-read invoice changes nothing; a different total or two
// equal bills write nothing and ask the client admin, with the candidates as sources; and a test
// run proposes everything and writes nothing.

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
import { type Step, validateBundle, walkSteps } from "@countersign/core";
import {
  agent,
  docExtraction,
  event,
  externalAction,
  inboxItem,
  message,
  transaction,
  withTenant,
} from "@countersign/db";
import { loadSeedTemplates } from "@countersign/db/seed";
import { extractDocument, storeDocument } from "@countersign/documents";
import { createLlmClient, FakeModel } from "@countersign/llm";
import { DEFAULT_FIXTURE_DIR } from "@countersign/llm/node";
import { and, desc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
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
    await dispatchByIds(
      { db: H.db, instances: H.instances },
      H.A.tenantId,
      rows.map((r) => r.id),
    );
    return [...H.instances.started.values()].slice(before).filter((p) => p.agentId === clerkId);
  }

  const actionsOf = (runId: string) =>
    H.t.db.select().from(externalAction).where(eq(externalAction.runId, runId));
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
    bill("151", CEDAR, 5800, "2026-10-30", "CR-7731"); // not the invoice's 5,843.35
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

    // The template, installed as the seed installs it, then forked into client A.
    const seeded = (await loadSeedTemplates()).find((t) => t.slug === "bill-clerk");
    if (!seeded) throw new Error("no bill-clerk seed");
    const tpl = await H.call(OPERATOR, "POST", "/api/ops/templates", {
      slug: "bill-clerk",
      bundle: seeded.bundle,
    });
    expect(tpl.status, JSON.stringify(tpl.json)).toBe(200);
    templateId = j(tpl.json).agent.id;
    const pub = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${templateId}/versions/${j(tpl.json).version.id}/publish`,
    );
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
  });

  it("validates against the platform, with approval on every write", async () => {
    const seeded = (await loadSeedTemplates()).find((t) => t.slug === "bill-clerk");
    if (!seeded) throw new Error("no bill-clerk seed");
    const result = validateBundle(seeded.bundle, {
      skills: Object.fromEntries(H.platform.catalog.list().map((s) => [s.id, s])),
      tools: H.platform.tools.specs(),
      events: H.platform.events.byType(),
    });
    expect(result.errors).toEqual([]);
    const def = seeded.bundle.definition;
    expect(def.kind).toBe("platform");
    expect(def.permissions.mode).toBe("suggest_only");
    const [wf] = seeded.bundle.workflows;
    expect(wf?.workflow.trigger.on).toEqual({
      type: "event",
      event: "document.extracted",
      filter: {
        match: "all",
        rules: [{ field: "{{trigger.totalsValid}}", op: "is", value: true }],
      },
    });
    // Every step that can write to QuickBooks is an action with approval required (invariant 8),
    // and the only model step is the line mapping, which reads.
    const steps: Step[] = [];
    walkSteps(wf?.workflow as never, ({ step }) => void steps.push(step));
    const writes = steps.filter(
      (s) => s.kind === "action" && H.platform.tools.get(s.tool)?.spec.sideEffect === "external",
    );
    expect(writes.map((s) => (s.kind === "action" ? s.tool : ""))).toEqual([
      QBO_TOOLS.billUpdateLines,
      QBO_TOOLS.attachableUpload,
      QBO_TOOLS.billUpdateMemo,
    ]);
    for (const s of writes) {
      expect(s.kind === "action" && s.approval.required, s.id).toBe("required");
    }
    const agentSteps = steps.filter(
      (s) => s.kind === "skill" && H.platform.catalog.get(s.skill)?.mode === "agent",
    );
    expect(agentSteps.map((s) => s.id)).toEqual(["map"]);
    for (const s of steps) {
      if (s.kind !== "skill") continue;
      const skill = H.platform.catalog.get(s.skill);
      for (const t of [...(skill?.tools ?? []), ...(skill?.handler ? [skill.handler] : [])]) {
        expect(H.platform.tools.get(t)?.spec.sideEffect, `${s.id}: ${t}`).not.toBe("external");
      }
    }
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
    expect(result).toEqual({ status: "succeeded" });
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
    expect(await executeRun(runDeps(model), params, cloudflareStepRunner(step))).toEqual({
      status: "succeeded",
    });

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

    // Untrusted invoice text reached the model only in a tool result (invariant 9).
    const first = JSON.stringify([model.requests[0]?.system, model.requests[0]?.messages]);
    expect(first).not.toContain("Baltic Birch");
    const results = (model.requests[1]?.messages ?? []).flatMap((m) =>
      Array.isArray(m.content) ? m.content : [],
    );
    expect(
      JSON.stringify(results.filter((b) => (b as { type: string }).type === "tool_result")),
    ).toContain("Baltic Birch");

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
    const notice = notices.find((m) => j(m.body).nodeId === "done");
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
    ).toEqual({ status: "succeeded" });
    expect(qbo.apiCalls("POST")).toHaveLength(posts);
    expect(await actionsOf(params.runId)).toEqual([]);
    const notes = await H.t.db.select().from(message).where(eq(message.tenantId, H.A.tenantId));
    expect(notes.some((m) => j(m.body).nodeId === "nothing")).toBe(true);
  });

  it("a different total or two equal bills write nothing and ask the client admin", async () => {
    const posts = qbo.apiCalls("POST").length;
    const expectAsked = async (documentId: string, title: string, candidates: string[]) => {
      const [params] = await dispatchExtracted(documentId);
      if (!params) throw new Error("the invoice started no run");
      // Nobody answers within the week: the run ends, having written nothing.
      expect(
        await executeRun(
          runDeps(new FakeModel()),
          params,
          cloudflareStepRunner(new FakeWorkflowStep()),
        ),
      ).toEqual({ status: "succeeded" });
      expect(await actionsOf(params.runId)).toEqual([]);
      const [item] = await itemsOf(params.runId);
      expect(item).toMatchObject({ kind: "request", assigneeRole: "client_admin", title });
      expect(j(item?.payload).candidates).toEqual(candidates);
      expect(j(item?.payload).sources).toEqual(expect.arrayContaining([documentId, ...candidates]));
      return item;
    };
    const cedar = await expectAsked(
      docs.cedar,
      "We couldn't match invoice CR-7731 from Cedar Ridge Hardwoods to a bill",
      [(await txnOf("Bill:151"))?.id as string],
    );
    expect(j(cedar?.payload).reason).toMatch(
      /^No bill from Cedar Ridge Hardwoods for USD 5843\.35/,
    );
    const keystone = await expectAsked(
      docs.keystone,
      "We couldn't match invoice 55102 from Keystone Hardware & Finishes to a bill",
      [(await txnOf("Bill:152"))?.id as string, (await txnOf("Bill:153"))?.id as string],
    );
    expect(j(keystone?.payload).reason).toMatch(/^2 bills from Keystone/);
    expect(qbo.apiCalls("POST")).toHaveLength(posts);
  });
});
