// The approval card's "now / after this change" (docs/plan.md "Inbox and run views"): a tool's
// declared display drives what a person reads (its fields, labels and kinds; lines as a table with
// totals; refs by name; money in the reader's locale; no ids or guards), and tools without one fall
// back to the record's own fields without ever showing a raw object.
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../i18n/i18n";
import { BILL_BEFORE, BILL_INPUT, BILL_ITEM, BILL_LINES_DISPLAY } from "../test/changes";
import { ChangeTables } from "./ChangePanel";
import { changeHeading, changeModel, fieldLabel, formatValue } from "./change";
import { InboxCard } from "./InboxCard";

function renderTables(props: Parameters<typeof ChangeTables>[0], locale: "en" | "es" = "en") {
  return render(
    <I18nProvider locale={locale} browser={[]}>
      <ChangeTables {...props} />
    </I18nProvider>,
  );
}

describe("the change model, through a tool's display", () => {
  it("reads the bill's lines now and after: the replaced line goes, the new lines follow", () => {
    const model = changeModel(BILL_LINES_DISPLAY, BILL_BEFORE, BILL_INPUT);
    expect(model.create).toBe(false);
    expect(model.fields.map((f) => [f.key, f.label, f.list, f.changed])).toEqual([
      ["txnDate", "Date", false, false],
      ["lines", "Lines", true, true],
      ["total", "Total", false, false],
    ]);
    const lines = model.fields[1];
    expect(lines?.now).toEqual({
      type: "lines",
      currency: "USD",
      total: "9742.35",
      items: [
        {
          description: "Northline invoice 20418",
          ref: "Job Materials",
          qty: null,
          unitPrice: null,
          amount: "9742.35",
          size: null,
          marked: true,
        },
      ],
    });
    expect(lines?.after).toMatchObject({
      type: "lines",
      total: "9742.35",
      items: [
        {
          description: "Baltic birch 3/4 4x8 B/BB",
          ref: "Baltic birch 3/4 4x8",
          qty: "60",
          unitPrice: "142.5000",
          amount: "8550.00",
          marked: true,
        },
        {
          description: "Edgebanding oak 7/8 x 500'",
          ref: "Edgebanding oak 7/8",
          amount: "1192.35",
          marked: true,
        },
      ],
    });
    // The record "now" is shown in full, through the same fields as "after".
    expect(model.fields[2]?.now).toEqual({ type: "money", amount: "9742.3500", currency: "USD" });
    expect(model.fields[2]?.after).toEqual(model.fields[2]?.now);
    expect(model.fields[0]?.now).toEqual({ type: "date", value: "2026-10-28" });
  });

  it("keeps the lines a change does not replace; unknown ids read only in the back office", () => {
    const before = {
      ...BILL_BEFORE,
      names: undefined,
      lines: [
        ...BILL_BEFORE.lines,
        { ...BILL_BEFORE.lines[0], id: "2", description: "Freight", amount: "120.00" },
      ],
    };
    const refs = (showIds: boolean) => {
      const model = changeModel(BILL_LINES_DISPLAY, before, BILL_INPUT, "en", { showIds });
      const after = model.fields.find((f) => f.key === "lines")?.after;
      return after?.type === "lines" && after.items.map((l) => [l.description, l.ref, l.marked]);
    };
    expect(refs(true)).toEqual([
      ["Freight", "Job Materials", false],
      ["Baltic birch 3/4 4x8 B/BB", "#31", true],
      ["Edgebanding oak 7/8 x 500'", "#32", true],
    ]);
    // QA round 1: a client never reads a bare id.
    expect(refs(false)).toEqual([
      ["Freight", "Job Materials", false],
      ["Baltic birch 3/4 4x8 B/BB", null, true],
      ["Edgebanding oak 7/8 x 500'", null, true],
    ]);
  });

  it("titles the card with the tool's name, the record's number and the vendor", () => {
    const heading = changeHeading(
      { connectorName: "QuickBooks Online", tool: BILL_LINES_DISPLAY },
      "qbo.bill.update_lines",
      BILL_BEFORE,
      BILL_INPUT,
    );
    expect(heading).toEqual({
      title: "QuickBooks bill 20418 · Northline Panel Supply",
      description:
        "Replace the bill's lines with the items on the vendor's invoice. The total stays the same.",
      connector: "QuickBooks Online",
    });
    expect(
      changeHeading(
        { connectorName: "QuickBooks Online", tool: BILL_LINES_DISPLAY },
        "qbo.bill.update_lines",
        BILL_BEFORE,
        BILL_INPUT,
        "es",
      ).title,
    ).toBe("Factura de QuickBooks 20418 · Northline Panel Supply");
  });

  it("names the record by its kind when a tool acts on several", () => {
    const display = {
      ...BILL_LINES_DISPLAY,
      nameBy: {
        path: "input.entity" as const,
        names: { Purchase: { en: "QuickBooks purchase" } },
      },
    };
    const heading = changeHeading(
      { connectorName: "QuickBooks Online", tool: display },
      "qbo.attachable.upload",
      BILL_BEFORE,
      { entity: "Purchase" },
    );
    expect(heading.title).toBe("QuickBooks purchase 20418 · Northline Panel Supply");
  });

  it("shows files by name and size, the one being attached marked", () => {
    const model = changeModel(
      {
        name: { en: "QuickBooks bill" },
        fields: [
          {
            label: { en: "Attachments" },
            kind: "files",
            now: "before.attachments",
            after: "before.adding",
            adds: true,
            columns: { id: "id", description: "fileName", size: "size" },
          },
          { label: { en: "Note" }, kind: "text", after: "input.note" },
        ],
      },
      {
        attachments: [{ id: "9", syncToken: "0", fileName: "po-311.pdf", size: 20480 }],
        adding: { fileName: "northline-20418.pdf", size: 186_000, contentType: "application/pdf" },
      },
      { documentId: "d1", entity: "Bill", entityId: "146" },
    );
    // A note the change leaves out is not a row.
    expect(model.fields.map((f) => f.key)).toEqual(["attachments"]);
    const after = model.fields[0]?.after;
    expect(
      after?.type === "files" && after.items.map((f) => [f.description, f.size, f.marked]),
    ).toEqual([
      ["po-311.pdf", 20480, false],
      ["northline-20418.pdf", 186000, true],
    ]);
  });
});

describe("the change tables", () => {
  it("render the lines as a table with names, qty × unit price, amounts and totals", () => {
    renderTables({ before: BILL_BEFORE, input: BILL_INPUT, display: BILL_LINES_DISPLAY });
    const now = screen.getByTestId("change-lines-now");
    const after = screen.getByTestId("change-lines-after");
    expect(within(now).getByTestId("change-lines-now-item-0")).toHaveTextContent(
      // The word behind the marking, for screen readers.
      "Northline invoice 20418 (removed)Job Materials$9,742.35",
    );
    expect(within(now).getByTestId("change-lines-now-item-0")).toHaveAttribute(
      "data-removed",
      "true",
    );
    const first = within(after).getByTestId("change-lines-after-item-0");
    expect(first).toHaveTextContent("Baltic birch 3/4 4x8 B/BB");
    expect(first).toHaveTextContent("Baltic birch 3/4 4x8");
    expect(first).toHaveTextContent("60 × $142.50");
    expect(first).toHaveTextContent("$8,550.00");
    expect(first).toHaveAttribute("data-changed", "true");
    expect(within(after).getByTestId("change-lines-after-item-1")).toHaveTextContent(
      "4 × $298.0875",
    );
    expect(within(now).getByTestId("change-lines-now-total")).toHaveTextContent("Total$9,742.35");
    expect(within(after).getByTestId("change-lines-after-total")).toHaveTextContent(
      "Total$9,742.35",
    );
  });

  it("set out only what changes, and what stays the same on one line", () => {
    renderTables({ before: BILL_BEFORE, input: BILL_INPUT, display: BILL_LINES_DISPLAY });
    // QA round 1: the date and total are the same before and after, so no table repeats them.
    expect(screen.queryByTestId("change-fields")).toBeNull();
    expect(screen.getByTestId("change-unchanged")).toHaveTextContent(
      "Unchanged: Date Oct 28, 2026 · Total $9,742.35",
    );
  });

  it("put a changed field's now and after side by side in one row", () => {
    renderTables({
      before: { ...BILL_BEFORE, memo: "old" },
      input: { memo: "new" },
      display: {
        name: { en: "QuickBooks bill" },
        fields: [
          { label: { en: "Memo" }, kind: "text", now: "before.memo", after: "input.memo" },
          {
            label: { en: "Total" },
            kind: "money",
            now: "before.total",
            currencyPath: "before.currency",
          },
        ],
      },
    });
    expect(screen.getByTestId("change-row-memo-now")).toHaveTextContent("old");
    expect(screen.getByTestId("change-row-memo-after")).toHaveTextContent("new");
    expect(screen.queryByTestId("change-row-total")).toBeNull();
    expect(screen.getByTestId("change-unchanged-total")).toHaveTextContent("Total $9,742.35");
  });

  it("name an account the before state leaves unnamed from the server's names, never as #20", () => {
    const before = {
      ...BILL_BEFORE,
      lines: [{ ...BILL_BEFORE.lines[0], account: { id: "20" } }],
      names: { items: BILL_BEFORE.names.items, accounts: {} },
    };
    const { unmount } = renderTables({ before, input: BILL_INPUT, display: BILL_LINES_DISPLAY });
    // Nobody names it: the client reads nothing rather than a bare id.
    expect(screen.getByTestId("change-lines-now-item-0")).not.toHaveTextContent("#20");
    unmount();
    renderTables({
      before,
      input: BILL_INPUT,
      display: BILL_LINES_DISPLAY,
      names: { accounts: { "20": "Job Expenses:Job Materials" } },
    });
    expect(screen.getByTestId("change-lines-now-item-0")).toHaveTextContent(
      "Job Expenses:Job Materials",
    );
  });

  it("hide ids, sync tokens and the write's guards", () => {
    const { container } = renderTables({
      before: BILL_BEFORE,
      input: BILL_INPUT,
      display: BILL_LINES_DISPLAY,
    });
    const text = container.textContent ?? "";
    for (const hidden of [
      "Replace line ids",
      "Expected total",
      "Sync token",
      "Entity",
      "Payment type",
      "146",
      "accountId",
      "{",
    ]) {
      expect(text).not.toContain(hidden);
    }
  });

  it("format money in the reader's locale", () => {
    renderTables({ before: BILL_BEFORE, input: BILL_INPUT, display: BILL_LINES_DISPLAY }, "es");
    expect(screen.getByTestId("change-lines")).toHaveAccessibleName("Líneas");
    // Spanish groups thousands with a dot and decimals with a comma.
    expect(screen.getByTestId("change-unchanged-total")).toHaveTextContent("9742,35");
    expect(screen.getByTestId("change-lines-after-item-0")).toHaveTextContent("8550,00");
  });

  it("fall back to the record's own fields for a tool without a display, with no raw objects", () => {
    const { container } = renderTables({
      before: {
        id: "r1",
        etag: "W/1",
        vendor: { id: "58", name: "Northline Panel Supply" },
        status: "open",
        lines: [{ id: "l1", amount: "2740.00", accountId: "20", description: "Panels" }],
        address: { city: "Tacoma", state: "WA" },
      },
      input: {
        id: "r1",
        vendorId: "58",
        status: "closed",
        lines: [{ amount: "2740.00", accountId: "20", description: "Panels, itemized" }],
      },
    });
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/[{}[\]"]/);
    expect(screen.getByTestId("change-unchanged-vendor")).toHaveTextContent(
      "Northline Panel Supply",
    );
    expect(screen.getByTestId("change-unchanged-address")).toHaveTextContent(
      "City: Tacoma, State: WA",
    );
    expect(screen.getByTestId("change-row-status-now")).toHaveTextContent("open");
    expect(screen.getByTestId("change-row-status-after")).toHaveTextContent("closed");
    // A list of records reads as a small table, ids left out.
    const after = screen.getByTestId("change-lines-after");
    expect(within(after).getByRole("table")).toHaveTextContent("AmountDescription");
    expect(within(after).getByTestId("change-lines-after-item-0")).toHaveTextContent(
      "2740.00Panels, itemized",
    );
    expect(text).not.toContain("Vendor id");
    expect(text).not.toContain("Etag");
  });
});

describe("plain values", () => {
  it("write labels and nested values plainly", () => {
    expect(fieldLabel("unitPrice")).toBe("Unit price");
    expect(fieldLabel("vendor_name")).toBe("Vendor name");
    expect(formatValue(null)).toBe("—");
    expect(formatValue(["a", 2])).toBe("a, 2");
    expect(formatValue({ qty: 2 })).toBe("Qty: 2");
    expect(formatValue({ id: "58", name: "Northline" })).toBe("Northline");
    expect(formatValue([{ id: "1", name: "A" }, { name: "B" }])).toBe("A; B");
    // A field that only ends in "id" is not an id.
    expect(formatValue({ paid: true })).toBe("Paid: true");
  });
});

describe("InboxCard: a declared change, for a client", () => {
  it("reads like the record, without the tool id, and signs with the connector's name", () => {
    render(
      <MemoryRouter>
        <InboxCard item={BILL_ITEM} onResolve={async () => {}} />
      </MemoryRouter>,
    );
    const card = screen.getByTestId(`inbox-item-${BILL_ITEM.id}`);
    expect(within(card).getByRole("heading", { level: 3 })).toHaveTextContent(
      "QuickBooks bill 20418 · Northline Panel Supply",
    );
    expect(within(card).getByTestId("inbox-item-description")).toHaveTextContent(
      "Replace the bill's lines with the items on the vendor's invoice. The total stays the same.",
    );
    expect(card.textContent).not.toContain("qbo.bill.update_lines");
    expect(card.textContent).not.toContain("Qbo");
    expect(within(card).getByTestId("inbox-item-approve")).toHaveTextContent(
      "Approve and update QuickBooks Online",
    );
  });
});
