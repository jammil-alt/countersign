import { defineRoute, routes } from "@countersign/core";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { z } from "zod";
import { ApiError, createApiClient, type ResponseOf } from "./client";
import { apiRoutes } from "./routes";

/** A route with a free-form path parameter, to see it encoded. */
const thing = defineRoute({
  method: "GET",
  path: "/api/ops/things/:id",
  auth: "session",
  roles: ["operator"],
  summary: "test only",
  params: z.object({ id: z.string() }),
  response: z.unknown(),
});

function respond(status: number, body: string, contentType = "application/json") {
  return vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(body, { status, headers: { "content-type": contentType } }),
  );
}

async function failure(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    return e as ApiError;
  }
  throw new Error("expected the call to fail");
}

describe("api client", () => {
  it("returns the parsed response, typed by the route", async () => {
    const fetch = respond(200, JSON.stringify({ ok: true, extra: "ignored" }));
    const api = createApiClient({ fetch });
    const res = await api.call(routes.health);
    expect(res).toEqual({ ok: true });
    expectTypeOf(res).toEqualTypeOf<ResponseOf<typeof routes.health>>();
    expectTypeOf(res.ok).toEqualTypeOf<true>();
    expect(fetch).toHaveBeenCalledWith(
      "/api/health",
      expect.objectContaining({ method: "GET", credentials: "same-origin" }),
    );
  });

  it("fills path parameters and the query string", async () => {
    const fetch = respond(200, JSON.stringify({ users: [] }));
    const api = createApiClient({ fetch, baseUrl: "http://x" });
    await api.call(apiRoutes.devUsers, { query: { a: 1, b: undefined, c: "x y" } });
    expect(fetch.mock.calls[0]?.[0]).toBe("http://x/api/auth/dev/users?a=1&c=x+y");

    const agent = respond(500, "{}");
    await failure(createApiClient({ fetch: agent }).call(thing, { params: { id: "a/b" } }));
    expect(agent.mock.calls[0]?.[0]).toBe("/api/ops/things/a%2Fb");
  });

  it("reports a 401 as unauthenticated, with the server's code and message", async () => {
    const api = createApiClient({
      fetch: respond(401, JSON.stringify({ code: "session_invalid", message: "not signed in" })),
    });
    const e = await failure(api.call(routes.session));
    expect(e.status).toBe(401);
    expect(e.unauthenticated).toBe(true);
    expect(e.code).toBe("session_invalid");
    expect(e.message).toBe("not signed in");
    expect(e.route).toBe("GET /api/session");
  });

  it("reads both error body shapes and falls back to a code for the status", async () => {
    const nested = createApiClient({
      fetch: respond(
        403,
        JSON.stringify({ error: { code: "forbidden", message: "operators only" } }),
      ),
    });
    const a = await failure(nested.call(apiRoutes.opsClients));
    expect([a.status, a.code, a.message]).toEqual([403, "forbidden", "operators only"]);

    const flat = createApiClient({ fetch: respond(409, JSON.stringify({ error: "conflict" })) });
    const b = await failure(flat.call(apiRoutes.opsClients));
    expect([b.status, b.code]).toEqual([409, "conflict"]);

    const html = createApiClient({ fetch: respond(502, "<h1>Bad gateway</h1>", "text/html") });
    const c = await failure(html.call(apiRoutes.opsClients));
    expect([c.status, c.code]).toEqual([502, "http_502"]);
    expect(c.body).toBe("<h1>Bad gateway</h1>");

    const missing = createApiClient({ fetch: respond(404, "") });
    expect((await failure(missing.call(apiRoutes.opsClients))).code).toBe("not_found");
  });

  it("rejects a 2xx body that breaks the contract or is not JSON", async () => {
    const wrong = createApiClient({
      fetch: respond(200, JSON.stringify({ clients: [{ id: 1 }] })),
    });
    const a = await failure(wrong.call(apiRoutes.opsClients));
    expect(a.code).toBe("invalid_response");
    expect(a.message).toMatch(/clients\.0/);

    const text = createApiClient({ fetch: respond(200, "ok", "text/plain") });
    expect((await failure(text.call(routes.health))).code).toBe("invalid_response");
  });

  it("refuses to send a body or params that fail the route's schema", async () => {
    const fetch = respond(200, "{}");
    const api = createApiClient({ fetch });
    const a = await failure(api.call(apiRoutes.devSignIn, { body: { email: "not an email" } }));
    expect([a.status, a.code]).toEqual([0, "invalid_request"]);
    const b = await failure(api.call(apiRoutes.opsClient, { params: { id: "" } }));
    expect(b.code).toBe("invalid_request");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("turns a failed fetch into a network error, but lets an abort through", async () => {
    const down = createApiClient({
      fetch: vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    });
    const e = await failure(down.call(routes.health));
    expect([e.status, e.code]).toEqual([0, "network"]);
    expect(e.cause).toBeInstanceOf(TypeError);

    const aborted = createApiClient({
      fetch: vi.fn(async () => {
        throw new DOMException("aborted", "AbortError");
      }),
    });
    await expect(aborted.call(routes.health)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("sends JSON bodies with a content type", async () => {
    const fetch = respond(200, JSON.stringify({ ok: true }));
    await createApiClient({ fetch }).call(apiRoutes.devSignIn, { body: { email: "a@b.co" } });
    const init = fetch.mock.calls[0]?.[1] ?? {};
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ email: "a@b.co" }));
    expect(init.headers).toMatchObject({ "content-type": "application/json" });
  });
});
