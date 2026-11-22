// The back office's sidebar (staging QA, 2026-11-22): it keeps its scroll across moves and when the
// frame is drawn again, brings the current page's row into view only when it is out of sight, and
// its feedback tool reads "Report a problem", apart from Utilities (titled as the sidebar names it).
import { act, render, screen, within } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../App";
import { fakeApi, OPERATOR_SESSION } from "../test/fixtures";
import { resetNavScroll } from "./Shell";

let go: (to: string) => void = () => {};
function Driver() {
  go = useNavigate();
  return null;
}

function renderAt(path: string) {
  const api = fakeApi({
    "GET /api/session": () => OPERATOR_SESSION,
    "GET /api/ops/clients": () => ({ clients: [] }),
    "GET /api/ops/counts": () => ({ needsUs: 0, clients: [] }),
  });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
        <Driver />
      </AppProviders>
    </MemoryRouter>,
  );
}

const nav = () => document.querySelector<HTMLElement>(".ui-sidebar__nav") as HTMLElement;

/** jsdom lays nothing out: give the nav and its rows the boxes a short window would. */
function layOut(navTop: number, navBottom: number, rowTop: (row: HTMLElement) => number) {
  const box = (top: number, bottom: number) =>
    ({ top, bottom, height: bottom - top, left: 0, right: 200, width: 200 }) as DOMRect;
  nav().getBoundingClientRect = () => box(navTop, navBottom);
  for (const row of nav().querySelectorAll<HTMLElement>("a")) {
    row.getBoundingClientRect = () => box(rowTop(row), rowTop(row) + 36);
  }
}

afterEach(() => resetNavScroll());

describe("the sidebar", () => {
  it("keeps its scroll across moves and when the frame is drawn again", async () => {
    const first = renderAt("/ops/usage");
    await screen.findByTestId("shell-ops", {}, { timeout: 10_000 });
    // Everything in view: nothing moves the nav but the person.
    layOut(0, 600, () => 100);
    act(() => {
      nav().scrollTop = 240;
      nav().dispatchEvent(new Event("scroll"));
    });
    act(() => go("/ops/security"));
    expect(nav().scrollTop).toBe(240);
    act(() => go("/ops/users"));
    expect(nav().scrollTop).toBe(240);

    // The frame drawn again (a page that suspended or a remount): back where it was.
    first.unmount();
    renderAt("/ops/users");
    await screen.findByTestId("shell-ops", {}, { timeout: 10_000 });
    expect(nav().scrollTop).toBe(240);
  });

  it("brings the current page's row into view when it is out of sight", async () => {
    renderAt("/ops");
    await screen.findByTestId("shell-ops", {}, { timeout: 10_000 });
    // Users' row sits 300px below a nav that ends at 400.
    layOut(0, 400, (row) => (row.dataset.testid === "ops-nav-users" ? 700 : 50));
    act(() => go("/ops/users"));
    // Scrolled by just enough: its bottom (736) clear of the fade at the nav's foot (400 - 32).
    expect(nav().scrollTop).toBe(368);
  });

  it("names its feedback tool apart from Utilities, whose pages are titled Utilities", async () => {
    renderAt("/ops/utilities/feedback");
    const shell = await screen.findByTestId("shell-ops", {}, { timeout: 10_000 });
    expect(within(shell).getByTestId("ops-nav-utilities")).toHaveTextContent("Utilities");
    const tool = within(shell).getByTestId("feedback-button");
    expect(tool).toHaveTextContent("Report a problem");
    expect(tool).not.toHaveTextContent("Feedback");
    expect(await screen.findByRole("heading", { level: 1, name: "Utilities" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1, name: "Feedback" })).toBeNull();
    act(() => go("/ops/utilities/run-audit"));
    expect(await screen.findByRole("heading", { level: 1, name: "Utilities" })).toBeInTheDocument();
  });
});
