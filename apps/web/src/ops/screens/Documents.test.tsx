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
  receivedAt: "2026-10-29T10:00:00.000Z",
  vendorName: "Northline Panel Supply",
  invoiceNumber: "20418",
  total: "9742.3500",
  // A bill in QuickBooks: named as one, never "a purchase".
  match: { transactionId: TXN, kind: "bill", number: "20418", by: "link" } as {
    transactionId: string;
    kind: string;
    number: string | null;
    by: "link" | "run";
  } | null,
  transactionId: TXN as string | null,
  duplicateOf: null as { documentId: string; filename: string } | null,
};

const COPY = "00000000-0000-4000-8000-0000000a8009";

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

function renderAt(path: string, sandbox = false) {
  let documents = [SUMMARY];
  let copyReads = 0;
  const api = fakeApi({
    "GET /api/session": () => OPERATOR_SESSION,
    [`GET /api/ops/clients/${CLIENT}/documents`]: () => ({ documents, sandbox }),
    [`GET /api/ops/clients/${CLIENT}/documents/${DOC}`]: () => DETAIL,
    // A copy of the invoice: being read, then read as the same invoice as the first.
    [`GET /api/ops/clients/${CLIENT}/documents/${COPY}`]: () => {
      copyReads += 1;
      return {
        ...DETAIL,
        document: {
          ...DETAIL.document,
          id: COPY,
          filename: "northline-20418 copy.pdf",
          status: copyReads > 1 ? "extracted" : "extracting",
          match: null,
          duplicateOf: copyReads > 1 ? { documentId: DOC, filename: "northline-20418.pdf" } : null,
        },
      };
    },
  });
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
  return Object.assign(api, {
    setDocuments: (next: (typeof SUMMARY)[]) => {
      documents = next;
    },
  });
}

afterEach(() => vi.restoreAllMocks());

describe("back-office documents", () => {
  it("lists the client's documents and opens one", async () => {
    renderAt(`/ops/clients/${CLIENT}/documents`);
    // The back office is a lazy chunk: give it time to load on a busy machine.
    const table = await screen.findByTestId("ops-documents", {}, { timeout: 10_000 });
    const row = within(table).getByTestId(`ops-document-row-${DOC}`);
    expect(row).toHaveTextContent("Invoice 20418");
    expect(row).toHaveTextContent("Forwarded");
    expect(row).toHaveTextContent("Northline Panel Supply");
    expect(row).toHaveTextContent("$9,742.35");
    expect(row).toHaveTextContent("Needs review");
    expect(screen.getByText("1 document, newest first")).toBeInTheDocument();
    expect(screen.getByTestId("ops-nav-documents")).toHaveAttribute(
      "href",
      `/ops/clients/${CLIENT}/documents`,
    );
    expect(within(row).getByRole("link", { name: "Bill 20418" })).toHaveAttribute(
      "href",
      `/ops/clients/${CLIENT}/records/${TXN}`,
    );
    // A real client uploads or forwards its own: no upload here.
    expect(screen.queryByTestId("ops-sandbox-upload")).not.toBeInTheDocument();
    await userEvent.setup().click(within(row).getByRole("link", { name: "Invoice 20418" }));
    expect(await screen.findByTestId("ops-document-status")).toHaveTextContent("Needs review");
  }, 20_000);

  it("marks a copy of an invoice already here as a duplicate, and a document with no match", async () => {
    const api = renderAt(`/ops/clients/${CLIENT}/documents`);
    api.setDocuments([
      {
        ...SUMMARY,
        id: COPY,
        filename: "northline-20418 copy.pdf",
        match: null,
        duplicateOf: { documentId: DOC, filename: "northline-20418.pdf" },
      },
      { ...SUMMARY, match: null, transactionId: null },
    ]);
    const copy = await screen.findByTestId(`ops-document-match-${COPY}`, {}, { timeout: 10_000 });
    expect(
      within(copy).getByRole("link", { name: "Duplicate of northline-20418.pdf" }),
    ).toHaveAttribute("href", `/ops/clients/${CLIENT}/documents/${DOC}`);
    expect(screen.getByTestId(`ops-document-match-${DOC}`)).toHaveTextContent("Not yet");
    expect(screen.queryByText("Purchase")).toBeNull();
  }, 20_000);

  it("warns on upload once a new document reads as a copy of one already here", async () => {
    const api = renderAt(`/ops/clients/${CLIENT}/documents`, true);
    const fetched = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({
        results: [
          {
            filename: "northline-20418 copy.pdf",
            kind: "document",
            document: {
              ...SUMMARY,
              id: COPY,
              source: "upload",
              status: "stored",
              filename: "northline-20418 copy.pdf",
              match: null,
            },
            created: true,
            purchases: null,
            error: null,
          },
        ],
      }),
    );
    await screen.findByTestId("ops-sandbox-upload", {}, { timeout: 10_000 });
    await userEvent
      .setup()
      .upload(screen.getByTestId("ops-upload-input"), [
        new File(["%PDF"], "northline-20418 copy.pdf", { type: "application/pdf" }),
      ]);
    const results = await screen.findByTestId("ops-upload-results");
    expect(results).toHaveTextContent("Received");
    // Read a few seconds later: the same invoice as the first.
    expect(
      await within(results).findByText(
        "Same invoice as northline-20418.pdf: we won't process it again.",
        {},
        { timeout: 12_000 },
      ),
    ).toBeInTheDocument();
    expect(api.calls).toContain(`GET /api/ops/clients/${CLIENT}/documents/${COPY}`);
    fetched.mockRestore();
  }, 30_000);

  it("uploads the Sandbox's documents through the back office's route, and lists them", async () => {
    const api = renderAt(`/ops/clients/${CLIENT}/documents`, true);
    api.setDocuments([]);
    const sentTo: string[] = [];
    const fetched = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      sentTo.push(String(input));
      expect(init?.body).toBeInstanceOf(FormData);
      api.setDocuments([{ ...SUMMARY, source: "upload" }]);
      return Response.json({
        results: [
          {
            filename: "northline-20418.pdf",
            kind: "document",
            document: { ...SUMMARY, source: "upload" },
            created: true,
            purchases: null,
            error: null,
          },
          {
            filename: "again.pdf",
            kind: "document",
            document: { ...SUMMARY, source: "upload" },
            created: false,
            purchases: null,
            error: null,
          },
        ],
      });
    });
    const area = await screen.findByTestId("ops-sandbox-upload", {}, { timeout: 10_000 });
    expect(area).toHaveTextContent("you upload its invoices here");
    expect(screen.getByText("No documents yet. Upload an invoice above.")).toBeInTheDocument();
    await userEvent
      .setup()
      .upload(screen.getByTestId("ops-upload-input"), [
        new File(["%PDF"], "northline-20418.pdf", { type: "application/pdf" }),
        new File(["%PDF"], "again.pdf", { type: "application/pdf" }),
      ]);
    const results = await screen.findByTestId("ops-upload-results");
    expect(sentTo).toEqual([`/api/ops/clients/${CLIENT}/uploads`]);
    expect(results).toHaveTextContent("Received");
    expect(results).toHaveTextContent("Already here: we keep one copy.");
    expect(within(results).getByRole("link", { name: "northline-20418.pdf" })).toHaveAttribute(
      "href",
      `/ops/clients/${CLIENT}/documents/${DOC}`,
    );
    // The list reloads with the new document.
    expect(await screen.findByTestId(`ops-document-row-${DOC}`)).toHaveTextContent("Uploaded");
    fetched.mockRestore();
  }, 20_000);

  it("shows the reading, its problems and the purchase, and opens a fresh link", async () => {
    const opened = vi.spyOn(window, "open").mockImplementation(() => null);
    const api = renderAt(`/ops/clients/${CLIENT}/documents/${DOC}`);
    expect(
      await screen.findByTestId("ops-document-problems", {}, { timeout: 10_000 }),
    ).toHaveTextContent("Lines add up to $8,990.00");
    expect(screen.getByTestId("ops-document-lines")).toHaveTextContent("Baltic birch 3/4in");
    expect(screen.getByTestId("ops-document-totals")).toHaveTextContent("$9,742.35");
    expect(screen.getByTestId("ops-document-transaction")).toHaveAttribute(
      "href",
      `/ops/clients/${CLIENT}/records/${TXN}`,
    );
    expect(screen.getByTestId("ops-document-transaction")).toHaveTextContent("Matched to a bill.");
    expect(screen.queryByTestId("ops-document-duplicate")).toBeNull();
    const before = api.calls.filter((c) => c.endsWith(`/documents/${DOC}`)).length;
    await userEvent.setup().click(screen.getByTestId("ops-document-original"));
    expect(opened).toHaveBeenCalledWith(DETAIL.url, "_blank", "noopener,noreferrer");
    expect(api.calls.filter((c) => c.endsWith(`/documents/${DOC}`)).length).toBe(before + 1);
    // Back-office words, not the client's.
    expect(document.body.textContent).not.toContain("Your team at Mezonas");
  }, 20_000);
});
