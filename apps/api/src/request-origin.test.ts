// State-changing requests come from the app's own pages (./request-origin.ts): a cookie-signed
// request from another origin, or from a sibling host under the same domain, is refused before any
// route runs; requests with no browser headers, the phone app's header and the machine endpoints
// go on. The exempt list is held against the app's actual routes, so a new route is checked unless
// it is added here on purpose.

import { DEV_USER_COOKIE } from "@countersign/auth";
import { MOBILE_SESSION_HEADER, routes } from "@countersign/core";
import { afterAll, describe, expect, it } from "vitest";
import { type ApiHarness, admin, createApiHarness } from "./api.test-helper";
import { createApp } from "./app";
import { ORIGIN_EXEMPT_PATHS, originExempt, sameOriginRequest } from "./request-origin";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

describe("which routes are exempt", () => {
  const all = createApp().routes.filter((r) => !SAFE.has(r.method));
  const exempt = [
    ...new Set(all.filter((r) => originExempt(r.path)).map((r) => `${r.method} ${r.path}`)),
  ].sort();

  it("exempts only the machine endpoints, token links and the phone's code exchange", () => {
    expect(exempt).toEqual(
      [
        "POST /api/billing/stripe/webhook",
        "POST /api/connections/bankfeed/webhook/:tenantId",
        "POST /api/connections/qbo/webhook",
        "POST /api/elevenlabs/post-call",
        "POST /api/forms/:token",
        "POST /api/forms/:token/files",
        "PUT /api/forms/:token/draft",
        "POST /api/hooks/:tenantId/:hookId",
        "POST /api/hooks/gchat",
        "POST /api/hooks/resend",
        "POST /api/hooks/teams",
        "POST /api/hooks/whatsapp_meta",
        "POST /api/hooks/zoho_crm/:tenantId/:connectionId",
        "POST /api/in/:pack/:tenantId/:target",
        // The middleware that keeps the phone's sign-in routes off unless MOBILE_SIGNIN is on.
        "ALL /api/mobile/session",
        "POST /api/mobile/session",
        "POST /api/text-signup/:token",
        "POST /api/text-signup/:token/decline",
        "POST /api/twilio/:tenantId/messages",
        "POST /api/twilio/:tenantId/status",
        "POST /api/twilio/:tenantId/voice",
        "POST /api/twilio/:tenantId/voice/answer",
        "POST /api/twilio/:tenantId/voice/status",
        "POST /api/voice/:tenantId/tools/:tool",
      ].sort(),
    );
  });

  it("names no path the app doesn't have", () => {
    for (const p of ORIGIN_EXEMPT_PATHS) {
      expect(
        all.some(
          (r) => originExempt(r.path) && (p.endsWith("/") ? r.path.startsWith(p) : r.path === p),
        ),
        p,
      ).toBe(true);
    }
  });

  it("never exempts a session route of the contract", () => {
    const session = Object.values(routes).filter(
      (r) => r.auth === "session" && !SAFE.has(r.method),
    );
    expect(session.length).toBeGreaterThan(100);
    for (const r of session) expect(originExempt(r.path), `${r.method} ${r.path}`).toBe(false);
  });

  it("checks the sign-in's own routes and the Claude connection's approval", () => {
    for (const path of [
      "/api/auth/dev/sign-in",
      "/api/auth/sign-out",
      "/api/auth/second-factor/verify",
      "/api/auth/claude-connections/abc/approve",
      "/api/users",
      "/api/inbox/abc/resolve",
      "/api/connections/abc/webhook/hooks",
      "/api/ops/clients/abc/invites",
    ]) {
      expect(originExempt(path), path).toBe(false);
    }
  });
});

describe("the check", () => {
  const env = { APP_ORIGIN: "https://app.mezonas.com", ENVIRONMENT: "production" };
  const post = (headers: Record<string, string>, method = "POST") =>
    new Request("https://app.mezonas.com/api/users", { method, headers });
  const allowed = (headers: Record<string, string>, method = "POST", e = env) =>
    sameOriginRequest(post(headers, method), "/api/users", e);

  it("lets the app's own pages through", () => {
    expect(allowed({ origin: "https://app.mezonas.com", "sec-fetch-site": "same-origin" })).toBe(
      true,
    );
    expect(allowed({ origin: "https://app.mezonas.com" })).toBe(true);
    expect(allowed({ "sec-fetch-site": "same-origin" })).toBe(true);
    // APP_ORIGIN written with a trailing slash still names the same origin.
    expect(
      allowed({ origin: "https://app.mezonas.com" }, "POST", {
        ...env,
        APP_ORIGIN: "https://app.mezonas.com/",
      }),
    ).toBe(true);
  });

  it("refuses another origin, a sibling host and an origin the browser won't name", () => {
    for (const headers of [
      { origin: "https://evil.example" },
      { origin: "https://staging.mezonas.com" },
      { origin: "https://mezonas.com" },
      { origin: "http://app.mezonas.com" },
      { origin: "null" },
      { "sec-fetch-site": "same-site" },
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "none" },
      { origin: "https://app.mezonas.com", "sec-fetch-site": "same-site" },
      { origin: "https://staging.mezonas.com", "sec-fetch-site": "same-origin" },
    ]) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        expect(allowed(headers, method), `${method} ${JSON.stringify(headers)}`).toBe(false);
      }
    }
  });

  it("checks no GET, HEAD or OPTIONS", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(allowed({ origin: "https://evil.example" }, method)).toBe(true);
    }
  });

  it("lets loopback origins through in development only (Vite's dev server)", () => {
    const local = { APP_ORIGIN: "http://localhost:8787", ENVIRONMENT: "development" };
    expect(allowed({ origin: "http://localhost:5173" }, "POST", local)).toBe(true);
    expect(allowed({ origin: "http://127.0.0.1:8787" }, "POST", local)).toBe(true);
    expect(allowed({ origin: "http://localhost:5173" }, "POST", env)).toBe(false);
    expect(
      allowed({ origin: "http://localhost:5173" }, "POST", { ...local, ENVIRONMENT: "staging" }),
    ).toBe(false);
    expect(allowed({ origin: "https://evil.example" }, "POST", local)).toBe(false);
  });

  it("lets a request with no browser headers through, and the phone app's header", () => {
    expect(allowed({})).toBe(true);
    expect(allowed({ [MOBILE_SESSION_HEADER]: "x", origin: "https://evil.example" })).toBe(true);
  });
});

const h = await createApiHarness();
afterAll(() => h?.close());

describe.skipIf(!h)("through the API", () => {
  const H = h as ApiHarness;
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as never;
  // The harness's env leaves APP_ORIGIN unset: the app's origin is then https://app.mezonas.com.
  const APP = "https://app.mezonas.com";

  async function send(
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: string,
  ) {
    const res = await H.app.request(
      path,
      { method, headers, ...(body === undefined ? {} : { body }) },
      H.env,
      ctx,
    );
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json: j(json), headers: res.headers };
  }

  const signedIn = (email: string) => ({
    cookie: `${DEV_USER_COOKIE}=${encodeURIComponent(email)}`,
  });
  const JSON_TYPE = { "content-type": "application/json" };

  it("refuses a cookie-signed request from another origin or a sibling host, before the route", async () => {
    for (const from of [
      { origin: "https://staging.mezonas.com", "sec-fetch-site": "same-site" },
      { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
      { origin: "https://evil.example" },
      { "sec-fetch-site": "same-site" },
    ]) {
      const invite = await send(
        "POST",
        "/api/users",
        { ...signedIn(admin("a")), ...from, "content-type": "text/plain;charset=UTF-8" },
        JSON.stringify({ email: "new@a.example.com", name: "New", role: "client_user" }),
      );
      expect(invite.status, JSON.stringify(from)).toBe(403);
      expect(invite.json.error.code).toBe("forbidden");
      // The API's security headers are on the refusal too.
      expect(invite.headers.get("x-content-type-options")).toBe("nosniff");

      const out = await send("POST", "/api/auth/sign-out", { ...signedIn(admin("a")), ...from });
      expect(out.status).toBe(403);
      expect(out.headers.get("set-cookie")).toBeNull();

      const signIn = await send(
        "POST",
        "/api/auth/dev/sign-in",
        { ...from, ...JSON_TYPE },
        JSON.stringify({ email: admin("a") }),
      );
      expect(signIn.status).toBe(403);
      expect(signIn.headers.get("set-cookie")).toBeNull();
    }
  });

  it("lets the app's own pages through", async () => {
    const from = { origin: APP, "sec-fetch-site": "same-origin" };
    const signIn = await send(
      "POST",
      "/api/auth/dev/sign-in",
      { ...from, ...JSON_TYPE },
      JSON.stringify({ email: admin("a") }),
    );
    expect(signIn.status, JSON.stringify(signIn.json)).toBe(200);
    expect(signIn.headers.get("set-cookie")).toContain(`${DEV_USER_COOKIE}=`);
    const out = await send("POST", "/api/auth/sign-out", { ...signedIn(admin("a")), ...from });
    expect(out.status, JSON.stringify(out.json)).toBe(200);
  });

  it("refuses a JSON body that doesn't say it is JSON", async () => {
    const res = await send(
      "POST",
      "/api/auth/dev/sign-in",
      { origin: APP, "content-type": "text/plain;charset=UTF-8" },
      JSON.stringify({ email: admin("a") }),
    );
    expect(res.status).toBe(415);
    expect(res.headers.get("set-cookie")).toBeNull();
    const charset = await send(
      "POST",
      "/api/auth/dev/sign-in",
      { origin: APP, "content-type": "application/json; charset=utf-8" },
      JSON.stringify({ email: admin("a") }),
    );
    expect(charset.status).toBe(200);
  });

  it("lets machine endpoints through whatever the origin", async () => {
    const from = { origin: "https://evil.example", "sec-fetch-site": "cross-site" };
    // A measured website's beacon, sent as text from its own pages: always 204.
    const beacon = await send(
      "POST",
      `/api/in/marketing/${H.A.tenantId}/${H.A.tenantId}`,
      { ...from, "content-type": "text/plain;charset=UTF-8" },
      "{}",
    );
    expect(beacon.status).toBe(204);
    // A generic webhook (its token in the path): an unknown one is not found, whatever the origin.
    const hook = await send(
      "POST",
      `/api/hooks/${H.A.tenantId}/${H.A.connectionId}`,
      { ...from, ...JSON_TYPE },
      "{}",
    );
    expect(hook.status, JSON.stringify(hook.json)).not.toBe(403);
    expect(hook.json?.error?.code).not.toBe("forbidden");
  });
});
