// The page that asks before a sign-in goes to one of our apps (docs/plan.md §1.219): it names the
// app and the person, Open sends the browser where the API says (the app's link), Cancel sends it
// home, and a sign-in that can't go on says to start again from the app.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppProviders, AppRoutes } from "../App";
import { CLIENT_SESSION, fakeApi, Reply } from "../test/fixtures";
import { go } from "./AppHandoff";

function renderPage(routes: Parameters<typeof fakeApi>[0]) {
  const api = fakeApi({ "GET /api/session": () => CLIENT_SESSION, ...routes });
  render(
    <MemoryRouter initialEntries={["/sign-in/app"]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
  return api;
}

const original = go.to;
afterEach(() => {
  go.to = original;
});

describe("confirming before the app gets the session", () => {
  it("names the desktop app and the person, and opens the app's link only on Open", async () => {
    const to = vi.fn();
    go.to = to;
    const bodies: unknown[] = [];
    const api = renderPage({
      "GET /api/mobile/handoff/pending": () => ({ app: "desktop", email: "ann@example.com" }),
      "POST /api/mobile/handoff": ({ init }) => {
        bodies.push(JSON.parse(String(init.body)));
        return { redirectTo: "mezonas://signed-in?code=abc" };
      },
    });
    expect(await screen.findByText("Open the Mezonas desktop app?")).toBeInTheDocument();
    expect(screen.getByTestId("app-handoff-who")).toHaveTextContent(
      "You're signed in as ann@example.com.",
    );
    expect(screen.getByTestId("app-handoff-warn")).toBeInTheDocument();
    expect(api.calls).not.toContain("POST /api/mobile/handoff");
    await userEvent.click(screen.getByTestId("app-handoff-open"));
    await waitFor(() => expect(to).toHaveBeenCalledWith("mezonas://signed-in?code=abc"));
    expect(bodies).toEqual([{ open: true }]);
  });

  it("names the phone app, and Cancel goes where the API says", async () => {
    const to = vi.fn();
    go.to = to;
    const bodies: unknown[] = [];
    renderPage({
      "GET /api/mobile/handoff/pending": () => ({ app: "phone", email: "ann@example.com" }),
      "POST /api/mobile/handoff": ({ init }) => {
        bodies.push(JSON.parse(String(init.body)));
        return { redirectTo: "/" };
      },
    });
    expect(await screen.findByText("Open the Mezonas phone app?")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("app-handoff-cancel"));
    await waitFor(() => expect(to).toHaveBeenCalledWith("/"));
    expect(bodies).toEqual([{ open: false }]);
  });

  it("says to start again when the sign-in has ended", async () => {
    const to = vi.fn();
    go.to = to;
    renderPage({
      "GET /api/mobile/handoff/pending": () =>
        new Reply(404, { error: { code: "no_start", message: "start again" } }),
    });
    expect(await screen.findByTestId("app-handoff-gone")).toHaveTextContent(
      "Start again from the app.",
    );
    expect(screen.queryByTestId("app-handoff-open")).toBeNull();
    expect(to).not.toHaveBeenCalled();
  });
});
