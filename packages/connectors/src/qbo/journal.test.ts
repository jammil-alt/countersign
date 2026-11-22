// docs/plan.md §1.232 (the Close pack): a journal entry in QuickBooks, against the fake.

import { DEFAULT_PERMISSIONS, type JsonObject } from "@countersign/core";
import { describe, expect, it } from "vitest";
import type { ToolContext, WriteContext } from "../connector";
import { memoryCredentials } from "../credentials-accessor";
import { captureBefore, executeWrite } from "../invoke";
import { memoryLogger } from "../logger";
import { FAKE_QBO_CLIENT, FAKE_QBO_REALM, fakeQbo } from "../testing";
import { createQboConnector, JOURNAL_TOOLS, journalProblem, referenceMark } from "./index";

const NOW = new Date("2026-11-05T18:00:00.000Z");
const tenant = "0190f0c8-0000-7000-8000-000000000001";
const user = "0190f0c8-0000-7000-8000-0000000000a1";
const connectionId = "0190f0c8-0000-7000-8000-0000000000c1";
const REDIRECT = "https://staging.mezonas.com/api/connections/qbo/callback";
const RENT = "62";
const ACCRUED = "2100";

async function setup() {
  const qbo = fakeQbo({ now: () => NOW });
  for (const [Id, Name, AccountType] of [
    ["62", "Rent", "Expense"],
    ["2100", "Accrued Liabilities", "Other Current Liability"],
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

const accrual = {
  txnDate: "2026-10-31",
  expectedTotal: "1250.00",
  privateNote: "Accrued rent, October",
  reference: "ce-0190f0c8",
  lines: [
    { accountId: RENT, posting: "debit" as const, amount: "1250.00", description: "Rent" },
    { accountId: ACCRUED, posting: "credit" as const, amount: "1250.00" },
  ],
};

describe("qbo.journal.create", () => {
  it("records a balanced entry once after approval, its accounts named on the card", async () => {
    const s = await setup();
    const proposed = await captureBefore(s.connector, JOURNAL_TOOLS.create, accrual, s.propose());
    expect(proposed.before).toEqual({
      names: { accounts: { [RENT]: "Rent", [ACCRUED]: "Accrued Liabilities" } },
    });
    const first = await executeWrite(s.connector, JOURNAL_TOOLS.create, accrual, s.ctx());
    expect(first.output).toMatchObject({ total: "1250.0000", alreadyDone: false });
    const id = (first.output as { id: string }).id;
    expect(s.qbo.get("JournalEntry", id)).toMatchObject({
      TxnDate: "2026-10-31",
      PrivateNote: `Accrued rent, October ${referenceMark("ce-0190f0c8")}`,
      Line: [
        {
          Amount: 1250,
          JournalEntryLineDetail: { PostingType: "Debit", AccountRef: { value: RENT } },
        },
        {
          Amount: 1250,
          JournalEntryLineDetail: { PostingType: "Credit", AccountRef: { value: ACCRUED } },
        },
      ],
    });
    // The same action again (a lost answer): found by its mark, reported done.
    const again = await executeWrite(s.connector, JOURNAL_TOOLS.create, accrual, s.ctx());
    expect(again.output).toMatchObject({ id, alreadyDone: true });
    // Proposed again after it was written: refused.
    expect(
      await refusal(captureBefore(s.connector, JOURNAL_TOOLS.create, accrual, s.propose())),
    ).toContain("already in QuickBooks");
  });

  it("refuses an entry that doesn't balance or isn't the total expected", async () => {
    const s = await setup();
    const lopsided = {
      ...accrual,
      lines: [
        { accountId: RENT, posting: "debit" as const, amount: "1250.00" },
        { accountId: ACCRUED, posting: "credit" as const, amount: "1200.00" },
      ],
    };
    expect(
      await refusal(captureBefore(s.connector, JOURNAL_TOOLS.create, lopsided, s.propose())),
    ).toContain("don't balance");
    expect(journalProblem(accrual.lines, "1000.00")).toContain("not the 1000.00 expected");
    expect(journalProblem(accrual.lines, "1250")).toBeNull();
  });

  it("refuses one someone already entered on the same day for the same total", async () => {
    const s = await setup();
    s.qbo.put("JournalEntry", {
      Id: "901",
      SyncToken: "0",
      TxnDate: "2026-10-31",
      PrivateNote: "Rent accrual (by hand)",
      Line: [
        {
          Amount: 1250,
          JournalEntryLineDetail: { PostingType: "Debit", AccountRef: { value: RENT } },
        },
        {
          Amount: 1250,
          JournalEntryLineDetail: { PostingType: "Credit", AccountRef: { value: ACCRUED } },
        },
      ],
    });
    expect(
      await refusal(captureBefore(s.connector, JOURNAL_TOOLS.create, accrual, s.propose())),
    ).toContain("same day and total");
  });

  it("refuses an account that isn't the company's", async () => {
    const s = await setup();
    const unknown = {
      ...accrual,
      lines: [
        { accountId: "999", posting: "debit" as const, amount: "1250.00" },
        { accountId: ACCRUED, posting: "credit" as const, amount: "1250.00" },
      ],
    };
    expect(
      await refusal(captureBefore(s.connector, JOURNAL_TOOLS.create, unknown, s.propose())),
    ).toContain("isn't one of this company's active accounts");
  });
});
