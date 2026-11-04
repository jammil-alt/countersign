// Error tracking in the browser (./observability.ts): the privacy filters, where it runs, and
// which failed calls are worth reporting. Nothing here reaches Sentry.
import { describe, expect, it } from "vitest";
import { ApiError } from "./api/client";
import {
  apiFailureKind,
  environmentOf,
  reportApiFailure,
  scrubBreadcrumb,
  scrubEvent,
  withoutQuery,
} from "./observability";

const failure = (status: number, code: string) =>
  new ApiError({ status, code, message: code, route: "GET /api/session" });

describe("error tracking in the browser", () => {
  it("strips bodies, cookies, headers but the user agent, queries, and the user to an id", () => {
    const event = scrubEvent({
      type: undefined,
      request: {
        url: "https://staging.mezonas.com/sign-in?error=not_invited#x",
        data: { vendor: "what the invoice said" },
        cookies: { session: "x" },
        query_string: "error=not_invited",
        headers: { "User-Agent": "Safari", Cookie: "session=x", Authorization: "Bearer y" },
      },
      user: { id: "u1", email: "a@b.c", ip_address: "1.2.3.4" },
      message: "x".repeat(900),
      exception: { values: [{ type: "Error", value: "y".repeat(900) }] },
    });
    expect(event.request).toEqual({
      url: "https://staging.mezonas.com/sign-in",
      headers: { "user-agent": "Safari" },
    });
    expect(event.user).toEqual({ id: "u1" });
    expect(event.message?.length).toBe(501);
    expect(event.exception?.values?.[0]?.value?.length).toBe(501);
  });

  it("drops console breadcrumbs and cuts queries from navigation and fetch ones", () => {
    expect(scrubBreadcrumb({ category: "console", message: "a client's data" })).toBeNull();
    expect(
      scrubBreadcrumb({ category: "navigation", data: { from: "/a?x=1", to: "/b#c" } })?.data,
    ).toEqual({ from: "/a", to: "/b" });
    expect(
      scrubBreadcrumb({ category: "fetch", data: { url: "/api/x?token=1", status_code: 500 } })
        ?.data,
    ).toEqual({ url: "/api/x", status_code: 500 });
    expect(withoutQuery("/plain")).toBe("/plain");
  });

  it("runs only on the Mezonas hosts", () => {
    expect(environmentOf("localhost")).toBeNull();
    expect(environmentOf("127.0.0.1")).toBeNull();
    expect(environmentOf("staging.mezonas.com")).toBe("staging");
    expect(environmentOf("app.mezonas.com")).toBe("production");
    expect(environmentOf("mezonas.com.evil.example")).toBeNull();
  });

  it("reports what no user can fix, and not the API working or a page being left", () => {
    expect(apiFailureKind(failure(0, "network"), false)).toBe("api_unreachable");
    expect(apiFailureKind(failure(0, "network"), true)).toBeNull();
    expect(apiFailureKind(failure(200, "invalid_response"), false)).toBe("api_contract");
    expect(apiFailureKind(failure(500, "internal"), false)).toBe("api_5xx");
    expect(apiFailureKind(failure(401, "unauthenticated"), false)).toBeNull();
    expect(apiFailureKind(failure(403, "forbidden"), false)).toBeNull();
    expect(apiFailureKind(failure(0, "invalid_request"), false)).toBeNull();
  });

  it("is a no-op until started (tests and local development never send)", () => {
    expect(() => reportApiFailure(failure(500, "internal"))).not.toThrow();
  });
});
