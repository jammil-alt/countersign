// R-1 (docs/plan.md §1.80, M57): the Bookkeeper's monthly reconciliation end to end through the API
// against the fakes (QuickBooks, Plaid, a FakeModel; nothing live). The client's checking account is
// on the bank feed and in QuickBooks; October in QuickBooks has a deposit the bank only shows on
// November 2nd. The monthly workflow reads the feed's balances, reads QuickBooks' register for
// October, reconciles them (explained by the deposit in transit), the model suggests nothing more,
// and the client signs it off on the card. November's run carries the deposit in, where it clears:
// balanced, and nobody is asked. Another client sees nothing; the portal carries no prompt or cost.

import {
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
  fakePlaidTransaction,
  fakeQbo,
} from "@countersign/connectors/testing";
import { agent, ledgerAccount, stepRun, withTenant } from "@countersign/db";
import { FakeModel, type LlmRequest } from "@countersign/llm";
import { reconciliation, reconciliationItem } from "@countersign/pack-bookkeeping";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  FakeWorkflowStep,
  forbiddenKeys,
  OPERATOR,
} from "./api.test-helper";
import { BANKFEED_CRON_MINUTE, bankfeedCron } from "./bankfeed/sync";
import { MemoryQboSyncInstances } from "./qbo/instances";
import { runQboSync } from "./qbo/sync";
import { credentialsFor, executeRun } from "./runs/execute";
import { cloudflareStepRunner } from "./runs/step-runner";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
type J = any;
const j = (v: unknown) => v as J;

const ENCRYPTION_KEY = generateEncryptionKey();
const qbo = fakeQbo();
const plaid = fakePlaid();
const CHECKING = "chk0000000000000000000000000000000000001";

const h = await createApiHarness({
  connectors: () => [
    createQboConnector({
      ...FAKE_QBO_CLIENT,
      environment: "sandbox",
      webhookVerifier: "qbo-verifier",
      fetch: qbo.fetch,
      sleep: async () => {},
    }),
    createBankfeedConnector({ ...FAKE_PLAID, fetch: plaid.fetch }),
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
afterEach(() => vi.useRealTimers());

describe.skipIf(!h)("the Bookkeeper reconciles a month", () => {
  const H = h as ApiHarness;
  const A = () => H.A.tenantId;
  const act = (name: string, body: unknown) =>
    H.call(OPERATOR, "POST", `/api/ops/clients/${A()}/packs/bookkeeping/actions/${name}`, body);
  const ids = { qbo: "", feed: "", template: "", agentId: "", checkingLink: "" };
  const asked: J[] = [];

  const inbox = async () => j((await H.call(admin("a"), "GET", "/api/inbox")).json).items as J[];

  /** The client checks the reconciliation on its card and signs it off. */
  const waits = async (_name: string, type: string) => {
    const woke = () => H.instances.events.find((e) => e.event.type === type)?.event.payload;
    if (!type.startsWith("inbox-")) throw new Error(`unexpected wait ${type}`);
    const item = (await inbox()).find((i) => `inbox-${i.id.replace(/-/g, "")}` === type);
    if (!item) throw new Error(`no open item for ${type}`);
    expect(item.payload?.review).toBe("bookkeeping.reconciliation");
    const card = j((await H.call(admin("a"), "GET", `/api/inbox/${item.id}/pack-review`)).json);
    expect(forbiddenKeys(card)).toEqual([]);
    asked.push({ title: item.title, card: card.data.reconciliation });
    const signed = await H.call(admin("a"), "POST", `/api/inbox/${item.id}/pack-review`, {
      action: "sign_off",
      input: { note: "The Smith deposit reached the bank on November 2nd" },
    });
    expect(signed.status, JSON.stringify(signed.json)).toBe(200);
    const done = await H.call(admin("a"), "POST", `/api/inbox/${item.id}/resolve`, {
      decision: "approve",
    });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    return woke();
  };

  /** The model: reads what is left and suggests nothing (the deposit in transit is timing). */
  function brain(r: LlmRequest) {
    const tools = (r.tools ?? []).map((t) => (t as { name: string }).name);
    if (!tools.includes("bookkeeping__reconcile__propose")) {
      throw new Error(`unexpected call: ${tools}`);
    }
    // The task input (the first message) names the reconciliation.
    const id = JSON.stringify(r.messages[0]).match(
      /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/,
    )?.[0];
    if (!JSON.stringify(r.messages).includes('"name":"bookkeeping__reconcile__open"')) {
      return { toolUse: { name: "bookkeeping__reconcile__open", input: { reconciliationId: id } } };
    }
    return { toolUse: { name: "finish", input: { proposed: 0, sources: [id] } } };
  }

  async function runMonthly(today: string, model: FakeModel) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${today}T14:00:00Z`));
    const res = await H.call(OPERATOR, "POST", `/api/ops/agents/${ids.agentId}/run`, {
      workflow: "reconcile-monthly",
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const params = H.instances.started.get(j(res.json).runId);
    if (!params) throw new Error("not started");
    const result = await executeRun(
      {
        db: H.db,
        platform: H.platform,
        transport: model,
        instances: H.instances,
        credentials: credentialsFor(H.db, { current: ENCRYPTION_KEY }),
      },
      params,
      // Each run is its own Workflow instance, with its own step results.
      cloudflareStepRunner(new FakeWorkflowStep(waits)),
    );
    const steps = await H.t.db.select().from(stepRun).where(eq(stepRun.runId, params.runId));
    return { result, steps };
  }

  beforeAll(async () => {
    // QuickBooks: the checking account opened at $10,000; October has a deposit, a cheque and the
    // Smith deposit entered on the 31st; November a fuel purchase.
    qbo.put("Account", {
      Id: "935",
      SyncToken: "0",
      Name: "Checking",
      FullyQualifiedName: "Checking",
      AccountType: "Bank",
      Active: true,
      OpeningBalance: 10000,
    });
    for (const [Id, Name, AccountType] of [
      ["86", "Fuel", "Expense"],
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
    const deposit = (Id: string, TxnDate: string, TotalAmt: number) =>
      qbo.put("Deposit", {
        Id,
        SyncToken: "0",
        TxnDate,
        TotalAmt,
        DepositToAccountRef: { value: "935", name: "Checking" },
        Line: [],
      });
    const purchase = (Id: string, TxnDate: string, TotalAmt: number, DocNumber?: string) =>
      qbo.put("Purchase", {
        Id,
        SyncToken: "0",
        TxnDate,
        TotalAmt,
        ...(DocNumber ? { DocNumber } : {}),
        PaymentType: "Check",
        AccountRef: { value: "935", name: "Checking" },
        Line: [],
      });
    deposit("901", "2026-10-04", 500);
    purchase("902", "2026-10-20", 120, "1042");
    deposit("903", "2026-10-31", 250);
    purchase("904", "2026-11-02", 50);

    const offered = await H.call(OPERATOR, "PUT", `/api/ops/clients/${A()}/connectors`, {
      offered: ["qbo", "bankfeed"],
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

    // The bank feed: the client signs in to its bank in Plaid Link. Today's balance is $10,580:
    // October's +500 and −120, then November's +250 and −50 on the 2nd.
    const start = await H.call(admin("a"), "POST", "/api/connections/bankfeed/authorize");
    const { link } = j(start.json);
    const publicToken = plaid.issuePublicToken({
      accounts: [
        {
          account_id: CHECKING,
          name: "Business Checking",
          official_name: null,
          mask: "0000",
          type: "depository",
          subtype: "checking",
          balances: {
            available: 10580,
            current: 10580,
            limit: null,
            iso_currency_code: "USD",
            unofficial_currency_code: null,
          },
        },
      ],
    });
    const done = await H.call(admin("a"), "POST", "/api/connections/bankfeed/callback", {
      params: { public_token: publicToken, state: link.state },
    });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    ids.feed = j(done.json).connection.connection.id;
    const itemId = plaid.itemOf(publicToken)?.itemId ?? "";
    const on = (id: string, amount: number, date: string, name: string) =>
      fakePlaidTransaction(id, {
        amount,
        account_id: CHECKING,
        date,
        name,
        merchant_name: null,
      });
    plaid.add(
      itemId,
      on("o-1", -500, "2026-10-05", "DEPOSIT"),
      on("o-2", 120, "2026-10-21", "CHECK 1042"),
      on("n-1", -250, "2026-11-02", "DEPOSIT SMITH"),
      on("n-2", 50, "2026-11-02", "SHELL 5741"),
    );
    await bankfeedCron(
      H.env,
      { db: H.db, instances: H.instances, platform: H.platform },
      new Date(Date.UTC(2026, 10, 6, 15, BANKFEED_CRON_MINUTE)),
    );
  });

  it("switches the area on, links the checking account and forks the Bookkeeper", async () => {
    const enable = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/clients/${A()}/packs/bookkeeping/enable`,
    );
    expect(enable.status, JSON.stringify(enable.json)).toBe(200);
    const imported = await act("import", {});
    expect(imported.status, JSON.stringify(imported.json)).toBe(200);
    expect(j(imported.json).result).toMatchObject({ added: 4, accounts: 1 });
    const report = j(
      (await H.call(OPERATOR, "GET", `/api/ops/clients/${A()}/reports/bookkeeping/transactions`))
        .json,
    ).report;
    ids.checkingLink = report.accounts[0]?.id;
    const [checking] = await H.t.db
      .select()
      .from(ledgerAccount)
      .where(and(eq(ledgerAccount.tenantId, A()), eq(ledgerAccount.externalId, "935")));
    const linked = await act("link-account", {
      linkId: ids.checkingLink,
      ledgerAccountId: checking?.id,
      mode: "suggest",
    });
    expect(linked.status, JSON.stringify(linked.json)).toBe(200);

    const [tpl] = await H.t.db
      .select()
      .from(agent)
      .where(and(eq(agent.kind, "template"), eq(agent.slug, "bookkeeper")));
    const fork = await H.call(OPERATOR, "POST", `/api/ops/templates/${tpl?.id}/fork`, {
      clientId: A(),
      slug: "bookkeeper-a",
    });
    expect(fork.status, JSON.stringify(fork.json)).toBe(200);
    ids.agentId = j(fork.json).agent.id;
    const bound = await H.call(OPERATOR, "PATCH", `/api/ops/agents/${ids.agentId}/operation`, {
      bindings: { qbo: ids.qbo, bankfeed: ids.feed },
    });
    expect(bound.status, JSON.stringify(bound.json)).toBe(200);
    const pub = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${ids.agentId}/versions/${j(fork.json).version.id}/publish`,
    );
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
    await H.t.db.update(agent).set({ runStatus: "active" }).where(eq(agent.id, ids.agentId));
  });

  it("reconciles October: explained by a deposit in transit, which the client signs off", async () => {
    const { result, steps } = await runMonthly(
      "2026-11-03",
      new FakeModel(Array.from({ length: 4 }, () => brain)),
    );
    expect(result, JSON.stringify(steps.map((s) => [s.nodeId, s.status, s.output]))).toMatchObject({
      status: "succeeded",
    });
    expect(asked).toHaveLength(1);
    // The card leads with the numbers: the bank as of October 31st, QuickBooks, the difference.
    expect(asked[0].title).toBe(
      "Business Checking …0000 $10,380.00, QuickBooks $10,630.00, difference −$250.00: 1 item left: QuickBooks $250.00 on 2026-10-31 (timing).",
    );
    expect(asked[0].card).toMatchObject({
      outcome: "explained",
      residual: "0.0000",
      periodStart: "2026-10-01",
      asOf: "2026-10-31",
    });
    const [october] = await H.t.db
      .select()
      .from(reconciliation)
      .where(and(eq(reconciliation.tenantId, A()), eq(reconciliation.asOf, "2026-10-31")));
    expect(october).toMatchObject({ status: "signed_off", note: expect.stringContaining("Smith") });
    expect(october?.agentVersionId).not.toBeNull();
    // Cited: the feed's records and QuickBooks' postings.
    expect(october?.sources).toEqual(
      expect.arrayContaining(["qbo:Deposit:901", "qbo:Expense:902", "qbo:Deposit:903"]),
    );
  });

  it("reconciles November: the deposit carried in clears, balanced, and nobody is asked", async () => {
    const { result, steps } = await runMonthly("2026-12-03", new FakeModel([]));
    expect(result, JSON.stringify(steps.map((s) => [s.nodeId, s.status, s.output]))).toMatchObject({
      status: "succeeded",
    });
    expect(asked).toHaveLength(1);
    const [november] = await H.t.db
      .select()
      .from(reconciliation)
      .where(and(eq(reconciliation.tenantId, A()), eq(reconciliation.asOf, "2026-11-30")));
    expect(november).toMatchObject({ outcome: "balanced", residual: "0.0000", status: "open" });
    const carried = await H.t.db
      .select()
      .from(reconciliationItem)
      .where(
        and(
          eq(reconciliationItem.reconciliationId, november?.id ?? ""),
          eq(reconciliationItem.carried, true),
        ),
      );
    expect(carried.map((c) => [c.ref, c.state])).toEqual([["qbo:Deposit:903", "matched"]]);
  });

  it("shows the client its reconciliations with no prompt, model or cost; another client sees none", async () => {
    const portal = await H.call(admin("a"), "GET", "/api/reports/bookkeeping/reconciliations");
    expect(portal.status, JSON.stringify(portal.json)).toBe(200);
    expect(forbiddenKeys(portal.json)).toEqual([]);
    expect(
      j(portal.json).report.reconciliations.map((r: J) => [r.asOf, r.outcome, r.status]),
    ).toEqual([
      ["2026-11-30", "balanced", "open"],
      ["2026-10-31", "explained", "signed_off"],
    ]);
    await withTenant(H.db, H.B.tenantId, async (tx) => {
      expect(await tx.select().from(reconciliation)).toEqual([]);
      expect(await tx.select().from(reconciliationItem)).toEqual([]);
    });
    const other = await H.call(admin("b"), "GET", "/api/reports/bookkeeping/reconciliations");
    expect(other.status).not.toBe(200);
  });
});
