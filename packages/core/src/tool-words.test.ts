// S5.6 (overnight fixes, 2026-11-23): a read tool's id in words, never "Query purchaseorder".
import { describe, expect, it } from "vitest";
import { seatLabelOf } from "./reach/rules";
import { entityPlural, readToolWords } from "./tool-words";

describe("read tools in words", () => {
  it("names finds, lists and reads", () => {
    expect(readToolWords("qbo.purchaseorder.query")).toBe("Find purchase orders");
    expect(readToolWords("qbo.bill.query")).toBe("Find bills");
    expect(readToolWords("qbo.class.query")).toBe("Find classes");
    expect(readToolWords("qbo.attachable.list")).toBe("List attachments");
    expect(readToolWords("zoho_crm.record.search")).toBe("Find records");
    expect(readToolWords("hubspot.record.get")).toBe("Read a record");
    expect(readToolWords("qbo.item.get")).toBe("Read a product or service");
    expect(readToolWords("qbo.journal_entry.query")).toBe("Find journal entries");
  });

  it("leaves writes and short ids to their own labels", () => {
    expect(readToolWords("qbo.bill.create")).toBeNull();
    expect(readToolWords("docs.read")).toBeNull();
    expect(entityPlural("vendor")).toBe("vendors");
  });
});

describe("a role without a label", () => {
  it("keeps its short forms in capitals", () => {
    expect(seatLabelOf({ role: "ap-approver" })).toBe("AP approver");
    expect(seatLabelOf({ role: "bill-approver" })).toBe("Bill approver");
    expect(seatLabelOf({ role: "cfo" })).toBe("CFO");
    expect(seatLabelOf({ role: "x", label: "Approves bills" })).toBe("Approves bills");
  });
});
