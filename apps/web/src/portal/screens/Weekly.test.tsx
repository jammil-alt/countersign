// The Weekly Table (C8): the lead's note, the week's figures, decisions answered once in the lead
// thread, setup to do, what each agent did, next week, the PDF and earlier weeks.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { CLIENT_SESSION, fakeApi, Reply } from "../../test/fixtures";

const SVC = "00000000-0000-4000-8000-00000000b001";
const DECISION = "00000000-0000-4000-8000-0000000d0001";

const table = (replied: boolean) => ({
  id: "00000000-0000-4000-8000-0000000e0001",
  weekStart: "2026-11-02",
  status: "sent",
  stats: {
    weekStart: "2026-11-02",
    from: "2026-11-02T00:00:00.000Z",
    to: "2026-11-09T00:00:00.000Z",
    runs: { done: 38, lastWeek: 31, change: 7, sources: [] },
    changes: { automatic: 20, signed: 11, sources: [] },
    signatures: { given: 11, sources: [] },
    documents: { read: 31, sources: [] },
    agents: [{ id: SVC, name: "Pia", runsDone: 12, kpis: [] }],
    computedAt: "2026-11-06T17:00:00.000Z",
  },
  note: "A good week. Rugby raised birch prices again.",
  noteBy: { id: "u1", name: "Ana Ruiz" },
  decisions: [
    {
      id: DECISION,
      title: "Baltic birch from Rugby",
      body: "Two options below.",
      options: ["Ask Marco for last quarter's price", "Get a quote from Northland"],
      sources: [],
      ...(replied
        ? { reply: { by: "Demo admin", at: "2026-11-09T09:00:00.000Z", messageId: "m1" } }
        : {}),
    },
  ],
  nextWeek: "Month-end is Friday.",
  setup: {
    items: [{ kind: "connect", agentId: SVC, agentName: "Remy", connector: "amex", tool: "Amex" }],
  },
  sentAt: "2026-11-09T07:00:00.000Z",
  updatedAt: "2026-11-09T07:00:00.000Z",
});

function setup() {
  let replied = false;
  const replies: unknown[] = [];
  const weeks: (string | null)[] = [];
  const api = fakeApi({
    "GET /api/session": () => CLIENT_SESSION,
    "GET /api/overview": () => new Reply(404, {}),
    "GET /api/weekly": ({ url }) => {
      weeks.push(url.searchParams.get("week"));
      return { table: table(replied), weeks: ["2026-11-02", "2026-10-26"] };
    },
    [`POST /api/weekly/2026-11-02/decisions/${DECISION}/reply`]: ({ init }) => {
      replies.push(JSON.parse(String(init.body)));
      replied = true;
      return { messageId: "m1" };
    },
  });
  render(
    <MemoryRouter initialEntries={["/weekly"]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
  return { replies, weeks };
}

describe("the Weekly Table", () => {
  it("shows the lead's note, the week's figures, setup and what the team did", async () => {
    setup();
    expect(await screen.findByTestId("portal-weekly-note")).toHaveTextContent(
      "Rugby raised birch prices again.",
    );
    expect(screen.getByText("From Ana Ruiz, your Mezonas lead.", { exact: false })).toBeVisible();
    expect(screen.getByTestId("portal-weekly-runs")).toHaveTextContent("38");
    expect(screen.getByTestId("portal-weekly-runs")).toHaveTextContent("Up 7 on last week");
    expect(screen.getByTestId("portal-weekly-changes")).toHaveTextContent("31");
    expect(screen.getByTestId("portal-weekly-setup-amex")).toHaveTextContent("Connect Amex");
    expect(screen.getByTestId("portal-weekly-team")).toHaveTextContent("Pia finished 12 runs");
    expect(screen.getByTestId("portal-weekly-next")).toHaveTextContent("Month-end is Friday.");
    expect(screen.getByTestId("portal-weekly-pdf")).toHaveAttribute(
      "href",
      "/api/weekly/2026-11-02/pdf",
    );
  });

  it("answers a decision once, in the lead thread", async () => {
    const { replies } = setup();
    const decision = await screen.findByTestId(`portal-weekly-decision-${DECISION}`);
    await userEvent.click(within(decision).getByTestId("portal-weekly-reply"));
    await userEvent.type(within(decision).getByTestId("portal-weekly-reply-text"), "Option A");
    await userEvent.click(within(decision).getByTestId("portal-weekly-reply-send"));
    expect(replies).toEqual([{ text: "Option A" }]);
    await waitFor(() => expect(decision).toHaveTextContent("Answered by Demo admin"));
    expect(within(decision).queryByTestId("portal-weekly-reply")).not.toBeInTheDocument();
  });

  it("opens an earlier week", async () => {
    const { weeks } = setup();
    await userEvent.selectOptions(await screen.findByTestId("portal-weekly-weeks"), "2026-10-26");
    await waitFor(() => expect(weeks.at(-1)).toBe("2026-10-26"));
  });

  it("says when no week was sent yet", async () => {
    render(
      <MemoryRouter initialEntries={["/weekly"]}>
        <AppProviders
          client={
            fakeApi({
              "GET /api/session": () => CLIENT_SESSION,
              "GET /api/weekly": () => ({ table: null, weeks: [] }),
            }).client
          }
        >
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    expect(await screen.findByText(/Your first Weekly Table arrives/)).toBeInTheDocument();
  });
});
