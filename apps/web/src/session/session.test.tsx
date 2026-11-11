// The first load (docs/audit-plan.md 4.1, 4.3): the session asked before React mounts is the one
// the provider uses; the frame's first calls go with it into the store and are dropped if the
// session refuses; nothing signed in or signed out shows until its language has loaded.
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ApiStore } from "../api/store";
import { ApiProvider } from "../api/useApi";
import { loadAllCatalogs, unloadCatalogs } from "../i18n/catalog";
import { useI18n } from "../i18n/i18n";
import { SessionLanguage } from "../i18n/SessionLanguage";
import { CLIENT_SESSION, fakeApi, Reply } from "../test/fixtures";
import { startSessionEarly, takeEarlySession } from "./early";
import { StillFrame } from "./StillFrame";
import { SessionProvider, useSessionState } from "./session";

function Probe({ seen = [] }: { seen?: string[] }) {
  const { state } = useSessionState();
  const { t } = useI18n();
  if (state.status === "loading") return <StillFrame />;
  const text = `${state.status}: ${t("common.loading")}`;
  seen.push(text);
  return <p data-testid="probe">{text}</p>;
}

afterEach(async () => {
  takeEarlySession();
  await loadAllCatalogs();
});

describe("the session on first load", () => {
  it("takes the answer asked before React mounted, and the frame's calls go with it", async () => {
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/overview": () => new Reply(500, { error: "later" }),
      "GET /api/feedback/status": () => ({ enabled: false }),
    });
    startSessionEarly(api.client);
    const store = new ApiStore(api.client);
    render(
      <ApiProvider client={api.client} store={store}>
        <SessionProvider>
          <Probe />
        </SessionProvider>
      </ApiProvider>,
    );
    expect(await screen.findByText("signed_in: Loading…")).toBeInTheDocument();
    // Asked once, before mount; the portal frame's two calls started beside it.
    expect(api.calls.filter((c) => c === "GET /api/session")).toHaveLength(1);
    expect(api.calls).toEqual(
      expect.arrayContaining(["GET /api/overview", "GET /api/feedback/status"]),
    );
    expect(api.calls.indexOf("GET /api/overview")).toBeLessThan(3);
    await waitFor(() => expect(store.size).toBe(2));
  });

  it("drops the frame's calls when the session refuses", async () => {
    const api = fakeApi({
      "GET /api/session": () => new Reply(401, { error: "unauthenticated" }),
      "GET /api/overview": () => new Reply(401, { error: "unauthenticated" }),
      "GET /api/feedback/status": () => new Reply(401, { error: "unauthenticated" }),
    });
    startSessionEarly(api.client);
    const store = new ApiStore(api.client);
    render(
      <ApiProvider client={api.client} store={store}>
        <SessionProvider>
          <Probe />
        </SessionProvider>
      </ApiProvider>,
    );
    expect(await screen.findByText("signed_out: Loading…")).toBeInTheDocument();
    await waitFor(() => expect(api.calls).toHaveLength(3));
    // Their answers landed in a store that was emptied: nothing of them is kept.
    await new Promise((r) => setTimeout(r, 0));
    expect(store.size).toBe(0);
  });

  it("asks for itself when nothing was asked early", async () => {
    const api = fakeApi({ "GET /api/session": () => CLIENT_SESSION });
    render(
      <ApiProvider client={api.client}>
        <SessionProvider>
          <Probe />
        </SessionProvider>
      </ApiProvider>,
    );
    expect(await screen.findByText("signed_in: Loading…")).toBeInTheDocument();
    expect(api.calls).toEqual(["GET /api/session"]);
  });

  it("shows the still frame until the session's language has loaded: no English, no keys", async () => {
    unloadCatalogs();
    const api = fakeApi({
      "GET /api/session": () => ({
        ...CLIENT_SESSION,
        language: { effective: "es", user: "es", client: null },
      }),
    });
    const seen: string[] = [];
    render(
      <ApiProvider client={api.client}>
        <SessionProvider>
          <SessionLanguage>
            <Probe seen={seen} />
          </SessionLanguage>
        </SessionProvider>
      </ApiProvider>,
    );
    expect(screen.getByTestId("still-frame")).toBeInTheDocument();
    expect(await screen.findByText("signed_in: Cargando…")).toBeInTheDocument();
    expect(new Set(seen)).toEqual(new Set(["signed_in: Cargando…"]));
  });
});
