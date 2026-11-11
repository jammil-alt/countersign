import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { DataBlock, FieldsView, StepDataList, stepChipState, tableColumns } from "./StepPanel";

const wrap = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe("step panel data", () => {
  it("reads a list of like rows as a table, and anything else as items", () => {
    expect(
      tableColumns([
        { sku: "A", qty: 1 },
        { sku: "B", price: "2.00" },
      ]),
    ).toEqual(["sku", "qty", "price"]);
    expect(tableColumns([{ sku: "A", nested: { x: 1 } }])).toBeNull();
    expect(tableColumns(["a", "b"])).toBeNull();
    expect(tableColumns([])).toBeNull();
  });

  it("shows fields by their labels, ids by their tail, yes and no, and no JSON", () => {
    wrap(
      <FieldsView
        value={{
          vendorName: "Northline",
          recordId: "00000000-0000-4000-8000-0000000f5001",
          paid: false,
          tags: ["oak", "mdf"],
          lines: [{ sku: "MDF-18", amount: "1000.0000" }],
          empty: [],
        }}
      />,
    );
    expect(screen.getByText("Vendor name")).toBeInTheDocument();
    expect(screen.getByTitle("00000000-0000-4000-8000-0000000f5001")).toHaveTextContent("·0f5001");
    expect(screen.getByText("No")).toBeInTheDocument();
    expect(screen.getByRole("table")).toHaveTextContent("MDF-18");
    expect(screen.getByRole("table")).toHaveTextContent("1,000");
    expect(document.body.textContent).toContain("oak, mdf");
    expect(document.body.textContent).not.toContain("{");
  });

  it("cuts a long list and says how many more", () => {
    wrap(<FieldsView value={Array.from({ length: 25 }, (_, i) => ({ n: i, more: { x: i } }))} />);
    expect(screen.getByText("and 5 more")).toBeInTheDocument();
  });

  it("puts the raw JSON behind a toggle, and says when nothing was recorded", async () => {
    const user = userEvent.setup();
    wrap(
      <>
        <DataBlock label="What came out" value={{ total: "12.00" }} testId="out" />
        <DataBlock label="What went in" value={null} testId="in" />
      </>,
    );
    expect(screen.getByTestId("in")).toHaveTextContent("Nothing recorded.");
    expect(screen.queryByTestId("in-toggle")).toBeNull();
    await user.click(screen.getByTestId("out-toggle"));
    expect(screen.getByTestId("out-raw")).toHaveTextContent('"total": "12.00"');
    expect(screen.getByTestId("out-toggle")).toHaveTextContent("Hide raw data");
  });

  it("groups what a step touched, with links where a page exists", () => {
    wrap(
      <StepDataList
        testId="d"
        entries={[
          { key: "record-1", kind: "record", label: "Oak board", href: "/records/1" },
          { key: "change-1", kind: "change", label: "Update the bill" },
        ]}
      />,
    );
    expect(screen.getByRole("link", { name: "Oak board" })).toHaveAttribute("href", "/records/1");
    expect(screen.getByTestId("d-change")).toHaveTextContent("Update the bill");
    expect(screen.getByText("Records · 1")).toBeInTheDocument();
    expect(screen.queryByText(/Documents/)).toBeNull();
  });

  it("says when a step touched nothing", () => {
    wrap(<StepDataList testId="d" entries={[]} />);
    expect(screen.getByTestId("d")).toHaveTextContent("made, changed or cited no records");
  });

  it("maps a step's status to a chip", () => {
    expect(stepChipState("succeeded")).toBe("done");
    expect(stepChipState("failed")).toBe("failed");
    expect(stepChipState("pending")).toBe("idle");
  });
});
