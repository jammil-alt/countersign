// The back office's view of a client's documents (plan §1.16): the list through the client's ops
// route, a document page with its reading, the purchase it is matched to, and a fresh 5-minute
// link to the original each time it is opened.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { fakeApi, OPERATOR_SESSION } from "../../test/fixtures";

const CLIENT = "00000000-0000-4000-8000-00000000a002";
const DOC = "00000000-0000-4000-8000-0000000a8001";
const TXN = "00000000-0000-4000-8000-0000000a8002";

const SUMMARY = {
  id: DOC,
  source: "email",
  filename: "northline-20418.pdf",
  mimeType: "application/pdf",
  sizeBytes: 48_000,
  status: "needs_review",
  pageCount: 1,
  transactionId: TXN,
  receivedAt: "2026-10-29T10:00:00.000Z",
  vendorName: "Northline Panel Supply",
  invoiceNumber: "20418",
  total: "9742.3500",
};

const DETAIL = {
  document: { ...SUMMARY, meta: { email: { from: "ap@shop.example.com" } } },
  url: "https://files.example.com/northline?sig=1",
  urlExpiresAt: "2026-10-29T10:05:00.000Z",
  extraction: {
    id: "00000000-0000-4000-8000-0000000a8003",
    createdAt: "2026-10-29T10:01:00.000Z",
    vendorName: "Northline Panel Supply",
    invoiceNumber: "20418",
    invoiceDate: "2026-10-28",
    dueDate: null,
    poNumber: "J-118",
    currency: "USD",
    subtotal: "9000.0000",
    freight: "0.0000",
    surcharges: [],
    tax: "742.3500",
    total: "9742.3500",
    linesSum: "8990.0000",
    totalsMatch: false,
    problems: ["Lines add up to $8,990.00, not the subtotal $9,000.00."],
    lines: [
      {
        lineNo: 1,
        vendorSku: "BB34",
        description: "Baltic birch 3/4in",
        qty: "40.0000",
        uom: "SHT",
        unitPrice: "224.7500",
        extPrice: "8990.0000",
        page: 1,
      },
    ],
  },
};

function renderAt(path: string) {
  const api = fakeApi({
    "GET /api/session": () => OPERATOR_SESSION,
    [`GET /api/ops/clients/${CLIENT}/documents`]: () => ({ documents: [SUMMARY] }),
    [`GET /api/ops/clients/${CLIENT}/documents/${DOC}`]: () => DETAIL,
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

afterEach(() => vi.restoreAllMocks());

describe("back-office documents", () => {
  it("lists the client's documents and opens one", async () => {
    renderAt(`/ops/clients/${CLIENT}/documents`);
    const table = await screen.findByTestId("ops-documents");
    const row = within(table).getByTestId(`ops-document-row-${DOC}`);
    expect(row).toHaveTextContent("Invoice 20418");
    expect(row).toHaveTextContent("Forwarded");
    expect(row).toHaveTextContent("Northline Panel Supply");
    expect(row).toHaveTextContent("$9,742.35");
    expect(row).toHaveTextContent("Needs review");
    expect(screen.getByText(/Demo client · 1 document/)).toBeInTheDocument();
    expect(screen.getByTestId("ops-nav-documents")).toHaveAttribute(
      "href",
      `/ops/clients/${CLIENT}/documents`,
    );
    expect(within(row).getByRole("link", { name: "Purchase" })).toHaveAttribute(
      "href",
      `/ops/clients/${CLIENT}/records/${TXN}`,
    );
    await userEvent.setup().click(within(row).getByRole("link", { name: "Invoice 20418" }));
    expect(await screen.findByTestId("ops-document-status")).toHaveTextContent("Needs review");
  });

  it("shows the reading, its problems and the purchase, and opens a fresh link", async () => {
    const opened = vi.spyOn(window, "open").mockImplementation(() => null);
    const api = renderAt(`/ops/clients/${CLIENT}/documents/${DOC}`);
    expect(await screen.findByTestId("ops-document-problems")).toHaveTextContent(
      "Lines add up to $8,990.00",
    );
    expect(screen.getByTestId("ops-document-lines")).toHaveTextContent("Baltic birch 3/4in");
    expect(screen.getByTestId("ops-document-totals")).toHaveTextContent("$9,742.35");
    expect(screen.getByTestId("ops-document-transaction")).toHaveAttribute(
      "href",
      `/ops/clients/${CLIENT}/records/${TXN}`,
    );
    const before = api.calls.filter((c) => c.endsWith(`/documents/${DOC}`)).length;
    await userEvent.setup().click(screen.getByTestId("ops-document-original"));
    expect(opened).toHaveBeenCalledWith(DETAIL.url, "_blank", "noopener,noreferrer");
    expect(api.calls.filter((c) => c.endsWith(`/documents/${DOC}`)).length).toBe(before + 1);
    // Back-office words, not the client's.
    expect(document.body.textContent).not.toContain("Your team at Mezonas");
  });
});
