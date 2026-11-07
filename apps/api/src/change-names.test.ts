// QA round 1 (Q-B 3): a QuickBooks bill's line booked to an account the change's before state
// doesn't name ("#20") reads by its name on the client's card, found in the connection's synced
// records; never another client's records, and the before state's own names come first.
import { createQboConnector } from "@countersign/connectors";
import { inboxItem, rawRecord } from "@countersign/db";
import { afterAll, describe, expect, it } from "vitest";
import { admin, createApiHarness } from "./api.test-helper";
import { unnamedIds } from "./change-names";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const qbo = createQboConnector({ environment: "sandbox" });
const display = qbo.manifest.tools.find((t) => t.id === "qbo.bill.update_lines")?.display;
if (!display) throw new Error("qbo.bill.update_lines declares no display");

const beforeState = (account: Record<string, unknown>, names = {}) => ({
  docNumber: "20418",
  vendor: { id: "58", name: "Northline Panel Supply" },
  txnDate: "2026-10-28",
  total: "9742.3500",
  currency: "USD",
  lines: [{ id: "1", description: "Northline invoice 20418", amount: "9742.35", account }],
  names: { items: {}, accounts: {}, ...names },
});
const input = {
  id: "146",
  replaceLineIds: ["1"],
  lines: [{ accountId: "20", description: "Panels", amount: "9742.35" }],
};

describe("unnamedIds", () => {
  it("lists ids no line and no before name covers", () => {
    const got = unnamedIds(display, beforeState({ id: "20" }), [input]);
    expect([...(got.get("accounts") ?? [])]).toEqual(["20"]);
  });

  it("needs nothing when the before state names the id or the line names it", () => {
    expect(
      unnamedIds(display, beforeState({ id: "20" }, { accounts: { "20": "Job" } }), [input]).size,
    ).toBe(0);
    const named = { ...input, lines: [{ account: { id: "20", name: "Job" }, amount: "1.00" }] };
    expect(unnamedIds(display, beforeState({ id: "20", name: "Job" }), [named]).size).toBe(0);
  });
});

const h = await createApiHarness({
  connectors: () => [createQboConnector({ environment: "sandbox" })],
});
afterAll(() => h?.close());

describe.skipIf(!h)("portal inbox names", () => {
  const H = h as NonNullable<typeof h>;

  it("names an unnamed account from the client's own synced bills, never another client's", async () => {
    const line = (name: string) => ({
      Line: [
        {
          DetailType: "AccountBasedExpenseLineDetail",
          Amount: 10,
          AccountBasedExpenseLineDetail: { AccountRef: { value: "20", name } },
        },
      ],
    });
    // Client B has a synced bill booked to account 20 under another name; client A has its own.
    await H.t.db.insert(rawRecord).values([
      {
        tenantId: H.B.tenantId,
        connectionId: H.B.connectionId,
        connector: "qbo",
        entityType: "Bill",
        externalId: "900",
        externalVersion: "0",
        payload: line("B's secret account"),
      },
      {
        tenantId: H.A.tenantId,
        connectionId: H.A.connectionId,
        connector: "qbo",
        entityType: "Bill",
        externalId: "146",
        externalVersion: "0",
        payload: line("Job Expenses:Job Materials"),
      },
    ]);
    const [item] = await H.t.db
      .insert(inboxItem)
      .values({
        tenantId: H.A.tenantId,
        kind: "external_action",
        title: "QuickBooks bill",
        assigneeRole: "client_admin",
        payload: {
          tool: "qbo.bill.update_lines",
          connectionId: H.A.connectionId,
          input,
          before: beforeState({ id: "20" }),
        },
      })
      .returning();
    const res = await H.call(admin("a"), "GET", "/api/inbox?status=open");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const got = j(res.json).items.find((i: { id: string }) => i.id === item?.id);
    expect(got.display).toMatchObject({
      connectorName: "QuickBooks Online",
      names: { accounts: { "20": "Job Expenses:Job Materials" } },
    });
    expect(JSON.stringify(res.json)).not.toContain("B's secret account");

    // An id the before state names needs no lookup: the view carries no names.
    const [named] = await H.t.db
      .insert(inboxItem)
      .values({
        tenantId: H.A.tenantId,
        kind: "external_action",
        title: "QuickBooks bill",
        assigneeRole: "client_admin",
        payload: {
          tool: "qbo.bill.update_lines",
          connectionId: H.A.connectionId,
          input,
          before: beforeState({ id: "20" }, { accounts: { "20": "Job Materials" } }),
        },
      })
      .returning();
    const again = await H.call(admin("a"), "GET", "/api/inbox?status=open");
    const plain = j(again.json).items.find((i: { id: string }) => i.id === named?.id);
    expect(plain.display.names).toBeUndefined();
  });
});
