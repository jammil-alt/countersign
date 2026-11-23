// SOC 2 readiness (§1.218): the checklist with its owner and evidence, a criterion nothing answers
// yet, recording this quarter's access review with a removal, and the last deletion drill.
import { quarterOf, SOC2_CRITERIA } from "@countersign/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { fakeApi, OPERATOR_SESSION } from "../../test/fixtures";

const ACME = "00000000-0000-4000-8000-00000000a002";
const DANA = "00000000-0000-4000-8000-00000000b001";
const NOW = new Date().toISOString();
const QUARTER = quarterOf(new Date(NOW));

function renderAt(path: string) {
  let recorded: unknown = null;
  const reviews: unknown[] = [];
  const api = fakeApi({
    "GET /api/session": () => OPERATOR_SESSION,
    "GET /api/ops/security/soc2": () => ({
      now: NOW,
      accessReviews: reviews,
      deletionDrill: {
        at: "2026-11-20T10:00:00.000Z",
        ok: true,
        tables: 41,
        rows: 812,
        failed: null,
      },
    }),
    "GET /api/ops/access-review": () => ({
      users: [
        {
          id: DANA,
          email: "dana@acme.example.com",
          name: "Dana Reyes",
          memberships: [
            { client: { id: ACME, name: "Acme Supply", retired: false }, role: "client_admin" },
          ],
          lastSignInAt: null,
          lastSeenAt: null,
        },
      ],
      generatedAt: NOW,
    }),
    "POST /api/ops/access-reviews": ({ init }) => {
      recorded = JSON.parse(String(init.body));
      const review = {
        id: "00000000-0000-4000-8000-00000000c001",
        period: QUARTER,
        createdAt: NOW,
        reviewerEmail: "operator@example.com",
        clients: 1,
        people: 1,
        removals: 1,
        note: "",
        items: [],
      };
      reviews.push(review);
      return review;
    },
  });
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
  return { api, recorded: () => recorded };
}

describe("SOC 2 readiness", () => {
  it("lists every criterion with its status, owner and evidence, and the last drill", async () => {
    renderAt("/ops/security/soc2");
    expect(await screen.findByRole("heading", { name: "SOC 2 readiness" })).toBeInTheDocument();
    // The heading renders before the facts load; the rows come with them.
    expect(await screen.findByTestId(`soc2-row-${SOC2_CRITERIA[0]?.id}`)).toBeInTheDocument();
    for (const c of SOC2_CRITERIA) {
      expect(screen.getByTestId(`soc2-row-${c.id}`)).toBeInTheDocument();
    }
    expect(
      within(screen.getByTestId("soc2-CC6")).getByText(
        /criteria in place · Owner: Security officer/,
      ),
    ).toBeInTheDocument();
    // QA SC1: criteria, never read as controls.
    expect(screen.getByTestId("soc2-counts")).toHaveTextContent(/Criteria in our scope/);
    // Physical access: nothing answers it yet, and the row says what would.
    const physical = screen.getByTestId("soc2-row-CC6.4");
    expect(within(physical).getByText("Missing")).toBeInTheDocument();
    expect(within(physical).getByText(/carved out/)).toBeInTheDocument();
    // No review this quarter: the access criteria aren't in place.
    const granting = screen.getByTestId("soc2-row-CC6.2");
    expect(within(granting).getByText(/None recorded yet/)).toBeInTheDocument();
    expect(screen.getByTestId("soc2-deletion-drill")).toHaveTextContent(/812 rows in 41 tables/);
  });

  it("records this quarter's access review with the people to remove", async () => {
    const { recorded } = renderAt("/ops/security/soc2");
    await userEvent.click(await screen.findByTestId("soc2-record"));
    const box = await screen.findByTestId(`soc2-remove-${ACME}:${DANA}`);
    await userEvent.click(box);
    await userEvent.type(screen.getByPlaceholderText("Why"), "Left");
    await userEvent.type(screen.getByTestId("soc2-record-note"), "Consoles reviewed");
    await userEvent.click(screen.getByTestId("soc2-record-save"));
    await waitFor(() =>
      expect(recorded()).toEqual({
        note: "Consoles reviewed",
        remove: [{ clientId: ACME, userId: DANA, note: "Left" }],
      }),
    );
    // Both access criteria (CC6.2, CC6.3) now read the review.
    expect(await screen.findAllByText(new RegExp(`^${QUARTER} recorded on`))).toHaveLength(2);
  });

  it("is a tab of the Security section", async () => {
    renderAt("/ops/security/controls");
    const tabs = await screen.findByTestId("security-tabs");
    expect(within(tabs).getByRole("link", { name: "SOC 2 readiness" })).toHaveAttribute(
      "href",
      "/ops/security/soc2",
    );
  });
});
