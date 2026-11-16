import { MOBILE_SESSION_HEADER, MOBILE_SIGNED_IN_URL } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { readCookie } from "../cookies";
import { seal } from "../seal";
import {
  isMobileSignIn,
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
  openSession,
  SESSION_COOKIE,
  sealSession,
  sessionCookie,
} from "./session";

const PASSWORD = "a-test-cookie-password-of-32-chars-or-more";
const VERIFIER = `${"v".repeat(43)}-._~0123456789`;
const T0 = new Date("2026-11-13T15:00:00Z");

async function sealedSession(
  now = T0,
  over: { secondFactor?: "pending" | "done" | "exempt"; acct?: unknown } = {},
) {
  const fresh = newSession(
    {
      userId: "0190a1b2-0000-7000-8000-000000000001",
      workosUserId: "user_01",
      email: "maria@example.com",
      workosOrganizationId: null,
      sessionId: "session_01",
      refreshToken: "refresh",
      ...(over.secondFactor ? { secondFactor: over.secondFactor } : {}),
    },
    epochSec(now),
  );
  const session = over.acct === undefined ? fresh : { ...fresh, acct: over.acct };
  return { session, sealed: await sealSession(session, PASSWORD) };
}

const cookieValue = (setCookie: string, name: string) => readCookie(setCookie.split(";")[0], name);

async function browserAfterSignIn(
  challenge: string,
  now = T0,
  over: Parameters<typeof sealedSession>[1] = {},
) {
  const start = await mobileStartCookie(challenge, PASSWORD, now);
  const { sealed } = await sealedSession(now, over);
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
    expect(redeemed.userId).toBe("0190a1b2-0000-7000-8000-000000000001");
  });

  it("never hands over a session whose second step is pending (docs/plan.md §1.100)", async () => {
    const challenge = await pkceChallengeOf(VERIFIER);
    const pending = await browserAfterSignIn(challenge, T0, { secondFactor: "pending" });
    expect(await mobileHandoff(pending, PASSWORD, T0)).toEqual({
      ok: false,
      reason: "second_factor_pending",
    });
    // Nor redeems one, should a code ever hold one.
    const { sealed } = await sealedSession(T0, { secondFactor: "pending" });
    const forged = await seal(
      { s: sealed, c: challenge, exp: epochSec(T0) + 60 },
      PASSWORD,
      "mobile-handoff",
    );
    expect(await mobileRedeem(forged, VERIFIER, PASSWORD, T0)).toEqual({
      ok: false,
      reason: "invalid_code",
    });
    // Passed or exempt: handed over.
    for (const secondFactor of ["done", "exempt"] as const) {
      const r = await mobileHandoff(
        await browserAfterSignIn(challenge, T0, { secondFactor }),
        PASSWORD,
        T0,
      );
      expect(r.ok).toBe(true);
    }
  });

  it("hands over the session the API just refreshed, without the account it carries (§1.93)", async () => {
    const challenge = await pkceChallengeOf(VERIFIER);
    const request = await browserAfterSignIn(challenge, T0, {
      secondFactor: "done",
      acct: { at: epochSec(T0), m: [] },
    });
    const { sealed: rotated } = await sealedSession(T0, { secondFactor: "done" });
    const handoff = await mobileHandoff(request, PASSWORD, T0, rotated);
    if (!handoff.ok) throw new Error(handoff.reason);
    const code = new URL(handoff.redirectTo).searchParams.get("code") ?? "";
    const redeemed = await mobileRedeem(code, VERIFIER, PASSWORD, T0);
    if (!redeemed.ok) throw new Error(redeemed.reason);
    expect(redeemed.session).toBe(rotated);

    const own = await mobileHandoff(request, PASSWORD, T0);
    if (!own.ok) throw new Error(own.reason);
    const ownCode = new URL(own.redirectTo).searchParams.get("code") ?? "";
    const fromCookie = await mobileRedeem(ownCode, VERIFIER, PASSWORD, T0);
    if (!fromCookie.ok) throw new Error(fromCookie.reason);
    const opened = await openSession(fromCookie.session, PASSWORD);
    expect(opened?.acct).toBeUndefined();
    expect(opened?.mf).toBe("done");
  });

  it("knows a sign-in for the phone by its start cookie", async () => {
    expect(isMobileSignIn(await browserAfterSignIn(await pkceChallengeOf(VERIFIER)))).toBe(true);
    expect(isMobileSignIn(new Request("https://app.mezonas.test/api/auth/callback"))).toBe(false);
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
