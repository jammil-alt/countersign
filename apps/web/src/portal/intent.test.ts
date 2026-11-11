// Fetch on intent (docs/audit-plan.md 1.6): which addresses are worth asking for early, one ask
// per target, none in a hidden tab, none before a session names who is asking.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiStore } from "../api/store";
import { fakeApi } from "../test/fixtures";
import { prefetchTarget, targetOf } from "./intent";

const RUN = "00000000-0000-4000-8000-0000000f1001";
const AGENT = "00000000-0000-4000-8000-00000000b001";

function setup() {
  const api = fakeApi({
    [`GET /api/runs/${RUN}`]: () => ({ run: {}, steps: [], approvals: [], actions: [] }),
    [`GET /api/services/${AGENT}`]: () => ({ service: {} }),
    "GET /api/inbox": () => ({ items: [] }),
  });
  const store = new ApiStore(api.client);
  store.setScope("user:client");
  return { api, store };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("targetOf", () => {
  it("knows runs, agents (any tab) and the Inbox, and nothing else", () => {
    expect(targetOf(`/runs/${RUN}`)).toEqual({ kind: "run", id: RUN });
    expect(targetOf(`/agents/${AGENT}`)).toEqual({ kind: "agent", id: AGENT });
    expect(targetOf(`/agents/${AGENT}/access`)).toEqual({ kind: "agent", id: AGENT });
    expect(targetOf("/inbox?item=abc")).toEqual({ kind: "inbox" });
    expect(targetOf("/runs")).toBeNull();
    expect(targetOf("/documents/abc")).toBeNull();
    expect(targetOf("https://example.com/runs/abc")).toBeNull();
  });
});

describe("prefetchTarget", () => {
  it("asks each target's first call once", async () => {
    const { api, store } = setup();
    prefetchTarget(store, { kind: "run", id: RUN });
    prefetchTarget(store, { kind: "run", id: RUN });
    prefetchTarget(store, { kind: "agent", id: AGENT });
    prefetchTarget(store, { kind: "inbox" });
    prefetchTarget(store, { kind: "inbox" });
    await vi.waitFor(() => expect(api.calls).toHaveLength(3));
    expect(api.calls).toEqual([
      `GET /api/runs/${RUN}`,
      `GET /api/services/${AGENT}`,
      "GET /api/inbox",
    ]);
  });

  it("asks again once the store has been emptied (another session)", async () => {
    const { api, store } = setup();
    prefetchTarget(store, { kind: "run", id: RUN });
    await vi.waitFor(() => expect(api.calls).toHaveLength(1));
    store.setScope("other:client");
    prefetchTarget(store, { kind: "run", id: RUN });
    await vi.waitFor(() => expect(api.calls).toHaveLength(2));
  });

  it("asks nothing in a hidden tab, or before a session is known", async () => {
    const { api, store } = setup();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    prefetchTarget(store, { kind: "run", id: RUN });
    vi.restoreAllMocks();
    const fresh = new ApiStore(api.client);
    prefetchTarget(fresh, { kind: "run", id: RUN });
    await new Promise((r) => setTimeout(r, 0));
    expect(api.calls).toEqual([]);
  });
});
