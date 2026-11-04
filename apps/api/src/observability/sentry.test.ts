// Error tracking's options and privacy filters (./sentry.ts). Nothing here reaches Sentry.

import { describe, expect, it } from "vitest";
import {
  scrubBreadcrumb,
  scrubEvent,
  sentryOptions,
  withoutQuery,
  withoutQueryParams,
  withoutSecrets,
} from "./sentry";

describe("Sentry on the Worker", () => {
  it("is off without a DSN, and names the environment and the deployed commit", () => {
    expect(sentryOptions({ SENTRY_DSN: "", ENVIRONMENT: "staging" })).not.toHaveProperty("dsn");
    expect(sentryOptions({}).environment).toBe("development");
    const on = sentryOptions({
      SENTRY_DSN: " https://k@o1.ingest.sentry.io/2 ",
      ENVIRONMENT: "staging",
      DEPLOYED_SHA: "a".repeat(40),
    });
    expect(on).toMatchObject({
      dsn: "https://k@o1.ingest.sentry.io/2",
      environment: "staging",
      release: "a".repeat(40),
      tracesSampleRate: 0,
    });
    expect(on.dataCollection).toMatchObject({
      userInfo: false,
      cookies: false,
      httpBodies: [],
      urlQueryParams: false,
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      stackFrameVariables: false,
    });
  });

  it("strips bodies, cookies, headers but the user agent, queries, and the user to an id", () => {
    const event = scrubEvent({
      type: undefined,
      request: {
        url: "https://staging.mezonas.com/api/auth/callback?code=secret&state=s",
        data: '{"vendor":"what the invoice said"}',
        cookies: { __Host_cs_session: "x" },
        query_string: "code=secret",
        headers: { "user-agent": "curl", cookie: "session=x", authorization: "Bearer t" },
      },
      user: { id: "u1", email: "a@b.c", ip_address: "1.2.3.4" },
      exception: { values: [{ type: "Error", value: "z".repeat(800) }] },
    });
    expect(event.request).toEqual({
      url: "https://staging.mezonas.com/api/auth/callback",
      headers: { "user-agent": "curl" },
    });
    expect(event.user).toEqual({ id: "u1" });
    expect(event.exception?.values?.[0]?.value?.endsWith("…")).toBe(true);
    expect(scrubBreadcrumb({ category: "console", message: "x" })).toBeNull();
    expect(scrubBreadcrumb({ category: "fetch", data: { url: "https://x/y?k=1" } })?.data).toEqual({
      url: "https://x/y",
    });
    expect(withoutQuery("/a#b")).toBe("/a");
  });

  it("removes a failed query's bound values, and the frames the SDK made from them", () => {
    const statement = 'Failed query: insert into "doc_line" ("description") values ($1)';
    const event = scrubEvent({
      type: undefined,
      exception: {
        values: [
          {
            type: "Error",
            value: `${statement}\nparams: Baltic birch 3/4, 64.00`,
            stacktrace: {
              frames: [
                { filename: "src/runs/execute.ts", lineno: 96, function: "executeRun" },
                { filename: "Baltic birch 3/4", function: "?" },
              ],
            },
          },
        ],
      },
    });
    const [ex] = event.exception?.values ?? [];
    expect(ex?.value).toBe(`${statement}\nparams: (removed)`);
    expect(ex?.stacktrace?.frames).toEqual([
      { filename: "src/runs/execute.ts", lineno: 96, function: "executeRun" },
    ]);
    expect(withoutQueryParams("no params here")).toBe("no params here");
  });

  it("removes anything shaped like a key, token or password in a connection string", () => {
    const cases = [
      "OpenAI 401: Incorrect API key provided: sk-proj-abcdefghijklmnop1234",
      "WorkOS refused sk_test_a1b2c3d4e5f6g7h8i9",
      "anthropic key sk-ant-api03-abcdefghijklmnopqrstu",
      "header Bearer abcdefghijklmnop.qrstuv",
      "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl",
      "connect postgresql://cs_worker:hunter2secret@ep-x.neon.tech/countersign failed",
    ];
    for (const text of cases) {
      const out = withoutSecrets(text);
      expect(out, text).toContain("(removed)");
      expect(out).not.toMatch(/hunter2|abcdefghijklmnop|a1b2c3d4|eyJhbGci/);
    }
    expect(withoutSecrets("record R-1001 not found")).toBe("record R-1001 not found");
    const event = scrubEvent({
      type: undefined,
      message: "failed with sk_live_0123456789abcdef",
      exception: { values: [{ type: "Error", value: "key sk-ant-api03-zzzzzzzzzzzzzzzz" }] },
    });
    expect(event.message).toBe("failed with (removed)");
    expect(event.exception?.values?.[0]?.value).toBe("key (removed)");
  });
});
