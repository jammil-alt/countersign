// B-4 (docs/plan.md §1.79): booking bank transactions in QuickBooks, against the fake.

import { DEFAULT_PERMISSIONS, type JsonObject } from "@countersign/core";
import { describe, expect, it } from "vitest";
import type { ToolContext, WriteContext } from "../connector";
import { memoryCredentials } from "../credentials-accessor";
import { captureBefore, executeWrite } from "../invoke";
import { memoryLogger } from "../logger";
import { FAKE_QBO_CLIENT, FAKE_QBO_REALM, fakeQbo } from "../testing";
import { BANKING_TOOLS, createQboConnector, referenceMark } from "./index";

const NOW = new Date("2026-11-05T18:00:00.000Z");
const tenant = "0190f0c8-0000-7000-8000-000000000001";
const user = "0190f0c8-0000-7000-8000-0000000000a1";
const connectionId = "0190f0c8-0000-7000-8000-0000000000c1";
const REDIRECT = "https://staging.mezonas.com/api/connections/qbo/callback";
const CHECKING = "35";
const CARD = "41";
const SAVINGS = "36";

async function setup() {
  const qbo = fakeQbo({ now: () => NOW });
  for (const [Id, Name, AccountType] of [
    [CHECKING, "Checking", "Bank"],
    [SAVINGS, "Savings", "Bank"],
    [CARD, "Amex", "Credit Card"],
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
  const connector = createQboConnector({
    ...FAKE_QBO_CLIENT,
    environment: "sandbox",
    fetch: qbo.fetch,
    sleep: async () => {},
    now: () => NOW,
  });
  const grant = await connector.handleCallback?.(
    { code: "fixture-code", realmId: FAKE_QBO_REALM, state: "x" },
    { tenantId: tenant, userId: user, redirectUri: REDIRECT },
  );
  if (!grant) throw new Error("no grant");
  const store = memoryCredentials(grant.credentials as JsonObject);
  const ctx = (key = "run-1:step-1:0"): WriteContext => ({
    tenantId: tenant,
    connection: {
      id: connectionId,
      tenantId: tenant,
      connector: "qbo",
      status: "connected",
      externalAccountId: FAKE_QBO_REALM,
      config: {},
      permissions: DEFAULT_PERMISSIONS,
    },
    credentials: store,
    logger: memoryLogger(),
    now: () => NOW,
    idempotencyKey: key,
  });
  const propose = (): ToolContext => {
    const { idempotencyKey: _key, ...rest } = ctx();
    return rest;
  };
  return { qbo, connector, ctx, propose };
}

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("it was not refused");
}

const charge = {
  accountId: CARD,
  paymentType: "CreditCard" as const,
  vendorId: "56",
  txnDate: "2026-11-03",
  expectedTotal: "48.10",
  privateNote: "Glue and blades",
  reference: "bk-0190f0c8",
  lines: [{ accountId: "84", amount: "48.10", description: "Shop supplies" }],
};

describe("qbo.purchase.create", () => {
  it("books a card charge once after approval, its card named on the card; a retry writes nothing again", async () => {
    const s = await setup();
    const proposed = await captureBefore(
      s.connector,
      BANKING_TOOLS.purchaseCreate,
      charge,
      s.propose(),
    );
    expect(proposed.before).toEqual({
      account: { id: CARD, name: "Amex" },
      names: { accounts: { "84": "Shop Supplies" } },
    });
    const first = await executeWrite(s.connector, BANKING_TOOLS.purchaseCreate, charge, s.ctx());
    expect(first.output).toMatchObject({ total: "48.1000", alreadyDone: false });
    const id = (first.output as { id: string }).id;
    const stored = s.qbo.get("Purchase", id);
    expect(stored).toMatchObject({
      AccountRef: { value: CARD },
      PaymentType: "CreditCard",
      EntityRef: { value: "56", type: "Vendor" },
      TxnDate: "2026-11-03",
      PrivateNote: `Glue and blades ${referenceMark("bk-0190f0c8")}`,
    });
    // The same action again (a lost answer): found by its reference, reported done.
    const again = await executeWrite(s.connector, BANKING_TOOLS.purchaseCreate, charge, s.ctx());
    expect(again.output).toMatchObject({ id, alreadyDone: true });
    // Proposed again after it was written: refused, it is already there.
    expect(
      await refusal(captureBefore(s.connector, BANKING_TOOLS.purchaseCreate, charge, s.propose())),
    ).toContain("already in QuickBooks");
  });

  it("refuses a purchase someone already entered for the same card, day and amount", async () => {
    const s = await setup();
    s.qbo.put("Purchase", {
      Id: "77",
      SyncToken: "0",
      AccountRef: { value: CARD },
      PaymentType: "CreditCard",
      TxnDate: "2026-11-03",
      TotalAmt: 48.1,
      Line: [],
    });
    expect(
      await refusal(captureBefore(s.connector, BANKING_TOOLS.purchaseCreate, charge, s.propose())),
    ).toContain("match it instead");
    expect(
      await refusal(executeWrite(s.connector, BANKING_TOOLS.purchaseCreate, charge, s.ctx())),
    ).toContain("(77)");
  });

  it("refuses lines that don't add up, item lines, an account that isn't a card, and an unknown account", async () => {
    const s = await setup();
    const try_ = (over: object) =>
      refusal(
        captureBefore(
          s.connector,
          BANKING_TOOLS.purchaseCreate,
          { ...charge, ...over },
          s.propose(),
        ),
      );
    expect(await try_({ expectedTotal: "50.00" })).toContain("add up to 48.10");
    expect(await try_({ accountId: CHECKING })).toContain("isn't a card account");
    expect(await try_({ accountId: "84" })).toContain("isn't a bank or card account");
    expect(await try_({ lines: [{ accountId: "9999", amount: "48.10" }] })).toContain(
      "isn't one of this company's active accounts",
    );
    expect(
      await try_({ lines: [{ itemId: "21", qty: "1", unitPrice: "48.10", amount: "48.10" }] }),
    ).toContain("account lines only");
  });

  it("books a card refund as a credit", async () => {
    const s = await setup();
    const refund = { ...charge, credit: true, reference: "bk-refund-1" };
    const out = await executeWrite(s.connector, BANKING_TOOLS.purchaseCreate, refund, s.ctx());
    expect(s.qbo.get("Purchase", (out.output as { id: string }).id)?.Credit).toBe(true);
  });
});

describe("qbo.deposit.create", () => {
  const deposit = {
    accountId: CHECKING,
    txnDate: "2026-11-04",
    expectedTotal: "1200.00",
    reference: "bk-dep-1",
    lines: [{ accountId: "400", amount: "1200.00", description: "Kitchen job, final payment" }],
  };

  it("books money in to the bank from income, once", async () => {
    const s = await setup();
    const proposed = await captureBefore(
      s.connector,
      BANKING_TOOLS.depositCreate,
      deposit,
      s.propose(),
    );
    expect(proposed.before).toMatchObject({ account: { id: CHECKING, name: "Checking" } });
    const out = await executeWrite(s.connector, BANKING_TOOLS.depositCreate, deposit, s.ctx());
    const row = s.qbo.get("Deposit", (out.output as { id: string }).id);
    expect(row).toMatchObject({
      DepositToAccountRef: { value: CHECKING },
      TotalAmt: 1200,
      Line: [
        {
          Amount: 1200,
          DetailType: "DepositLineDetail",
          DepositLineDetail: { AccountRef: { value: "400" } },
        },
      ],
    });
    const again = await executeWrite(s.connector, BANKING_TOOLS.depositCreate, deposit, s.ctx());
    expect(again.output).toMatchObject({ alreadyDone: true });
  });
});

describe("qbo.transfer.create", () => {
  const payment = {
    fromAccountId: CHECKING,
    toAccountId: CARD,
    amount: "500.00",
    txnDate: "2026-11-02",
    reference: "bk-xfer-1",
  };

  it("books a card payment from the bank as a transfer, once", async () => {
    const s = await setup();
    const proposed = await captureBefore(
      s.connector,
      BANKING_TOOLS.transferCreate,
      payment,
      s.propose(),
    );
    expect(proposed.before).toEqual({
      from: { id: CHECKING, name: "Checking" },
      to: { id: CARD, name: "Amex" },
    });
    const out = await executeWrite(s.connector, BANKING_TOOLS.transferCreate, payment, s.ctx());
    expect(s.qbo.get("Transfer", (out.output as { id: string }).id)).toMatchObject({
      FromAccountRef: { value: CHECKING },
      ToAccountRef: { value: CARD },
      Amount: 500,
    });
    const again = await executeWrite(s.connector, BANKING_TOOLS.transferCreate, payment, s.ctx());
    expect(again.output).toMatchObject({ alreadyDone: true });
  });

  it("refuses a transfer to the same account", async () => {
    const s = await setup();
    expect(
      await refusal(
        captureBefore(
          s.connector,
          BANKING_TOOLS.transferCreate,
          { ...payment, toAccountId: CHECKING },
          s.propose(),
        ),
      ),
    ).toContain("two different accounts");
  });
});
