// S5.6 (overnight fixes, 2026-11-23): no raw codes on screen. Each of these printed the code the
// QA walks found: "Qbo", "Query purchaseorder", "changed in qbo", "vendor:59", "QboBill:146",
// `trg-invoice-read`, `totalsValid`, a dated model id, $0.2106 and a JSON dump of a reference.
import { askChips } from "@countersign/core";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { connectorName } from "../inbox/change";
import { readableProblem } from "../ops/builder/problems";
import { fieldText } from "../ops/workflow/describe";
import { payloadRows } from "../records/RecordDetail";
import { refLabel, SourceLinks } from "../records/SourceLinks";
import { cost } from "../usage/format";
import { connectorChipNames, modelCallLabel, toolLabel } from "./labels";

describe("raw codes in words", () => {
  it("names a connector without the names table", () => {
    expect(connectorName("qbo")).toBe("QuickBooks");
    expect(connectorName("qbo", { qbo: "QuickBooks Online" })).toBe("QuickBooks Online");
    expect(connectorName("zoho_crm")).toBe("Zoho CRM");
  });

  it("names a read tool", () => {
    expect(toolLabel("qbo.purchaseorder.query")).toBe("Find purchase orders");
    expect(toolLabel("qbo.bill.create")).toBe("Create a bill");
  });

  it("names the connector on a run filter's chip", () => {
    const chips = askChips(
      { changedConnector: "qbo" },
      { agents: new Map(), connectors: connectorChipNames("qbo") },
    );
    expect(chips.find((c) => c.key === "changedConnector")?.value).toBe("QuickBooks");
  });

  it("reads a record an agent named by kind and id", () => {
    expect(refLabel("vendor:59")).toBe("Vendor 59");
    expect(refLabel("QboBill:146")).toBe("QuickBooks bill 146");
    expect(refLabel("r1")).toBe("r1");
    render(
      <MemoryRouter>
        <SourceLinks ids={["vendor:59", "QboBill:146"]} href={(id) => `/records/${id}`} />
      </MemoryRouter>,
    );
    expect(screen.getByText("Vendor 59")).toBeVisible();
    expect(screen.getByText("QuickBooks bill 146")).toBeVisible();
    expect(screen.queryByText("vendor:59")).toBeNull();
  });

  it("names a trigger's field", () => {
    expect(fieldText("{{trigger.totalsValid}}")).toBe("trigger · totals valid");
  });

  it("says an unbound connection in words", () => {
    const text = readableProblem(
      {
        workflow: "main",
        stepId: "s1",
        field: "",
        code: "connection_missing",
        message: 'no qbo connection is bound for "qbo.vendor.create"',
      },
      { workflows: [] } as unknown as Parameters<typeof readableProblem>[1],
    ).text;
    expect(text).toBe(
      "No QuickBooks connection is set up for “Add a vendor”: the client connects it in their portal.",
    );
  });

  it("names a model without its date, and money in cents", () => {
    expect(modelCallLabel("anthropic", "claude-haiku-4-5-20251001")).toBe(
      "Anthropic · Claude Haiku 4.5",
    );
    expect(modelCallLabel("anthropic", "claude-opus-5-5")).toBe("Anthropic · Claude Opus 5.5");
    expect(cost("0.2106")).toBe("$0.21");
  });

  it("reads a raw record's reference by name, not as JSON", () => {
    expect(
      payloadRows({ VendorRef: { value: "59", name: "Northline Panel Supply" }, TotalAmt: 12.5 }),
    ).toEqual([
      ["VendorRef", "Northline Panel Supply (59)"],
      ["TotalAmt", "12.5"],
    ]);
  });
});
