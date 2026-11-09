// R-1 (docs/plan.md §1.80): an account's register from QuickBooks' GeneralLedger report, against the
// fake: the opening at the start date, each posting's effect on the account's own balance (a card's
// charge raises what it owes), the closing, and nothing outside the dates.

import { DEFAULT_PERMISSIONS, type JsonObject } from "@countersign/core";
import { describe, expect, it } from "vitest";
import type { ToolContext } from "../connector";
import { memoryCredentials } from "../credentials-accessor";
import { runReadTool } from "../invoke";
import { memoryLogger } from "../logger";
import { FAKE_QBO_CLIENT, FAKE_QBO_REALM, fakeQbo } from "../testing";
import { createQboConnector, QBO_REGISTER_TOOL, readRegister } from "./index";

const NOW = new Date("2026-11-05T18:00:00.000Z");
const tenant = "0190f0c8-0000-7000-8000-000000000001";

async function setup() {
  const qbo = fakeQbo({ now: () => NOW });
  qbo.put("Account", {
    Id: "935",
    SyncToken: "0",
    Name: "Checking",
    FullyQualifiedName: "Checking",
    AccountType: "Bank",
    Active: true,
    OpeningBalance: 1000,
  });
  qbo.put("Account", {
    Id: "941",
    SyncToken: "0",
    Name: "Amex",
    FullyQualifiedName: "Amex",
    AccountType: "Credit Card",
    Active: true,
  });
  const purchase = (
    Id: string,
    TxnDate: string,
    AccountRef: string,
    TotalAmt: number,
    extra = {},
  ) =>
    qbo.put("Purchase", {
      Id,
      SyncToken: "0",
      TxnDate,
      AccountRef: { value: AccountRef },
      PaymentType: "Cash",
      TotalAmt,
      Line: [],
      ...extra,
    });
  purchase("601", "2026-09-28", "935", 100); // before the period
  purchase("602", "2026-10-03", "935", 64, {
    DocNumber: "1042",
    EntityRef: { value: "56", name: "Home Depot" },
  });
  purchase("603", "2026-10-07", "941", 48.1); // a card charge
  purchase("604", "2026-10-09", "941", 12, { Credit: true }); // a card refund
  qbo.put("Deposit", {
    Id: "605",
    SyncToken: "0",
    TxnDate: "2026-10-15",
    DepositToAccountRef: { value: "935" },
    TotalAmt: 1200,
    Line: [],
  });
  qbo.put("Transfer", {
    Id: "606",
    SyncToken: "0",
    TxnDate: "2026-10-20",
    FromAccountRef: { value: "935" },
    ToAccountRef: { value: "941" },
    Amount: 36.1,
  });
  purchase("607", "2026-11-02", "935", 9); // after the period
  const connector = createQboConnector({
    ...FAKE_QBO_CLIENT,
    environment: "sandbox",
    fetch: qbo.fetch,
    sleep: async () => {},
    now: () => NOW,
  });
  const grant = await connector.handleCallback?.(
    { code: "fixture-code", realmId: FAKE_QBO_REALM, state: "x" },
    {
      tenantId: tenant,
      userId: "0190f0c8-0000-7000-8000-0000000000a1",
      redirectUri: "https://x.example/cb",
    },
  );
  if (!grant) throw new Error("no grant");
  const ctx: ToolContext = {
    tenantId: tenant,
    connection: {
      id: "0190f0c8-0000-7000-8000-0000000000c1",
      tenantId: tenant,
      connector: "qbo",
      status: "connected",
      externalAccountId: FAKE_QBO_REALM,
      config: {},
      permissions: DEFAULT_PERMISSIONS,
    },
    credentials: memoryCredentials(grant.credentials as JsonObject),
    logger: memoryLogger(),
    now: () => NOW,
  };
  const read = async (input: unknown) =>
    // biome-ignore lint/suspicious/noExplicitAny: outputs are read loosely in tests.
    (await runReadTool(connector, QBO_REGISTER_TOOL, input, ctx)).output as any;
  return { read };
}

describe("qbo.account.register", () => {
  it("reads a bank account's month: opening, postings, closing", async () => {
    const s = await setup();
    const r = await s.read({ accountId: "935", startDate: "2026-10-01", endDate: "2026-10-31" });
    expect(r).toMatchObject({
      accountName: "Checking",
      accountType: "Bank",
      opening: "900.0000",
      closing: "1999.9000",
    });
    expect(
      r.items.map((i: { id: string; effect: string; reference: string | null }) => [
        i.id,
        i.effect,
        i.reference,
      ]),
    ).toEqual([
      ["qbo:Expense:602", "-64.0000", "1042"],
      ["qbo:Deposit:605", "1200.0000", null],
      ["qbo:Transfer:606", "-36.1000", null],
    ]);
    expect(r.items[0].description).toBe("Home Depot");
    expect(r.sources).toEqual(["qbo:Expense:602", "qbo:Deposit:605", "qbo:Transfer:606"]);
  });

  it("signs a card account as what it owes: a charge up, a refund and a payment down", async () => {
    const s = await setup();
    const r = await s.read({ accountId: "941", startDate: "2026-10-01", endDate: "2026-10-31" });
    expect(r.items.map((i: { effect: string }) => i.effect)).toEqual([
      "48.1000",
      "-12.0000",
      "-36.1000",
    ]);
    expect(r).toMatchObject({ opening: "0.0000", closing: "0.0000" });
  });

  it("refuses dates the wrong way round and an unknown account", async () => {
    const s = await setup();
    await expect(
      s.read({ accountId: "935", startDate: "2026-10-31", endDate: "2026-10-01" }),
    ).rejects.toThrow();
    await expect(
      s.read({ accountId: "9999", startDate: "2026-10-01", endDate: "2026-10-31" }),
    ).rejects.toThrow("not in QuickBooks");
  });
});

describe("readRegister", () => {
  it("keeps the last running balance as the closing, and an empty report as zeros", () => {
    expect(readRegister({})).toEqual({ opening: "0.0000", closing: "0.0000", items: [] });
  });
});
