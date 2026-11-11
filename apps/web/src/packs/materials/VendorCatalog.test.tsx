// The back office's vendor catalog (docs/plan.md §1.88): a client's vendors, one vendor's items
// with their last price and where it came from, a master item's vendors side by side, and the
// operator's actions (preferred, discontinued).
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders } from "../../App";
import { fakeApi, OPERATOR_SESSION } from "../../test/fixtures";
import { VendorCatalogView } from "./VendorCatalog";

const CLIENT = "00000000-0000-4000-8000-00000000a002";
const NORTHLINE = "00000000-0000-4000-8000-0000000b0001";
const CEDAR = "00000000-0000-4000-8000-0000000b0002";
const BALTIC = "00000000-0000-4000-8000-0000000c0001";
const BB34 = "00000000-0000-4000-8000-0000000e0001";
const WAL = "00000000-0000-4000-8000-0000000e0002";

const item = (over: Record<string, unknown>) => ({
  vendorId: NORTHLINE,
  catalogItemId: BALTIC,
  catalogItemName: "Baltic birch plywood 3/4in 60x60in BB/BB",
  category: "sheet_goods",
  standardUom: "sheet",
  description: null,
  minOrderQty: null,
  leadTimeDays: null,
  listPrice: null,
  listPriceOn: null,
  lastPriceSourceId: null,
  currency: "USD",
  preferred: false,
  status: "active",
  ...over,
});

function renderView(routes: Parameters<typeof fakeApi>[0]) {
  const api = fakeApi({ "GET /api/session": () => OPERATOR_SESSION, ...routes });
  render(
    <MemoryRouter>
      <AppProviders client={api.client}>
        <Routes>
          <Route path="*" element={<VendorCatalogView clientId={CLIENT} />} />
        </Routes>
      </AppProviders>
    </MemoryRouter>,
  );
  return api;
}

describe("the vendor catalog", () => {
  it("shows a vendor's items, a master item's vendors, and marks one preferred", async () => {
    const bodies: unknown[] = [];
    renderView({
      [`GET /api/ops/clients/${CLIENT}/reports/materials/vendor-catalog`]: () => ({
        report: {
          vendors: [
            {
              vendorId: NORTHLINE,
              name: "Northline Panel Supply",
              items: 2,
              discontinued: 0,
              preferred: 0,
              lastPriceOn: "2026-11-02",
            },
            {
              vendorId: CEDAR,
              name: "Cedar Ridge Lumber",
              items: 1,
              discontinued: 0,
              preferred: 0,
              lastPriceOn: null,
            },
          ],
        },
      }),
      [`GET /api/ops/clients/${CLIENT}/reports/materials/vendor-catalog/items/${NORTHLINE}`]:
        () => ({
          report: {
            vendor: { id: NORTHLINE, name: "Northline Panel Supply" },
            items: [
              item({
                id: BB34,
                sku: "BB34-55",
                name: "BALTIC BIRCH PLY 3/4 5X5 BB/BB",
                packSize: "bundle of 5",
                vendorUom: "bundle",
                stdPerVendorUom: "5.0000",
                lastPrice: "330.0000",
                lastPriceStd: "66.0000",
                lastPriceOn: "2026-11-02",
                lastPriceSource: "invoice",
                listPrice: "335.0000",
                listPriceOn: "2026-11-01",
              }),
              item({
                id: WAL,
                catalogItemId: "00000000-0000-4000-8000-0000000c0002",
                catalogItemName: "Walnut 4/4 FAS",
                sku: null,
                name: "WALNUT 4/4 FAS KD",
                packSize: null,
                vendorUom: "board_foot",
                stdPerVendorUom: "1.0000",
                lastPrice: null,
                lastPriceStd: null,
                lastPriceOn: null,
                lastPriceSource: null,
                status: "discontinued",
              }),
            ],
          },
        }),
      [`GET /api/ops/clients/${CLIENT}/reports/materials/master-vendors/items/${BALTIC}`]: () => ({
        report: {
          item: {
            id: BALTIC,
            name: "Baltic birch plywood 3/4in 60x60in BB/BB",
            category: "sheet_goods",
            standardUom: "sheet",
            attributes: {},
          },
          vendors: [
            item({
              id: BB34,
              vendorName: "Northline Panel Supply",
              sku: "BB34-55",
              name: "BALTIC BIRCH PLY 3/4 5X5 BB/BB",
              packSize: "bundle of 5",
              vendorUom: "bundle",
              stdPerVendorUom: "5.0000",
              lastPrice: "330.0000",
              lastPriceStd: "66.0000",
              lastPriceOn: "2026-11-02",
              lastPriceSource: "invoice",
            }),
          ],
        },
      }),
      [`POST /api/ops/clients/${CLIENT}/packs/materials/actions/vendor-item-preferred`]: ({
        init,
      }) => {
        bodies.push(JSON.parse(String(init.body)));
        return { result: { item: { id: BB34, preferred: true }, cleared: [] } };
      },
    });
    const rows = await screen.findAllByTestId("vendor-catalog-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("BB34-55");
    expect(rows[0]?.textContent).toContain("$330.00");
    expect(rows[0]?.textContent).toContain("invoice");
    expect(rows[0]?.textContent).toContain("$335.00");
    // A discontinued item has no actions.
    expect(within(rows[1] as HTMLElement).getByText("Discontinued")).toBeTruthy();
    expect(within(rows[1] as HTMLElement).queryByTestId("vendor-item-prefer")).toBeNull();
    // The master item's vendors, per sheet.
    await userEvent.click(within(rows[0] as HTMLElement).getByTestId("vendor-catalog-master-link"));
    const side = await screen.findAllByTestId("vendor-catalog-master-row");
    expect(side[0]?.textContent).toContain("$66.00");
    await userEvent.click(within(rows[0] as HTMLElement).getByTestId("vendor-item-prefer"));
    await waitFor(() => expect(bodies).toEqual([{ vendorItemId: BB34 }]));
  });

  it("says how items arrive when there are none", async () => {
    renderView({
      [`GET /api/ops/clients/${CLIENT}/reports/materials/vendor-catalog`]: () => ({
        report: { vendors: [] },
      }),
    });
    expect(await screen.findByText(/No vendor items yet/)).toBeTruthy();
  });
});
