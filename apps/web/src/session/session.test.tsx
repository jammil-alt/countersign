// The first load (docs/audit-plan.md 4.1, 4.3): the session asked before React mounts is the one
// the provider uses; no other call leaves before it answers (a racing call could revoke a WorkOS
// session mid-refresh); the frame's first calls follow it, for the session's surface; nothing
// signed in or signed out shows until its language has loaded, and none loads while it is unknown.
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiStore } from "../api/store";
import { ApiProvider } from "../api/useApi";
import { loadAllCatalogs, loadedCatalog, unloadCatalogs } from "../i18n/catalog";
import { useI18n } from "../i18n/i18n";
import { SessionLanguage } from "../i18n/SessionLanguage";
import { CLIENT_SESSION, fakeApi, OPERATOR_SESSION, Reply } from "../test/fixtures";
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

/** A reply the test sends when it chooses. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function mount(client: ReturnType<typeof fakeApi>["client"], store?: ApiStore, seen?: string[]) {
  return render(
    <ApiProvider client={client} {...(store ? { store } : {})}>
      <SessionProvider>
        <SessionLanguage>
          <Probe {...(seen ? { seen } : {})} />
        </SessionLanguage>
      </SessionProvider>
    </ApiProvider>,
  );
}

const tick = () => new Promise((r) => setTimeout(r, 20));

describe("the session on first load", () => {
  it("takes the answer asked before React mounted; no other call leaves before it answers", async () => {
    const session = deferred<unknown>();
    const api = fakeApi({
      "GET /api/session": () => session.promise,
      "GET /api/overview": () => new Reply(500, { error: "later" }),
      "GET /api/feedback/status": () => ({ enabled: false }),
    });
    startSessionEarly(api.client);
    const store = new ApiStore(api.client);
    mount(api.client, store);
    expect(screen.getByTestId("still-frame")).toBeInTheDocument();
    await tick();
    // While the session is unanswered the cookie may be mid-refresh: nothing else may use it.
    expect(api.calls).toEqual(["GET /api/session"]);
    session.resolve(CLIENT_SESSION);
    expect(await screen.findByText("signed_in: Loading…")).toBeInTheDocument();
    // Asked once, before mount; then the portal frame's two calls, into the store.
    expect(api.calls[0]).toBe("GET /api/session");
    expect(api.calls.filter((c) => c === "GET /api/session")).toHaveLength(1);
    expect([...api.calls.slice(1)].sort()).toEqual([
      "GET /api/feedback/status",
      "GET /api/overview",
    ]);
    await waitFor(() => expect(store.size).toBe(2));
  });

  it("asks for the back office's frame when the session is an operator's, wherever it landed", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/clients": () => ({ clients: [] }),
    });
    startSessionEarly(api.client);
    mount(api.client);
    expect(await screen.findByText("signed_in: Loading…")).toBeInTheDocument();
    await waitFor(() => expect(api.calls).toEqual(["GET /api/session", "GET /api/ops/clients"]));
  });

  it("asks nothing else when the session refuses", async () => {
    const api = fakeApi({
      "GET /api/session": () => new Reply(401, { error: "unauthenticated" }),
    });
    startSessionEarly(api.client);
    const store = new ApiStore(api.client);
    mount(api.client, store);
    expect(await screen.findByText("signed_out: Loading…")).toBeInTheDocument();
    await tick();
    expect(api.calls).toEqual(["GET /api/session"]);
    expect(store.size).toBe(0);
  });

  it("asks for itself when nothing was asked early, and prefetches nothing", async () => {
    const api = fakeApi({ "GET /api/session": () => CLIENT_SESSION });
    mount(api.client);
    expect(await screen.findByText("signed_in: Loading…")).toBeInTheDocument();
    await tick();
    expect(api.calls).toEqual(["GET /api/session"]);
  });

  it("loads no language while the session loads, then only the session's: no English, no keys", async () => {
    unloadCatalogs();
    // A German browser, a Spanish session: German is never fetched.
    const languages = vi.spyOn(navigator, "languages", "get").mockReturnValue(["de-DE"]);
    const session = deferred<unknown>();
    const api = fakeApi({ "GET /api/session": () => session.promise });
    const seen: string[] = [];
    try {
      mount(api.client, undefined, seen);
      expect(screen.getByTestId("still-frame")).toBeInTheDocument();
      await tick();
      expect(loadedCatalog("de")).toBeUndefined();
      session.resolve({
        ...CLIENT_SESSION,
        language: { effective: "es", user: "es", client: null },
      });
      expect(await screen.findByText("signed_in: Cargando…")).toBeInTheDocument();
      expect(new Set(seen)).toEqual(new Set(["signed_in: Cargando…"]));
      expect(loadedCatalog("de")).toBeUndefined();
    } finally {
      languages.mockRestore();
    }
  });

  it("signed out, reads in the browser's language", async () => {
    unloadCatalogs();
    const languages = vi.spyOn(navigator, "languages", "get").mockReturnValue(["de-DE"]);
    const api = fakeApi({
      "GET /api/session": () => new Reply(401, { error: "unauthenticated" }),
    });
    try {
      mount(api.client);
      expect(await screen.findByText("signed_out: Wird geladen…")).toBeInTheDocument();
    } finally {
      languages.mockRestore();
    }
  });
});
