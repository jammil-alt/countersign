import { MOBILE_SESSION_HEADER, MOBILE_SIGNED_IN_URL } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { readCookie } from "../cookies";
import {
  MOBILE_START_COOKIE,
  mobileHandoff,
  mobileRedeem,
  mobileSessionFromSetCookies,
  mobileStartCookie,
  pkceChallengeOf,
  withMobileSession,
} from "./mobile";
import {
  clearSessionCookie,
  epochSec,
  newSession,
  SESSION_COOKIE,
  sealSession,
  sessionCookie,
} from "./session";

const PASSWORD = "a-test-cookie-password-of-32-chars-or-more";
const VERIFIER = "v".repeat(43) + "-._~0123456789";
const T0 = new Date("2026-11-13T15:00:00Z");

async function sealedSession(now = T0) {
  const session = newSession(
    {
      userId: "0190a1b2-0000-7000-8000-000000000001",
      workosUserId: "user_01",
      email: "maria@example.com",
      workosOrganizationId: null,
      sessionId: "session_01",
      refreshToken: "refresh",
    },
    epochSec(now),
  );
  return { session, sealed: await sealSession(session, PASSWORD) };
}

const cookieValue = (setCookie: string, name: string) => readCookie(setCookie.split(";")[0], name);

async function browserAfterSignIn(challenge: string, now = T0) {
  const start = await mobileStartCookie(challenge, PASSWORD, now);
  const { sealed } = await sealedSession(now);
  return new Request("https://app.mezonas.test/api/mobile/handoff", {
    headers: {
      cookie: `${MOBILE_START_COOKIE}=${cookieValue(start, MOBILE_START_COOKIE)}; ${SESSION_COOKIE}=${sealed}`,
    },
  });
}

describe("signing in from the phone app", () => {
  it("hands the browser's session to the app, which redeems it with its verifier", async () => {
    const challenge = await pkceChallengeOf(VERIFIER);
    const handoff = await mobileHandoff(await browserAfterSignIn(challenge), PASSWORD, T0);
    if (!handoff.ok) throw new Error(handoff.reason);
    expect(handoff.redirectTo.startsWith(`${MOBILE_SIGNED_IN_URL}?code=`)).toBe(true);
    // The browser keeps neither the session nor the challenge.
    expect(handoff.setCookies.some((c) => c.startsWith(`${SESSION_COOKIE}=;`))).toBe(true);
    expect(handoff.setCookies.some((c) => c.startsWith(`${MOBILE_START_COOKIE}=;`))).toBe(true);

    const code = new URL(handoff.redirectTo).searchParams.get("code") ?? "";
    const redeemed = await mobileRedeem(code, VERIFIER, PASSWORD, new Date(T0.getTime() + 30_000));
    if (!redeemed.ok) throw new Error(redeemed.reason);
    expect(redeemed.expiresAt.toISOString()).toBe("2026-11-14T03:00:00.000Z");
  });

  it("refuses a code without its verifier, after two minutes, or that is not ours", async () => {
    const challenge = await pkceChallengeOf(VERIFIER);
    const handoff = await mobileHandoff(await browserAfterSignIn(challenge), PASSWORD, T0);
    if (!handoff.ok) throw new Error(handoff.reason);
    const code = new URL(handoff.redirectTo).searchParams.get("code") ?? "";
    expect(await mobileRedeem(code, "w".repeat(43), PASSWORD, T0)).toEqual({
      ok: false,
      reason: "verifier_mismatch",
    });
    expect(await mobileRedeem(code, VERIFIER, PASSWORD, new Date(T0.getTime() + 121_000))).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(await mobileRedeem(code, VERIFIER, `${PASSWORD}-other`, T0)).toEqual({
      ok: false,
      reason: "invalid_code",
    });
    // The session cookie itself is not a code.
    const { sealed } = await sealedSession();
    expect((await mobileRedeem(sealed, VERIFIER, PASSWORD, T0)).ok).toBe(false);
  });

  it("hands nothing over without the app's start or a session", async () => {
    const { sealed } = await sealedSession();
    const noStart = new Request("https://app.mezonas.test/api/mobile/handoff", {
      headers: { cookie: `${SESSION_COOKIE}=${sealed}` },
    });
    expect(await mobileHandoff(noStart, PASSWORD, T0)).toEqual({ ok: false, reason: "no_start" });
    const start = await mobileStartCookie(await pkceChallengeOf(VERIFIER), PASSWORD, T0);
    const noSession = new Request("https://app.mezonas.test/api/mobile/handoff", {
      headers: { cookie: `${MOBILE_START_COOKIE}=${cookieValue(start, MOBILE_START_COOKIE)}` },
    });
    expect(await mobileHandoff(noSession, PASSWORD, T0)).toEqual({
      ok: false,
      reason: "no_session",
    });
    // A start older than the sign-in window is no start.
    expect(
      await mobileHandoff(
        await browserAfterSignIn(await pkceChallengeOf(VERIFIER)),
        PASSWORD,
        new Date(T0.getTime() + 31 * 60_000),
      ),
    ).toEqual({ ok: false, reason: "no_start" });
  });
});

describe("the session in a header", () => {
  it("reads the app's header as the session cookie, and never a browser cookie beside it", () => {
    const request = new Request("https://app.mezonas.test/api/inbox", {
      headers: { [MOBILE_SESSION_HEADER]: "v1.abc.def", cookie: `${SESSION_COOKIE}=browser` },
    });
    const read = withMobileSession(request);
    expect(read.headers.get("cookie")).toBe(`${SESSION_COOKIE}=v1.abc.def`);
    expect(read.headers.get(MOBILE_SESSION_HEADER)).toBeNull();

    const bad = withMobileSession(
      new Request("https://app.mezonas.test/api/inbox", {
        headers: { [MOBILE_SESSION_HEADER]: "x; other=1", cookie: `${SESSION_COOKIE}=browser` },
      }),
    );
    expect(bad.headers.get("cookie")).toBeNull();

    const browser = new Request("https://app.mezonas.test/api/inbox", {
      headers: { cookie: `${SESSION_COOKIE}=browser` },
    });
    expect(withMobileSession(browser)).toBe(browser);
  });

  it("gives the app the session a response would set, or empty when it was cleared", async () => {
    const { session, sealed } = await sealedSession();
    expect(
      mobileSessionFromSetCookies([
        sessionCookie(sealed, session, epochSec(T0)),
        "other=1; Path=/",
      ]),
    ).toBe(sealed);
    expect(mobileSessionFromSetCookies([clearSessionCookie()])).toBe("");
    expect(mobileSessionFromSetCookies(["other=1; Path=/"])).toBeNull();
    expect(mobileSessionFromSetCookies([])).toBeNull();
  });
});
