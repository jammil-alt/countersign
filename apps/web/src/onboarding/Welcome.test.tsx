// `/start/:token` (docs/plan.md §1.149): the welcome page an invite opens, before sign-in. It shows
// who it's from, the lead's note and what's in it in the person's language, and starts WorkOS's
// sign-in by Google, Microsoft or email with the invited address; signed in, the invited address
// goes on to Getting started and any other is told whose invite it is, and nothing more; an
// expired link asks the lead for a new one.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AppProviders } from "../App";
import { CLIENT_SESSION, fakeApi, Reply } from "../test/fixtures";
import { signInHref, WelcomeScreen } from "./Welcome";

const TOKEN = "eyJ0IjoiYSJ9.c2lnbmF0dXJl";

const page = (over: Record<string, unknown> = {}) => ({
  state: "open",
  client: "Acme Supply",
  lead: { name: "Jammil Ade", photoUrl: null },
  note: "Dana, good to talk today.",
  summary: { general: true, areas: ["purchasing"], agents: 1, minutes: 15 },
  email: "dana@acme.example",
  expiresAt: "2026-12-01T12:00:00.000Z",
  language: "en",
  ...over,
});

const signedOut = () => new Reply(401, { error: { code: "unauthenticated" } });
const session = CLIENT_SESSION;

function renderAt(api: ReturnType<typeof fakeApi>, go = vi.fn()) {
  render(
    <MemoryRouter initialEntries={[`/start/${TOKEN}`]}>
      <AppProviders client={api.client}>
        <Routes>
          <Route path="/start/:token" element={<WelcomeScreen go={go} />} />
          <Route path="/start" element={<p data-testid="getting-started">Getting started</p>} />
        </Routes>
      </AppProviders>
    </MemoryRouter>,
  );
  return go;
}

describe("the welcome page", () => {
  it("shows who it's from, the note and what's in it, and starts sign-in with the address", async () => {
    const api = fakeApi({
      "GET /api/session": signedOut,
      "GET /api/auth/provider": () => ({ provider: "workos", message: null }),
      [`GET /api/start/${TOKEN}`]: () => page(),
    });
    const go = renderAt(api);
    expect(await screen.findByTestId("welcome-title")).toHaveTextContent(
      "Let's get Acme Supply started",
    );
    expect(screen.getByText("From Jammil Ade, your lead at Mezonas")).toBeTruthy();
    expect(screen.getByTestId("welcome-note")).toHaveTextContent("Dana, good to talk today.");
    expect(screen.getByTestId("welcome-summary")).toHaveTextContent(
      "A few questions about how Acme Supply works and purchasing, and what we need to set up one agent; about 15 minutes.",
    );
    expect(screen.getByTestId("welcome-address")).toHaveTextContent("dana@acme.example");
    expect(screen.getByText("We'll never ask for a password by email.")).toBeTruthy();
    await userEvent.click(screen.getByTestId("welcome-microsoft"));
    const url = new URL(go.mock.calls[0]?.[0] as string, "https://app.test");
    expect(url.pathname).toBe("/api/auth/sign-in");
    expect(url.searchParams.get("method")).toBe("microsoft");
    expect(url.searchParams.get("login_hint")).toBe("dana@acme.example");
    expect(url.searchParams.get("return_to")).toBe(`/start/${TOKEN}`);
  });

  it("speaks the person's language", async () => {
    const api = fakeApi({
      "GET /api/session": signedOut,
      "GET /api/auth/provider": () => ({ provider: "workos", message: null }),
      [`GET /api/start/${TOKEN}`]: () => page({ language: "es" }),
    });
    renderAt(api);
    expect(await screen.findByTestId("welcome-title")).toHaveTextContent(
      "Empecemos con Acme Supply",
    );
    expect(screen.getByTestId("welcome-google")).toHaveTextContent("Continuar con Google");
  });

  it("sends the invited address on to Getting started once signed in", async () => {
    const api = fakeApi({
      "GET /api/session": () => session,
      "GET /api/auth/provider": () => ({ provider: "workos", message: null }),
      [`GET /api/start/${TOKEN}`]: () => page(),
      [`POST /api/start/${TOKEN}/signed-in`]: () => ({ state: "ok", next: "/start" }),
    });
    renderAt(api);
    expect(await screen.findByTestId("getting-started")).toBeTruthy();
  });

  it("tells another account whose invite it is, and nothing more", async () => {
    const api = fakeApi({
      "GET /api/session": () => ({ ...session, user: { ...session.user, email: "x@y.example" } }),
      "GET /api/auth/provider": () => ({ provider: "workos", message: null }),
      [`GET /api/start/${TOKEN}`]: () => page(),
      [`POST /api/start/${TOKEN}/signed-in`]: () => ({
        state: "wrong_account",
        invitedEmail: "d•••@acme.example",
      }),
    });
    renderAt(api);
    expect(await screen.findByTestId("welcome-wrong-account")).toHaveTextContent(
      "This invite is for d•••@acme.example.",
    );
    expect(screen.queryByTestId("welcome-note")).toBeNull();
    expect(screen.queryByTestId("welcome-summary")).toBeNull();
    expect(screen.queryByText(/Acme Supply/)).toBeNull();
  });

  it("lets an expired link ask the lead for a new one", async () => {
    let asked = 0;
    const api = fakeApi({
      "GET /api/session": signedOut,
      "GET /api/auth/provider": () => ({ provider: "workos", message: null }),
      [`GET /api/start/${TOKEN}`]: () =>
        page({ state: "expired", note: null, summary: null, email: null }),
      [`POST /api/start/${TOKEN}/ask-new`]: () => {
        asked++;
        return { ok: true };
      },
    });
    renderAt(api);
    expect(await screen.findByTestId("welcome-closed")).toHaveTextContent("This link has expired");
    await userEvent.click(screen.getByTestId("welcome-ask-new"));
    await waitFor(() => expect(screen.getByTestId("welcome-asked")).toBeTruthy());
    expect(screen.getByTestId("welcome-asked")).toHaveTextContent("We told Jammil.");
    expect(asked).toBe(1);
  });

  it("says a broken link doesn't work", async () => {
    const api = fakeApi({
      "GET /api/session": signedOut,
      "GET /api/auth/provider": () => ({ provider: "workos", message: null }),
      [`GET /api/start/${TOKEN}`]: () => new Reply(404, { error: { code: "not_found" } }),
    });
    renderAt(api);
    expect(await screen.findByTestId("welcome-gone")).toHaveTextContent("This link doesn't work.");
  });

  it("uses the development sign-in locally", () => {
    expect(signInHref("dev", TOKEN, "google", "d@a.example")).toBe(
      `/sign-in?next=${encodeURIComponent(`/start/${TOKEN}`)}`,
    );
  });
});
