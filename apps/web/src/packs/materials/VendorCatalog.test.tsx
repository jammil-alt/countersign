// The vendor catalog (docs/plan.md §1.88): in the back office, a client's vendors, one vendor's
// items with their pack and unit, last price with its date and source, list price, preferred and
// status, a search, and the operator's actions (preferred, discontinued); a master item's page
// with its vendors side by side per its standard unit, preferred first; and in the portal the same
// screens read only, in the reader's language.
import type { Locale } from "@countersign/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { CLIENT_SESSION, fakeApi, OPERATOR_SESSION, Reply } from "../../test/fixtures";
import { CatalogView } from "./Reports";
import {
  MasterItemView,
  preferredFirst,
  VendorCatalogView,
  type VendorItemRow,
} from "./VendorCatalog";

const CLIENT = "00000000-0000-4000-8000-00000000a002";
const NORTHLINE = "00000000-0000-4000-8000-0000000b0001";
const CEDAR = "00000000-0000-4000-8000-0000000b0002";
const BALTIC = "00000000-0000-4000-8000-0000000c0001";
const WALNUT = "00000000-0000-4000-8000-0000000c0002";
const BB34 = "00000000-0000-4000-8000-0000000e0001";
const WAL = "00000000-0000-4000-8000-0000000e0002";
const CR34 = "00000000-0000-4000-8000-0000000e0003";
const OLD = "00000000-0000-4000-8000-0000000e0004";

const item = (over: Partial<VendorItemRow> & Record<string, unknown>): VendorItemRow =>
  ({
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
    lastPrice: null,
    lastPriceStd: null,
    lastPriceOn: null,
    lastPriceSource: null,
    lastPriceSourceId: null,
    packSize: null,
    vendorUom: "sheet",
    stdPerVendorUom: "1.0000",
    sku: null,
    currency: "USD",
    preferred: false,
    status: "active",
    ...over,
  }) as VendorItemRow;

const VENDORS = {
  report: {
    vendors: [
      {
        vendorId: NORTHLINE,
        name: "Northline Panel Supply",
        items: 2,
        discontinued: 1,
        preferred: 0,
        lastPriceOn: "2026-11-02",
      },
      {
        vendorId: CEDAR,
        name: "Cedar Ridge Lumber",
        items: 1,
        discontinued: 0,
        preferred: 1,
        lastPriceOn: null,
      },
    ],
  },
};

const NORTHLINE_ITEMS = {
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
        catalogItemId: WALNUT,
        catalogItemName: "Walnut 4/4 FAS",
        standardUom: "board_foot",
        sku: null,
        name: "WALNUT 4/4 FAS KD",
        vendorUom: "board_foot",
        status: "discontinued",
      }),
    ],
  },
};

const CEDAR_ITEMS = {
  report: {
    vendor: { id: CEDAR, name: "Cedar Ridge Lumber" },
    items: [
      item({
        id: CR34,
        vendorId: CEDAR,
        sku: "PLY-18-BB",
        name: "BB PLY 18MM 1525X1525",
        lastPrice: "64.0000",
        lastPriceStd: "64.0000",
        lastPriceOn: "2026-10-20",
        lastPriceSource: "quote",
        preferred: true,
      }),
    ],
  },
};

// The API answers the cheapest first; the page still puts the preferred one first and the
// discontinued one last.
const MASTER = {
  report: {
    item: {
      id: BALTIC,
      name: "Baltic birch plywood 3/4in 60x60in BB/BB",
      category: "sheet_goods",
      standardUom: "sheet",
      attributes: { thickness: "3/4in", grade: "bb_bb", thickness_mm: "18" },
    },
    vendors: [
      item({
        id: OLD,
        vendorId: CEDAR,
        vendorName: "Cedar Ridge Lumber",
        sku: "PLY-OLD",
        name: "OLD BB PLY",
        lastPrice: "50.0000",
        lastPriceStd: "50.0000",
        lastPriceOn: "2026-01-02",
        status: "discontinued",
      }),
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
      item({
        id: CR34,
        vendorId: CEDAR,
        vendorName: "Cedar Ridge Lumber",
        sku: "PLY-18-BB",
        name: "BB PLY 18MM 1525X1525",
        lastPrice: "64.0000",
        lastPriceStd: "64.0000",
        lastPriceOn: "2026-10-20",
        preferred: true,
      }),
    ],
  },
};

function Where() {
  const { pathname } = useLocation();
  return <span data-testid="where">{pathname}</span>;
}

const OPS = `/api/ops/clients/${CLIENT}/reports/materials`;

function renderOps(routes: Parameters<typeof fakeApi>[0], at = "/vendors") {
  const api = fakeApi({ "GET /api/session": () => OPERATOR_SESSION, ...routes });
  render(
    <MemoryRouter initialEntries={[at]}>
      <AppProviders client={api.client}>
        <Where />
        <Routes>
          <Route path="/vendors" element={<VendorCatalogView clientId={CLIENT} />} />
          <Route
            path={`/ops/clients/${CLIENT}/reports/materials/vendor-catalog/:id`}
            element={<VendorCatalogView clientId={CLIENT} />}
          />
          <Route
            path={`/ops/clients/${CLIENT}/reports/materials/catalog/:id`}
            element={<MasterItemView clientId={CLIENT} />}
          />
          <Route path="/catalog" element={<CatalogView clientId={CLIENT} />} />
        </Routes>
      </AppProviders>
    </MemoryRouter>,
  );
  return api;
}

describe("the vendor catalog in the back office", () => {
  it("shows a vendor's items with pack, unit, last price, list price, preferred and status", async () => {
    renderOps({
      [`GET ${OPS}/vendor-catalog`]: () => VENDORS,
      [`GET ${OPS}/vendor-catalog/items/${NORTHLINE}`]: () => NORTHLINE_ITEMS,
    });
    const rows = await screen.findAllByTestId("vendor-catalog-row");
    expect(rows).toHaveLength(2);
    const [bb, wal] = rows as [HTMLElement, HTMLElement];
    expect(bb).toHaveTextContent("BB34-55");
    expect(bb).toHaveTextContent("bundle of 5");
    // The vendor's unit, and what it holds in the master item's unit.
    expect(bb).toHaveTextContent("bundle (5 × sheet)");
    expect(bb).toHaveTextContent("$330.00");
    expect(bb).toHaveTextContent("Invoice");
    expect(bb).toHaveTextContent("$335.00");
    expect(bb).toHaveTextContent("Active");
    // A discontinued item says so and has no actions.
    expect(within(wal).getByText("Discontinued")).toBeInTheDocument();
    expect(within(wal).queryByTestId("vendor-item-prefer")).toBeNull();
    expect(within(wal).queryByTestId("vendor-item-discontinue")).toBeNull();
    expect(screen.getByText(/Last priced/)).toBeInTheDocument();
  });

  it("searches one vendor's items by SKU, their name and the master item", async () => {
    const user = userEvent.setup();
    renderOps({
      [`GET ${OPS}/vendor-catalog`]: () => VENDORS,
      [`GET ${OPS}/vendor-catalog/items/${NORTHLINE}`]: () => NORTHLINE_ITEMS,
    });
    await screen.findAllByTestId("vendor-catalog-row");
    const search = screen.getByTestId("vendor-catalog-search");
    await user.type(search, "bb34");
    expect(screen.getAllByTestId("vendor-catalog-row")).toHaveLength(1);
    await user.clear(search);
    await user.type(search, "walnut 4/4");
    const rows = screen.getAllByTestId("vendor-catalog-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("WALNUT 4/4 FAS KD");
    await user.clear(search);
    await user.type(search, "nothing like it");
    expect(screen.queryAllByTestId("vendor-catalog-row")).toHaveLength(0);
    expect(screen.getByText("No items match your search.")).toBeInTheDocument();
    expect(screen.getByTestId("vendor-catalog-count")).toHaveTextContent("0");
  });

  it("opens another vendor from the picker, by its path", async () => {
    const user = userEvent.setup();
    renderOps({
      [`GET ${OPS}/vendor-catalog`]: () => VENDORS,
      [`GET ${OPS}/vendor-catalog/items/${NORTHLINE}`]: () => NORTHLINE_ITEMS,
      [`GET ${OPS}/vendor-catalog/items/${CEDAR}`]: () => CEDAR_ITEMS,
    });
    await screen.findAllByTestId("vendor-catalog-row");
    await user.selectOptions(screen.getByTestId("vendor-catalog-pick"), CEDAR);
    await waitFor(() =>
      expect(screen.getByTestId("where")).toHaveTextContent(
        `/ops/clients/${CLIENT}/reports/materials/vendor-catalog/${CEDAR}`,
      ),
    );
    const rows = await screen.findAllByTestId("vendor-catalog-row");
    expect(rows[0]).toHaveTextContent("PLY-18-BB");
    expect(rows[0]).toHaveTextContent("Preferred");
    expect(rows[0]).toHaveTextContent("Quote");
  });

  it("marks a vendor item preferred and discontinues one, then reads the catalog again", async () => {
    const user = userEvent.setup();
    const bodies: { action: string; body: unknown }[] = [];
    const api = renderOps({
      [`GET ${OPS}/vendor-catalog`]: () => VENDORS,
      [`GET ${OPS}/vendor-catalog/items/${NORTHLINE}`]: () => NORTHLINE_ITEMS,
      [`POST /api/ops/clients/${CLIENT}/packs/materials/actions/vendor-item-preferred`]: ({
        init,
      }) => {
        bodies.push({ action: "preferred", body: JSON.parse(String(init.body)) });
        return { result: { item: { id: BB34, preferred: true }, cleared: [] } };
      },
      [`POST /api/ops/clients/${CLIENT}/packs/materials/actions/vendor-item-discontinue`]: ({
        init,
      }) => {
        bodies.push({ action: "discontinue", body: JSON.parse(String(init.body)) });
        return { result: { item: { id: BB34, status: "discontinued" } } };
      },
    });
    const [bb] = (await screen.findAllByTestId("vendor-catalog-row")) as [HTMLElement];
    const reads = () =>
      api.calls.filter((c) => c === `GET ${OPS}/vendor-catalog/items/${NORTHLINE}`).length;
    const before = reads();
    await user.click(within(bb).getByTestId("vendor-item-prefer"));
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    await user.click(within(bb).getByTestId("vendor-item-discontinue"));
    await waitFor(() =>
      expect(bodies).toEqual([
        { action: "preferred", body: { vendorItemId: BB34 } },
        { action: "discontinue", body: { vendorItemId: BB34 } },
      ]),
    );
  });

  it("says how items arrive when there are none", async () => {
    renderOps({ [`GET ${OPS}/vendor-catalog`]: () => ({ report: { vendors: [] } }) });
    expect(await screen.findByText(/No vendor items yet/)).toBeInTheDocument();
  });

  it("goes from a vendor item to its master item's page", async () => {
    const user = userEvent.setup();
    renderOps({
      [`GET ${OPS}/vendor-catalog`]: () => VENDORS,
      [`GET ${OPS}/vendor-catalog/items/${NORTHLINE}`]: () => NORTHLINE_ITEMS,
      [`GET ${OPS}/master-vendors/items/${BALTIC}`]: () => MASTER,
    });
    const [bb] = (await screen.findAllByTestId("vendor-catalog-row")) as [HTMLElement];
    await user.click(within(bb).getByTestId("vendor-catalog-master-link"));
    expect(await screen.findByTestId("materials-master-item")).toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent(
      `/ops/clients/${CLIENT}/reports/materials/catalog/${BALTIC}`,
    );
  });

  it("goes from the catalog to a master item's page", async () => {
    const user = userEvent.setup();
    renderOps(
      {
        [`GET ${OPS}/catalog`]: () => ({
          report: {
            items: [
              {
                id: BALTIC,
                category: "sheet_goods",
                name: "Baltic birch plywood 3/4in 60x60in BB/BB",
                standardUom: "sheet",
                attributes: {},
                vendors: 2,
                aliases: 3,
                purchases: 4,
                lastPrice: "66.0000",
                lastOn: "2026-11-02",
              },
            ],
          },
        }),
        [`GET ${OPS}/master-vendors/items/${BALTIC}`]: () => MASTER,
      },
      "/catalog",
    );
    await user.click(await screen.findByTestId("materials-catalog-item-link"));
    expect(await screen.findByTestId("materials-master-item")).toBeInTheDocument();
  });
});

describe("a master item's page", () => {
  it("lists its vendors side by side per its standard unit, preferred first, discontinued last", async () => {
    renderOps(
      { [`GET ${OPS}/master-vendors/items/${BALTIC}`]: () => MASTER },
      `/ops/clients/${CLIENT}/reports/materials/catalog/${BALTIC}`,
    );
    const page = await screen.findByTestId("materials-master-item");
    expect(within(page).getByRole("heading", { level: 1 })).toHaveTextContent(
      "Baltic birch plywood 3/4in 60x60in BB/BB",
    );
    expect(page).toHaveTextContent("Sheet goods · sheet");
    // The attributes as recorded, less the measured millimetres.
    expect(screen.getByTestId("materials-master-item-attributes")).toHaveTextContent(
      "thickness 3/4in · grade bb bb",
    );
    expect(page).toHaveTextContent("Vendors, per sheet");
    expect(page).toHaveTextContent("Per sheet");
    const rows = screen.getAllByTestId("vendor-catalog-master-row");
    expect(rows.map((r) => r.querySelector(".reference")?.textContent)).toEqual([
      "PLY-18-BB",
      "BB34-55",
      "PLY-OLD",
    ]);
    expect(rows[0]).toHaveTextContent("Preferred");
    expect(rows[0]).toHaveTextContent("$64.00");
    // Northline's bundle of 5: $330.00 a bundle is $66.00 a sheet.
    expect(rows[1]).toHaveTextContent("$66.00");
    expect(rows[1]).toHaveTextContent("$330.00");
    expect(rows[2]).toHaveTextContent("Discontinued");
    // The operator's actions: the preferred one can only be discontinued.
    expect(within(rows[0] as HTMLElement).queryByTestId("vendor-item-prefer")).toBeNull();
    expect(within(rows[1] as HTMLElement).getByTestId("vendor-item-prefer")).toBeInTheDocument();
    // A vendor's name opens its catalog.
    expect(
      within(rows[1] as HTMLElement).getByRole("link", { name: "Northline Panel Supply" }),
    ).toHaveAttribute(
      "href",
      `/ops/clients/${CLIENT}/reports/materials/vendor-catalog/${NORTHLINE}`,
    );
  });

  it("says when no vendor sells it yet", async () => {
    renderOps(
      {
        [`GET ${OPS}/master-vendors/items/${BALTIC}`]: () => ({
          report: { ...MASTER.report, vendors: [] },
        }),
      },
      `/ops/clients/${CLIENT}/reports/materials/catalog/${BALTIC}`,
    );
    expect(await screen.findByText("No vendor sells you this item yet.")).toBeInTheDocument();
  });

  it("sorts preferred first, then active, then discontinued, keeping the API's order within", () => {
    const rows = [
      item({ id: "a", status: "discontinued" }),
      item({ id: "b" }),
      item({ id: "c", preferred: true }),
      item({ id: "d" }),
    ];
    expect(preferredFirst(rows).map((r) => r.id)).toEqual(["c", "b", "d", "a"]);
  });
});

describe("the vendor catalog in the portal", () => {
  function renderPortal(
    path: string,
    routes: Parameters<typeof fakeApi>[0],
    locale: Locale = "en",
  ) {
    const session = {
      ...CLIENT_SESSION,
      language: { effective: locale, user: locale, client: null },
    };
    const api = fakeApi({
      "GET /api/session": () => session,
      "GET /api/overview": () => new Reply(404, {}),
      "GET /api/feedback/status": () => ({ enabled: false }),
      "GET /api/reports/activity": () => ({
        from: "2026-11-01",
        to: "2026-11-08",
        timezone: "UTC",
        runs: { total: 0, succeeded: 0, failed: 0, cancelled: 0, waiting: 0, going: 0 },
        documents: { received: 0, read: 0 },
        actions: { total: 0, byConnector: [] },
        services: [],
        packs: ["materials"],
      }),
      ...routes,
    });
    render(
      <MemoryRouter initialEntries={[path]}>
        <AppProviders client={api.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    return api;
  }

  it("shows the client its vendor catalog read only, with no operator actions", async () => {
    const api = renderPortal("/reports/materials/vendor-catalog", {
      "GET /api/reports/materials/vendor-catalog": () => VENDORS,
      [`GET /api/reports/materials/vendor-catalog/items/${NORTHLINE}`]: () => NORTHLINE_ITEMS,
    });
    const rows = await screen.findAllByTestId("vendor-catalog-row");
    expect(rows[0]).toHaveTextContent("BB34-55");
    expect(rows[0]).toHaveTextContent("$330.00");
    expect(screen.queryByTestId("vendor-item-prefer")).toBeNull();
    expect(screen.queryByTestId("vendor-item-discontinue")).toBeNull();
    expect(api.calls.some((c) => c.includes("/api/ops/"))).toBe(false);
    // The master item link stays in the portal.
    expect(
      within(rows[0] as HTMLElement).getByTestId("vendor-catalog-master-link"),
    ).toHaveAttribute("href", `/reports/materials/catalog/${BALTIC}`);
  });

  it("opens a master item's page with its vendors, in the reader's language", async () => {
    renderPortal(
      `/reports/materials/catalog/${BALTIC}`,
      { [`GET /api/reports/materials/master-vendors/items/${BALTIC}`]: () => MASTER },
      "es",
    );
    const page = await screen.findByTestId("materials-master-item");
    expect(page).toHaveTextContent("Proveedores, por");
    expect(page).toHaveTextContent("Preferido");
    expect(page).toHaveTextContent("Descontinuado");
    const rows = screen.getAllByTestId("vendor-catalog-master-row");
    expect(rows[0]).toHaveTextContent("PLY-18-BB");
    expect(screen.queryByTestId("vendor-item-prefer")).toBeNull();
  });

  it("reads a vendor's catalog in German", async () => {
    renderPortal(
      `/reports/materials/vendor-catalog/${CEDAR}`,
      {
        "GET /api/reports/materials/vendor-catalog": () => VENDORS,
        [`GET /api/reports/materials/vendor-catalog/items/${CEDAR}`]: () => CEDAR_ITEMS,
      },
      "de",
    );
    const rows = await screen.findAllByTestId("vendor-catalog-row");
    expect(rows[0]).toHaveTextContent("PLY-18-BB");
    expect(rows[0]).toHaveTextContent("Bevorzugt");
    expect(rows[0]).toHaveTextContent("Angebot");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Lieferantenkatalog");
    expect(screen.getByTestId("vendor-catalog-search")).toHaveAttribute(
      "placeholder",
      "Artikelnummer, Name oder Material suchen",
    );
  });
});
