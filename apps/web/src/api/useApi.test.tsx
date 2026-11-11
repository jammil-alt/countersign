import { routes } from "@countersign/core";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SESSION_SCOPE_KEY,
  SessionProvider,
  scopeFingerprint,
  useSessionState,
} from "../session/session";
import { CLIENT_SESSION, fakeApi, OPERATOR_SESSION, Reply } from "../test/fixtures";
import { ApiStore, MAX_ENTRIES } from "./store";
import { ApiProvider, useApi, useApiClient, useApiStore, usePrefetch } from "./useApi";

// A small route with params (`GET /api/ops/feedback/:id/screenshot`) stands for any; its answer's
// `url` carries a name so a test can tell answers apart.
const CLIENT_A = "00000000-0000-4000-8000-00000000a00a";
const CLIENT_B = "00000000-0000-4000-8000-00000000a00b";
const client = (_id: string, name: string) => ({ url: name, expiresAt: "2026-11-11T00:05:00Z" });
const ROUTE = routes.opsFeedbackScreenshot;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function setup(handlers: Parameters<typeof fakeApi>[0]) {
  const api = fakeApi(handlers);
  // One store for every render in the test, as one app's provider would be.
  const store = new ApiStore(api.client);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ApiProvider client={api.client} store={store}>
      {children}
    </ApiProvider>
  );
  return { api, wrapper };
}

const count = (calls: string[], key: string) => calls.filter((c) => c === key).length;

afterEach(() => {
  vi.useRealTimers();
});

describe("useApi's store", () => {
  it("shows a stored answer at once on the way back, and refreshes behind it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let name = "Acme";
    const { api, wrapper } = setup({
      [`GET /api/ops/feedback/${CLIENT_A}/screenshot`]: () => client(CLIENT_A, name),
    });
    const first = renderHook(() => useApi(ROUTE, { params: { id: CLIENT_A } }), {
      wrapper,
    });
    expect(first.result.current.loading).toBe(true);
    await waitFor(() => expect(first.result.current.data?.url).toBe("Acme"));
    first.unmount();

    // A list → row → back later: the list is there on the first render, no loading.
    vi.setSystemTime(Date.now() + 30_000);
    name = "Acme Ltd";
    const back = renderHook(() => useApi(ROUTE, { params: { id: CLIENT_A } }), {
      wrapper,
    });
    expect(back.result.current.loading).toBe(false);
    expect(back.result.current.data?.url).toBe("Acme");
    expect(back.result.current.refreshing).toBe(true);
    await waitFor(() => expect(back.result.current.data?.url).toBe("Acme Ltd"));
    expect(back.result.current.refreshing).toBe(false);
    expect(count(api.calls, `GET /api/ops/feedback/${CLIENT_A}/screenshot`)).toBe(2);
  });

  it("asks once when parts of one screen ask the same route, in flight or just answered", async () => {
    const gate = deferred<unknown>();
    const { api, wrapper } = setup({
      "GET /api/ops/catalog/events": () => gate.promise,
    });
    const hook = () => [
      useApi(routes.opsEventCatalog, {}),
      useApi(routes.opsEventCatalog, {}),
      useApi(routes.opsEventCatalog, {}),
    ];
    const { result } = renderHook(hook, { wrapper });
    gate.resolve({ events: [] });
    await waitFor(() => expect(result.current.every((s) => s.data !== undefined)).toBe(true));
    // A part that mounts a moment later reads the fresh answer.
    const late = renderHook(() => useApi(routes.opsEventCatalog, {}), { wrapper });
    expect(late.result.current.data).toEqual({ events: [] });
    expect(count(api.calls, "GET /api/ops/catalog/events")).toBe(1);
  });

  it("keeps a catalog fresh for five minutes, and asks again after a write (2.5)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { api, wrapper } = setup({
      "GET /api/ops/catalog/events": () => ({ events: [] }),
      [`POST /api/ops/runs/${CLIENT_B}/cancel`]: () => ({ runId: CLIENT_B, status: "cancelled" }),
    });
    const KEY = "GET /api/ops/catalog/events";
    const first = renderHook(() => useApi(routes.opsEventCatalog, { life: "catalog" }), {
      wrapper,
    });
    await waitFor(() => expect(first.result.current.data).toEqual({ events: [] }));
    first.unmount();

    // A minute later another screen mounts it: a default answer would be asked again, a
    // catalog's is not.
    vi.setSystemTime(Date.now() + 60_000);
    const later = renderHook(() => useApi(routes.opsEventCatalog, { life: "catalog" }), {
      wrapper,
    });
    expect(later.result.current.data).toEqual({ events: [] });
    expect(count(api.calls, KEY)).toBe(1);
    // The same answer without the catalog life is refreshed on mount.
    const plain = renderHook(() => useApi(routes.opsEventCatalog, {}), { wrapper });
    await waitFor(() => expect(count(api.calls, KEY)).toBe(2));
    plain.unmount();
    later.unmount();

    // A write marks it stale like every other answer.
    const writer = renderHook(() => useApiClient(), { wrapper });
    await act(() => writer.result.current.call(routes.opsCancelRun, { params: { id: CLIENT_B } }));
    renderHook(() => useApi(routes.opsEventCatalog, { life: "catalog" }), { wrapper });
    await waitFor(() => expect(count(api.calls, KEY)).toBe(3));
  });

  it("prefetches a catalog with its life: a fresh catalog is not asked twice (2.5)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { api, wrapper } = setup({
      "GET /api/ops/catalog/events": () => ({ events: [] }),
    });
    const tools = renderHook(() => ({ prefetch: usePrefetch(), store: useApiStore() }), {
      wrapper,
    });
    tools.result.current.prefetch(routes.opsEventCatalog, {}, "catalog");
    await waitFor(() => expect(count(api.calls, "GET /api/ops/catalog/events")).toBe(1));
    vi.setSystemTime(Date.now() + 60_000);
    tools.result.current.prefetch(routes.opsEventCatalog, {}, "catalog");
    expect(count(api.calls, "GET /api/ops/catalog/events")).toBe(1);
    // Without the life, a minute-old answer is asked again.
    tools.result.current.prefetch(routes.opsEventCatalog, {});
    await waitFor(() => expect(count(api.calls, "GET /api/ops/catalog/events")).toBe(2));
  });

  it("marks every stored answer stale after a successful write", async () => {
    let name = "Acme";
    const { api, wrapper } = setup({
      [`GET /api/ops/feedback/${CLIENT_A}/screenshot`]: () => client(CLIENT_A, name),
      [`POST /api/ops/runs/${CLIENT_B}/cancel`]: () => {
        name = "Acme Ltd";
        return { runId: CLIENT_B, status: "cancelled" };
      },
    });
    const first = renderHook(
      () => ({
        state: useApi(ROUTE, { params: { id: CLIENT_A } }),
        call: useApiClient(),
      }),
      { wrapper },
    );
    await waitFor(() => expect(first.result.current.state.data?.url).toBe("Acme"));
    await act(() =>
      first.result.current.call.call(routes.opsCancelRun, { params: { id: CLIENT_B } }),
    );
    first.unmount();
    // Still well inside the fresh window, but stale: shown, then refreshed.
    const again = renderHook(() => useApi(ROUTE, { params: { id: CLIENT_A } }), {
      wrapper,
    });
    expect(again.result.current.data?.url).toBe("Acme");
    await waitFor(() => expect(again.result.current.data?.url).toBe("Acme Ltd"));
    expect(count(api.calls, `GET /api/ops/feedback/${CLIENT_A}/screenshot`)).toBe(2);
  });

  it("never shows an answer older than five minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { wrapper } = setup({
      [`GET /api/ops/feedback/${CLIENT_A}/screenshot`]: () => client(CLIENT_A, "Acme"),
    });
    const first = renderHook(() => useApi(ROUTE, { params: { id: CLIENT_A } }), {
      wrapper,
    });
    await waitFor(() => expect(first.result.current.data).toBeDefined());
    first.unmount();
    vi.setSystemTime(Date.now() + 5 * 60_000);
    const later = renderHook(() => useApi(ROUTE, { params: { id: CLIENT_A } }), {
      wrapper,
    });
    expect(later.result.current.data).toBeUndefined();
    expect(later.result.current.loading).toBe(true);
    await waitFor(() => expect(later.result.current.data).toBeDefined());
  });

  it('keeps nothing for `cache: "none"`: each mount asks, and nothing is shared', async () => {
    const { api, wrapper } = setup({
      [`GET /api/ops/feedback/${CLIENT_A}/screenshot`]: () => client(CLIENT_A, "Acme"),
    });
    const opts = { params: { id: CLIENT_A }, cache: "none" as const };
    const two = renderHook(() => [useApi(ROUTE, opts), useApi(ROUTE, opts)], { wrapper });
    await waitFor(() => expect(two.result.current.every((s) => s.data)).toBe(true));
    two.unmount();
    const again = renderHook(() => useApi(ROUTE, opts), { wrapper });
    expect(again.result.current.data).toBeUndefined();
    expect(again.result.current.loading).toBe(true);
    await waitFor(() => expect(again.result.current.data).toBeDefined());
    expect(count(api.calls, `GET /api/ops/feedback/${CLIENT_A}/screenshot`)).toBe(3);
    // And a cached hook for the same route never reads the private answers.
    const cached = renderHook(() => useApi(ROUTE, { params: { id: CLIENT_A } }), {
      wrapper,
    });
    expect(cached.result.current.data).toBeUndefined();
  });

  it("says which stored answers were asked before a write, whatever their age", async () => {
    const { wrapper } = setup({
      [`GET /api/ops/feedback/${CLIENT_A}/screenshot`]: () => client(CLIENT_A, "Acme"),
      [`POST /api/ops/runs/${CLIENT_B}/cancel`]: () => ({ runId: CLIENT_B, status: "cancelled" }),
    });
    const hook = renderHook(
      () => ({
        state: useApi(ROUTE, { params: { id: CLIENT_A } }),
        call: useApiClient(),
        store: useApiStore(),
      }),
      { wrapper },
    );
    await waitFor(() => expect(hook.result.current.state.data?.url).toBe("Acme"));
    const { store } = hook.result.current;
    const key = store.key(ROUTE, { params: { id: CLIENT_A } });
    expect(store.staleByWrite(key)).toBe(false);
    expect(store.staleByWrite(store.key(ROUTE, { params: { id: CLIENT_B } }))).toBe(false);
    await act(() =>
      hook.result.current.call.call(routes.opsCancelRun, { params: { id: CLIENT_B } }),
    );
    expect(store.staleByWrite(key)).toBe(true);
    act(() => hook.result.current.state.reload());
    await waitFor(() => expect(store.staleByWrite(key)).toBe(false));
  });

  it("prefetch fills the store without a component", async () => {
    const { api, wrapper } = setup({
      [`GET /api/ops/feedback/${CLIENT_A}/screenshot`]: () => client(CLIENT_A, "Acme"),
    });
    const tools = renderHook(() => ({ prefetch: usePrefetch(), store: useApiStore() }), {
      wrapper,
    });
    tools.result.current.prefetch(ROUTE, { params: { id: CLIENT_A } });
    tools.result.current.prefetch(ROUTE, { params: { id: CLIENT_A } });
    await waitFor(() => expect(api.calls).toHaveLength(1));
    await waitFor(() =>
      expect(
        tools.result.current.store.get(
          tools.result.current.store.key(ROUTE, { params: { id: CLIENT_A } }),
        )?.fetching,
      ).toBe(false),
    );
    const page = renderHook(() => useApi(ROUTE, { params: { id: CLIENT_A } }), {
      wrapper,
    });
    expect(page.result.current.data?.url).toBe("Acme");
    expect(page.result.current.loading).toBe(false);
    expect(api.calls).toHaveLength(1);
  });
});

describe("the store's size", () => {
  it(`keeps at most ${MAX_ENTRIES} answers, letting the least recently used go`, async () => {
    const api = fakeApi({});
    api.on("GET /api/ops/clients", () => ({ clients: [] }));
    const store = new ApiStore(api.client);
    for (let i = 0; i < MAX_ENTRIES + 20; i++) {
      store.prefetch(routes.opsClients, { query: { view: "names" }, page: i } as never);
    }
    await waitFor(() => expect(api.calls).toHaveLength(MAX_ENTRIES + 20));
    await waitFor(() => expect(store.size).toBe(MAX_ENTRIES));
    // The first asked went first; the last are kept.
    expect(store.get(store.key(routes.opsClients, { query: { view: "names" }, page: 0 }))).toBe(
      undefined,
    );
    expect(
      store.get(store.key(routes.opsClients, { query: { view: "names" }, page: MAX_ENTRIES + 19 }))
        ?.data,
    ).toEqual({ clients: [] });
  });
});

describe("a failed refresh keeps the page (1.9)", () => {
  it("keeps the data and shows the error beside it, and a later reload still asks", async () => {
    let fail = false;
    const { api, wrapper } = setup({
      [`GET /api/ops/feedback/${CLIENT_A}/screenshot`]: () =>
        fail ? new Reply(500, { error: "boom" }) : client(CLIENT_A, "Acme"),
    });
    const { result } = renderHook(() => useApi(ROUTE, { params: { id: CLIENT_A } }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.data).toBeDefined());
    fail = true;
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.error).toBeDefined());
    expect(result.current.data?.url).toBe("Acme");
    expect(result.current.loading).toBe(false);
    // A run page polls with `reload`: the next poll still asks, and its answer clears the error.
    fail = false;
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.error).toBeUndefined());
    expect(result.current.data?.url).toBe("Acme");
    expect(count(api.calls, `GET /api/ops/feedback/${CLIENT_A}/screenshot`)).toBe(3);
  });

  it("never shows another entity's data under new params", async () => {
    const gate = deferred<unknown>();
    const { wrapper } = setup({
      [`GET /api/ops/feedback/${CLIENT_A}/screenshot`]: () => client(CLIENT_A, "Acme"),
      [`GET /api/ops/feedback/${CLIENT_B}/screenshot`]: () => gate.promise,
    });
    const { result, rerender } = renderHook(({ id }) => useApi(ROUTE, { params: { id } }), {
      wrapper,
      initialProps: { id: CLIENT_A },
    });
    await waitFor(() => expect(result.current.data?.url).toBe("Acme"));
    rerender({ id: CLIENT_B });
    expect(result.current.data).toBeUndefined();
    expect(result.current.loading).toBe(true);
    gate.resolve(client(CLIENT_B, "Birch"));
    await waitFor(() => expect(result.current.data?.url).toBe("Birch"));
  });

  it("shows nothing of the last answer when a query names another entity", async () => {
    const gate = deferred<unknown>();
    const { wrapper } = setup({
      "GET /api/ops/clients": ({ url }) =>
        url.searchParams.get("view") === "names" ? gate.promise : { clients: [] },
    });
    // Without `keep`, a query change (here `?view=`, as `?client=` or `?agent=` would be) is
    // another answer altogether.
    const { result, rerender } = renderHook(
      ({ view }: { view?: "names" }) => useApi(routes.opsClients, view ? { query: { view } } : {}),
      { wrapper, initialProps: {} },
    );
    await waitFor(() => expect(result.current.data).toEqual({ clients: [] }));
    rerender({ view: "names" });
    expect(result.current.data).toBeUndefined();
    expect(result.current.loading).toBe(true);
    gate.resolve({ clients: [] });
    await waitFor(() => expect(result.current.data).toEqual({ clients: [] }));
  });

  it("keeps the last rows while a new query on the same list loads", async () => {
    const gate = deferred<unknown>();
    const { wrapper } = setup({
      "GET /api/ops/clients": ({ url }) =>
        url.searchParams.get("view") === "names" ? gate.promise : { clients: [] },
    });
    const { result, rerender } = renderHook(
      ({ view }: { view?: "names" }) =>
        useApi(routes.opsClients, view ? { query: { view }, keep: true } : { keep: true }),
      { wrapper, initialProps: {} },
    );
    await waitFor(() => expect(result.current.data).toEqual({ clients: [] }));
    rerender({ view: "names" });
    expect(result.current.data).toEqual({ clients: [] });
    expect(result.current.loading).toBe(false);
    expect(result.current.refreshing).toBe(true);
    gate.resolve({ clients: [] });
    await waitFor(() => expect(result.current.refreshing).toBe(false));
  });
});

describe("the store and the session", () => {
  function Shown() {
    const { data, loading } = useApi(ROUTE, { params: { id: CLIENT_A } });
    return <p data-testid="shown">{loading ? "loading" : (data?.url ?? "none")}</p>;
  }
  function Controls() {
    const { refresh, signOut } = useSessionState();
    return (
      <>
        <button type="button" data-testid="refresh" onClick={() => void refresh()} />
        <button type="button" data-testid="sign-out" onClick={() => void signOut()} />
      </>
    );
  }

  it("a second user's session never sees the first's answers", async () => {
    let session: unknown = OPERATOR_SESSION;
    const gate = deferred<unknown>();
    let name = "First user's view";
    const api = fakeApi({
      "GET /api/session": () => session,
      [`GET /api/ops/feedback/${CLIENT_A}/screenshot`]: () =>
        name === "First user's view" ? client(CLIENT_A, name) : gate.promise,
    });
    render(
      <ApiProvider client={api.client}>
        <SessionProvider>
          <Shown />
          <Controls />
        </SessionProvider>
      </ApiProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("shown")).toHaveTextContent("First user's view"));
    // Another person signs in on the same tab.
    session = { ...CLIENT_SESSION, user: { ...CLIENT_SESSION.user, id: "someone-else" } };
    name = "Second user's view";
    act(() => screen.getByTestId("refresh").click());
    await waitFor(() => expect(screen.getByTestId("shown")).toHaveTextContent("loading"));
    expect(document.body.textContent).not.toContain("First user's view");
    gate.resolve(client(CLIENT_A, name));
    await waitFor(() =>
      expect(screen.getByTestId("shown")).toHaveTextContent("Second user's view"),
    );
  });

  it("empties the store on sign-out, and asks nothing more with the old cookie", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "POST /api/auth/sign-out": () => ({ ok: true, redirectTo: null }),
      [`GET /api/ops/feedback/${CLIENT_A}/screenshot`]: () => client(CLIENT_A, "Acme"),
    });
    let store: ReturnType<typeof useApiStore> | undefined;
    function Grab() {
      store = useApiStore();
      return null;
    }
    // As the app does: the signed-in screens show only while signed in.
    function Gate() {
      const { state } = useSessionState();
      return state.status === "signed_in" ? <Shown /> : <p data-testid="out">{state.status}</p>;
    }
    render(
      <ApiProvider client={api.client}>
        <SessionProvider>
          <Gate />
          <Controls />
          <Grab />
        </SessionProvider>
      </ApiProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("shown")).toHaveTextContent("Acme"));
    const asked = api.calls.length;
    act(() => screen.getByTestId("sign-out").click());
    expect(await screen.findByTestId("out")).toHaveTextContent("signed_out");
    // Long after the sign-out (the idle lock signs out the same way): nothing was asked again and
    // nothing of the session is kept.
    await new Promise((r) => setTimeout(r, 50));
    expect(api.calls.slice(asked)).toEqual(["POST /api/auth/sign-out"]);
    expect(store?.size).toBe(0);
  });

  it("forgets everything when another tab finds someone else signed in", async () => {
    let session: unknown = OPERATOR_SESSION;
    let name = "First user's view";
    const gate = deferred<unknown>();
    const api = fakeApi({
      "GET /api/session": () => session,
      [`GET /api/ops/feedback/${CLIENT_A}/screenshot`]: () =>
        name === "First user's view" ? client(CLIENT_A, name) : gate.promise,
    });
    render(
      <ApiProvider client={api.client}>
        <SessionProvider>
          <Shown />
        </SessionProvider>
      </ApiProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("shown")).toHaveTextContent("First user's view"));
    // Another tab loaded fresh with someone else signed in (as a WorkOS sign-in arrives): the
    // cookie is theirs now, and that tab's fingerprint says so.
    const other = { ...CLIENT_SESSION, user: { ...CLIENT_SESSION.user, id: "someone-else" } };
    session = other;
    name = "Second user's view";
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: SESSION_SCOPE_KEY,
          newValue: scopeFingerprint(`someone-else\u0001${other.activeTenantId ?? ""}`),
        }),
      );
    });
    expect(screen.getByTestId("shown")).toHaveTextContent("loading");
    gate.resolve(client(CLIENT_A, name));
    await waitFor(() =>
      expect(screen.getByTestId("shown")).toHaveTextContent("Second user's view"),
    );
    expect(document.body.textContent).not.toContain("First user's view");
    expect(count(api.calls, "GET /api/session")).toBe(2);
  });

  it("shares this tab's fingerprint, and ignores another tab's that is the same", async () => {
    localStorage.clear();
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/feedback/${CLIENT_A}/screenshot`]: () => client(CLIENT_A, "Acme"),
    });
    render(
      <ApiProvider client={api.client}>
        <SessionProvider>
          <Shown />
        </SessionProvider>
      </ApiProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("shown")).toHaveTextContent("Acme"));
    // A fresh load writes who is signed in, as a hash: no id, no answer.
    const mine = scopeFingerprint(`${OPERATOR_SESSION.user.id}\u0001`);
    expect(localStorage.getItem(SESSION_SCOPE_KEY)).toBe(mine);
    expect(localStorage.getItem(SESSION_SCOPE_KEY)).not.toContain(OPERATOR_SESSION.user.id);
    // Another tab of the same session says the same: nothing is dropped or asked.
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: SESSION_SCOPE_KEY, newValue: mine }));
    });
    expect(screen.getByTestId("shown")).toHaveTextContent("Acme");
    expect(count(api.calls, "GET /api/session")).toBe(1);
  });

  it("keeps a signed-out tab working when another tab signs in or out", async () => {
    const api = fakeApi({
      "GET /api/session": () => new Reply(401, { error: { code: "unauthenticated" } }),
      "GET /api/auth/provider": () => ({ provider: "dev", message: null }),
    });
    // What a signed-out tab shows: the sign-in page, which reads the provider.
    function SignInish() {
      const { data, loading } = useApi(routes.authProvider);
      return <p data-testid="signin">{loading ? "loading" : (data?.provider ?? "none")}</p>;
    }
    render(
      <ApiProvider client={api.client}>
        <SessionProvider>
          <SignInish />
        </SessionProvider>
      </ApiProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("signin")).toHaveTextContent("dev"));
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: SESSION_SCOPE_KEY, newValue: "someone" }),
      );
    });
    // It asks who is signed in (still no one here) and the sign-in page keeps answering.
    await waitFor(() => expect(count(api.calls, "GET /api/session")).toBe(2));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByTestId("signin")).toHaveTextContent("dev");
  });

  it("empties the store when the active client changes", async () => {
    let session = { ...OPERATOR_SESSION, activeTenantId: CLIENT_A };
    const api = fakeApi({
      "GET /api/session": () => session,
      [`GET /api/ops/feedback/${CLIENT_A}/screenshot`]: () => client(CLIENT_A, "Acme"),
    });
    let store: ReturnType<typeof useApiStore> | undefined;
    function Grab() {
      store = useApiStore();
      return null;
    }
    render(
      <ApiProvider client={api.client}>
        <SessionProvider>
          <Shown />
          <Controls />
          <Grab />
        </SessionProvider>
      </ApiProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("shown")).toHaveTextContent("Acme"));
    const before = store?.key(ROUTE, { params: { id: CLIENT_A } }) ?? "";
    session = { ...OPERATOR_SESSION, activeTenantId: CLIENT_B };
    act(() => screen.getByTestId("refresh").click());
    await waitFor(() => expect(store?.get(before)).toBeUndefined());
  });

  it("keeps two providers' answers apart", async () => {
    const one = setup({
      [`GET /api/ops/feedback/${CLIENT_A}/screenshot`]: () => client(CLIENT_A, "One"),
    });
    const two = setup({
      [`GET /api/ops/feedback/${CLIENT_A}/screenshot`]: () => client(CLIENT_A, "Two"),
    });
    const a = renderHook(() => useApi(ROUTE, { params: { id: CLIENT_A } }), {
      wrapper: one.wrapper,
    });
    await waitFor(() => expect(a.result.current.data?.url).toBe("One"));
    const b = renderHook(() => useApi(ROUTE, { params: { id: CLIENT_A } }), {
      wrapper: two.wrapper,
    });
    expect(b.result.current.data).toBeUndefined();
    await waitFor(() => expect(b.result.current.data?.url).toBe("Two"));
  });
});
