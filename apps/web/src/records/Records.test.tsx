// Record pages (plan §1.16) in both surfaces: a transaction with its lines, documents and source;
// a raw record as it arrived; a vendor; a document id opening its document page; an id that is no
// record; and the Receipts that link step outputs and inbox items to them.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders } from "../App";
import { InboxCard } from "../inbox/InboxCard";
import { CLIENT_SESSION, fakeApi, OPERATOR_SESSION, Reply } from "../test/fixtures";
import { OpsRecordScreen, PortalRecordScreen } from "./RecordScreens";
import { SourceLinks, sourceLabel } from "./SourceLinks";

const CLIENT = "00000000-0000-4000-8000-00000000a002";
const TXN = "00000000-0000-4000-8000-0000000a7001";
const RAW = "00000000-0000-4000-8000-0000000a7002";
const VENDOR = "00000000-0000-4000-8000-0000000a7003";
const DOC = "00000000-0000-4000-8000-0000000a7004";
const EXTRACTION = "00000000-0000-4000-8000-0000000a7005";

const TRANSACTION = {
  kind: "transaction",
  id: TXN,
  txnKind: "purchase",
  connector: "upload",
  externalId: "abc:1",
  vendor: { id: VENDOR, name: "Northline Panel Supply" },
  txnDate: "2026-10-29",
  total: "9742.3500",
  currency: "USD",
  purchaserRef: "J. Ortiz",
  paymentType: "card",
  memo: "Sheet goods",
  status: "needs_doc",
  createdAt: "2026-10-29T10:00:00.000Z",
  lines: [
    {
      lineNo: 1,
      detailType: "account",
      accountRef: "Materials",
      itemRef: null,
      description: "Baltic birch 3/4in",
      qty: "40.0000",
      unitPrice: "243.5588",
      amount: "9742.3500",
    },
  ],
  documents: [{ id: DOC, filename: "northline-20418.pdf", status: "extracted" }],
  rawRecordId: RAW,
};

const RAW_RECORD = {
  kind: "raw_record",
  id: RAW,
  connector: "upload",
  entityType: "Purchase",
  externalId: "abc:1",
  externalVersion: null,
  syncedAt: "2026-10-29T10:00:00.000Z",
  isDeleted: false,
  payload: {
    cells: { Date: "10/29/2026", Vendor: "Northline Panel Supply", Amount: "9742.35" },
    file: { filename: "card.csv", row: 2 },
  },
  transactions: [
    { id: TXN, txnKind: "purchase", txnDate: "2026-10-29", total: "9742.35", currency: "USD" },
  ],
};

const VENDOR_RECORD = {
  kind: "vendor",
  id: VENDOR,
  name: "Northline Panel Supply",
  aliases: ["Northline"],
  createdAt: "2026-10-01T10:00:00.000Z",
  transactions: RAW_RECORD.transactions,
};

const records: Record<string, unknown> = {
  [TXN]: TRANSACTION,
  [RAW]: RAW_RECORD,
  [VENDOR]: VENDOR_RECORD,
  [EXTRACTION]: {
    kind: "document",
    id: EXTRACTION,
    documentId: DOC,
    filename: "northline-20418.pdf",
    status: "extracted",
    source: "upload",
    receivedAt: "2026-10-29T10:00:00.000Z",
  },
};

function portal(id: string) {
  const api = fakeApi({ "GET /api/session": () => CLIENT_SESSION });
  for (const [rid, record] of Object.entries(records)) {
    api.on(`GET /api/records/${rid}`, () => ({ record }));
  }
  render(
    <MemoryRouter initialEntries={[`/records/${id}`]}>
      <AppProviders client={api.client}>
        <Routes>
          <Route path="/records/:id" element={<PortalRecordScreen />} />
          <Route path="/documents/:id" element={<p>The document page</p>} />
        </Routes>
      </AppProviders>
    </MemoryRouter>,
  );
  return api;
}

describe("portal record pages", () => {
  it("shows a transaction: what it says, its lines, documents and where it came from", async () => {
    portal(TXN);
    const page = await screen.findByTestId("record-transaction");
    expect(page).toHaveTextContent("Purchase · $9,742.35");
    expect(screen.getByTestId("record-status")).toHaveTextContent("Needs a document");
    expect(within(page).getByText("Northline Panel Supply")).toHaveAttribute(
      "href",
      `/records/${VENDOR}`,
    );
    expect(screen.getByTestId("record-lines")).toHaveTextContent("Baltic birch 3/4in");
    expect(screen.getByTestId("record-documents")).toHaveTextContent("northline-20418.pdf");
    expect(within(screen.getByTestId("record-documents")).getByRole("link")).toHaveAttribute(
      "href",
      `/documents/${DOC}`,
    );
    expect(screen.getByTestId("record-origin")).toHaveTextContent("Upload");
    expect(screen.getByTestId("record-raw-link")).toHaveAttribute("href", `/records/${RAW}`);
  });

  it("shows a raw record as it arrived, from the file's own columns", async () => {
    portal(RAW);
    const page = await screen.findByTestId("record-raw");
    expect(page).toHaveTextContent("Purchase from Upload");
    expect(page).toHaveTextContent("card.csv, row 2");
    const payload = screen.getByTestId("record-payload");
    expect(payload).toHaveTextContent("Vendor");
    expect(payload).toHaveTextContent("Northline Panel Supply");
    expect(within(screen.getByTestId("record-transactions")).getByRole("link")).toHaveAttribute(
      "href",
      `/records/${TXN}`,
    );
  });

  it("shows a vendor with its transactions", async () => {
    portal(VENDOR);
    const page = await screen.findByTestId("record-vendor");
    expect(page).toHaveTextContent("Northline Panel Supply");
    expect(page).toHaveTextContent("Also known as Northline");
    expect(screen.getByTestId("record-transactions")).toHaveTextContent("$9,742.35");
  });

  it("opens an extraction's document page", async () => {
    portal(EXTRACTION);
    expect(await screen.findByText("The document page")).toBeInTheDocument();
  });

  it("says when an id is no record it can show", async () => {
    portal("00000000-0000-4000-8000-0000000a7999");
    expect(await screen.findByTestId("record-not-found")).toBeInTheDocument();
  });
});

describe("back-office record pages", () => {
  it("reads the record through the client's ops route and links within that client", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/clients/${CLIENT}/records/${TXN}`]: () => ({ record: TRANSACTION }),
    });
    render(
      <MemoryRouter initialEntries={[`/ops/clients/${CLIENT}/records/${TXN}`]}>
        <AppProviders client={api.client}>
          <Routes>
            <Route path="/ops/clients/:clientId/records/:recordId" element={<OpsRecordScreen />} />
          </Routes>
        </AppProviders>
      </MemoryRouter>,
    );
    await screen.findByTestId("record-transaction");
    expect(screen.getByTestId("record-raw-link")).toHaveAttribute(
      "href",
      `/ops/clients/${CLIENT}/records/${RAW}`,
    );
    expect(within(screen.getByTestId("record-documents")).getByRole("link")).toHaveAttribute(
      "href",
      `/ops/clients/${CLIENT}/documents/${DOC}`,
    );
    expect(api.calls).not.toContain(`GET /api/records/${TXN}`);
  });

  it("shows a refusal from the API as an error", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/clients/${CLIENT}/records/${TXN}`]: () =>
        new Reply(403, { error: { code: "forbidden", message: "no" } }),
    });
    render(
      <MemoryRouter initialEntries={[`/ops/clients/${CLIENT}/records/${TXN}`]}>
        <AppProviders client={api.client}>
          <Routes>
            <Route path="/ops/clients/:clientId/records/:recordId" element={<OpsRecordScreen />} />
          </Routes>
        </AppProviders>
      </MemoryRouter>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("You don't have access to this.");
  });
});

describe("source links", () => {
  it("links record ids to their pages and leaves other ids as plain receipts", async () => {
    render(
      <MemoryRouter>
        <SourceLinks ids={[TXN, "r1"]} href={(id) => `/records/${id}`} testId="sources" />
      </MemoryRouter>,
    );
    const sources = screen.getByTestId("sources");
    expect(within(sources).getByRole("link")).toHaveAttribute("href", `/records/${TXN}`);
    expect(within(sources).getByRole("link")).toHaveTextContent(sourceLabel(TXN));
    expect(sources).toHaveTextContent("r1");
  });

  it("shows an inbox item's sources as receipts, not as a fact", async () => {
    render(
      <MemoryRouter initialEntries={["/inbox"]}>
        <Routes>
          <Route
            path="/inbox"
            element={
              <InboxCard
                item={{
                  id: "00000000-0000-4000-8000-0000000a7101",
                  kind: "extraction_review",
                  title: "Check the totals",
                  payload: { details: "Lines don't add up", sources: [DOC, EXTRACTION] },
                  status: "open",
                  runId: null,
                  dueAt: null,
                  createdAt: "2026-10-29T10:00:00.000Z",
                  resolvedAt: null,
                }}
                recordHref={(id) => `/records/${id}`}
                onResolve={null}
              />
            }
          />
          <Route path="/records/:id" element={<p>The record page</p>} />
        </Routes>
      </MemoryRouter>,
    );
    const links = within(screen.getByTestId("inbox-item-sources")).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      `/records/${DOC}`,
      `/records/${EXTRACTION}`,
    ]);
    expect(screen.queryByText("Sources")).not.toBeInTheDocument();
    await userEvent.setup().click(links[0] as HTMLElement);
    expect(await screen.findByText("The record page")).toBeInTheDocument();
  });
});
