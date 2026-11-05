// QuickBooks Online through the API (plan M9), against the fake QuickBooks (no live Intuit): the
// client admin signs in through Intuit's registered callback path; sync stores raw records once,
// maps bills, purchases and vendor credits with their lines and vendors in decimal, stores
// attachments once and links them; CDC brings new, changed and deleted records; the signed webhook
// starts a sync; agents itemize a bill (total unchanged), update a memo and attach the invoice,
// each only after approval, once, with the before state; a stale SyncToken or a changed total is
// refused; grants and human release hold; disconnect revokes at Intuit; no token in any response.

import {
  ContentStore,
  createQboConnector,
  generateEncryptionKey,
  QBO_TOOLS,
  qboWebhookSignature,
} from "@countersign/connectors";
import {
  FAKE_QBO_CLIENT,
  FAKE_QBO_REALM,
  fakeQbo,
  QBO_FIXTURES,
} from "@countersign/connectors/testing";
import { AgentBundle, type AgentBundleInput } from "@countersign/core";
import {
  agent,
  connection,
  document,
  event,
  externalAction,
  inboxItem,
  rawRecord,
  transaction,
  transactionLine,
  vendor,
  withTenant,
} from "@countersign/db";
import { storeDocument } from "@countersign/documents";
import { FakeModel } from "@countersign/llm";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import cdcFixture from "../../../fixtures/qbo/webhook-notification.json";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  FakeWorkflowStep,
  OPERATOR,
  user,
} from "./api.test-helper";
import { MemoryQboSyncInstances, type QboSyncParams } from "./qbo/instances";
import { dispatchByIds, runQboSync } from "./qbo/sync";
import { credentialsFor, executeRun } from "./runs/execute";
import { cloudflareStepRunner } from "./runs/step-runner";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const ENCRYPTION_KEY = generateEncryptionKey();
const ORIGIN = "https://staging.mezonas.test";
const VERIFIER = "qbo-verifier-token";
const qbo = fakeQbo();
const syncs = new MemoryQboSyncInstances();
/** Every response body the tests saw, checked for tokens at the end. */
const seen: string[] = [];

const h = await createApiHarness({
  connectors: () => [
    createQboConnector({
      ...FAKE_QBO_CLIENT,
      environment: "sandbox",
      webhookVerifier: VERIFIER,
      fetch: qbo.fetch,
      sleep: async () => {},
    }),
  ],
  env: {
    ENCRYPTION_KEY,
    OAUTH_STATE_SECRET: "state-secret-".repeat(4),
    APP_ORIGIN: ORIGIN,
    QBO_WEBHOOK_VERIFIER: VERIFIER,
  },
  qboSync: syncs,
});
afterAll(() => h?.close());

describe.skipIf(!h)("QuickBooks Online through the API", () => {
  const H = h as ApiHarness;
  let connectionId = "";
  let bundleCount = 0;

  async function call(
    who: string | null,
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) {
    const res = await H.call(who, method, path, body, headers);
    seen.push(JSON.stringify(res.json));
    return res;
  }

  const syncDeps = () => ({
    db: H.db,
    platform: H.platform,
    content: new ContentStore(H.objects),
    credentials: credentialsFor(H.db, { current: ENCRYPTION_KEY }),
  });
  const inline = { do: <T>(_name: string, fn: () => Promise<T>) => fn() };
  const sync = (dispatch?: (ids: string[]) => Promise<void>) =>
    runQboSync(
      syncDeps(),
      { tenantId: H.A.tenantId, connectionId, reason: "operator" },
      inline,
      dispatch,
    );

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
      const res = await call(admin("a"), "GET", "/api/inbox");
      const item = j(res.json).items.find(
        (i: { id: string }) => `inbox-${i.id.replace(/-/g, "")}` === type,
      );
      if (!item) throw new Error(`no open item for ${type}`);
      const done = await call(admin("a"), "POST", `/api/inbox/${item.id}/resolve`, {
        decision: "approve",
      });
      expect(done.status, JSON.stringify(done.json)).toBe(200);
      return H.instances.events.find((e) => e.event.type === type)?.event.payload;
    });
  }

  function bundle(
    steps: unknown[],
    extraTools: string[],
    skills: string[] = [],
    on: unknown = { type: "manual", input: {} },
  ): AgentBundle {
    return AgentBundle.parse({
      schemaVersion: 1,
      definition: {
        schemaVersion: 2,
        identity: {
          name: "Books clerk",
          role: "keeps the books",
          mission: "match bills to invoices",
        },
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
            trigger: { id: "trg", on },
            steps,
          },
        },
      ],
    } as AgentBundleInput);
  }

  async function makeAgent(b: AgentBundle): Promise<string> {
    bundleCount += 1;
    const created = await call(OPERATOR, "POST", `/api/ops/clients/${H.A.tenantId}/agents`, {
      slug: `books-${bundleCount}`,
      bundle: b,
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    const id = j(created.json).agent.id as string;
    expect(
      (
        await call(OPERATOR, "PATCH", `/api/ops/agents/${id}/operation`, {
          bindings: { qbo: connectionId },
        })
      ).status,
    ).toBe(200);
    const pub = await call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${id}/versions/${j(created.json).version.id}/publish`,
    );
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
    await H.t.db.update(agent).set({ runStatus: "active" }).where(eq(agent.id, id));
    return id;
  }

  async function start(agentId: string) {
    const res = await call(OPERATOR, "POST", `/api/ops/agents/${agentId}/run`, {
      workflow: "main",
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const params = H.instances.started.get(j(res.json).runId);
    if (!params) throw new Error("not started");
    return params;
  }

  async function actionsOf(runId: string) {
    return H.t.db.select().from(externalAction).where(eq(externalAction.runId, runId));
  }

  const findBill = (id: string) => ({
    id: "find",
    name: "Find the bill",
    kind: "skill",
    skill: QBO_TOOLS.billQuery,
    input: { ids: [id] },
    client: { visible: true, label: "Found the bill" },
  });
  const B = "{{steps.find.output.bills.0";

  beforeAll(async () => {
    const offer = await call(OPERATOR, "PUT", `/api/ops/clients/${H.A.tenantId}/connectors`, {
      offered: ["testkit", "qbo"],
    });
    expect(offer.status, JSON.stringify(offer.json)).toBe(200);
  });

  it("signs in through Intuit's registered callback path; tokens go to the vault only", async () => {
    const list = await call(admin("a"), "GET", "/api/connections");
    expect(
      j(list.json).connections.find((c: { connector: string }) => c.connector === "qbo"),
    ).toMatchObject({ name: "QuickBooks Online", available: true, connection: null });
    // The operator can't sign a client in.
    expect((await call(OPERATOR, "POST", "/api/connections/qbo/authorize")).status).toBe(403);
    expect((await call(user("a"), "POST", "/api/connections/qbo/authorize")).status).toBe(403);

    const start = await call(admin("a"), "POST", "/api/connections/qbo/authorize");
    expect(start.status, JSON.stringify(start.json)).toBe(200);
    const redirect = new URL(j(start.json).redirectUrl);
    expect(redirect.origin + redirect.pathname).toBe("https://appcenter.intuit.com/connect/oauth2");
    expect(redirect.searchParams.get("redirect_uri")).toBe(
      `${ORIGIN}/api/connections/qbo/callback`,
    );
    expect(redirect.searchParams.get("scope")).toBe("com.intuit.quickbooks.accounting");
    const state = redirect.searchParams.get("state") ?? "";

    // Intuit sends the browser to the registered API path, which hands on to the portal page.
    const query = `code=fixture-code&state=${encodeURIComponent(state)}&realmId=${FAKE_QBO_REALM}`;
    const bounce = await H.call(null, "GET", `/api/connections/qbo/callback?${query}`);
    expect(bounce.status).toBe(302);
    expect(bounce.headers.get("location")).toBe(`/connections/qbo/callback?${query}`);

    // The portal page posts the parameters in the admin's session; another client can't land them.
    const params = { code: "fixture-code", state, realmId: FAKE_QBO_REALM };
    expect(
      (await call(admin("b"), "POST", "/api/connections/qbo/callback", { params })).status,
    ).toBe(404);
    const done = await call(admin("a"), "POST", "/api/connections/qbo/callback", { params });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect(j(done.json).connection.connection).toMatchObject({
      status: "connected",
      externalAccountId: FAKE_QBO_REALM,
      accountName: "Harbor Millwork (sandbox)",
    });
    connectionId = j(done.json).connection.connection.id;
    const exchange = qbo.requests.find((r) => r.url.includes("tokens/bearer"));
    expect(exchange?.body).toContain(
      `redirect_uri=${encodeURIComponent(`${ORIGIN}/api/connections/qbo/callback`)}`,
    );

    const [row] = await H.t.db.select().from(connection).where(eq(connection.id, connectionId));
    expect(row).toMatchObject({ connectedBy: H.A.admin, externalAccountId: FAKE_QBO_REALM });
    expect(row?.permissions).toMatchObject({
      read: "auto",
      create: "approval",
      update: "approval",
      delete: "off",
    });
    expect(row?.config).toMatchObject({
      accountName: "Harbor Millwork (sandbox)",
      environment: "sandbox",
    });
    const sealed = JSON.stringify(row?.credentialsEncrypted);
    expect(sealed).not.toContain(QBO_FIXTURES.tokenCode.access_token);
    expect(sealed).not.toContain(QBO_FIXTURES.tokenCode.refresh_token);

    // The first sync starts once the client is connected.
    await H.settle();
    expect([...syncs.started.values()]).toContainEqual({
      tenantId: H.A.tenantId,
      connectionId,
      reason: "connected",
    });
  });

  it("syncs: raw records once, transactions with lines and vendors in decimal, attachments linked", async () => {
    const first = await sync();
    expect(first.skipped).toBeUndefined();
    expect(first.stored).toBeGreaterThanOrEqual(13);
    expect(first.documents).toBe(1);

    const txns = await H.t.db
      .select()
      .from(transaction)
      .where(eq(transaction.tenantId, H.A.tenantId))
      .orderBy(asc(transaction.externalId));
    expect(txns.map((t) => [t.externalId, t.kind, t.total, t.status])).toEqual([
      ["Bill:145", "bill", "1352.7500", "needs_doc"],
      ["Bill:146", "bill", "961.2500", "doc_found"],
      ["Purchase:201", "purchase", "214.6000", "needs_doc"],
      ["Purchase:202", "purchase", "48.1000", "needs_doc"],
      ["Purchase:203", "vendor_credit", "32.0000", "needs_doc"],
      ["VendorCredit:301", "vendor_credit", "45.0000", "needs_doc"],
    ]);
    const bill146 = txns.find((t) => t.externalId === "Bill:146");
    const lines = await H.t.db
      .select()
      .from(transactionLine)
      .where(eq(transactionLine.transactionId, bill146?.id ?? ""))
      .orderBy(asc(transactionLine.lineNo));
    expect(
      lines.map((l) => [l.detailType, l.itemRef ?? l.accountRef, l.qty, l.unitPrice, l.amount]),
    ).toEqual([
      ["item", "White oak 4/4 FAS", "95.0000", "8.7500", "831.2500"],
      ["account", "Freight In", null, null, "130.0000"],
    ]);
    const vendors = await H.t.db.select().from(vendor).where(eq(vendor.tenantId, H.A.tenantId));
    const nwp = vendors.find((v) => v.name === "Northwest Plywood Supply");
    expect(nwp?.externalRefs).toEqual({ qbo: "56" });
    // "Northwest Plywood Supply, Inc." is the same name once normalized: no alias needed.
    expect(nwp?.aliases).toEqual([]);
    expect(txns.find((t) => t.externalId === "Bill:145")?.vendorId).toBe(nwp?.id);

    // The attachment of bill 146 is a document from the connector, linked to its transaction.
    const docs = await H.t.db.select().from(document).where(eq(document.tenantId, H.A.tenantId));
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      source: "connector",
      connectionId,
      filename: "cascade-77812.pdf",
      transactionId: bill146?.id,
      meta: { via: "qbo", attachableId: "5000000000000401" },
    });
    // History raises nothing: no transaction or document event waits to start runs.
    const pending = await H.t.db.select().from(event).where(eq(event.tenantId, H.A.tenantId));
    expect(pending.filter((e) => e.dispatchedAt === null)).toEqual([]);

    // Again: nothing new is stored (raw records once per entity, id and SyncToken).
    const rawCount = (
      await H.t.db.select().from(rawRecord).where(eq(rawRecord.connectionId, connectionId))
    ).length;
    const again = await sync();
    expect(again.stored).toBe(0);
    expect(
      (await H.t.db.select().from(rawRecord).where(eq(rawRecord.connectionId, connectionId)))
        .length,
    ).toBe(rawCount);
    expect(
      (await H.t.db.select().from(transaction).where(eq(transaction.tenantId, H.A.tenantId)))
        .length,
    ).toBe(6);
    const [conn] = await H.t.db.select().from(connection).where(eq(connection.id, connectionId));
    expect(conn?.syncCursor).toMatchObject({ v: 1, phase: "cdc" });
    expect(conn?.lastSyncAt).not.toBeNull();
    // Client B sees none of it.
    await withTenant(H.db, H.B.tenantId, async (tx) => {
      expect(await tx.select().from(transaction)).toEqual([]);
      expect(await tx.select().from(rawRecord).where(eq(rawRecord.connector, "qbo"))).toEqual([]);
    });
  });

  it("CDC brings a new bill with its invoice, a change and a deletion, and raises events", async () => {
    qbo.put("Bill", {
      Id: "147",
      SyncToken: "0",
      DocNumber: "INV-21007",
      TxnDate: "2026-11-04",
      CurrencyRef: { value: "USD" },
      VendorRef: { value: "56", name: "Northwest Plywood Supply" },
      Line: [
        {
          Id: "1",
          Amount: 704,
          DetailType: "AccountBasedExpenseLineDetail",
          AccountBasedExpenseLineDetail: { AccountRef: { value: "80", name: "Job Materials" } },
        },
      ],
      TotalAmt: 704,
    });
    qbo.attachFile("Bill", "147", {
      fileName: "nwp-INV-21007.pdf",
      contentType: "application/pdf",
      bytes: new TextEncoder().encode("%PDF-1.4\n% NWP INV-21007\n%%EOF\n"),
    });
    const vc = qbo.get("VendorCredit", "301") as Record<string, unknown> & { Id: string };
    qbo.put("VendorCredit", { ...vc, SyncToken: "1", PrivateNote: "Credit applied to 146" });
    qbo.remove("Purchase", "202");
    // An intake agent that starts on every new QuickBooks transaction.
    const intake = await makeAgent(
      bundle(
        [
          {
            id: "note",
            name: "Note it",
            kind: "notify",
            channel: "thread",
            message: "A new bill came in",
            client: { visible: false },
          },
        ],
        [],
        [],
        {
          type: "event",
          event: "transaction.created",
          filter: { match: "all", rules: [{ field: "{{trigger.source}}", op: "=", value: "qbo" }] },
        },
      ),
    );
    const runsBefore = H.instances.started.size;
    const eventsBefore = new Set(
      (await H.t.db.select({ id: event.id }).from(event)).map((e) => e.id),
    );

    const r = await sync((ids) =>
      dispatchByIds({ db: H.db, instances: H.instances }, H.A.tenantId, ids),
    );
    // The new bill starts the intake agent's run, once.
    const started = [...H.instances.started.values()].slice(runsBefore);
    expect(started.map((p) => p.agentId)).toEqual([intake]);
    expect(r.stored).toBe(4);
    expect(r.documents).toBe(1);
    const [bill147] = await H.t.db
      .select()
      .from(transaction)
      .where(and(eq(transaction.tenantId, H.A.tenantId), eq(transaction.externalId, "Bill:147")));
    expect(bill147).toMatchObject({ total: "704.0000", status: "doc_found" });
    const [credit] = await H.t.db
      .select()
      .from(transaction)
      .where(eq(transaction.externalId, "VendorCredit:301"));
    expect(credit?.memo).toBe("Credit applied to 146");
    const [gone] = await H.t.db
      .select()
      .from(transaction)
      .where(eq(transaction.externalId, "Purchase:202"));
    expect(gone?.ext).toMatchObject({ qbo: { deleted: true } });
    const flagged = await H.t.db
      .select()
      .from(rawRecord)
      .where(and(eq(rawRecord.connectionId, connectionId), eq(rawRecord.externalId, "202")));
    expect(flagged.every((x) => x.isDeleted)).toBe(true);

    const events = await H.t.db.select().from(event).where(eq(event.tenantId, H.A.tenantId));
    const types = events
      .filter((e) => !eventsBefore.has(e.id))
      .map((e) => e.type)
      .sort();
    expect(types).toEqual([
      "document.received",
      "transaction.created",
      "transaction.updated",
      "transaction.updated",
      "transaction.updated",
    ]);
    const created = events.find((e) => e.type === "transaction.created");
    expect(created?.payload).toMatchObject({
      source: "qbo",
      total: { amount: "704.0000", currency: "USD" },
    });
  });

  it("starts a sync from a signed webhook, and refuses a bad signature", async () => {
    const body = JSON.stringify(cdcFixture);
    const sig = await qboWebhookSignature(VERIFIER, new TextEncoder().encode(body));
    // Syncs share one-minute slots: forget the sign-in's, so this minute's slot is free.
    syncs.started.clear();
    const before = syncs.started.size;
    const ok = await H.app.request(
      "/api/connections/qbo/webhook",
      {
        method: "POST",
        headers: { "content-type": "application/json", "intuit-signature": sig },
        body,
      },
      H.env,
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ syncs: 1 });
    const started = [...syncs.started.entries()].slice(before);
    expect(started).toHaveLength(1);
    expect(started[0]?.[1]).toEqual({
      tenantId: H.A.tenantId,
      connectionId,
      reason: "webhook",
    } satisfies QboSyncParams);
    // A burst of notifications in the same minute starts no second sync.
    const burst = await H.app.request(
      "/api/connections/qbo/webhook",
      { method: "POST", headers: { "intuit-signature": sig }, body },
      H.env,
    );
    expect(await burst.json()).toEqual({ syncs: 0 });

    for (const headers of [
      { "intuit-signature": `${sig.slice(0, -4)}AAA=` },
      {} as Record<string, string>,
    ]) {
      const bad = await H.app.request(
        "/api/connections/qbo/webhook",
        { method: "POST", headers, body },
        H.env,
      );
      expect(bad.status).toBe(401);
    }
    // Another company: signed, acknowledged, nothing started.
    const other = JSON.stringify({
      eventNotifications: [{ realmId: "4620816365211111", dataChangeEvent: { entities: [] } }],
    });
    const otherSig = await qboWebhookSignature(VERIFIER, new TextEncoder().encode(other));
    const res = await H.app.request(
      "/api/connections/qbo/webhook",
      { method: "POST", headers: { "intuit-signature": otherSig }, body: other },
      H.env,
    );
    expect(await res.json()).toEqual({ syncs: 0 });
    expect(syncs.started.size).toBe(before + 1);
  });

  it("lets the operator start a sync, and only for QuickBooks connections it serves", async () => {
    const res = await call(OPERATOR, "POST", `/api/ops/connections/${connectionId}/sync`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(j(res.json).instanceId).toMatch(new RegExp(`^qbo-${connectionId}-n`));
    expect(
      (await call(admin("a"), "POST", `/api/ops/connections/${connectionId}/sync`)).status,
    ).toBe(403);
    expect((await call(OTHER_OP, "POST", `/api/ops/connections/${connectionId}/sync`)).status).toBe(
      404,
    );
    expect(
      (await call(OPERATOR, "POST", `/api/ops/connections/${H.A.connectionId}/sync`)).status,
    ).toBe(409);
  });

  it("itemizes a bill and attaches the invoice only after approval, once, with the before state", async () => {
    const pdf = new TextEncoder().encode("%PDF-1.4\n% Northwest Plywood INV-20931\n%%EOF\n");
    const doc = await withTenant(H.db, H.A.tenantId, (tx) =>
      storeDocument(tx, new ContentStore(H.objects), {
        tenantId: H.A.tenantId,
        source: "upload",
        connectionId: null,
        bytes: pdf,
        filename: "nwp-INV-20931.pdf",
        mimeType: "application/pdf",
      }),
    );
    const agentId = await makeAgent(
      bundle(
        [
          findBill("145"),
          {
            id: "itemize",
            name: "Itemize the bill",
            kind: "action",
            tool: QBO_TOOLS.billUpdateLines,
            input: {
              id: `${B}.id}}`,
              syncToken: `${B}.syncToken}}`,
              expectedTotal: `${B}.total}}`,
              replaceLineIds: [`${B}.lines.0.id}}`],
              lines: [
                {
                  itemId: "21",
                  description: "Baltic birch 18mm 5x5 B/BB",
                  qty: "18",
                  unitPrice: "64.00",
                  amount: "1152.00",
                },
                { itemId: "23", qty: "50", unitPrice: "3.20", amount: "160.00" },
                { accountId: "81", description: "Fuel surcharge", amount: "40.75" },
              ],
            },
            approval: { required: "required" },
            client: { visible: true, label: "Itemized the bill" },
          },
          {
            id: "attach",
            name: "Attach the invoice",
            kind: "action",
            tool: QBO_TOOLS.attachableUpload,
            input: { documentId: doc.document.id, entity: "Bill", entityId: "145" },
            approval: { required: "required" },
            client: { visible: true, label: "Attached the invoice" },
          },
        ],
        [QBO_TOOLS.billUpdateLines, QBO_TOOLS.attachableUpload],
        [QBO_TOOLS.billQuery],
      ),
    );
    const params = await start(agentId);
    // Nothing is written before a person approves it: at the first wait nothing, at the second
    // only the itemizing approved before it.
    const atWaits: number[] = [];
    const step = approver(async () => {
      atWaits.push(qbo.apiCalls("POST").length);
    });
    const result = await executeRun(runDeps(), params, cloudflareStepRunner(step));
    expect(result).toEqual({ status: "succeeded" });
    expect(atWaits).toEqual([0, 1]);
    expect(qbo.apiCalls("POST", "bill")).toHaveLength(1);
    expect(qbo.apiCalls("POST", "upload")).toHaveLength(1);
    const bill = qbo.get("Bill", "145");
    expect(bill?.TotalAmt).toBe(1352.75);
    expect(bill?.Line).toHaveLength(3);

    const actions = await actionsOf(params.runId);
    const itemized = actions.find((a) => a.tool === QBO_TOOLS.billUpdateLines);
    expect(itemized).toMatchObject({ status: "done", approvedBy: H.A.admin });
    expect(itemized?.before).toMatchObject({
      id: "145",
      syncToken: "0",
      total: "1352.7500",
      lines: [{ id: "1", amount: "1352.7500", account: { id: "80", name: "Job Materials" } }],
    });
    expect(itemized?.result).toMatchObject({
      total: "1352.7500",
      lineCount: 3,
      alreadyDone: false,
    });
    const attached = actions.find((a) => a.tool === QBO_TOOLS.attachableUpload);
    expect(attached).toMatchObject({ status: "done", approvedBy: H.A.admin });
    expect(attached?.before).toEqual({ entity: "Bill", entityId: "145", attachments: [] });
    const attachableId = j(attached?.result).attachableId;
    expect(qbo.fileOf(attachableId)).toEqual(pdf);

    // The run replayed (a retried Workflow): nothing is written twice.
    await executeRun(runDeps(), params, cloudflareStepRunner(step));
    expect(qbo.apiCalls("POST", "bill")).toHaveLength(1);
    expect(qbo.apiCalls("POST", "upload")).toHaveLength(1);

    // What the client sees of the run carries no token.
    seen.push(JSON.stringify((await call(admin("a"), "GET", `/api/runs/${params.runId}`)).json));
    seen.push(JSON.stringify((await call(OPERATOR, "GET", `/api/ops/runs/${params.runId}`)).json));
  });

  it("refuses a change proposed on a stale SyncToken, and leaves QuickBooks as it was", async () => {
    const agentId = await makeAgent(
      bundle(
        [
          findBill("146"),
          {
            id: "memo",
            name: "Note the invoice",
            kind: "action",
            tool: QBO_TOOLS.billUpdateMemo,
            input: {
              id: `${B}.id}}`,
              syncToken: `${B}.syncToken}}`,
              memo: "Matched to invoice 77812",
            },
            approval: { required: "required" },
            client: { visible: true, label: "Noted the invoice" },
          },
        ],
        [QBO_TOOLS.billUpdateMemo],
        [QBO_TOOLS.billQuery],
      ),
    );
    const params = await start(agentId);
    // While the approval waits, someone edits the bill in QuickBooks.
    const step = approver(() => {
      const b = qbo.get("Bill", "146") as Record<string, unknown> & { Id: string };
      qbo.put("Bill", { ...b, SyncToken: String(Number(b.SyncToken) + 1), DueDate: "2026-12-15" });
    });
    await executeRun(runDeps(), params, cloudflareStepRunner(step));
    const [action] = await actionsOf(params.runId);
    expect(action?.status).toBe("failed");
    expect(j(action?.error).message).toMatch(/changed in QuickBooks since it was read/);
    expect(qbo.apiCalls("POST", "bill")).toHaveLength(1); // only the earlier itemize
    expect(qbo.get("Bill", "146")?.PrivateNote).toBeUndefined();
  });

  it("refuses an itemization that would change the total before anyone is asked", async () => {
    const agentId = await makeAgent(
      bundle(
        [
          findBill("147"),
          {
            id: "itemize",
            name: "Itemize",
            kind: "action",
            tool: QBO_TOOLS.billUpdateLines,
            input: {
              id: `${B}.id}}`,
              syncToken: `${B}.syncToken}}`,
              expectedTotal: `${B}.total}}`,
              replaceLineIds: ["1"],
              lines: [
                { itemId: "21", qty: "11", unitPrice: "64.00", amount: "704.00" },
                { accountId: "81", amount: "12.00" },
              ],
            },
            approval: { required: "required" },
            client: { visible: true, label: "Itemized the bill" },
          },
        ],
        [QBO_TOOLS.billUpdateLines],
        [QBO_TOOLS.billQuery],
      ),
    );
    const params = await start(agentId);
    const step = approver();
    const result = await executeRun(runDeps(), params, cloudflareStepRunner(step));
    expect(result.status).toBe("failed");
    expect(step.waits).toHaveLength(0);
    const items = await H.t.db.select().from(inboxItem).where(eq(inboxItem.runId, params.runId));
    expect(items.filter((i) => i.kind === "external_action")).toEqual([]);
    expect(qbo.apiCalls("POST", "bill")).toHaveLength(1);
    expect(qbo.get("Bill", "147")?.TotalAmt).toBe(704);
  });

  it("honors grants: an agent whose grant has update off can't propose the change", async () => {
    const agentId = await makeAgent(
      bundle(
        [
          findBill("146"),
          {
            id: "memo",
            name: "Note the invoice",
            kind: "action",
            tool: QBO_TOOLS.billUpdateMemo,
            input: { id: `${B}.id}}`, syncToken: `${B}.syncToken}}`, memo: "Granted?" },
            approval: { required: "required" },
            client: { visible: true, label: "Noted the invoice" },
          },
        ],
        [QBO_TOOLS.billUpdateMemo],
        [QBO_TOOLS.billQuery],
      ),
    );
    const grant = await call(OPERATOR, "PUT", `/api/ops/agents/${agentId}/grants/${connectionId}`, {
      limits: { verbs: { update: "off" } },
    });
    expect(grant.status, JSON.stringify(grant.json)).toBe(200);
    const params = await start(agentId);
    const step = approver();
    const result = await executeRun(runDeps(), params, cloudflareStepRunner(step));
    expect(result.status).toBe("failed");
    expect(step.waits).toHaveLength(0);
    expect(await actionsOf(params.runId)).toEqual([]);
    expect(qbo.get("Bill", "146")?.PrivateNote).toBeUndefined();
  });

  it("honors human release: an approved write without a live release never runs", async () => {
    const agentId = await makeAgent(
      bundle(
        [
          {
            id: "memo",
            name: "Note the invoice",
            kind: "action",
            tool: QBO_TOOLS.billUpdateMemo,
            input: { id: "146", syncToken: "3", memo: "Released?" },
            approval: { required: "required" },
            client: { visible: true, label: "Noted the invoice" },
          },
        ],
        [QBO_TOOLS.billUpdateMemo],
      ),
    );
    const [row] = await H.t.db.select().from(connection).where(eq(connection.id, connectionId));
    await H.t.db
      .update(connection)
      .set({
        config: {
          ...(row?.config ?? {}),
          release: { mode: "code", personId: H.A.admin, channel: "email", window: "run" },
        },
      })
      .where(eq(connection.id, connectionId));
    try {
      const params = await start(agentId);
      // No release service here (fails closed): approving is not releasing.
      await executeRun(runDeps(), params, cloudflareStepRunner(approver()));
      const actions = await actionsOf(params.runId);
      for (const a of actions) expect(a.status).not.toBe("done");
      expect(qbo.get("Bill", "146")?.PrivateNote).toBeUndefined();
    } finally {
      await H.t.db
        .update(connection)
        .set({ config: row?.config ?? {} })
        .where(eq(connection.id, connectionId));
    }
  });

  it("refreshes an expired token during a run and stores the new refresh token encrypted", async () => {
    qbo.expireAccessTokens();
    const r = await sync();
    expect(r.skipped).toBeUndefined();
    const [row] = await H.t.db.select().from(connection).where(eq(connection.id, connectionId));
    const sealed = JSON.stringify(row?.credentialsEncrypted);
    expect(sealed).not.toContain(QBO_FIXTURES.tokenRefresh.refresh_token);
    const opened = await credentialsFor(H.db, { current: ENCRYPTION_KEY })({
      id: connectionId,
      tenantId: H.A.tenantId,
    } as never).get();
    expect(opened).toMatchObject({ refreshToken: qbo.refreshToken });
  });

  it("revokes the grant at Intuit when the client disconnects; syncs then stop", async () => {
    const res = await call(admin("a"), "DELETE", `/api/connections/${connectionId}`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(qbo.requests.some((r) => r.url.endsWith("/oauth2/tokens/revoke"))).toBe(true);
    expect(qbo.refreshToken).toBeNull();
    const [row] = await H.t.db.select().from(connection).where(eq(connection.id, connectionId));
    expect(row).toMatchObject({ status: "disconnected", credentialsEncrypted: null });
    expect((await sync()).skipped).toMatch(/disconnected/);
    expect((await call(OPERATOR, "POST", `/api/ops/connections/${connectionId}/sync`)).status).toBe(
      409,
    );
  });

  it("never put a token in any response", async () => {
    const operator = await call(OPERATOR, "GET", `/api/ops/clients/${H.A.tenantId}/connections`);
    const portal = await call(admin("a"), "GET", "/api/connections");
    expect(operator.status).toBe(200);
    expect(portal.status).toBe(200);
    const text = seen.join("\n");
    for (const token of [
      QBO_FIXTURES.tokenCode.access_token,
      QBO_FIXTURES.tokenCode.refresh_token,
      QBO_FIXTURES.tokenRefresh.access_token,
      QBO_FIXTURES.tokenRefresh.refresh_token,
      FAKE_QBO_CLIENT.clientSecret,
    ]) {
      expect(text).not.toContain(token);
    }
  });
});

const OTHER_OP = "other-operator@example.com";
