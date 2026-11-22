// R3: a record's Runs panel (docs/plan.md §1.194) in both surfaces: the runs about it, newest
// first as the API sends them, each with what it did ("Read", "Matched", "Changed in QuickBooks")
// and the step's line, a link to the run, and an empty state.
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders } from "../App";
import { CLIENT_SESSION, fakeApi, OPERATOR_SESSION } from "../test/fixtures";
import { OpsRecordScreen, PortalRecordScreen } from "./RecordScreens";
import { RecordRuns } from "./RecordRuns";

const CLIENT = "00000000-0000-4000-8000-00000000a002";
const VENDOR = "00000000-0000-4000-8000-0000000a7003";
const R1 = "00000000-0000-4000-8000-0000000b0001";
const R2 = "00000000-0000-4000-8000-0000000b0002";

const VENDOR_RECORD = {
  kind: "vendor",
  id: VENDOR,
  name: "Northline Panel Supply",
  aliases: [],
  createdAt: "2026-10-01T10:00:00.000Z",
  transactions: [],
};

const RUNS = [
  {
    id: R2,
    service: { id: "a1", name: "Bill clerk" },
    status: "succeeded",
    startedAt: "2026-11-02T10:00:00.000Z",
    finishedAt: "2026-11-02T10:01:00.000Z",
    waitingOnYou: false,
    subject: { kind: "document", vendor: "Northline Panel Supply", number: "20418", filename: null },
    roles: [
      { role: "read", connector: null, summary: "Read the invoice" },
      { role: "changed", connector: "qbo", summary: "Entered bill 20418" },
    ],
  },
  {
    id: R1,
    service: { id: "a2", name: "PO clerk" },
    status: "running",
    startedAt: "2026-11-01T10:00:00.000Z",
    finishedAt: null,
    waitingOnYou: true,
    roles: [{ role: "decided", connector: null, summary: null }],
  },
];

describe("a record's Runs panel", () => {
  it("lists the portal's runs about a vendor, with what each did and its step's line", async () => {
    const api = fakeApi({ "GET /api/session": () => CLIENT_SESSION });
    api.on(`GET /api/records/${VENDOR}`, () => ({ record: VENDOR_RECORD }));
    api.on(`GET /api/records/${VENDOR}/runs`, () => ({ runs: RUNS }));
    render(
      <MemoryRouter initialEntries={[`/records/${VENDOR}`]}>
        <AppProviders client={api.client}>
          <Routes>
            <Route path="/records/:id" element={<PortalRecordScreen />} />
          </Routes>
        </AppProviders>
      </MemoryRouter>,
    );
    const first = await screen.findByTestId(`record-runs-${R2}`);
    expect(within(first).getByText("Northline Panel Supply · Invoice 20418")).toHaveAttribute(
      "href",
      `/runs/${R2}`,
    );
    expect(first).toHaveTextContent("Bill clerk");
    expect(within(first).getByTestId(`record-runs-${R2}-roles`)).toHaveTextContent(
      "Read · Read the invoiceChanged in QuickBooks · Entered bill 20418",
    );
    const second = screen.getByTestId(`record-runs-${R1}`);
    expect(second).toHaveTextContent("Matched");
    expect(second).toHaveTextContent("Waiting on you");
    // Newest first, as the API sends them.
    const rows = within(screen.getByTestId("record-runs")).getAllByRole("listitem");
    expect(rows[0]).toBe(first);
  });

  it("says so when no run was about it, in the back office too", async () => {
    const api = fakeApi({ "GET /api/session": () => OPERATOR_SESSION });
    api.on(`GET /api/ops/clients/${CLIENT}/records/${VENDOR}`, () => ({ record: VENDOR_RECORD }));
    api.on(`GET /api/ops/clients/${CLIENT}/records/${VENDOR}/runs`, () => ({ runs: [] }));
    render(
      <MemoryRouter initialEntries={[`/ops/clients/${CLIENT}/records/${VENDOR}`]}>
        <AppProviders client={api.client}>
          <Routes>
            <Route path="/ops/clients/:clientId/records/:recordId" element={<OpsRecordScreen />} />
          </Routes>
        </AppProviders>
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("record-runs-empty")).toHaveTextContent(
      "No run has been about this yet.",
    );
  });

  it("links the back office's runs to its run pages and marks a test run", async () => {
    const api = fakeApi({ "GET /api/session": () => OPERATOR_SESSION });
    api.on(`GET /api/ops/clients/${CLIENT}/records/${VENDOR}/runs`, () => ({
      runs: [{ ...RUNS[0], waitingOnYou: undefined, mode: "test" }],
    }));
    render(
      <MemoryRouter>
        <AppProviders client={api.client}>
          <RecordRuns
            source={{ surface: "ops", clientId: CLIENT }}
            recordId={VENDOR}
            runHref={(r) => `/ops/runs/${r}`}
          />
        </AppProviders>
      </MemoryRouter>,
    );
    const row = await screen.findByTestId(`record-runs-${R2}`);
    expect(within(row).getByRole("link")).toHaveAttribute("href", `/ops/runs/${R2}`);
    expect(row).toHaveTextContent("Test run");
  });
});
