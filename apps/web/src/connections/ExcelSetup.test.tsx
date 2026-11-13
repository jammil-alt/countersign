// §1.97: the client admin's Excel card: the workbooks agents may use (remove one), and a search of
// the person's OneDrive to add one; a workbook picked with another account is marked.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiProvider } from "../api/useApi";
import { fakeApi } from "../test/fixtures";
import { ExcelSetup } from "./ExcelSetup";

const LOG = {
  id: "01LOG",
  name: "Receiving log.xlsx",
  url: null,
  addedAt: "2026-11-12T15:00:00.000Z",
  usable: true,
};
const OLD = {
  id: "01OLD",
  name: "Old prices.xlsx",
  url: null,
  addedAt: "2026-11-01T15:00:00.000Z",
  usable: false,
};

function renderCard() {
  let workbooks = [LOG, OLD];
  const saved: string[][] = [];
  const api = fakeApi({
    "GET /api/connections/excel/picker": () => ({
      available: true,
      connectionId: "00000000-0000-4000-8000-00000000e301",
      account: "pat.lee@acme.example",
      workbooks,
    }),
    "GET /api/connections/excel/search": () => ({
      results: [
        { id: "01LOG", name: "Receiving log.xlsx", url: null, folder: "Finance", modifiedAt: null },
        { id: "01NEW", name: "Deliveries.xlsx", url: null, folder: "", modifiedAt: null },
      ],
    }),
    "PUT /api/connections/excel/workbooks": ({ init }) => {
      const ids = (JSON.parse(String(init.body)) as { workbookIds: string[] }).workbookIds;
      saved.push(ids);
      workbooks = ids.map((id) => (id === LOG.id ? LOG : { ...LOG, id, name: "Deliveries.xlsx" }));
      return { available: true, connectionId: null, account: "pat.lee@acme.example", workbooks };
    },
  });
  render(
    <ApiProvider client={api.client}>
      <ExcelSetup />
    </ApiProvider>,
  );
  return { saved, user: userEvent.setup() };
}

afterEach(() => vi.restoreAllMocks());

describe("ExcelSetup", () => {
  it("lists the workbooks, marks one picked with another account, and adds one from a search", async () => {
    const { saved, user } = renderCard();
    const list = await screen.findByTestId("excel-workbooks");
    expect(within(list).getByText("Receiving log.xlsx")).toBeInTheDocument();
    expect(within(list).getByText(/another Microsoft account/)).toBeInTheDocument();
    await user.type(screen.getByTestId("excel-search"), "deliveries");
    await user.click(screen.getByRole("button", { name: "Search" }));
    const results = await screen.findByTestId("excel-results");
    // Already picked: no button.
    expect(within(results).getByText("Added")).toBeInTheDocument();
    await user.click(within(results).getByTestId("excel-add"));
    expect(saved).toEqual([["01LOG", "01NEW"]]);
  });

  it("removes a workbook, keeping only the usable rest", async () => {
    const { saved, user } = renderCard();
    await screen.findByTestId("excel-workbooks");
    await user.click(screen.getAllByTestId("excel-remove")[1] as HTMLElement);
    expect(saved).toEqual([["01LOG"]]);
  });
});
