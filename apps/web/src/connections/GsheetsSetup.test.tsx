// v0.14 W4-D: the client admin's Google Sheets card lists the sheets agents may use (one picked by
// another Google account says so), removes one by sending the rest, and opens the picking page
// with a full load; without the Picker's keys it says picking isn't set up. Only the picking page
// gets Google's script and frame in the Content-Security-Policy.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import headers from "../../public/_headers?raw";
import { ApiProvider } from "../api/useApi";
import { fakeApi } from "../test/fixtures";
import { GSHEETS_PICK_PATH, GsheetsSetup } from "./GsheetsSetup";

const BUDGET = {
  id: "1BudgetSheet000000000",
  name: "Shop budget",
  url: "https://docs.google.com/spreadsheets/d/1BudgetSheet000000000/edit",
  addedAt: "2026-11-06T15:00:00.000Z",
  usable: true,
};
const OLD = { ...BUDGET, id: "1OldSheet000000000000", name: "Old costs", url: null, usable: false };
const RATES = { ...BUDGET, id: "1RatesSheet0000000000", name: "Rates", url: null };

function picker(over: Record<string, unknown> = {}) {
  return {
    available: true,
    connectionId: "00000000-0000-4000-8000-00000000c101",
    account: "books@acme.example",
    developerKey: "AIza-fake",
    appId: "123456789012",
    clientId: "1234-mezonas.apps.googleusercontent.com",
    sheets: [BUDGET, OLD, RATES],
    ...over,
  };
}

function renderCard(initial = picker()) {
  let state = initial;
  const bodies: unknown[] = [];
  const api = fakeApi({
    "GET /api/connections/gsheets/picker": () => state,
    "PUT /api/connections/gsheets/sheets": ({ init }) => {
      const body = JSON.parse(String(init.body)) as { sheetIds: string[] };
      bodies.push(body);
      state = { ...state, sheets: state.sheets.filter((s) => body.sheetIds.includes(s.id)) };
      return state;
    },
  });
  render(
    <ApiProvider client={api.client}>
      <GsheetsSetup />
    </ApiProvider>,
  );
  return { bodies, user: userEvent.setup() };
}

afterEach(() => vi.restoreAllMocks());

describe("GsheetsSetup", () => {
  it("lists the sheets, marks one picked by another account, and removes one", async () => {
    const { bodies, user } = renderCard();
    const list = await screen.findByTestId("gsheets-sheets");
    expect(within(list).getByRole("link", { name: "Shop budget" })).toHaveAttribute(
      "href",
      BUDGET.url,
    );
    expect(within(list).getByText(/Chosen with another Google account/)).toBeInTheDocument();
    await user.click(within(list).getAllByTestId("gsheets-remove")[0] as HTMLElement);
    expect(bodies).toEqual([{ sheetIds: [RATES.id] }]);
  });

  it("opens the picking page with a full load", async () => {
    const assign = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, assign });
    const { user } = renderCard();
    await user.click(await screen.findByTestId("gsheets-choose"));
    expect(assign).toHaveBeenCalledWith(GSHEETS_PICK_PATH);
  });

  it("says picking isn't set up without the Picker's keys", async () => {
    renderCard(picker({ available: false, developerKey: null, sheets: [] }));
    expect(await screen.findByText(/isn't set up here yet/)).toBeInTheDocument();
    expect(screen.getByText("No sheets chosen yet.")).toBeInTheDocument();
    expect(screen.queryByTestId("gsheets-choose")).toBeNull();
  });
});

describe("the picking page's Content-Security-Policy", () => {
  // Each blank-line-separated block: comments, then a path and its headers.
  const block = (path: string) =>
    headers
      .split("\n\n")
      .map((b) => b.split("\n").filter((l) => !l.startsWith("#")))
      .find((lines) => lines[0] === path) ?? [];
  const csp = (lines: string[]) =>
    lines.find((l) => l.trim().startsWith("Content-Security-Policy:"))?.trim() ?? "";

  it("lets Google in on the picking page only", () => {
    const all = block("/*");
    const pick = block(GSHEETS_PICK_PATH);
    expect(csp(all)).not.toContain("google");
    expect(all.map((l) => l.trim())).toContain("Cross-Origin-Opener-Policy: same-origin");
    expect(pick.map((l) => l.trim())).toEqual(
      expect.arrayContaining([
        "! Content-Security-Policy",
        "! Cross-Origin-Opener-Policy",
        "Cross-Origin-Opener-Policy: same-origin-allow-popups",
      ]),
    );
    const policy = csp(pick);
    expect(policy).toContain(
      "script-src 'self' https://apis.google.com https://accounts.google.com/gsi/client;",
    );
    expect(policy).toContain(
      "frame-src 'self' https://docs.google.com https://accounts.google.com/gsi/;",
    );
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toContain("unsafe-eval");
  });
});
