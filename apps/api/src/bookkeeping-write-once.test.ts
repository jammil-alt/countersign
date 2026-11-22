// docs/plan.md §1.187: the Bookkeeper's v6 writes one money once, end to end through the API
// against the fakes (QuickBooks, the bank feed's records; no model is asked anything). The client's
// Checking account is set to book and a rule books Stripe and Square payouts to Sales.
//   1. Two signatures: a deposit's write waits for a signature when the bank sends the transaction
//      again; a person books the new copy and signs everything offered. One deposit is written,
//      and the copy is recorded as it.
//   2. A run stops after a deposit's write, before recording it. The next run finds the deposit in
//      QuickBooks by its mark and records it; nothing is written again.

import {
  BANKING_TOOLS,
  ContentStore,
  createBankfeedConnector,
  createQboConnector,
  generateEncryptionKey,
} from "@countersign/connectors";
import {
  FAKE_PLAID,
  FAKE_QBO_CLIENT,
  FAKE_QBO_REALM,
  fakePlaid,
  fakeQbo,
} from "@countersign/connectors/testing";
import {
  agent,
  agentVersion,
  connection,
  externalAction,
  ledgerAccount,
  rawRecord,
  stepRun,
} from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { bankTxn, booking } from "@countersign/pack-bookkeeping";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  allowForAgent,
  createApiHarness,
  FakeWorkflowStep,
  OPERATOR,
} from "./api.test-helper";
import { MemoryQboSyncInstances } from "./qbo/instances";
import { runQboSync } from "./qbo/sync";
import { credentialsFor, executeRun } from "./runs/execute";
import { cloudflareStepRunner } from "./runs/step-runner";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
type J = any;
const j = (v: unknown) => v as J;

const ENCRYPTION_KEY = generateEncryptionKey();
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
    createBankfeedConnector({ ...FAKE_PLAID, fetch: fakePlaid().fetch }),
  ],
  env: {
    ENCRYPTION_KEY,
    OAUTH_STATE_SECRET: "state-secret-".repeat(4),
    APP_ORIGIN: "https://app.mezonas.test",
    QBO_WEBHOOK_VERIFIER: "qbo-verifier",
  },
  qboSync: new MemoryQboSyncInstances(),
});
afterAll(() => h?.close());

/** A step that stops the run (as a worker gone mid-run) when it reaches a named step. */
class StoppingStep extends FakeWorkflowStep {
  constructor(
    onWait: (name: string, type: string) => Promise<unknown>,
    private readonly stopAt: RegExp | null,
  ) {
    super(onWait);
  }
  override async do(
    name: string,
    a: Parameters<FakeWorkflowStep["do"]>[1],
    b?: () => Promise<unknown>,
  ): Promise<unknown> {
    if (this.stopAt?.test(name)) throw new Error(`the worker stopped at ${name}`);
    return super.do(name, a, b);
  }
}

describe.skipIf(!h)("the Bookkeeper v6 writes each money once", () => {
  const H = h as ApiHarness;
  const A = () => H.A.tenantId;
  const act = (name: string, body: unknown) =>
    H.call(OPERATOR, "POST", `/api/ops/clients/${A()}/packs/bookkeeping/actions/${name}`, body);
  const ids = { qbo: "", feed: "", template: "", agentId: "", sales: "" };
  let versions = 0;

  /** A transaction version on Checking as the bank feed's sync stores it. */
  async function feed(t: { id: string; amount: string; date: string; merchantName: string }) {
    await H.t.db.insert(rawRecord).values({
      tenantId: A(),
      connectionId: ids.feed,
      connector: "bankfeed",
      entityType: "Transaction",
      externalId: t.id,
      externalVersion: `v1:${++versions}`,
      payload: {
        id: t.id,
        account: {
          id: "acc-checking",
          name: "Checking",
          mask: "0001",
          type: "depository",
          subtype: "checking",
        },
        amount: { amount: t.amount, currency: "USD" },
        direction: "in",
        date: t.date,
        authorizedDate: null,
        pending: false,
        pendingTransactionId: null,
        merchantName: t.merchantName,
        description: null,
        category: null,
        paymentChannel: null,
      },
    });
  }

  /** The bank dropped a transaction from the feed. */
  async function feedRemoved(id: string) {
    await H.t.db.insert(rawRecord).values({
      tenantId: A(),
      connectionId: ids.feed,
      connector: "bankfeed",
      entityType: "Transaction",
      externalId: id,
      externalVersion: "removed",
      payload: { id, accountId: "acc-checking", removed: true },
      isDeleted: true,
    });
  }

  const inbox = async () => j((await H.call(admin("a"), "GET", "/api/inbox")).json).items as J[];
  const txn = async (externalId: string) => {
    const [row] = await H.t.db
      .select()
      .from(bankTxn)
      .where(and(eq(bankTxn.tenantId, A()), eq(bankTxn.externalId, externalId)));
    if (!row) throw new Error(`no bank_txn ${externalId}`);
    return row;
  };
  const liveOf = async (externalId: string) => {
    const id = (await txn(externalId)).id;
    const rows = await H.t.db.select().from(booking).where(eq(booking.bankTxnId, id));
    return rows.find((b) => ["proposed", "approved", "posted"].includes(b.status)) ?? null;
  };
  const depositsWritten = () =>
    qbo.requests.filter((r) => r.method === "POST" && /\/deposit(\?|$)/.test(r.url));
  const actions = () =>
    H.t.db.select().from(externalAction).where(eq(externalAction.tenantId, A()));

  /** What the person does at each wait: signs every write; books a re-sent copy to Sales. */
  let onSign: (title: string) => Promise<void> = async () => {};
  const signed: string[] = [];
  async function answer(_name: string, type: string): Promise<unknown> {
    const woke = () => H.instances.events.find((e) => e.event.type === type)?.event.payload;
    if (!type.startsWith("inbox-")) throw new Error(`unexpected wait ${type}`);
    const item = (await inbox()).find((i) => `inbox-${i.id.replace(/-/g, "")}` === type);
    if (!item) throw new Error(`no open item for ${type}`);
    if (item.payload?.review === "bookkeeping.bookings") {
      const card = j((await H.call(admin("a"), "GET", `/api/inbox/${item.id}/pack-review`)).json);
      for (const t of card.data.transactions as J[]) {
        const decided = await H.call(admin("a"), "POST", `/api/inbox/${item.id}/pack-review`, {
          action: "book",
          input: { bankTxnId: t.id, lines: [{ ledgerAccountId: ids.sales }] },
        });
        expect(decided.status, JSON.stringify(decided.json)).toBe(200);
      }
    } else {
      await onSign(item.title);
      signed.push(item.title);
    }
    const done = await H.call(admin("a"), "POST", `/api/inbox/${item.id}/resolve`, {
      decision: "approve",
    });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    return woke();
  }

  async function runDaily(stopAt: RegExp | null = null) {
    const res = await H.call(OPERATOR, "POST", `/api/ops/agents/${ids.agentId}/run`, {
      workflow: "daily",
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const params = H.instances.started.get(j(res.json).runId);
    if (!params) throw new Error("not started");
    let result: unknown;
    try {
      result = await executeRun(
        {
          db: H.db,
          platform: H.platform,
          // Rules book every payout here: the model is never asked.
          transport: new FakeModel([]),
          instances: H.instances,
          credentials: credentialsFor(H.db, { current: ENCRYPTION_KEY }),
        },
        params,
        cloudflareStepRunner(new StoppingStep(answer, stopAt)),
      );
    } catch (error) {
      if (!stopAt) throw error;
      result = { stopped: String(error) };
    }
    const steps = await H.t.db.select().from(stepRun).where(eq(stepRun.runId, params.runId));
    return { result, steps, runId: params.runId };
  }

  beforeAll(async () => {
    for (const [Id, Name, AccountType] of [
      ["35", "Checking", "Bank"],
      ["400", "Sales", "Income"],
    ] as const) {
      qbo.put("Account", {
        Id,
        SyncToken: "0",
        Name,
        FullyQualifiedName: Name,
        AccountType,
        Active: true,
      });
    }
    const offered = await H.call(OPERATOR, "PUT", `/api/ops/clients/${A()}/connectors`, {
      offered: ["qbo"],
    });
    expect(offered.status, JSON.stringify(offered.json)).toBe(200);
    const q = await H.call(admin("a"), "POST", "/api/connections/qbo/authorize");
    const qState = new URL(j(q.json).redirectUrl).searchParams.get("state") ?? "";
    const qDone = await H.call(admin("a"), "POST", "/api/connections/qbo/callback", {
      params: { code: "fixture-code", state: qState, realmId: FAKE_QBO_REALM },
    });
    expect(qDone.status, JSON.stringify(qDone.json)).toBe(200);
    ids.qbo = j(qDone.json).connection.connection.id;
    await H.settle();
    await H.t.db.execute(
      sql`update connection set sync_cursor = sync_cursor - 'running' - 'pending' where id = ${ids.qbo}`,
    );
    await runQboSync(
      {
        db: H.db,
        platform: H.platform,
        content: new ContentStore(H.objects),
        credentials: credentialsFor(H.db, { current: ENCRYPTION_KEY }),
      },
      { tenantId: A(), connectionId: ids.qbo, reason: "operator" },
      { do: <T>(_name: string, fn: () => Promise<T>) => fn() },
    );
    const [feedConn] = await H.t.db
      .insert(connection)
      .values({ tenantId: A(), connector: "bankfeed", status: "connected" })
      .returning();
    ids.feed = feedConn?.id ?? "";
    await feed({ id: "st-1", amount: "1250.00", date: "2026-11-04", merchantName: "Stripe" });

    // The area on, the feed read, Checking set to book, a rule for the payouts.
    const enable = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/clients/${A()}/packs/bookkeeping/enable`,
    );
    expect(enable.status, JSON.stringify(enable.json)).toBe(200);
    const imported = await act("import", {});
    expect(imported.status, JSON.stringify(imported.json)).toBe(200);
    const accounts = await H.t.db
      .select()
      .from(ledgerAccount)
      .where(eq(ledgerAccount.tenantId, A()));
    const ledger = (name: string) => accounts.find((a) => a.name === name)?.id ?? "";
    ids.sales = ledger("Sales");
    const report = j(
      (await H.call(OPERATOR, "GET", `/api/ops/clients/${A()}/reports/bookkeeping/transactions`))
        .json,
    ).report;
    const linkId = report.accounts.find((a: J) => a.name === "Checking")?.id as string;
    const linked = await act("link-account", {
      linkId,
      ledgerAccountId: ledger("Checking"),
      mode: "book",
    });
    expect(linked.status, JSON.stringify(linked.json)).toBe(200);
    for (const payee of ["Stripe", "Square"]) {
      const rule = await act("add-rule", { payee, direction: "in", ledgerAccountId: ids.sales });
      expect(rule.status, JSON.stringify(rule.json)).toBe(200);
    }

    // The client's Bookkeeper from the template's v6, QuickBooks bound.
    const [tpl] = await H.t.db
      .select()
      .from(agent)
      .where(and(eq(agent.kind, "template"), eq(agent.slug, "bookkeeper")));
    ids.template = tpl?.id ?? "";
    const [v6] = await H.t.db
      .select({ id: agentVersion.id })
      .from(agentVersion)
      .where(and(eq(agentVersion.agentId, ids.template), eq(agentVersion.version, 6)));
    expect(v6, "the template's v6 is installed").toBeDefined();
    const fork = await H.call(OPERATOR, "POST", `/api/ops/templates/${ids.template}/fork`, {
      clientId: A(),
      slug: "bookkeeper-a",
      versionId: v6?.id,
    });
    expect(fork.status, JSON.stringify(fork.json)).toBe(200);
    ids.agentId = j(fork.json).agent.id;
    const bound = await H.call(OPERATOR, "PATCH", `/api/ops/agents/${ids.agentId}/operation`, {
      bindings: { qbo: ids.qbo },
    });
    expect(bound.status, JSON.stringify(bound.json)).toBe(200);
    await allowForAgent(H, admin("a"), ids.qbo, ids.agentId);
    const pub = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${ids.agentId}/versions/${j(fork.json).version.id}/publish`,
    );
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
    await H.t.db.update(agent).set({ runStatus: "active" }).where(eq(agent.id, ids.agentId));
  });

  it("writes one deposit when the bank sends it again while its write waits, and the person signs both copies", async () => {
    // While the first copy's write waits for its signature, the bank sends the payout again, the
    // next run asks the person about the new copy (they book it), and lays out its write.
    let nested: Awaited<ReturnType<typeof runDaily>> | null = null;
    onSign = async () => {
      if (nested) return;
      await feedRemoved("st-1");
      await feed({ id: "st-2", amount: "1250.00", date: "2026-11-04", merchantName: "Stripe" });
      nested = { result: null, steps: [], runId: "" };
      nested = await runDaily();
    };
    const { result, steps } = await runDaily();
    expect(result, JSON.stringify(steps.map((s) => [s.nodeId, s.status, s.summary]))).toMatchObject(
      {
        status: "succeeded",
      },
    );
    const second = nested as Awaited<ReturnType<typeof runDaily>> | null;
    if (!second) throw new Error("the second run didn't happen");
    // The copy's write was refused right before it, its earlier copy's waiting for a signature.
    const check = second.steps.find((s) => s.nodeId.endsWith("check-deposit"));
    expect(check, JSON.stringify(second.steps.map((s) => [s.nodeId, s.status]))).toMatchObject({
      status: "failed",
    });
    expect(JSON.stringify([check?.output, check?.summary])).toContain(
      "An earlier copy of this transaction is waiting for a signature",
    );
    expect(second.steps.some((s) => s.nodeId.endsWith("write-deposit"))).toBe(false);
    // One deposit in QuickBooks, one write done; the copy is recorded as that write.
    expect(depositsWritten()).toHaveLength(1);
    const writes = await actions();
    expect(writes.map((a) => [a.tool, a.status])).toEqual([[BANKING_TOOLS.depositCreate, "done"]]);
    const qboId = (writes[0]?.result as { id?: string } | null)?.id;
    expect(await liveOf("st-1")).toMatchObject({ status: "posted", qboId });
    expect(await liveOf("st-2")).toMatchObject({
      status: "posted",
      qboEntity: "Deposit",
      qboId,
    });
    expect(signed).toHaveLength(1);
    // The next run writes nothing.
    onSign = async () => {};
    const third = await runDaily();
    expect(third.result).toMatchObject({ status: "succeeded" });
    expect(depositsWritten()).toHaveLength(1);
    expect(await actions()).toHaveLength(1);
  });

  it("records a deposit the stopped run wrote and never recorded, and writes it once", async () => {
    await feed({ id: "sq-1", amount: "310.00", date: "2026-11-06", merchantName: "Square" });
    // The run stops right after the write, before it is recorded.
    await runDaily(/posted-deposit/);
    expect(depositsWritten()).toHaveLength(2);
    const written = (await actions()).filter((a) => a.status === "done");
    expect(written).toHaveLength(2);
    const made = written.find((a) => (a.input as { txnDate?: string }).txnDate === "2026-11-06");
    const qboId = (made?.result as { id?: string } | null)?.id;
    expect(qboId).toBeDefined();
    expect((await liveOf("sq-1"))?.status).not.toBe("posted");
    // The next run finds it in QuickBooks by its mark and records it; nothing is written again.
    const { result, steps } = await runDaily();
    expect(result, JSON.stringify(steps.map((s) => [s.nodeId, s.status, s.summary]))).toMatchObject(
      {
        status: "succeeded",
      },
    );
    expect(steps.find((s) => s.nodeId.endsWith("recorded"))).toMatchObject({
      status: "succeeded",
    });
    expect(depositsWritten()).toHaveLength(2);
    expect(await actions()).toHaveLength(2);
    expect(await liveOf("sq-1")).toMatchObject({ status: "posted", qboEntity: "Deposit", qboId });
    expect((await txn("sq-1")).status).toBe("posted");
  });
});
