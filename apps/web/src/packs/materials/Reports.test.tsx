// The Materials pack's screens: Price watch (rows with last price, change and sparkline; alerts
// with the invoices behind them; CSV), the back office's view of a client's, the Catalog, the
// match review card in the inbox (Match, New item, Skip, then Finish), the Packs page's switch
// and the portal's Reports page.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders } from "../../App";
import { createI18n, EN } from "../../i18n/i18n";
import { InboxCard } from "../../inbox/InboxCard";
import { CLIENT_SESSION, fakeApi, OPERATOR_SESSION } from "../../test/fixtures";
import { packReportPath, packReportsFor } from "../registry";
import { OpsPacksScreen } from "../screens";
import { CatalogView, PriceWatchView } from "./Reports";

const CLIENT = "00000000-0000-4000-8000-00000000a002";
const DOC = "00000000-0000-4000-8000-0000000d0001";
const ITEM = "00000000-0000-4000-8000-0000000c0001";
const LINE = "00000000-0000-4000-8000-0000000c1001";
const INBOX = "00000000-0000-4000-8000-0000000c2001";

const PRICES = {
  asOf: "2026-11-02",
  rows: [
    {
      catalogItemId: ITEM,
      item: "Baltic birch plywood 3/4in 60x60in BB/BB",
      category: "sheet_goods",
      standardUom: "sheet",
      vendorId: "v1",
      vendor: "Northline Panel Supply",
      lastPrice: "68.5000",
      lastOn: "2026-10-28",
      previousPrice: "62.5000",
      changePct: "9.6",
      series: [
        { on: "2026-10-01", price: "62.5000" },
        { on: "2026-10-28", price: "68.5000" },
      ],
      purchases90: 2,
      qty90: "80.0000",
      openAlerts: 1,
    },
    {
      catalogItemId: "00000000-0000-4000-8000-0000000c0002",
      item: "Red oak 4/4 FAS rough",
      category: "hardwood",
      standardUom: "board_foot",
      vendorId: "v2",
      vendor: "Keystone Lumber",
      lastPrice: "4.8000",
      lastOn: "2026-10-20",
      previousPrice: "4.9000",
      changePct: "-2.04",
      series: [{ on: "2026-10-20", price: "4.8000" }],
      purchases90: 1,
      qty90: "300.0000",
      openAlerts: 0,
    },
  ],
  alerts: [
    {
      id: "00000000-0000-4000-8000-0000000a1001",
      kind: "price_jump",
      severity: "warning",
      status: "open",
      title: "Baltic birch plywood 3/4in 60x60in BB/BB up 9.6% at Northline Panel Supply",
      body: "$68.50 a sheet on 2026-10-28, up from $62.50 on 2026-10-01.",
      dollarImpact: "480.0000",
      createdAt: "2026-11-02T10:00:00.000Z",
      catalogItemId: ITEM,
      vendorId: "v1",
      evidence: [LINE],
      documents: [{ id: DOC, label: "Northline Panel Supply invoice 20418" }],
    },
  ],
  totals: { items: 2, vendors: 2, openAlerts: 1, dollarImpact: "480.0000" },
};

function renderWith(
  node: React.ReactNode,
  routes: Parameters<typeof fakeApi>[0],
  session = CLIENT_SESSION,
) {
  const api = fakeApi({ "GET /api/session": () => session, ...routes });
  render(
    <MemoryRouter>
      <AppProviders client={api.client}>
        <Routes>
          <Route path="*" element={node} />
        </Routes>
      </AppProviders>
    </MemoryRouter>,
  );
  return api;
}

describe("Price watch", () => {
  it("shows each item and vendor with its last price, change and 90-day line, and the alerts", async () => {
    renderWith(<PriceWatchView />, {
      "GET /api/reports/materials/prices": () => ({ report: PRICES }),
    });
    const table = await screen.findByTestId("materials-prices-table");
    const rows = within(table).getAllByTestId("materials-price-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Baltic birch plywood 3/4in 60x60in BB/BB");
    expect(rows[0]).toHaveTextContent("$68.50");
    expect(rows[0]).toHaveTextContent("+9.6%");
    expect(rows[0]).toHaveTextContent("1 alert");
    expect(rows[1]).toHaveTextContent("−2.0%");
    expect(within(rows[0] as HTMLElement).getByTestId("materials-sparkline")).toHaveAttribute(
      "aria-label",
      expect.stringContaining("2 prices"),
    );
    expect(screen.getByTestId("materials-stat-impact")).toHaveTextContent("$480.00");
    const alerts = screen.getByTestId("materials-alerts");
    expect(alerts).toHaveTextContent("Price up");
    expect(alerts).toHaveTextContent("$480.00 at stake");
    expect(within(alerts).getByTestId("materials-alert-receipt")).toHaveAttribute(
      "href",
      `/documents/${DOC}`,
    );
    expect(screen.getByTestId("materials-prices-csv")).toHaveAttribute(
      "href",
      "/api/reports/materials/prices/csv",
    );

    await userEvent.type(screen.getByTestId("materials-prices-filter"), "oak");
    expect(within(table).getAllByTestId("materials-price-row")).toHaveLength(1);
  });

  it("shows the back office a client's, from that client's route", async () => {
    const api = renderWith(
      <PriceWatchView clientId={CLIENT} clientName="Demo client" />,
      {
        [`GET /api/ops/clients/${CLIENT}/reports/materials/prices`]: () => ({ report: PRICES }),
      },
      OPERATOR_SESSION,
    );
    await screen.findByTestId("materials-prices-table");
    expect(api.calls).toContain(`GET /api/ops/clients/${CLIENT}/reports/materials/prices`);
    expect(screen.getByTestId("materials-prices-csv")).toHaveAttribute(
      "href",
      `/api/ops/clients/${CLIENT}/reports/materials/prices/csv`,
    );
    expect(screen.getByText(/Demo client/)).toBeInTheDocument();
  });

  it("says so when there are no prices yet", async () => {
    renderWith(<PriceWatchView />, {
      "GET /api/reports/materials/prices": () => ({
        report: {
          ...PRICES,
          rows: [],
          alerts: [],
          totals: { items: 0, vendors: 0, openAlerts: 0, dollarImpact: "0" },
        },
      }),
    });
    expect(await screen.findByText(/No prices yet/)).toBeInTheDocument();
    expect(screen.getByText(/No open alerts/)).toBeInTheDocument();
  });

  it("reads in the client's language, with money, changes and days in its locale", async () => {
    renderWith(
      <PriceWatchView />,
      { "GET /api/reports/materials/prices": () => ({ report: PRICES }) },
      { ...CLIENT_SESSION, language: { effective: "de", user: "de", client: null } },
    );
    const table = await screen.findByTestId("materials-prices-table");
    expect(screen.getByRole("heading", { name: "Preisbeobachtung" })).toBeInTheDocument();
    const [first, second] = within(table).getAllByTestId("materials-price-row");
    expect(first).toHaveTextContent("68,50 $");
    expect(first).toHaveTextContent("/ Platte");
    expect(first).toHaveTextContent("+9,6 %");
    expect(first).toHaveTextContent("1 Hinweis");
    expect(first).toHaveTextContent("Plattenware · 2 Käufe in 90 Tagen");
    expect(first).toHaveTextContent("28. Okt. 2026");
    expect(second).toHaveTextContent("Hartholz");
    const alerts = screen.getByTestId("materials-alerts");
    expect(alerts).toHaveTextContent("Preis gestiegen");
    expect(alerts).toHaveTextContent("480,00 $ betroffen");
    // The alert's own text is the pack's, as written.
    expect(alerts).toHaveTextContent("Baltic birch plywood 3/4in 60x60in BB/BB up 9.6%");
    expect(screen.getByTestId("materials-stat-items")).toHaveTextContent("2 Artikel");
    expect(screen.getByTestId("materials-prices-csv")).toHaveTextContent("CSV herunterladen");
  });
});

describe("Catalog", () => {
  it("lists the items with their unit, vendors and last price", async () => {
    renderWith(<CatalogView />, {
      "GET /api/reports/materials/catalog": () => ({
        report: {
          items: [
            {
              id: ITEM,
              category: "sheet_goods",
              name: "Baltic birch plywood 3/4in 60x60in BB/BB",
              standardUom: "sheet",
              attributes: { thickness: "3/4in", thickness_mm: "19.1", grade: "bb/bb" },
              vendors: 3,
              aliases: 4,
              purchases: 12,
              lastPrice: "68.5000",
              lastOn: "2026-10-28",
            },
          ],
        },
      }),
    });
    const row = await screen.findByTestId("materials-catalog-row");
    expect(row).toHaveTextContent("Sheet goods");
    expect(row).toHaveTextContent("thickness 3/4in · grade bb/bb");
    expect(row).not.toHaveTextContent("19.1");
    expect(row).toHaveTextContent("$68.50");
    expect(screen.getByTestId("materials-catalog-csv")).toHaveAttribute(
      "href",
      "/api/reports/materials/catalog/csv",
    );
  });
});

describe("the back office's catalog merge", () => {
  it("merges an item into another of the same category and unit", async () => {
    const row = (id: string, name: string, category = "sheet_goods") => ({
      id,
      category,
      name,
      standardUom: category === "hardwood" ? "board_foot" : "sheet",
      attributes: {},
      vendors: 1,
      aliases: 1,
      purchases: 1,
      lastPrice: null,
      lastOn: null,
    });
    const bodies: unknown[] = [];
    const DUP = "00000000-0000-4000-8000-0000000c0009";
    renderWith(
      <CatalogView clientId={CLIENT} />,
      {
        [`GET /api/ops/clients/${CLIENT}/reports/materials/catalog`]: () => ({
          report: {
            items: [
              row(ITEM, "Baltic birch plywood 3/4in 60x60in BB/BB"),
              row(DUP, "Baltic birch plywood 3/4in"),
              row("00000000-0000-4000-8000-0000000c0003", "Red oak 4/4", "hardwood"),
            ],
          },
        }),
        [`POST /api/ops/clients/${CLIENT}/packs/materials/actions/merge-items`]: ({ init }) => {
          bodies.push(JSON.parse(String(init.body)));
          return { result: { intoId: ITEM, merged: [DUP] } };
        },
      },
      OPERATOR_SESSION,
    );
    const control = await screen.findByTestId(`materials-merge-${DUP}`);
    const select = within(control).getByRole("combobox");
    // Only same category and unit: the oak isn't offered.
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Same as…", "Baltic birch plywood 3/4in 60x60in BB/BB"]);
    await userEvent.selectOptions(select, ITEM);
    await userEvent.click(within(control).getByTestId("materials-merge-submit"));
    await waitFor(() => expect(bodies).toEqual([{ fromId: DUP, intoId: ITEM }]));
  });
});

describe("the match review card", () => {
  const line = (over: Record<string, unknown> = {}) => ({
    docLineId: LINE,
    lineNo: 3,
    description: "BB PLY 3/4 5X5",
    vendorSku: "BB34",
    qty: "10.0000",
    uom: "SHT",
    unitPrice: "64.0000",
    decision: "unsure",
    method: "llm",
    catalogItemId: null,
    catalogItemName: null,
    candidates: [
      {
        catalogItemId: ITEM,
        name: "Baltic birch plywood 3/4in 60x60in BB/BB",
        confidence: 0.75,
        vetoed: false,
      },
      {
        catalogItemId: "x",
        name: "Baltic birch plywood 1/2in 60x60in BB/BB",
        confidence: 0,
        vetoed: true,
      },
    ],
    ...over,
  });
  const item = {
    id: INBOX,
    kind: "request",
    title: "Which catalog items are these invoice lines?",
    payload: {
      review: "materials.match",
      documentId: DOC,
      docLineIds: [LINE],
      nodeId: "review-matches",
    },
    status: "open",
    runId: null,
    dueAt: null,
    createdAt: "2026-11-02T10:00:00.000Z",
    resolvedAt: null,
  };

  it("matches a line to a candidate, then finishes the review", async () => {
    const bodies: unknown[] = [];
    let decided = false;
    const resolved: unknown[] = [];
    renderWith(
      <InboxCard
        item={item}
        onResolve={async (b) => {
          resolved.push(b);
        }}
      />,
      {
        [`GET /api/inbox/${INBOX}/pack-review`]: () => ({
          review: "materials.match",
          status: "open",
          canDecide: true,
          data: { documentId: DOC, lines: [line()] },
        }),
        [`POST /api/inbox/${INBOX}/pack-review`]: ({ init }) => {
          bodies.push(JSON.parse(String(init.body)));
          decided = true;
          return {
            review: "materials.match",
            status: "open",
            canDecide: true,
            data: {
              documentId: DOC,
              lines: [
                line({
                  decision: "matched",
                  method: "human",
                  catalogItemId: ITEM,
                  catalogItemName: "Baltic birch plywood 3/4in 60x60in BB/BB",
                }),
              ],
            },
          };
        },
      },
    );
    const card = await screen.findByTestId("match-review");
    // The plain answer box is replaced by the card.
    expect(screen.queryByTestId("inbox-item-answer-input")).toBeNull();
    expect(within(card).getByTestId("match-review-state")).toHaveTextContent("Waiting on you");
    expect(within(card).getByText(/10 SHT at \$64\.00/)).toBeInTheDocument();
    expect(within(card).getByRole("option")).toHaveTextContent("(75% sure)");
    // Vetoed near-misses are not offered.
    const select = within(card).getByTestId("match-review-candidate");
    expect(within(select).getAllByRole("option")).toHaveLength(1);
    expect(within(card).getByTestId("match-review-finish")).toBeDisabled();

    await userEvent.click(within(card).getByTestId("match-review-match"));
    await waitFor(() => expect(decided).toBe(true));
    expect(bodies).toEqual([{ docLineId: LINE, action: "match", catalogItemId: ITEM }]);
    expect(await within(card).findByText("Matched")).toBeInTheDocument();
    expect(within(card).getByText(/Now Baltic birch plywood 3\/4in/)).toBeInTheDocument();

    await userEvent.click(within(card).getByTestId("match-review-finish"));
    expect(resolved).toEqual([{ decision: "approve", answer: { reviewed: 1, skipped: [] } }]);
  });

  it("counts a skipped line as done, and shows the lines read-only to someone else", async () => {
    renderWith(<InboxCard item={item} onResolve={async () => {}} />, {
      [`GET /api/inbox/${INBOX}/pack-review`]: () => ({
        review: "materials.match",
        status: "open",
        canDecide: true,
        data: { documentId: DOC, lines: [line()] },
      }),
      [`POST /api/inbox/${INBOX}/pack-review`]: () => ({
        review: "materials.match",
        status: "open",
        canDecide: true,
        data: { documentId: DOC, lines: [line()] },
      }),
    });
    const card = await screen.findByTestId("match-review");
    await userEvent.click(within(card).getByTestId("match-review-skip"));
    expect(await within(card).findByText("Skipped")).toBeInTheDocument();
    expect(within(card).getByTestId("match-review-finish")).toBeEnabled();
  });

  it("shows the back office the lines without buttons when the client decides", async () => {
    renderWith(
      <InboxCard
        item={item}
        surface="ops"
        onResolve={null}
        waitingOn="Waiting on the client admin"
      />,
      {
        [`GET /api/ops/inbox/${INBOX}/pack-review`]: () => ({
          review: "materials.match",
          status: "open",
          canDecide: false,
          data: { documentId: DOC, lines: [line()] },
        }),
      },
      OPERATOR_SESSION,
    );
    const card = await screen.findByTestId("match-review");
    expect(within(card).queryByTestId("match-review-match")).toBeNull();
    expect(within(card).queryByTestId("match-review-finish")).toBeNull();
    expect(screen.getByText("Waiting on the client admin")).toBeInTheDocument();
  });
});

describe("pack pages", () => {
  it("switches a pack on for a client from the Packs page, installing no agent", async () => {
    let enabled = false;
    const api = renderWith(
      <OpsPacksScreen />,
      {
        "GET /api/ops/packs": () => ({
          packs: [
            {
              id: "materials",
              name: "Materials",
              version: "0.1.0",
              description: "Material cost management.",
              templates: [],
              screens: [{ route: "/reports/materials/prices", title: "Price watch" }],
              clients: [
                {
                  id: CLIENT,
                  name: "Demo client",
                  enabled,
                  enabledAt: enabled ? "2026-11-02T10:00:00.000Z" : null,
                },
              ],
            },
          ],
        }),
        [`POST /api/ops/clients/${CLIENT}/packs/materials/enable`]: () => {
          enabled = true;
          return {
            pack: {
              id: "materials",
              name: "Materials",
              description: "",
              enabled: true,
              enabledAt: "2026-11-02T10:00:00.000Z",
              screens: [],
            },
            installed: [],
          };
        },
      },
      OPERATOR_SESSION,
    );
    const pack = await screen.findByTestId("ops-pack-materials");
    expect(pack).not.toHaveTextContent("Templates");
    await userEvent.click(within(pack).getByTestId(`pack-enable-materials-${CLIENT}`));
    await waitFor(() => expect(within(pack).getByText(/^On since/)).toBeInTheDocument());
    expect(api.calls).toContain(`POST /api/ops/clients/${CLIENT}/packs/materials/enable`);
    expect(screen.queryByTestId("ops-packs-installed")).toBeNull();
  });

  it("registers Price watch and Catalog as the portal's reports for clients with the pack on", () => {
    const reports = packReportsFor(["materials"]);
    expect(reports.map((r) => [EN.t(r.titleKey), packReportPath(r)])).toEqual([
      ["Price watch", "/reports/materials/prices"],
      ["Catalog", "/reports/materials/catalog"],
      // §1.88
      ["Vendor catalog", "/reports/materials/vendor-catalog"],
      // P-9
      ["Purchase requests", "/reports/materials/requests"],
    ]);
    // Titles and descriptions are message keys, so the portal reads them in the client's language.
    const de = createI18n("de");
    expect(reports.map((r) => de.t(r.titleKey))).toEqual([
      "Preisbeobachtung",
      "Katalog",
      "Lieferantenkatalog",
      "Bestellanfragen",
    ]);
    expect(de.t("materials.catalog.description")).toMatch(/Lieferant/);
    expect(packReportsFor([])).toEqual([]);
  });
});
