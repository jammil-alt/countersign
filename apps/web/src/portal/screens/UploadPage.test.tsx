// `/upload` (UI-3a): drop or choose files, see the latest documents and open each; the forwarding
// address and who may forward in the rail, which the admin edits.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { CLIENT_SESSION, fakeApi } from "../../test/fixtures";

const DOC = "00000000-0000-4000-8000-0000000d0001";

const document = {
  id: DOC,
  source: "upload",
  filename: "northline-20418.pdf",
  mimeType: "application/pdf",
  sizeBytes: 120_000,
  status: "extracted",
  pageCount: 1,
  transactionId: null,
  receivedAt: "2026-11-05T10:00:00.000Z",
  vendorName: "Northline Panel Supply",
  invoiceNumber: "20418",
  total: "9742.3500",
  match: null,
  duplicateOf: null,
};

const forwarding = (allowedSenders: string[]) => ({
  forwarding: {
    available: true,
    address: "ap-7f3k@in.mezonas.com",
    allowedSenders,
    accepted: 4,
    dropped: 0,
    lastReceivedAt: null,
    lastDroppedAt: null,
    lastDropReason: null,
  },
});

function renderAt(path: string, api: ReturnType<typeof fakeApi>) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("portal upload", () => {
  it("uploads a file, lists the documents and saves who may forward", async () => {
    const puts: unknown[] = [];
    let allowed: string[] = [];
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/documents": () => ({ documents: [document] }),
      "GET /api/connections/upload/forwarding": () => forwarding(allowed),
      "PUT /api/connections/upload/senders": ({ init }) => {
        const body = JSON.parse(String(init.body));
        puts.push(body);
        allowed = body.allowed;
        return forwarding(allowed);
      },
    });
    // Uploads go as multipart through the browser's fetch, not the JSON client.
    const sent: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      sent.push(String(input));
      return new Response(
        JSON.stringify({
          results: [
            {
              filename: "receipt.pdf",
              kind: "document",
              document: { ...document, id: DOC, filename: "receipt.pdf" },
              created: true,
              purchases: null,
              error: null,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    renderAt("/upload", api);

    expect(await screen.findByRole("heading", { name: "Upload documents" })).toBeInTheDocument();
    const docs = await screen.findByTestId("portal-documents");
    expect(within(docs).getByTestId(`portal-document-${DOC}-open`)).toHaveAttribute(
      "href",
      `/documents/${DOC}`,
    );
    expect(docs).toHaveTextContent("Invoice 20418");

    await userEvent.upload(
      screen.getByTestId("portal-upload-input"),
      new File(["%PDF"], "receipt.pdf", { type: "application/pdf" }),
    );
    expect(await screen.findByTestId("portal-upload-results")).toHaveTextContent("Received");
    expect(sent).toEqual(["/api/uploads"]);

    expect(await screen.findByTestId("portal-forwarding-address")).toHaveTextContent(
      "ap-7f3k@in.mezonas.com",
    );
    await userEvent.click(screen.getByTestId("portal-forwarding-edit"));
    await userEvent.type(screen.getByTestId("portal-forwarding-senders-input"), "northline.com");
    await userEvent.click(screen.getByTestId("portal-forwarding-save"));
    await waitFor(() => expect(puts).toEqual([{ allowed: ["northline.com"] }]));
    expect(await screen.findByTestId("portal-forwarding-senders")).toHaveTextContent(
      "northline.com",
    );
  });

  it("marks a second copy of an invoice, and says when the same file came", async () => {
    const SECOND = "00000000-0000-4000-8000-0000000d0002";
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/documents": () => ({
        documents: [
          {
            ...document,
            id: SECOND,
            filename: "northline-20418-scan.pdf",
            receivedAt: "2026-11-05T10:32:00.000Z",
            duplicateOf: { documentId: DOC, filename: "northline-20418.pdf" },
          },
          document,
        ],
      }),
      "GET /api/connections/upload/forwarding": () => forwarding([]),
    });
    // The same bytes again: the first document comes back, `created` false.
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            results: [
              {
                filename: "northline-20418.pdf",
                kind: "document",
                document,
                created: false,
                purchases: null,
                error: null,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    renderAt("/upload", api);

    // A second copy of an invoice already here is marked as a duplicate (it started nothing).
    expect(await screen.findByTestId(`portal-document-${SECOND}-duplicate`)).toBeInTheDocument();
    expect(screen.queryByTestId(`portal-document-${DOC}-duplicate`)).toBeNull();

    await userEvent.upload(
      screen.getByTestId("portal-upload-input"),
      new File(["%PDF"], "northline-20418.pdf", { type: "application/pdf" }),
    );
    expect(await screen.findByTestId("portal-upload-results")).toHaveTextContent(
      /Same file as the one received at .+\. We keep one copy\./,
    );
  });
});
