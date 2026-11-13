import { MOBILE_SESSION_HEADER, routes, SESSION_ACTIVITY_HEADER } from "@countersign/core";
import { describe, expect, it, vi } from "vitest";
import { type Credentials, createApiClient, DEV_USER_HEADER, isApiError } from "./client";

const SESSION_BODY = {
  user: { id: "u1", email: "maria@example.com", name: "Maria" },
  operator: false,
  tenants: [{ id: "t1", name: "Northside Millwork", role: "client_admin" }],
  activeTenantId: "t1",
  language: { effective: "en", user: null, client: null },
  lead: null,
};

function setup(credentials: Credentials, answer: () => Response) {
  const seen: { url: string; init: RequestInit }[] = [];
  const renewed = vi.fn();
  const ended = vi.fn();
  const api = createApiClient({
    origin: "https://staging.mezonas.test/",
    session: { credentials: () => credentials, renewed, ended },
    fetch: async (url, init) => {
      seen.push({ url, init });
      return answer();
    },
  });
  return { api, seen, renewed, ended };
}

const ok = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });

const headersOf = (init: RequestInit) => init.headers as Record<string, string>;

describe("the app's API client", () => {
  it("sends the sealed session in its header, never a cookie", async () => {
    const { api, seen } = setup({ kind: "session", session: "sealed-1" }, () => ok(SESSION_BODY));
    const me = await api.call(routes.session);
    expect(me.user.email).toBe("maria@example.com");
    expect(seen[0]?.url).toBe("https://staging.mezonas.test/api/session");
    const h = headersOf(seen[0]?.init ?? {});
    expect(h[MOBILE_SESSION_HEADER]).toBe("sealed-1");
    expect(h.cookie).toBeUndefined();
    expect(h[SESSION_ACTIVITY_HEADER]).toBeUndefined();
  });

  it("marks only the person's own requests as activity", async () => {
    const { api, seen } = setup({ kind: "session", session: "s" }, () => ok({ items: [] }));
    await api.call(routes.portalInbox, { query: { view: "waiting" }, byPerson: true });
    expect(headersOf(seen[0]?.init ?? {})[SESSION_ACTIVITY_HEADER]).toBe("1");
    expect(seen[0]?.url).toBe("https://staging.mezonas.test/api/inbox?view=waiting");
  });

  it("keeps a session the API sealed again", async () => {
    const { api, renewed, ended } = setup({ kind: "session", session: "old" }, () =>
      ok(SESSION_BODY, { [MOBILE_SESSION_HEADER]: "new" }),
    );
    await api.call(routes.session);
    expect(renewed).toHaveBeenCalledWith("new");
    expect(ended).not.toHaveBeenCalled();
  });

  it("signs out when the API answers with an empty session", async () => {
    const { api, renewed, ended } = setup({ kind: "session", session: "old" }, () =>
      ok({ ok: true, redirectTo: null }, { [MOBILE_SESSION_HEADER]: "" }),
    );
    await api.call(routes.signOut);
    expect(ended).toHaveBeenCalledTimes(1);
    expect(renewed).not.toHaveBeenCalled();
  });

  it("signs out on a 401 and says why", async () => {
    const { api, ended } = setup(
      { kind: "session", session: "old" },
      () =>
        new Response(JSON.stringify({ error: { code: "session_invalid", message: "idle" } }), {
          status: 401,
        }),
    );
    const error = await api.call(routes.session).catch((e: unknown) => e);
    expect(isApiError(error) && error.code).toBe("session_invalid");
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it("uses the dev header with the dev sign-in", async () => {
    const { api, seen } = setup({ kind: "dev", email: "maria@example.com" }, () =>
      ok(SESSION_BODY),
    );
    await api.call(routes.session);
    const h = headersOf(seen[0]?.init ?? {});
    expect(h[DEV_USER_HEADER]).toBe("maria@example.com");
    expect(h[MOBILE_SESSION_HEADER]).toBeUndefined();
  });

  it("checks bodies before they leave and responses against the contract", async () => {
    const { api, seen } = setup({ kind: "session", session: "s" }, () => ok({ nope: true }));
    const bad = await api
      .call(routes.setMyPush, { body: { on: true, every: "sometimes" } as never })
      .catch((e: unknown) => e);
    expect(isApiError(bad) && bad.code).toBe("invalid_request");
    expect(seen).toHaveLength(0);
    const wrong = await api.call(routes.myPush).catch((e: unknown) => e);
    expect(isApiError(wrong) && wrong.code).toBe("invalid_response");
  });

  it("reports a network failure in plain words", async () => {
    const api = createApiClient({
      origin: "https://x.test",
      session: { credentials: () => ({ kind: "none" }), renewed: () => {}, ended: () => {} },
      fetch: async () => {
        throw new TypeError("Network request failed");
      },
    });
    const error = await api.call(routes.session).catch((e: unknown) => e);
    expect(isApiError(error) && error.code).toBe("network");
  });
});
