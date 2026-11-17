// A screen that throws while rendering shows a plain notice in its own place, never the
// exception's words, and the frame around it stays usable; a new address or "Try again" clears it.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppProviders, AppRoutes } from "../App";
import { CLIENT_SESSION, fakeApi, tableView } from "../test/fixtures";
import { ErrorBoundary } from "./ErrorBoundary";

const CRASH = "Something went wrong showing this page. Try again, or go to another page.";

// The Contacts screen, made to throw while `broken` is set.
const state = vi.hoisted(() => ({ broken: true }));
vi.mock("../portal/screens/Contacts", () => ({
  ContactsScreen: () => {
    if (state.broken) throw new Error("x is undefined (secret detail)");
    return <p>Contacts here</p>;
  },
}));

// React logs each caught error; the tests expect them.
beforeEach(() => {
  state.broken = true;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function Boom({ when }: { when: () => boolean }) {
  if (when()) throw new Error("render failed (secret detail)");
  return <p>Fine</p>;
}

function Frame({ broken }: { broken: () => boolean }) {
  const { pathname } = useLocation();
  return (
    <>
      <nav>
        <Link to="/other">Other</Link>
      </nav>
      <ErrorBoundary resetKey={pathname}>
        <Boom when={() => pathname === "/broken" && broken()} />
      </ErrorBoundary>
    </>
  );
}

describe("ErrorBoundary", () => {
  it("shows the notice in plain words and clears it when the address changes", async () => {
    render(
      <MemoryRouter initialEntries={["/broken"]}>
        <Frame broken={() => true} />
      </MemoryRouter>,
    );
    const notice = screen.getByTestId("screen-crash");
    expect(notice).toHaveTextContent(CRASH);
    expect(notice).not.toHaveTextContent("secret detail");
    expect(screen.getByRole("alert")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("link", { name: "Other" }));
    expect(screen.queryByTestId("screen-crash")).toBeNull();
    expect(screen.getByText("Fine")).toBeInTheDocument();
  });

  it("renders the page again on Try again", async () => {
    let broken = true;
    render(
      <MemoryRouter initialEntries={["/broken"]}>
        <Frame broken={() => broken} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("screen-crash")).toBeInTheDocument();
    broken = false;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.queryByTestId("screen-crash")).toBeNull();
    expect(screen.getByText("Fine")).toBeInTheDocument();
  });
});

describe("the app's frame", () => {
  it("keeps the sidebar when a screen throws, and recovers on the next page", async () => {
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/table": () => tableView(),
    });
    render(
      <MemoryRouter initialEntries={["/contacts"]}>
        <AppProviders client={api.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    const notice = await screen.findByTestId("screen-crash");
    expect(notice).toHaveTextContent(CRASH);
    expect(notice).not.toHaveTextContent("secret detail");
    // The frame is still there: the crash is inside the page, under the sidebar and top bar.
    expect(notice.closest("main")).not.toBeNull();
    const runs = screen.getByTestId("portal-nav-runs");

    state.broken = false;
    await userEvent.click(runs);
    expect(screen.queryByTestId("screen-crash")).toBeNull();
    expect(await screen.findByTestId("shell-portal")).toBeInTheDocument();
  });
});
