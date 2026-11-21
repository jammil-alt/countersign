// Confirm matches (docs/plan.md §1.164): the Sales pack's card on an inbox item. The unsure rows
// first with the sheet's values beside the suggested record's, differences marked, the confidence
// in words and how each row was found; the settled rows folded under "Matched" with Approve all
// High; Approve, pick another, Look up (debounced, the module chosen) and No match each sent as the
// card's decision; Finish only once no row waits.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders } from "../../App";
import { InboxCard } from "../../inbox/InboxCard";
import { CLIENT_SESSION, fakeApi } from "../../test/fixtures";
import type { MatchRow, SalesMatchData } from "./types";

const INBOX = "00000000-0000-4000-8000-0000000c3001";
const L2 = "00000000-0000-4000-8000-0000000c0002";
const L3 = "00000000-0000-4000-8000-0000000c0003";
const L1 = "00000000-0000-4000-8000-0000000c0001";
const D1 = "00000000-0000-4000-8000-0000000c00d1";

function renderAt(node: React.ReactNode, routes: Parameters<typeof fakeApi>[0]) {
  const api = fakeApi({ "GET /api/session": () => CLIENT_SESSION, ...routes });
  render(
    <MemoryRouter initialEntries={["/"]}>
      <AppProviders client={api.client}>
        <Routes>
          <Route path="*" element={node} />
        </Routes>
      </AppProviders>
    </MemoryRouter>,
  );
  return api;
}

const item = {
  id: INBOX,
  kind: "request",
  title: "2 rows of your spreadsheet need you",
  payload: { review: "sales.match", nodeId: "confirm", batchId: "b", modules: ["Leads", "Deals"] },
  status: "open",
  runId: null,
  dueAt: null,
  createdAt: "2026-11-20T15:00:00.000Z",
  resolvedAt: null,
};

const sam = (decided: boolean): MatchRow => ({
  index: 1,
  agent: { decision: "unsure", method: "text", score: 0.74, confidence: "medium", found: "name" },
  decision: decided ? "matched" : "unsure",
  decidedBy: decided ? "person" : "agent",
  record: {
    recordKeyId: decided ? L3 : L2,
    module: "Leads",
    externalId: decided ? "L3" : "L2",
    values: { name: "Sam Okafor", company: "Harbor Supply Co" },
  },
  suggested: !decided,
  sheet: { firstName: "Sam", lastName: "Okafor", company: "Harbor Supply" },
  compare: [
    { field: "name", sheet: "Sam Okafor", record: "Sam Okafor", differs: false },
    { field: "company", sheet: "Harbor Supply", record: "Harbor Supply Co", differs: true },
  ],
  candidates: [
    {
      recordKeyId: L2,
      module: "Leads",
      externalId: "L2",
      values: { name: "Sam Okafor", company: "Harbor Supply Co" },
      score: 0.74,
      confidence: "medium",
      found: "name",
      vetoed: null,
    },
    {
      recordKeyId: L3,
      module: "Leads",
      externalId: "L3",
      values: { name: "Samuel Okafor", company: "Harbor Supply Company" },
      score: 0.7,
      confidence: "medium",
      found: "name",
      vetoed: null,
    },
  ],
});

const jane: MatchRow = {
  index: 0,
  agent: { decision: "matched", method: "key", score: 1, confidence: "high", found: "email" },
  decision: "matched",
  decidedBy: "agent",
  record: {
    recordKeyId: L1,
    module: "Leads",
    externalId: "L1",
    values: { name: "Jane Doe", email: "jane.doe@blueridgemillwork.com" },
  },
  suggested: false,
  sheet: { email: "jane.doe@blueridgemillwork.com" },
  compare: [
    {
      field: "email",
      sheet: "jane.doe@blueridgemillwork.com",
      record: "jane.doe@blueridgemillwork.com",
      differs: false,
    },
  ],
  candidates: [],
};

const view = (decided: boolean) => {
  const data: SalesMatchData = {
    batchId: "b",
    threshold: 0.9,
    modules: ["Leads", "Deals"],
    rows: [sam(decided), jane],
    counts: { unsure: 1, matched: 1, none: 0, waiting: decided ? 0 : 1, decided: decided ? 1 : 0 },
  };
  return { review: "sales.match", status: "open", canDecide: true, data };
};

describe("Confirm matches", () => {
  it("shows the unsure rows first, beside the record, with the matched folded", async () => {
    renderAt(<InboxCard item={item} onResolve={async () => {}} />, {
      [`GET /api/inbox/${INBOX}/pack-review`]: () => view(false),
    });
    const card = await screen.findByTestId("sales-match-review");
    const unsure = within(card).getByTestId("sales-match-unsure");
    expect(unsure).toHaveTextContent("1 row we weren't sure of");
    const [row] = within(unsure).getAllByTestId("sales-match-row");
    if (!row) throw new Error("no row");
    expect(within(row).getByTestId("sales-match-state")).toHaveTextContent("Waiting on you");
    expect(within(row).getByTestId("sales-match-confidence")).toHaveTextContent(
      "Medium (74%) · Similar name",
    );
    const differs = within(row)
      .getAllByTestId("sales-match-field")
      .filter((f) => f.dataset.differs === "true");
    expect(differs.map((f) => f.textContent)).toEqual([
      expect.stringContaining("Harbor Supply Co"),
    ]);
    expect(within(row).getByTestId("sales-match-differs")).toHaveTextContent("Differs");
    const matched = within(card).getByTestId("sales-match-matched");
    expect(matched).toHaveTextContent("Matched (1)");
    expect(within(matched).getByTestId("sales-match-approve-high")).toHaveTextContent(
      "Approve all High (1)",
    );
    // The agent's match is ink: a word, not a pill.
    const [agentRow] = within(matched).getAllByTestId("sales-match-row");
    expect(within(agentRow as HTMLElement).getByTestId("sales-match-state").tagName).toBe("SPAN");
    expect(within(agentRow as HTMLElement).getByTestId("sales-match-state")).toHaveTextContent(
      "Matched",
    );
    expect(within(card).getByTestId("sales-match-finish")).toBeDisabled();
  });

  it("approves, picks another and says No match, each as the card's decision", async () => {
    const bodies: unknown[] = [];
    renderAt(<InboxCard item={item} onResolve={async () => {}} />, {
      [`GET /api/inbox/${INBOX}/pack-review`]: () => view(false),
      [`POST /api/inbox/${INBOX}/pack-review`]: ({ init }) => {
        bodies.push(JSON.parse(String(init.body)));
        return view(false);
      },
    });
    const card = await screen.findByTestId("sales-match-review");
    const row = within(within(card).getByTestId("sales-match-unsure")).getByTestId(
      "sales-match-row",
    );
    await userEvent.click(within(row).getByTestId("sales-match-approve"));
    await userEvent.selectOptions(within(row).getByTestId("sales-match-candidate"), L3);
    await userEvent.click(within(row).getByTestId("sales-match-use"));
    await userEvent.click(within(row).getByTestId("sales-match-none"));
    await userEvent.click(within(card).getByTestId("sales-match-approve-high"));
    await waitFor(() =>
      expect(bodies).toEqual([
        { action: "approve", input: { index: 1 } },
        { action: "pick", input: { index: 1, recordKeyId: L3 } },
        { action: "no_match", input: { index: 1 } },
        { action: "approve_high", input: {} },
      ]),
    );
  });

  it("looks up a record in the module chosen, once typing pauses, and remaps the row; then Finish", async () => {
    const bodies: unknown[] = [];
    const searched: string[] = [];
    const resolved: unknown[] = [];
    let decided = false;
    renderAt(<InboxCard item={item} onResolve={async (b) => void resolved.push(b)} />, {
      [`GET /api/inbox/${INBOX}/pack-review`]: () => view(decided),
      [`GET /api/inbox/${INBOX}/pack-review/lookup`]: ({ url }) => {
        searched.push(url.search);
        return {
          records: [
            {
              recordKeyId: D1,
              connectionId: "c",
              module: "Deals",
              externalId: "D1",
              name: null,
              company: "Harbor Supply Co",
              email: null,
              phone: null,
              deal: "Harbor Supply renewal",
              stage: "Negotiation",
              amount: "12000",
              similarity: 0.8,
            },
          ],
        };
      },
      [`POST /api/inbox/${INBOX}/pack-review`]: ({ init }) => {
        bodies.push(JSON.parse(String(init.body)));
        decided = true;
        return view(true);
      },
    });
    const card = await screen.findByTestId("sales-match-review");
    const row = within(within(card).getByTestId("sales-match-unsure")).getByTestId(
      "sales-match-row",
    );
    await userEvent.click(within(row).getByTestId("sales-match-lookup-open"));
    const box = within(row).getByTestId("sales-match-lookup");
    await userEvent.selectOptions(within(box).getByTestId("sales-match-lookup-module"), "Deals");
    await userEvent.type(within(box).getByTestId("sales-match-lookup-q"), "Harbor renewal");
    const results = await within(box).findByTestId("sales-match-lookup-results");
    expect(results).toHaveTextContent("Harbor Supply renewal · Harbor Supply Co · Negotiation");
    // Asked once, after the pause, for the whole words in the module chosen.
    expect(searched).toEqual(["?q=Harbor+renewal&module=Deals"]);
    await userEvent.click(within(results).getByTestId("sales-match-lookup-choose"));
    await waitFor(() =>
      expect(bodies).toEqual([{ action: "lookup", input: { index: 1, recordKeyId: D1 } }]),
    );
    const after = within(within(card).getByTestId("sales-match-unsure")).getByTestId(
      "sales-match-row",
    );
    expect(within(after).getByTestId("sales-match-state")).toHaveTextContent("Confirmed");
    expect(within(card).getByTestId("sales-match-left")).toHaveTextContent("Every row is decided.");
    await userEvent.click(within(card).getByTestId("sales-match-finish"));
    expect(resolved).toEqual([{ decision: "approve", answer: { reviewed: 2 } }]);
  });
});
