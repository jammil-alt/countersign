// The platform's end-to-end test at the API level (docs/plan.md M11): the whole managed-service path
// through the real app (createApp, the dev sign-in, every route as the Worker mounts it) against a
// throwaway Postgres as cs_worker, with fakes for QuickBooks, Stripe and the model. No screens: the
// UI is being redesigned, and a Playwright e2e follows it.
//
// 1. The operator creates a client with its admin invited, offers QuickBooks and upload, installs
//    the seeded Bill clerk template and forks it into the client.
// 2. The client admin signs in to QuickBooks (fake OAuth) and the first sync brings the books in.
//    A first invoice arrives while the agent is off (nothing runs). The operator binds the
//    connection, publishes, test-runs on that invoice (nothing written) and activates.
// 3. The client admin uploads the Northline invoice; its run starts as soon as it is read (no
//    cron tick); the agent proposes three changes; the client admin reads each card in the portal inbox and signs it;
//    each write reaches the fake QuickBooks once.
// 4. The portal's runs, timeline, activity report, service page and records show the result; the
//    operator sees the run with its cost; usage rolls up; billing's daily record has the agent.
// 5. A template update is published, merged into the client agent and test-run.
// 6. A second client sees none of it, and no portal response carries prompts, bundles or cost.
//
// Where the Worker hands work to Cloudflare (Workflows, the cron), the test calls the same code the
// Worker's classes and scheduled handler call: executeRun, runQboSync, cronTick, qboCronTick and
// billingTick, as the other API tests do.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEV_USER_HEADER } from "@countersign/auth";
import {
  ContentStore,
  createQboConnector,
  createStripeClient,
  generateEncryptionKey,
  QBO_TOOLS,
} from "@countersign/connectors";
import {
  FAKE_QBO_CLIENT,
  FAKE_QBO_REALM,
  FAKE_STRIPE_KEY,
  fakeQbo,
  fakeStripe,
} from "@countersign/connectors/testing";
import { billingAgentDay, docExtraction, event, transaction } from "@countersign/db";
import { loadSeedTemplates } from "@countersign/db/seed";
import { FakeModel } from "@countersign/llm";
import { DEFAULT_FIXTURE_DIR } from "@countersign/llm/node";
import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  FakeWorkflowStep,
  forbiddenKeys,
  OPERATOR,
  OTHER_OPERATOR,
} from "./api.test-helper";
import { billingTick } from "./billing/jobs";
import { MemoryQboSyncInstances } from "./qbo/instances";
import { dispatchByIds } from "./qbo/sync";
import { runQboSyncInstance } from "./qbo/sync-now";
import { QBO_CRON_MINUTE, qboCronTick } from "./routes/qbo";
import { cronTick } from "./runs/dispatch";
import { credentialsFor, executeRun } from "./runs/execute";
import type { RunParams } from "./runs/instances";
import { cloudflareStepRunner } from "./runs/step-runner";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const ENCRYPTION_KEY = generateEncryptionKey();
const STRIPE_WEBHOOK_SECRET = "whsec_test_e2e";
const qbo = fakeQbo();
const stripeFake = fakeStripe({ webhookSecret: STRIPE_WEBHOOK_SECRET });
const stripe = createStripeClient({ secretKey: FAKE_STRIPE_KEY, fetch: stripeFake.fetch });
const syncs = new MemoryQboSyncInstances();
const invoice = (name: string) =>
  new Uint8Array(readFileSync(resolve(DEFAULT_FIXTURE_DIR, "..", "invoices", name)));

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
    OAUTH_STATE_SECRET: "e2e-state-secret-".repeat(3),
    APP_ORIGIN: "https://staging.mezonas.test",
    STRIPE_WEBHOOK_SECRET,
  },
  qboSync: syncs,
  stripe,
});
afterAll(() => h?.close());

/** A bill in the client's books with one account line for its whole total. */
function bill(id: string, vendor: [string, string], total: number, date: string, doc: string) {
  qbo.put("Vendor", { Id: vendor[0], SyncToken: "0", DisplayName: vendor[1], Active: true });
  qbo.put("Bill", {
    Id: id,
    SyncToken: "0",
    DocNumber: doc,
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

// The client's books before it connects: the bills its invoices belong to. Cedar Ridge's was
// entered at 5,800.00, not the invoice's 5,843.35.
bill("150", ["60", "Northline Panel Supply"], 9742.35, "2026-10-28", "20418");
bill("151", ["61", "Cedar Ridge Hardwoods"], 5800, "2026-10-30", "CR-7731");

const OWNER = "owner@harbor-millwork.example.com";

describe.skipIf(!h)("end to end: the managed service, through the API", () => {
  const H = h as ApiHarness;
  const ids = {
    client: "",
    template: "",
    templateV1: "",
    clerk: "",
    clerkV1: "",
    connection: "",
    document: "",
    firstDocument: "",
    run: "",
    bill: "",
    items: [] as string[],
  };
  let instructions = "";

  const ok = async (who: string, method: string, path: string, body?: unknown) => {
    const res = await H.call(who, method, path, body);
    expect(res.status, `${who} ${method} ${path}: ${JSON.stringify(res.json)}`).toBe(200);
    return j(res.json);
  };

  const runDeps = (transport = new FakeModel()) => ({
    db: H.db,
    platform: H.platform,
    transport,
    instances: H.instances,
    credentials: credentialsFor(H.db, { current: ENCRYPTION_KEY }),
    documents: { content: new ContentStore(H.objects) },
  });

  /** Runs the QuickBooks syncs started since the last call, as QboSyncWorkflow does. */
  const ranSyncs = new Set<string>();
  async function runStartedSyncs() {
    let n = 0;
    for (const [id, params] of syncs.started) {
      if (ranSyncs.has(id)) continue;
      ranSyncs.add(id);
      n += 1;
      // As QboSyncWorkflow runs it: holding the connection, handing on to a sync asked for meanwhile.
      await runQboSyncInstance(
        {
          db: H.db,
          platform: H.platform,
          content: new ContentStore(H.objects),
          credentials: credentialsFor(H.db, { current: ENCRYPTION_KEY }),
          instances: syncs,
        },
        params,
        id,
        { do: (_name, fn) => fn() },
        (eventIds) =>
          dispatchByIds({ db: H.db, instances: H.instances }, params.tenantId, eventIds),
      );
    }
    return n;
  }

  /** The model's one part in the Bill clerk: an item or account per Northline line. */
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

  /** A multipart upload through the portal, with the request's deferred work awaited. */
  async function upload(email: string, name: string, type: string, bytes: Uint8Array) {
    const form = new FormData();
    form.append("files", new File([bytes], name, { type }));
    const pending: Promise<unknown>[] = [];
    const res = await H.app.request(
      "/api/uploads",
      { method: "POST", headers: { [DEV_USER_HEADER]: email }, body: form },
      H.env,
      {
        waitUntil: (p: Promise<unknown>) => void pending.push(p),
        passThroughOnException: () => {},
        props: {},
      } as unknown as ExecutionContext,
    );
    while (pending.length > 0) await Promise.all(pending.splice(0));
    return { status: res.status, json: j(await res.json()) };
  }

  /** Test-runs a client agent version and drives the run; returns its id. */
  async function testRun(versionId: string, payload: unknown, model = new FakeModel()) {
    const posts = qbo.apiCalls("POST").length;
    const res = await ok(
      OPERATOR,
      "POST",
      `/api/ops/agents/${ids.clerk}/versions/${versionId}/test-run`,
      { workflow: "invoice-read", payload },
    );
    const params = H.instances.started.get(res.runId) as RunParams;
    expect(params.mode).toBe("test");
    const result = await executeRun(
      runDeps(model),
      params,
      cloudflareStepRunner(new FakeWorkflowStep()),
    );
    // A test run never writes to the client's tools (invariant 8).
    expect(qbo.apiCalls("POST")).toHaveLength(posts);
    return { runId: res.runId as string, result };
  }

  // ── 1. The operator sets up the client ───────────────────────────────────────────────────────

  it("the operator creates the client with its admin invited, offering QuickBooks and upload", async () => {
    const created = await ok(OPERATOR, "POST", "/api/ops/clients", {
      name: "Harbor Millwork",
      timezone: "America/Chicago",
      connectorsOffered: ["qbo", "upload"],
      admin: { email: OWNER, name: "Dana Harbor" },
    });
    ids.client = created.client.id;
    expect(created.admin).toMatchObject({
      member: { email: OWNER, role: "client_admin" },
      email: { status: "not_sent", reason: "dev_sign_in" },
    });

    // The admin signs in and lands in this client only, with QuickBooks and upload on offer.
    const session = await ok(OWNER, "GET", "/api/session");
    expect(session.tenants).toEqual([
      { id: ids.client, name: "Harbor Millwork", role: "client_admin" },
    ]);
    expect(session.operator).toBe(false);
    const conns = await ok(OWNER, "GET", "/api/connections");
    expect(conns.connections.map((c: { connector: string }) => c.connector).sort()).toEqual([
      "qbo",
      "upload",
    ]);
    const offered = await ok(OPERATOR, "GET", `/api/ops/clients/${ids.client}/connections`);
    expect([...offered.offered].sort()).toEqual(["qbo", "upload"]);
  });

  it("the operator installs the seeded Bill clerk template and forks it into the client", async () => {
    const seeded = (await loadSeedTemplates()).find((t) => t.slug === "bill-clerk");
    if (!seeded) throw new Error("no bill-clerk seed");
    instructions = seeded.bundle.definition.instructions;
    const tpl = await ok(OPERATOR, "POST", "/api/ops/templates", {
      slug: "bill-clerk",
      bundle: seeded.bundle,
    });
    ids.template = tpl.agent.id;
    ids.templateV1 = tpl.version.id;
    await ok(
      OPERATOR,
      "POST",
      `/api/ops/agents/${ids.template}/versions/${ids.templateV1}/publish`,
    );

    const fork = await ok(OPERATOR, "POST", `/api/ops/templates/${ids.template}/fork`, {
      clientId: ids.client,
      serviceName: "Bills",
    });
    ids.clerk = fork.agent.id;
    ids.clerkV1 = fork.version.id;
    // Nothing to write to yet: the client hasn't connected QuickBooks, so it can't publish.
    const early = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${ids.clerk}/versions/${ids.clerkV1}/publish`,
    );
    expect(early.status).toBe(422);
    expect(JSON.stringify(early.json)).toContain("connection_missing");
  });

  // ── 2. The client connects QuickBooks; the operator binds, test-runs and activates ───────────

  it("the client admin signs in to QuickBooks and the first sync brings the books in", async () => {
    const start = await ok(OWNER, "POST", "/api/connections/qbo/authorize");
    const redirect = new URL(start.redirectUrl);
    const state = redirect.searchParams.get("state") ?? "";
    expect(state).not.toBe("");
    const done = await ok(OWNER, "POST", "/api/connections/qbo/callback", {
      params: { code: "fixture-code", state, realmId: FAKE_QBO_REALM },
    });
    ids.connection = done.connection.connection.id;
    expect(done.connection.connection.status).toBe("connected");
    // No token or credential reaches the portal (invariant 13).
    expect(JSON.stringify(done)).not.toMatch(/access_?token|refresh_?token|"credentials"/i);
    await H.settle();

    // Connecting started the first sync.
    expect([...syncs.started.values()]).toEqual([
      { tenantId: ids.client, connectionId: ids.connection, reason: "connected" },
    ]);
    // The operator asks for a sync within the minute, while the first one runs: it is queued,
    // not merged into the first one and lost (v0.12 W1-H, ARCHITECTURE §6.2).
    const now = await H.call(OPERATOR, "POST", `/api/ops/connections/${ids.connection}/sync`);
    expect(now.status, JSON.stringify(now.json)).toBe(202);
    expect(j(now.json)).toMatchObject({ started: false, queued: true });
    expect(syncs.started.size).toBe(1);
    // QboSyncWorkflow runs the first sync; its last step starts the one asked for, which runs
    // after it (never two at once), and then nothing more.
    expect(await runStartedSyncs()).toBe(2);
    expect([...syncs.started.values()].map((p) => p.reason)).toEqual(["connected", "operator"]);
    expect([...syncs.started.keys()][1]?.startsWith(`qbo-${ids.connection}-now-`)).toBe(true);
    expect(await runStartedSyncs()).toBe(0);
    // With none running, "sync now" starts one at once.
    const again = await ok(OPERATOR, "POST", `/api/ops/connections/${ids.connection}/sync`);
    expect(again).toMatchObject({ started: true, queued: false });
    expect(await runStartedSyncs()).toBe(1);
    const [bill] = await H.t.db
      .select()
      .from(transaction)
      .where(and(eq(transaction.tenantId, ids.client), eq(transaction.externalId, "Bill:150")));
    expect(bill?.total).toBe("9742.3500");
    ids.bill = bill?.id as string;

    // The portal shows the connection, and the bill as a record.
    const conns = await ok(OWNER, "GET", "/api/connections");
    const q = conns.connections.find((c: { connector: string }) => c.connector === "qbo");
    expect(q.connection).toMatchObject({ id: ids.connection, status: "connected" });
    const record = await ok(OWNER, "GET", `/api/records/${ids.bill}`);
    expect(record.record).toMatchObject({
      kind: "transaction",
      connector: "qbo",
      total: "9742.3500",
      vendor: { name: "Northline Panel Supply" },
    });
    expect(record.record.lines).toHaveLength(1);
    // The portal's records list has it, from the client's QuickBooks (v0.12 W1-H).
    const list = await ok(OWNER, "GET", "/api/records");
    const row = list.page.rows.find((r: { id: string }) => r.id === ids.bill);
    expect(row).toMatchObject({ docNumber: "20418", total: "9742.3500", sourceId: ids.connection });
    expect(list.counts.transactions).toBeGreaterThanOrEqual(2);
  });

  /** Ages the client's undispatched events past the cron's 30 s, then ticks it: the runs started. */
  async function cronSweep(): Promise<RunParams[]> {
    await H.t.db.execute(
      sql`update event set created_at = created_at - interval '1 minute'
          where tenant_id = ${ids.client} and dispatched_at is null`,
    );
    const before = new Set(H.instances.started.keys());
    await cronTick({ db: H.db, instances: H.instances }, new Date());
    const left = await H.t.db
      .select({ id: event.id })
      .from(event)
      .where(and(eq(event.tenantId, ids.client), isNull(event.dispatchedAt)));
    expect(left).toEqual([]);
    return [...H.instances.started.values()].filter((p) => !before.has(p.runId));
  }

  it("a first invoice arrives while the agent is off: it is read, and nothing runs", async () => {
    const res = await upload(
      OWNER,
      "cedar-ridge-7731.png",
      "image/png",
      invoice("cedar-ridge-7731.png"),
    );
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    ids.firstDocument = res.json.results[0].document.id;
    const doc = await ok(OWNER, "GET", `/api/documents/${ids.firstDocument}`);
    expect(doc.document.status).toBe("extracted");
    expect(doc.extraction).toMatchObject({
      vendorName: "Cedar Ridge Hardwoods",
      totalsMatch: true,
    });
    expect(await cronSweep()).toEqual([]);
  });

  it("the operator binds the connection, publishes, test-runs on that invoice and activates", async () => {
    await ok(OPERATOR, "PATCH", `/api/ops/agents/${ids.clerk}/operation`, {
      bindings: { qbo: ids.connection },
    });
    await ok(OPERATOR, "POST", `/api/ops/agents/${ids.clerk}/versions/${ids.clerkV1}/publish`);
    // Not activated before a passing test run on this client's data.
    const early = await H.call(OPERATOR, "POST", `/api/ops/agents/${ids.clerk}/activate`);
    expect([early.status, j(early.json).error.code]).toEqual([409, "activation_refused"]);

    // The test-run picker offers the client's recent events: the invoice just read.
    const recent = await ok(
      OPERATOR,
      "GET",
      `/api/ops/clients/${ids.client}/events?type=document.extracted`,
    );
    const e = recent.events.find(
      (x: { payload: { documentId: string } }) => x.payload.documentId === ids.firstDocument,
    );
    expect(e).toBeDefined();
    const { runId, result } = await testRun(ids.clerkV1, e.payload);
    expect(result).toEqual({ status: "succeeded" });
    const run = await ok(OPERATOR, "GET", `/api/ops/runs/${runId}`);
    expect(run.run.mode).toBe("test");
    expect(run.actions).toEqual([]);
    // The bill's total differs, so the clerk would ask the client admin; a test run asks no one.
    expect(
      run.inbox.filter((i: { assigneeRole: string | null }) => i.assigneeRole !== "operator"),
    ).toEqual([]);
    expect((await ok(OWNER, "GET", "/api/inbox")).items).toEqual([]);

    await ok(OPERATOR, "POST", `/api/ops/agents/${ids.clerk}/activate`);
    const agent = await ok(OPERATOR, "GET", `/api/ops/agents/${ids.clerk}`);
    expect(agent.agent.runStatus).toBe("active");
    // v0.12 W1-A: activating starts the trial: every write is signed for 14 days and 25 runs.
    const goLive = await ok(OPERATOR, "GET", `/api/ops/agents/${ids.clerk}/go-live`);
    expect(goLive.goLive).toMatchObject({
      stage: "trial",
      writes: true,
      trial: { minDays: 14, minRuns: 25, runs: 0, ready: false },
      signoff: null,
    });
    // The portal never shows a test run.
    expect((await ok(OWNER, "GET", "/api/runs")).runs).toEqual([]);
  });

  // ── 3. The client uploads an invoice and signs the changes ───────────────────────────────────

  let northline: RunParams | undefined;

  it("the client admin uploads the Northline invoice; it is read and its run starts at once", async () => {
    const before = new Set(H.instances.started.keys());
    const res = await upload(
      OWNER,
      "northline-20418.pdf",
      "application/pdf",
      invoice("northline-20418.pdf"),
    );
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(
      res.json.results.map((r: { kind: string; created: boolean }) => [r.kind, r.created]),
    ).toEqual([["document", true]]);
    ids.document = res.json.results[0].document.id;
    const doc = await ok(OWNER, "GET", `/api/documents/${ids.document}`);
    expect(doc.document.status).toBe("extracted");
    expect(doc.extraction).toMatchObject({
      vendorName: "Northline Panel Supply",
      totalsMatch: true,
    });
    expect(doc.extraction.lines).toHaveLength(6);
    const list = await ok(OWNER, "GET", "/api/documents");
    expect(list.documents.map((d: { id: string }) => d.id)).toEqual(
      expect.arrayContaining([ids.document, ids.firstDocument]),
    );
    // The extraction's event was dispatched right after its transaction committed (ARCHITECTURE
    // §8): the run started with no cron tick, and nothing is left for the sweep.
    const started = [...H.instances.started.entries()]
      .filter(([id]) => !before.has(id))
      .map(([, p]) => p);
    expect(started.map((p) => [p.agentId, p.mode, p.workflowSlug])).toEqual([
      [ids.clerk, "live", "invoice-read"],
    ]);
    northline = started[0];
    const waiting = await H.t.db
      .select({ id: event.id })
      .from(event)
      .where(and(eq(event.tenantId, ids.client), isNull(event.dispatchedAt)));
    expect(waiting).toEqual([]);
    expect(await cronSweep()).toEqual([]);
  });

  it("the run goes; the client admin signs three changes, each written once", async () => {
    const params = northline as RunParams;
    ids.run = params.runId;

    // The client admin reads each card in the portal inbox at the moment the run waits on it.
    // biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
    const cards: { item: any; waiting: number; postsBefore: number }[] = [];
    const step = new FakeWorkflowStep(async (_name, type) => {
      const inbox = await ok(OWNER, "GET", "/api/inbox");
      expect(forbiddenKeys(inbox)).toEqual([]);
      const item = inbox.items.find(
        (i: { id: string }) => `inbox-${i.id.replace(/-/g, "")}` === type,
      );
      if (!item) throw new Error(`no open item for ${type}`);
      const overview = await ok(OWNER, "GET", "/api/overview");
      cards.push({
        item,
        waiting: overview.needsYou.inbox,
        postsBefore: qbo.apiCalls("POST").length,
      });
      await ok(OWNER, "POST", `/api/inbox/${item.id}/resolve`, { decision: "approve" });
      return H.instances.events.find((e) => e.event.type === type)?.event.payload;
    });
    expect(
      await executeRun(runDeps(mapModel(ids.document)), params, cloudflareStepRunner(step)),
    ).toEqual({ status: "succeeded" });

    // Three cards, each named as the client knows the record, with the tool's display.
    expect(cards.map((c) => c.item.payload.tool)).toEqual([
      QBO_TOOLS.billUpdateLines,
      QBO_TOOLS.attachableUpload,
      QBO_TOOLS.billUpdateMemo,
    ]);
    ids.items = cards.map((c) => c.item.id);
    for (const c of cards) {
      expect(c.waiting).toBe(1);
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
    expect(lines.payload.input.lines.map((l: { amount: string }) => l.amount)).toEqual([
      "2740.00",
      "1318.75",
      "2826.00",
      "838.00",
      "1740.60",
      "279.00",
    ]);
    expect(attach.payload.before.adding).toMatchObject({ fileName: "northline-20418.pdf" });
    expect(memo.payload.before).toMatchObject({ memo: null, total: "9742.3500" });

    // Nothing was written before its card was signed, and each write went once.
    expect(cards.map((c) => c.postsBefore)).toEqual([0, 1, 2]);
    expect(qbo.apiCalls("POST", "bill")).toHaveLength(2);
    expect(qbo.apiCalls("POST", "upload")).toHaveLength(1);
    const after = j(qbo.get("Bill", "150"));
    expect(after.TotalAmt).toBe(9742.35);
    expect(after.Line).toHaveLength(6);
    expect(after.PrivateNote).toBe("Northline Panel Supply invoice 20418, PO J-1182");

    // A retried Workflow writes nothing again.
    await executeRun(runDeps(), params, cloudflareStepRunner(step));
    expect(qbo.apiCalls("POST", "bill")).toHaveLength(2);
    expect(qbo.apiCalls("POST", "upload")).toHaveLength(1);
    const inbox = await ok(OWNER, "GET", "/api/inbox");
    expect(inbox.items).toEqual([]);
  });

  // ── 4. The result, in the portal and the back office ─────────────────────────────────────────

  it("the portal's runs, timeline, activity report, service page and records show the result", async () => {
    const runs = await ok(OWNER, "GET", "/api/runs");
    expect(runs.runs).toEqual([
      expect.objectContaining({
        id: ids.run,
        service: { id: ids.clerk, name: "Bills" },
        status: "succeeded",
      }),
    ]);
    const run = await ok(OWNER, "GET", `/api/runs/${ids.run}`);
    expect(run.steps.map((s: { label: string }) => s.label)).toEqual([
      "Looked for the bill in QuickBooks",
      "Checked the bill against the invoice",
      "Itemized the bill",
      "Attached the invoice",
      "Noted the invoice on the bill",
      "Told you what changed",
    ]);
    expect(run.approvals.map((a: { approved: boolean; status: string }) => a.approved)).toEqual([
      true,
      true,
      true,
    ]);
    expect(run.actions.map((a: { tool: string; status: string }) => [a.tool, a.status])).toEqual(
      expect.arrayContaining([
        [QBO_TOOLS.billUpdateLines, "done"],
        [QBO_TOOLS.attachableUpload, "done"],
        [QBO_TOOLS.billUpdateMemo, "done"],
      ]),
    );

    const activity = await ok(OWNER, "GET", "/api/reports/activity");
    expect(activity.runs).toMatchObject({ total: 1, succeeded: 1 });
    // Received: the two uploads and the bill attachment the first sync brought from QuickBooks
    // (the fake company's own); read: the two invoices.
    expect(activity.documents).toEqual({ received: 3, read: 2 });
    expect(activity.actions).toMatchObject({
      total: 3,
      byConnector: [{ connector: "qbo", name: "QuickBooks Online", count: 3 }],
    });
    // A service's documentsRead counts its own extractions: the clerk worked from the invoice
    // read on upload, so it shows 0 (listed as a gap in the e2e's PR).
    expect(activity.services).toEqual([
      expect.objectContaining({
        id: ids.clerk,
        name: "Bills",
        runs: expect.objectContaining({ total: 1, succeeded: 1 }),
        documentsRead: 0,
        actions: 3,
      }),
    ]);
    const service = await ok(OWNER, "GET", `/api/services/${ids.clerk}`);
    expect(service.service).toMatchObject({ id: ids.clerk, name: "Bills" });
    expect(service.recentRuns.map((r: { id: string }) => r.id)).toEqual([ids.run]);

    // QuickBooks' next sync (the cron's, every 15 minutes) brings the written bill back.
    const at = new Date();
    at.setUTCMinutes(QBO_CRON_MINUTE, 0, 0);
    expect(await qboCronTick(H.db, syncs, at)).toBe(1);
    expect(await runStartedSyncs()).toBe(1);
    const record = await ok(OWNER, "GET", `/api/records/${ids.bill}`);
    expect(record.record).toMatchObject({
      total: "9742.3500",
      memo: "Northline Panel Supply invoice 20418, PO J-1182",
    });
    expect(record.record.lines).toHaveLength(6);
    expect(record.record.documents.map((d: { id: string }) => d.id)).toContain(ids.document);
  });

  it("the operator sees the run with its cost", async () => {
    const list = await ok(OPERATOR, "GET", `/api/ops/runs?client=${ids.client}&mode=live`);
    const row = list.runs.find((r: { id: string }) => r.id === ids.run);
    expect(row).toMatchObject({ agentId: ids.clerk, status: "succeeded", mode: "live" });
    expect(Number(row.costUsd)).toBeGreaterThan(0);
    const one = await ok(OPERATOR, "GET", `/api/ops/runs/${ids.run}`);
    expect(one.run.costUsd).toBe(row.costUsd);
    expect(one.actions.map((a: { approvedBy: string | null }) => a.approvedBy)).toEqual(
      expect.arrayContaining([expect.any(String)]),
    );
    // An operator who doesn't serve the client sees none of it.
    const other = await ok(OTHER_OPERATOR, "GET", "/api/ops/runs");
    expect(other.runs.map((r: { tenantId: string }) => r.tenantId)).not.toContain(ids.client);
    expect((await H.call(OTHER_OPERATOR, "GET", `/api/ops/runs/${ids.run}`)).status).toBe(404);
  });

  it("usage rolls up for the client, its agent and the template", async () => {
    const usage = await ok(OPERATOR, "GET", `/api/ops/usage?client=${ids.client}`);
    const client = usage.clients.find((c: { id: string }) => c.id === ids.client);
    // The live run and the two test runs (their model calls cost the same).
    // v0.12 W1-H (ARCHITECTURE §13): the two uploads were read in the background, with no agent:
    // that reading is the client's own usage (usage_platform_daily), in its row and the total,
    // with what the model calls cost. The clerk's documents are the ones its live run cited.
    expect(usage.background.total).toMatchObject({ runs: 0, documents: 2 });
    expect(usage.background.total.tokensIn).toBeGreaterThan(0);
    expect(Number(usage.background.total.costUsd)).toBeGreaterThan(0);
    expect(client.total).toMatchObject({ runs: 2, documents: 3, externalActions: 3 });
    expect(Number(client.total.costUsd)).toBeGreaterThan(Number(usage.background.total.costUsd));
    const clerk = usage.agents.find((a: { id: string }) => a.id === ids.clerk);
    expect(clerk).toMatchObject({
      name: "Bill clerk",
      template: { id: ids.template, slug: "bill-clerk" },
      testCopy: false,
    });
    expect(clerk.total).toMatchObject({ externalActions: 3, documents: 1 });
    // Each reading's cost is on its extraction row, written once (the row is immutable).
    const reads = await H.t.db
      .select({ cost: docExtraction.costUsd, tokensIn: docExtraction.tokensIn })
      .from(docExtraction)
      .where(and(eq(docExtraction.tenantId, ids.client), isNull(docExtraction.agentVersionId)));
    expect(reads).toHaveLength(2);
    for (const r of reads) {
      expect(Number(r.cost)).toBeGreaterThan(0);
      expect(r.tokensIn).toBeGreaterThan(0);
    }
    const tpl = usage.templates.find((t: { id: string }) => t.id === ids.template);
    expect(tpl).toMatchObject({ clients: 1 });
  });

  it("billing's daily record shows the agent active", async () => {
    await ok(OPERATOR, "POST", `/api/ops/billing/clients/${ids.client}/setup`, {
      email: "billing@harbor-millwork.example.com",
    });
    const now = new Date();
    await billingTick({ db: H.db, stripe }, now);
    const day = now.toISOString().slice(0, 10);
    const days = await H.t.db
      .select()
      .from(billingAgentDay)
      .where(and(eq(billingAgentDay.tenantId, ids.client), eq(billingAgentDay.day, day)));
    expect(days.map((d) => [d.agentId, d.agentName])).toEqual([[ids.clerk, "Bills"]]);
    const detail = await ok(OPERATOR, "GET", `/api/ops/billing/clients/${ids.client}`);
    expect(detail.client).toMatchObject({ setUp: true, activeAgents: 1 });
    expect(
      detail.client.monthSoFar.lines.filter((l: { kind: string }) => l.kind === "agent"),
    ).toEqual([expect.objectContaining({ agentId: ids.clerk, description: "Bills", days: 1 })]);
    // The client admin sees the month so far, without our cost.
    const portal = await ok(OWNER, "GET", "/api/billing");
    expect(portal.monthSoFar.lines.map((l: { description: string }) => l.description)).toContain(
      "Bills",
    );
    expect(forbiddenKeys(portal, /cost|token|prompt|model/i)).toEqual([]);
  });

  // ── 5. A template update reaches the client ──────────────────────────────────────────────────

  it("the operator publishes a template update, merges it into the client agent and test-runs it", async () => {
    const tpl = await ok(OPERATOR, "GET", `/api/ops/agents/${ids.template}`);
    const bundle = structuredClone(tpl.live.bundle);
    const done = bundle.workflows[0].workflow.steps
      .flatMap(function all(s: { steps?: unknown[]; paths?: { steps: unknown[] }[] }): unknown[] {
        return [
          s,
          ...((s.steps ?? []) as never[]).flatMap(all),
          ...(s.paths ?? []).flatMap((p) => (p.steps as never[]).flatMap(all)),
        ];
      })
      .find((s: { id: string }) => s.id === "done");
    done.client.label = "Told you what changed on the bill";
    const v2 = await ok(OPERATOR, "POST", `/api/ops/agents/${ids.template}/versions`, {
      bundle,
      changeNote: "Clearer timeline label for the notice",
      releaseNote: "The notice's label names the bill",
    });
    await ok(OPERATOR, "POST", `/api/ops/agents/${ids.template}/versions/${v2.version.id}/publish`);
    // Publishing the template changed no client agent (invariant 11).
    const still = await ok(OPERATOR, "GET", `/api/ops/agents/${ids.clerk}`);
    expect(still.live.id).toBe(ids.clerkV1);

    const used = await ok(OPERATOR, "GET", `/api/ops/templates/${ids.template}/used-by`);
    expect(
      used.agents.find((a: { agent: { id: string } }) => a.agent.id === ids.clerk),
    ).toMatchObject({ behind: 1, conflicts: 0 });
    const preview = await ok(OPERATOR, "GET", `/api/ops/agents/${ids.clerk}/update-preview`);
    expect(preview.conflicts).toEqual([]);
    expect(preview.theirs.id).toBe(v2.version.id);
    const merged = await ok(OPERATOR, "POST", `/api/ops/agents/${ids.clerk}/update`, {
      resolutions: [],
    });
    expect(merged.version).toMatchObject({
      status: "draft",
      authorType: "merge",
      basedOnTemplateVersionId: v2.version.id,
      parentVersionId: ids.clerkV1,
    });

    // Test-run the merge on the client's own invoice (its recent event), then publish it.
    const recent = await ok(
      OPERATOR,
      "GET",
      `/api/ops/clients/${ids.client}/events?type=document.extracted`,
    );
    const e = recent.events.find(
      (x: { payload: { documentId: string } }) => x.payload.documentId === ids.document,
    );
    const { runId, result } = await testRun(merged.version.id, e.payload);
    // The bill is already done: the run says so, proposes nothing, and calls no model.
    expect(result).toEqual({ status: "succeeded" });
    const run = await ok(OPERATOR, "GET", `/api/ops/runs/${runId}`);
    expect(run.actions).toEqual([]);
    expect(run.steps.map((s: { nodeId: string }) => s.nodeId)).toContain("nothing");

    await ok(
      OPERATOR,
      "POST",
      `/api/ops/agents/${ids.clerk}/versions/${merged.version.id}/publish`,
    );
    const live = await ok(OPERATOR, "GET", `/api/ops/agents/${ids.clerk}`);
    expect(live.live.id).toBe(merged.version.id);
    expect(JSON.stringify(live.live.bundle)).toContain("Told you what changed on the bill");
    expect(live.agent).toMatchObject({ runStatus: "active", bindings: { qbo: ids.connection } });
    const after = await ok(OPERATOR, "GET", `/api/ops/templates/${ids.template}/used-by`);
    expect(
      after.agents.find((a: { agent: { id: string } }) => a.agent.id === ids.clerk),
    ).toMatchObject({ behind: 0 });
  });

  // ── 5b. v0.12 W1-A: the first invoice, which arrived while the agent was off, runs live once ──

  it("the operator runs the agent live once on the invoice that arrived while it was off", async () => {
    // A publish keeps the stage.
    const goLive = await ok(OPERATOR, "GET", `/api/ops/agents/${ids.clerk}/go-live`);
    expect(goLive.goLive.stage).toBe("trial");
    const recent = await ok(
      OPERATOR,
      "GET",
      `/api/ops/clients/${ids.client}/events?type=document.extracted`,
    );
    const e = recent.events.find(
      (x: { payload: { documentId: string } }) => x.payload.documentId === ids.firstDocument,
    );
    expect(e).toBeDefined();
    // Not the client's to start.
    const portal = await H.call(OWNER, "POST", `/api/ops/agents/${ids.clerk}/run-event`, {
      eventId: e.id,
    });
    expect(portal.status).toBe(403);

    const res = await ok(OPERATOR, "POST", `/api/ops/agents/${ids.clerk}/run-event`, {
      eventId: e.id,
    });
    expect(res.runs.map((r: { workflow: string }) => r.workflow)).toEqual(["invoice-read"]);
    const params = H.instances.started.get(res.runs[0].runId) as RunParams;
    expect(params).toMatchObject({
      mode: "live",
      agentId: ids.clerk,
      workflowSlug: "invoice-read",
    });
    const run = await ok(OPERATOR, "GET", `/api/ops/runs/${params.runId}`);
    expect(run.run.trigger).toMatchObject({
      type: "event",
      eventId: e.id,
      replayedBy: expect.any(String),
    });
    // It runs as any live run: the client admin answers what it asks.
    const asked: string[] = [];
    const step = new FakeWorkflowStep(async (_name, type) => {
      const inbox = await ok(OWNER, "GET", "/api/inbox");
      const item = inbox.items.find(
        (i: { id: string }) => `inbox-${i.id.replace(/-/g, "")}` === type,
      );
      if (!item) throw new Error(`no open item for ${type}`);
      asked.push(item.title);
      await ok(OWNER, "POST", `/api/inbox/${item.id}/resolve`, { decision: "approve" });
      return H.instances.events.find((x) => x.event.type === type)?.event.payload;
    });
    expect(await executeRun(runDeps(), params, cloudflareStepRunner(step))).toEqual({
      status: "succeeded",
    });
    expect(asked.length).toBeGreaterThan(0);
    const portalRuns = await ok(OWNER, "GET", "/api/runs");
    expect(portalRuns.runs.map((r: { id: string }) => r.id)).toContain(params.runId);

    // Once: the same event never starts this agent again.
    const again = await H.call(OPERATOR, "POST", `/api/ops/agents/${ids.clerk}/run-event`, {
      eventId: e.id,
    });
    expect([again.status, j(again.json).error.code]).toEqual([409, "already_ran"]);
  });

  // ── 6. Isolation and the portal's invariants ─────────────────────────────────────────────────

  /** Every portal GET this test touched, as the client admin of the first client. */
  const portalReads = () => [
    "/api/session",
    "/api/overview",
    "/api/inbox",
    "/api/runs",
    `/api/runs/${ids.run}`,
    "/api/connections",
    "/api/documents",
    `/api/documents/${ids.document}`,
    `/api/records/${ids.bill}`,
    "/api/records",
    "/api/records?kind=vendors",
    "/api/reports/activity",
    `/api/services/${ids.clerk}`,
    "/api/billing",
  ];

  it("a second client sees none of the first client's data", async () => {
    const theirs = [ids.client, ids.run, ids.document, ids.bill, ids.clerk, ids.connection];
    const B = admin("b");
    for (const path of portalReads()) {
      const res = await H.call(B, "GET", path);
      const named = theirs.filter((id) => path.includes(id));
      if (named.length > 0) {
        expect(res.status, `${B} GET ${path}`).toBe(404);
      } else {
        expect(res.status, `${B} GET ${path}: ${JSON.stringify(res.json)}`).toBe(200);
      }
      const body = JSON.stringify(res.json);
      for (const id of theirs) expect(body, `${path} names ${id}`).not.toContain(id);
      expect(body).not.toContain("Northline");
      expect(body).not.toContain("Harbor Millwork");
    }
    // Nor can it act on the first client's items, or ask for its run with its id in a header.
    const resolve = await H.call(B, "POST", `/api/inbox/${ids.items[0]}/resolve`, {
      decision: "approve",
    });
    expect(resolve.status).toBe(404);
    const asA = await H.call(B, "GET", "/api/runs", undefined, {
      "x-countersign-client": ids.client,
    });
    expect(JSON.stringify(asA.json)).not.toContain(ids.run);
  });

  it("no portal response carries prompts, bundles or cost", async () => {
    for (const path of portalReads()) {
      const res = await ok(OWNER, "GET", path);
      expect(forbiddenKeys(res), path).toEqual([]);
      const body = JSON.stringify(res);
      expect(body, path).not.toContain(instructions.slice(0, 60));
      expect(body, path).not.toContain("claude-opus");
      expect(body, path).not.toMatch(/costUsd|tokensIn|tokensOut/);
    }
  });
});
