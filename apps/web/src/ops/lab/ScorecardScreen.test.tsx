// docs/plan.md §1.212: the scorecard shows the golden datasets and each version's latest suite
// run; an approved change saves as a test case in one click, and saying it again answers the case
// already made.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ApiProvider } from "../../api/useApi";
import { fakeApi } from "../../test/fixtures";
import { SaveAsCase } from "./SaveAsCase";
import ScorecardScreen from "./ScorecardScreen";

const ITEM = "00000000-0000-4000-8000-0000000d0001";
const CASE = {
  id: "00000000-0000-4000-8000-0000000e0001",
  clientId: "00000000-0000-4000-8000-0000000f0001",
  clientName: "Golden Millwork",
  targetKind: "template",
  targetId: "00000000-0000-4000-8000-0000000a0001",
  name: "Approved: Send the review",
  input: { workflow: "invoice-review", payload: {} },
  fixtures: [],
  expected: { $writes: [{ step: "send-ap", expect: {} }], $writesScope: "named" },
  matcher: { kind: "subset", tolerances: {} },
  required: false,
  source: "run",
  sourceRef: `inbox:${ITEM}`,
  createdBy: null,
  createdAt: "2026-11-22T10:00:00.000Z",
  archivedAt: null,
};

describe("the scorecard", () => {
  it("shows the golden datasets and each version's latest suite run", async () => {
    const api = fakeApi({
      "GET /api/ops/evals/scorecard": () => ({
        golden: [
          {
            template: "bookkeeper",
            workflow: "daily",
            cases: 35,
            passed: 35,
            exactRate: 1,
            verifierAgreement: 0.75,
            verification: { agreed: 6, disagreed: 1, cannotVerify: 1 },
            costPerCase: "0.005286",
          },
        ],
        rows: [
          {
            templateId: "00000000-0000-4000-8000-0000000a0001",
            templateName: "Vendor contracts and invoice review",
            templateSlug: "vendor-contracts",
            versionId: "00000000-0000-4000-8000-0000000b0001",
            version: 3,
            workflow: "invoice-review",
            clientName: "Golden Millwork",
            suiteRunId: "00000000-0000-4000-8000-0000000c0001",
            finishedAt: "2026-11-22T10:00:00.000Z",
            cases: 2,
            passed: 1,
            exactRate: 0.5,
            writeCases: 2,
            verifierAgreement: null,
            verification: { agreed: 0, disagreed: 0, cannotVerify: 0 },
            costPerCase: "0.000100",
            msMedian: 412,
          },
        ],
      }),
    });
    render(
      <ApiProvider client={api.client}>
        <MemoryRouter>
          <ScorecardScreen />
        </MemoryRouter>
      </ApiProvider>,
    );
    const golden = await screen.findByTestId("scorecard-golden-bookkeeper");
    expect(golden.textContent).toContain("35");
    expect(golden.textContent).toContain("100%");
    expect(golden.textContent).toContain("75% of 8 · 1 disagreed · 1 couldn't check");
    const row = screen.getByTestId("scorecard-row-00000000-0000-4000-8000-0000000c0001");
    expect(row.textContent).toContain("v3");
    expect(row.textContent).toContain("1 of 2");
    expect(row.textContent).toContain("50% of 2");
    expect(row.textContent).toContain("412 ms");
    expect(row.textContent).toContain("Golden Millwork");
  });

  it("saves an approved change as a test case in one click", async () => {
    let created = true;
    const api = fakeApi({
      [`POST /api/ops/inbox/${ITEM}/save-as-case`]: () => {
        const out = { created, case: CASE };
        created = false;
        return out;
      },
    });
    const { unmount } = render(
      <ApiProvider client={api.client}>
        <SaveAsCase itemId={ITEM} />
      </ApiProvider>,
    );
    await userEvent.click(screen.getByTestId(`save-case-${ITEM}`));
    await waitFor(() =>
      expect(screen.getByTestId(`save-case-${ITEM}-done`).textContent).toBe(
        "Saved as a test case.",
      ),
    );
    unmount();
    render(
      <ApiProvider client={api.client}>
        <SaveAsCase itemId={ITEM} />
      </ApiProvider>,
    );
    await userEvent.click(screen.getByTestId(`save-case-${ITEM}`));
    await waitFor(() =>
      expect(screen.getByTestId(`save-case-${ITEM}-done`).textContent).toBe(
        "Already saved as a test case.",
      ),
    );
    expect(api.calls).toContain(`POST /api/ops/inbox/${ITEM}/save-as-case`);
  });
});
