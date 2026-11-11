// The client's step panel (docs/plan.md §1.95): a step opens beside the run from the timeline or a
// shared address (`?step=<id>`), says what it did, its times and tries, "AI read this" without a
// model, its input and output as fields (raw behind a toggle), its change before and after, and
// on Data the records, documents and changes it touched. Escape and the scrim close it.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders } from "../../App";
import { CLIENT_SESSION, fakeApi } from "../../test/fixtures";
import { PortalRunScreen } from "./RunTimeline";

const RUN_ID = "00000000-0000-4000-8000-0000000f1001";
const STEP = "00000000-0000-4000-8000-0000000f2001";
const RECORD = "00000000-0000-4000-8000-0000000f5001";
const DOC = "00000000-0000-4000-8000-0000000d0001";
const ACTION = "00000000-0000-4000-8000-0000000f4001";

const RUN = {
  run: {
    id: RUN_ID,
    service: { id: "00000000-0000-4000-8000-00000000b001", name: "Record keeping" },
    status: "succeeded",
    startedAt: "2026-11-03T10:00:00.000Z",
    finishedAt: "2026-11-03T10:02:00.000Z",
  },
  steps: [
    {
      id: STEP,
      label: "Read the bill",
      status: "succeeded",
      summary: "Read bill 20418 from Northline",
      sources: [RECORD],
      startedAt: "2026-11-03T10:00:10.000Z",
      finishedAt: "2026-11-03T10:00:40.000Z",
      attempts: 2,
      ai: true,
      input: { documentId: DOC, vendor: "Northline Panel Supply" },
      output: {
        bill: { number: "20418", total: "1250.5000" },
        lines: [
          { sku: "MDF-18", quantity: 4, amount: "1000.0000" },
          { sku: "Freight", quantity: 1, amount: "250.5000" },
        ],
        // A leak the API would never send: the panel drops it too.
        reasoning: "model text the client must not see",
        costUsd: "0.0400",
      },
    },
    {
      id: "00000000-0000-4000-8000-0000000f2002",
      label: "Confirm",
      status: "succeeded",
      summary: null,
      sources: [],
      startedAt: "2026-11-03T10:01:00.000Z",
      finishedAt: "2026-11-03T10:01:30.000Z",
    },
  ],
  sourceNames: { [RECORD]: "Northline Panel Supply · 20418" },
  approvals: [],
  actions: [
    {
      id: ACTION,
      tool: "testkit.record.update",
      description: "Change a record's name or amount.",
      status: "done",
      executedAt: "2026-11-03T10:00:20.000Z",
      stepRunId: STEP,
      before: { id: "r1", name: "Oak board", amount: "10.00" },
      input: { id: "r1", amount: "12.00" },
    },
  ],
};

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.search}</p>;
}

function renderRun(path = `/runs/${RUN_ID}`, session = CLIENT_SESSION) {
  const api = fakeApi({
    "GET /api/session": () => session,
    [`GET /api/runs/${RUN_ID}`]: () => RUN,
    [`GET /api/runs/${RUN_ID}/audit`]: () => ({ entries: [] }),
    "GET /api/runs": () => ({ runs: [] }),
  });
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <Routes>
          <Route
            path="/runs/:id"
            element={
              <>
                <PortalRunScreen />
                <Where />
              </>
            }
          />
        </Routes>
      </AppProviders>
    </MemoryRouter>,
  );
  return api;
}

describe("portal step panel", () => {
  it("opens from a step, says what it did, and puts the step in the address", async () => {
    const user = userEvent.setup();
    renderRun();
    await user.click(await screen.findByTestId(`portal-run-step-${STEP}-open`));
    const panel = await screen.findByTestId("portal-run-step-panel");
    expect(screen.getByTestId("where")).toHaveTextContent(`?step=${STEP}`);
    expect(screen.getByTestId(`portal-run-step-${STEP}-open`)).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(within(panel).getByRole("heading", { name: "Read the bill" })).toHaveFocus();
    expect(within(panel).getByText("Step 1 of 2")).toBeInTheDocument();
    expect(within(panel).getByTestId("portal-run-step-panel-summary")).toHaveTextContent(
      "Read bill 20418 from Northline",
    );
    const facts = within(panel).getByTestId("portal-run-step-panel-facts");
    expect(facts).toHaveTextContent("Status");
    expect(facts).toHaveTextContent("Took");
    expect(facts).toHaveTextContent("30 s");
    expect(facts).toHaveTextContent("2 tries");
    // "AI read this", never a model.
    expect(within(panel).getByTestId("portal-run-step-panel-ai")).toHaveTextContent("AI read this");

    // What came out, as fields and a table, not JSON; the raw view behind its toggle.
    const output = within(panel).getByTestId("portal-run-step-panel-output");
    expect(output).toHaveTextContent("Number");
    expect(output).toHaveTextContent("1,250.50");
    expect(within(output).getByRole("table")).toHaveTextContent("MDF-18");
    expect(output.textContent).not.toContain("{");
    await user.click(within(panel).getByTestId("portal-run-step-panel-output-toggle"));
    expect(within(panel).getByTestId("portal-run-step-panel-output-raw")).toHaveTextContent(
      '"number": "20418"',
    );

    // The change it made, before and after.
    const changes = within(panel).getByTestId("portal-run-step-panel-changes");
    expect(changes).toHaveTextContent("Made");
    expect(within(changes).getByTestId("change")).toHaveTextContent("12.00");

    // Never what a client may not see, even if a response carried it.
    const text = panel.textContent ?? "";
    for (const leak of ["model text", "0.0400", "claude", "Reasoning"]) {
      expect(text, leak).not.toContain(leak);
    }
  });

  it("lists on Data the change, the record and the document, with their pages", async () => {
    const user = userEvent.setup();
    renderRun(`/runs/${RUN_ID}?step=${STEP}`);
    const panel = await screen.findByTestId("portal-run-step-panel");
    await user.click(within(panel).getByTestId("portal-run-step-panel-tab-data"));
    const data = within(panel).getByTestId("portal-run-step-data");
    expect(
      within(data).getByRole("link", { name: "Northline Panel Supply · 20418" }),
    ).toHaveAttribute("href", `/records/${RECORD}`);
    expect(within(data).getByRole("link", { name: "Document ·0d0001" })).toHaveAttribute(
      "href",
      `/documents/${DOC}`,
    );
    expect(within(data).getByTestId("portal-run-step-data-change")).toHaveTextContent("Oak board");
  });

  it("closes on Escape and on the scrim, and takes the step out of the address", async () => {
    const user = userEvent.setup();
    renderRun(`/runs/${RUN_ID}?step=${STEP}`);
    await screen.findByTestId("portal-run-step-panel");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("portal-run-step-panel")).toBeNull());
    expect(screen.getByTestId("where")).toHaveTextContent("");

    await user.click(screen.getByTestId(`portal-run-step-${STEP}-open`));
    await screen.findByTestId("portal-run-step-panel");
    fireEvent.click(document.querySelector(".ui-scrim-button") as HTMLElement);
    await waitFor(() => expect(screen.queryByTestId("portal-run-step-panel")).toBeNull());
  });

  it("keeps focus inside while open", async () => {
    const user = userEvent.setup();
    renderRun(`/runs/${RUN_ID}?step=${STEP}`);
    const panel = await screen.findByTestId("portal-run-step-panel");
    for (let i = 0; i < 12; i++) {
      await user.tab();
      expect(panel.contains(document.activeElement)).toBe(true);
    }
    await user.tab({ shift: true });
    expect(panel.contains(document.activeElement)).toBe(true);
  });

  it("reads in the client's language", async () => {
    renderRun(`/runs/${RUN_ID}?step=${STEP}`, {
      ...CLIENT_SESSION,
      language: { effective: "de", user: "de", client: null },
    } as typeof CLIENT_SESSION);
    const panel = await screen.findByTestId("portal-run-step-panel");
    expect(within(panel).getByText("Schritt 1 von 2")).toBeInTheDocument();
    expect(within(panel).getByTestId("portal-run-step-panel-ai")).toHaveTextContent(
      "Von KI gelesen",
    );
    expect(within(panel).getByText("Ergebnis")).toBeInTheDocument();
  });
});
