import { describe, expect, it, vi } from "vitest";
import { readCookie } from "../cookies";
import { getSession } from "../session";
import type { ProvisionInput, ProvisionOutcome } from "../types";
import { createWorkOSAdapter } from "./adapter";
import { createWorkOS, type WorkOSAuthentication, type WorkOSClient, WorkOSError } from "./client";
import { workosStateOf } from "./config";
import {
  IDLE_TIMEOUT_SEC,
  isRestartState,
  newSession,
  OUTAGE_GRACE_SEC,
  RACE_GRACE_SEC,
  REFRESH_INTERVAL_SEC,
  resolveSession,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SEC,
  STATE_COOKIE,
  STATE_MAX_AGE_SEC,
  safeReturnTo,
  sealSession,
} from "./session";

const PASSWORD = "c".repeat(40);
const ORIGIN = "https://app.countersign.test";
const USER_ID = "00000000-0000-4000-8000-000000000001";
const TENANT = "00000000-0000-4000-8000-0000000000aa";
const T0 = 1_800_000_000;
const at = (sec: number) => new Date(sec * 1000);

function auth(overrides: Partial<WorkOSAuthentication> = {}): WorkOSAuthentication {
  return {
    user: {
      id: "wu_1",
      email: "Admin@Millwork.test",
      firstName: "Ada",
      lastName: "M",
      emailVerified: true,
    },
    organizationId: null,
    refreshToken: "rt_1",
    sessionId: "sess_1",
    authenticationMethod: "Password",
    ...overrides,
  };
}

function fakeWorkOS(overrides: Partial<WorkOSClient> = {}): WorkOSClient {
  return {
    authorizationUrl: ({ redirectUri, state }) =>
      `https://workos.test/authorize?redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`,
    authenticateWithCode: vi.fn(async () => auth()),
    refresh: vi.fn(async () => auth({ refreshToken: "rt_2", sessionId: "sess_2" })),
    logoutUrl: (sid, returnTo) =>
      `https://workos.test/logout?session_id=${sid}&return_to=${returnTo}`,
    revokeSession: vi.fn(async () => undefined),
    organizationName: vi.fn(async () => null),
    sendInvitation: vi.fn(async () => ({ id: "inv_1", acceptUrl: null })),
    revokeInvitation: vi.fn(async () => "revoked" as const),
    ...overrides,
  };
}

const config = {
  clientId: "client_1",
  apiKey: "sk_test",
  cookiePassword: PASSWORD,
  appOrigin: ORIGIN,
  callbackPath: "/api/auth/callback",
};

function setup(
  workos = fakeWorkOS(),
  provision: (i: ProvisionInput) => Promise<ProvisionOutcome> = async () => ({
    ok: true,
    userId: USER_ID,
  }),
) {
  const provisioned: ProvisionInput[] = [];
  const directory = {
    async provision(input: ProvisionInput) {
      provisioned.push(input);
      return provision(input);
    },
    async user(id: string) {
      return id === USER_ID ? { id, email: "admin@millwork.test", name: "Ada M" } : null;
    },
    async memberships() {
      return [{ tenantId: TENANT, tenantName: "Millwork", role: "client_admin" as const }];
    },
  };
  const adapter = createWorkOSAdapter({ config, directory, workos });
  return { adapter, directory, workos, provisioned };
}

const cookieValue = (setCookies: readonly string[], name: string) =>
  readCookie(setCookies.map((c) => c.split(";")[0]).join("; "), name);

async function sessionCookieFor(now = T0) {
  const payload = newSession(
    {
      userId: USER_ID,
      workosUserId: "wu_1",
      email: "admin@millwork.test",
      workosOrganizationId: null,
      sessionId: "sess_1",
      refreshToken: "rt_1",
    },
    now,
  );
  return { payload, sealed: await sealSession(payload, PASSWORD) };
}

const withCookie = (cookie: string, url = `${ORIGIN}/api/session`) =>
  new Request(url, { headers: { cookie } });

describe("sign-in flow", () => {
  it("signs in through state, callback and provisioning, and the cookie identifies the user", async () => {
    const { adapter, directory, provisioned } = setup();
    const start = await adapter.signIn({ returnTo: "/ops/clients?x=1" }, at(T0));
    if (!start.ok) throw new Error(start.code);
    const state = new URL(start.redirectTo).searchParams.get("state") ?? "";
    expect(start.redirectTo).toContain(encodeURIComponent(`${ORIGIN}/api/auth/callback`));
    const stateCookie = cookieValue(start.setCookies, STATE_COOKIE);
    expect(stateCookie).toBeTruthy();

    const done = await adapter.callback(
      withCookie(
        `${STATE_COOKIE}=${stateCookie}`,
        `${ORIGIN}/api/auth/callback?code=c1&state=${state}`,
      ),
      at(T0 + 5),
    );
    if (!done.ok) throw new Error(done.code);
    expect(done.redirectTo).toBe("/ops/clients?x=1");
    expect(provisioned[0]).toMatchObject({
      workosUserId: "wu_1",
      email: "admin@millwork.test",
      name: "Ada M",
      emailVerified: true,
    });
    const session = cookieValue(done.setCookies, SESSION_COOKIE);
    expect(session).toBeTruthy();
    expect(done.setCookies.some((c) => c.startsWith(`${STATE_COOKIE}=;`))).toBe(true);

    const result = await getSession(withCookie(`${SESSION_COOKIE}=${session}`), {
      adapter,
      directory,
      now: at(T0 + 10),
    });
    expect(result).toMatchObject({ ok: true, setCookies: [] });
    if (result.ok) expect(result.session.activeTenantId).toBe(TENANT);
  });

  it("refuses a callback whose state does not match, or that has no state cookie", async () => {
    const { adapter } = setup();
    const start = await adapter.signIn({}, at(T0));
    if (!start.ok) throw new Error(start.code);
    const stateCookie = cookieValue(start.setCookies, STATE_COOKIE);
    const wrong = await adapter.callback(
      withCookie(
        `${STATE_COOKIE}=${stateCookie}`,
        `${ORIGIN}/api/auth/callback?code=c&state=forged-state-value`,
      ),
      at(T0),
    );
    expect(wrong).toMatchObject({ ok: false, code: "unauthenticated" });
    const none = await adapter.callback(
      new Request(`${ORIGIN}/api/auth/callback?code=c&state=x`),
      at(T0),
    );
    expect(none).toMatchObject({ ok: false, code: "unauthenticated" });
  });

  describe("refused callbacks say why", () => {
    async function started(adapter = setup().adapter, restart = false) {
      const start = await adapter.signIn({ returnTo: "/ops/runs", restart }, at(T0));
      if (!start.ok) throw new Error(start.code);
      return {
        state: new URL(start.redirectTo).searchParams.get("state") ?? "",
        cookie: `${STATE_COOKIE}=${cookieValue(start.setCookies, STATE_COOKIE)}`,
      };
    }
    const callbackUrl = (state: string, code = "c1") =>
      `${ORIGIN}/api/auth/callback?code=${code}&state=${encodeURIComponent(state)}`;

    it("callback_incomplete: no code or no state on the URL, and it never restarts", async () => {
      const { adapter } = setup();
      const { state, cookie } = await started(adapter);
      for (const url of [
        `${ORIGIN}/api/auth/callback?state=${state}`,
        `${ORIGIN}/api/auth/callback?code=c1`,
        `${ORIGIN}/api/auth/callback?error=access_denied&state=${state}`,
      ]) {
        expect(await adapter.callback(withCookie(cookie, url), at(T0 + 5))).toMatchObject({
          ok: false,
          code: "unauthenticated",
          failure: { reason: "callback_incomplete", restart: false },
        });
      }
    });

    it("state_missing: no state cookie, or one that does not open", async () => {
      const { adapter } = setup();
      const { state } = await started(adapter);
      const none = await adapter.callback(new Request(callbackUrl(state)), at(T0 + 5));
      expect(none).toMatchObject({
        ok: false,
        code: "unauthenticated",
        failure: { reason: "state_missing", returnTo: null, restart: true },
      });
      const garbled = await adapter.callback(
        withCookie(`${STATE_COOKIE}=not-a-sealed-state`, callbackUrl(state)),
        at(T0 + 5),
      );
      expect(garbled).toMatchObject({ failure: { reason: "state_missing" } });
    });

    it("state_expired: after 30 minutes, keeping where it meant to land", async () => {
      const workos = fakeWorkOS();
      const { adapter } = setup(workos);
      const { state, cookie } = await started(adapter);
      expect(STATE_MAX_AGE_SEC).toBe(30 * 60);
      const late = await adapter.callback(
        withCookie(cookie, callbackUrl(state)),
        at(T0 + STATE_MAX_AGE_SEC),
      );
      expect(late).toMatchObject({
        ok: false,
        failure: { reason: "state_expired", returnTo: "/ops/runs", restart: true },
      });
      expect(workos.authenticateWithCode).not.toHaveBeenCalled();
      // A slow emailed-code step inside the limit still finishes.
      const slow = await adapter.callback(
        withCookie(cookie, callbackUrl(state)),
        at(T0 + STATE_MAX_AGE_SEC - 1),
      );
      expect(slow).toMatchObject({ ok: true, redirectTo: "/ops/runs" });
    });

    it("state_mismatch: another sign-in's state cookie, and no session is made", async () => {
      const workos = fakeWorkOS();
      const { adapter } = setup(workos);
      const first = await started(adapter);
      const second = await started(adapter);
      // The second tab's start replaced the first's state cookie.
      const r = await adapter.callback(
        withCookie(second.cookie, callbackUrl(first.state)),
        at(T0 + 5),
      );
      expect(r).toMatchObject({
        ok: false,
        failure: { reason: "state_mismatch", returnTo: "/ops/runs", restart: true },
      });
      expect(r.setCookies.some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(false);
      expect(workos.authenticateWithCode).not.toHaveBeenCalled();
    });

    it("code_rejected and workos_unavailable: a used code, or WorkOS down", async () => {
      const used = fakeWorkOS({
        authenticateWithCode: vi.fn(async () => {
          throw new WorkOSError("WorkOS answered 400", 400, "invalid_grant");
        }),
      });
      const a = setup(used).adapter;
      const s1 = await started(a);
      expect(await a.callback(withCookie(s1.cookie, callbackUrl(s1.state)), at(T0))).toMatchObject({
        ok: false,
        failure: { reason: "code_rejected", returnTo: "/ops/runs", restart: true },
      });
      for (const error of [new WorkOSError("down", null), new WorkOSError("5xx", 502)]) {
        const down = setup(
          fakeWorkOS({
            authenticateWithCode: vi.fn(async () => {
              throw error;
            }),
          }),
        ).adapter;
        const s = await started(down);
        expect(
          await down.callback(withCookie(s.cookie, callbackUrl(s.state)), at(T0)),
        ).toMatchObject({ ok: false, failure: { reason: "workos_unavailable", restart: true } });
      }
    });

    it("a restarted sign-in still needs its own state, and does not restart again", async () => {
      const workos = fakeWorkOS();
      const { adapter } = setup(workos);
      const restarted = await started(adapter, true);
      expect(isRestartState(restarted.state)).toBe(true);
      expect(isRestartState((await started(adapter)).state)).toBe(false);
      // A failure of the restarted sign-in is final, even when its state cookie is gone.
      const gone = await adapter.callback(new Request(callbackUrl(restarted.state)), at(T0));
      expect(gone).toMatchObject({ failure: { reason: "state_missing", restart: false } });
      const forged = await adapter.callback(
        withCookie(restarted.cookie, callbackUrl(`2.${"x".repeat(43)}`)),
        at(T0),
      );
      expect(forged).toMatchObject({ failure: { reason: "state_mismatch", restart: false } });
      // With its own state it signs in as any sign-in does.
      const done = await adapter.callback(
        withCookie(restarted.cookie, callbackUrl(restarted.state)),
        at(T0 + 5),
      );
      expect(done).toMatchObject({ ok: true, redirectTo: "/ops/runs" });
    });
  });

  it("refuses an uninvited sign-in and revokes its WorkOS session", async () => {
    const workos = fakeWorkOS();
    const { adapter } = setup(workos, async () => ({ ok: false, reason: "not_invited" }));
    const start = await adapter.signIn({}, at(T0));
    if (!start.ok) throw new Error(start.code);
    const state = new URL(start.redirectTo).searchParams.get("state") ?? "";
    const result = await adapter.callback(
      withCookie(
        `${STATE_COOKIE}=${cookieValue(start.setCookies, STATE_COOKIE)}`,
        `${ORIGIN}/api/auth/callback?code=c&state=${state}`,
      ),
      at(T0),
    );
    expect(result).toMatchObject({ ok: false, status: 403, code: "no_access" });
    expect(workos.revokeSession).toHaveBeenCalledWith("sess_1");
  });

  it.each(["GoogleOAuth", "MicrosoftOAuth", "MagicAuth", "Impersonation", null])(
    "refuses a sign-in by %s, where our second factor isn't certain, and revokes it",
    async (method) => {
      const workos = fakeWorkOS({
        authenticateWithCode: vi.fn(async () => auth({ authenticationMethod: method })),
      });
      const provision = vi.fn(async () => ({ ok: true as const, userId: USER_ID }));
      const { adapter } = setup(workos, provision);
      const start = await adapter.signIn({}, at(T0));
      if (!start.ok) throw new Error(start.code);
      const state = new URL(start.redirectTo).searchParams.get("state") ?? "";
      const result = await adapter.callback(
        withCookie(
          `${STATE_COOKIE}=${cookieValue(start.setCookies, STATE_COOKIE)}`,
          `${ORIGIN}/api/auth/callback?code=c&state=${state}`,
        ),
        at(T0),
      );
      expect(result).toMatchObject({
        ok: false,
        status: 403,
        code: "no_access",
        reason: "sign_in_method",
      });
      expect(provision).not.toHaveBeenCalled();
      expect(workos.revokeSession).toHaveBeenCalledWith("sess_1");
    },
  );

  it.each(["Password", "Passkey", "SSO"])("admits a sign-in by %s", async (method) => {
    const workos = fakeWorkOS({
      authenticateWithCode: vi.fn(async () => auth({ authenticationMethod: method })),
    });
    const { adapter } = setup(workos, async () => ({ ok: true, userId: USER_ID }));
    const start = await adapter.signIn({}, at(T0));
    if (!start.ok) throw new Error(start.code);
    const state = new URL(start.redirectTo).searchParams.get("state") ?? "";
    const result = await adapter.callback(
      withCookie(
        `${STATE_COOKIE}=${cookieValue(start.setCookies, STATE_COOKIE)}`,
        `${ORIGIN}/api/auth/callback?code=c&state=${state}`,
      ),
      at(T0),
    );
    expect(result).toMatchObject({ ok: true, signedIn: { userId: USER_ID, method } });
  });

  it("refuses a return_to that leaves the site", async () => {
    const { adapter } = setup();
    expect(await adapter.signIn({ returnTo: "//evil.test" }, at(T0))).toMatchObject({ ok: false });
    expect(safeReturnTo("https://evil.test/x", ORIGIN)).toBeNull();
    expect(safeReturnTo("/\\evil.test", ORIGIN)).toBeNull();
    expect(safeReturnTo(undefined, ORIGIN)).toBe("/");
  });
});

describe("invitations", () => {
  it("asks WorkOS to email the invitation, lowercased", async () => {
    const workos = fakeWorkOS();
    const { adapter } = setup(workos);
    expect(await adapter.invite(" New@Millwork.Test ")).toEqual({
      status: "sent",
      invitationId: "inv_1",
    });
    expect(workos.sendInvitation).toHaveBeenCalledWith("new@millwork.test");
  });

  it("reports a refused or unreachable WorkOS as failed, with the code only", async () => {
    const refused = setup(
      fakeWorkOS({
        sendInvitation: async () => {
          throw new WorkOSError("WorkOS answered 422", 422, "email_already_invited");
        },
      }),
    );
    expect(await refused.adapter.invite("a@b.test")).toEqual({
      status: "failed",
      reason: "email_already_invited",
    });
    const down = setup(
      fakeWorkOS({
        sendInvitation: async () => {
          throw new WorkOSError("WorkOS could not be reached", null);
        },
      }),
    );
    expect(await down.adapter.invite("a@b.test")).toEqual({
      status: "failed",
      reason: "unreachable",
    });
  });
});

describe("session cookie", () => {
  it("rejects a tampered cookie and clears it", async () => {
    const { adapter, directory } = setup();
    const { sealed } = await sessionCookieFor();
    const tampered = `${sealed.slice(0, -3)}${sealed.endsWith("A") ? "B" : "A"}xx`;
    const result = await getSession(withCookie(`${SESSION_COOKIE}=${tampered}`), {
      adapter,
      directory,
      now: at(T0 + 1),
    });
    expect(result).toMatchObject({ ok: false, status: 401, code: "session_invalid" });
    if (!result.ok) expect(result.setCookies[0]).toMatch(/^__Host-cs_session=;/);
  });

  it("does not refresh inside the window and rotates the cookie after it", async () => {
    const workos = fakeWorkOS();
    const { adapter, directory } = setup(workos);
    const { sealed } = await sessionCookieFor();

    const early = await getSession(withCookie(`${SESSION_COOKIE}=${sealed}`), {
      adapter,
      directory,
      now: at(T0 + REFRESH_INTERVAL_SEC - 1),
    });
    expect(early).toMatchObject({ ok: true, setCookies: [] });
    expect(workos.refresh).not.toHaveBeenCalled();

    const due = await getSession(withCookie(`${SESSION_COOKIE}=${sealed}`), {
      adapter,
      directory,
      now: at(T0 + REFRESH_INTERVAL_SEC),
    });
    expect(workos.refresh).toHaveBeenCalledWith("rt_1", null);
    if (!due.ok) throw new Error(due.code);
    const rotated = cookieValue(due.setCookies, SESSION_COOKIE);
    expect(rotated).toBeTruthy();
    expect(rotated).not.toBe(sealed);
  });
});

describe("idle sign-out through the adapter", () => {
  it("refuses an idle session, clears the cookie and ends WorkOS's session too", async () => {
    const workos = fakeWorkOS();
    const { adapter, directory } = setup(workos);
    const { sealed } = await sessionCookieFor();
    const result = await getSession(withCookie(`${SESSION_COOKIE}=${sealed}`), {
      adapter,
      directory,
      now: at(T0 + IDLE_TIMEOUT_SEC),
    });
    expect(result).toMatchObject({ ok: false, status: 401, code: "session_invalid" });
    expect(workos.revokeSession).toHaveBeenCalledWith("sess_1");
  });

  it("reads the activity header: a marked request re-seals the cookie with the new activity", async () => {
    const { adapter, directory } = setup();
    const { sealed } = await sessionCookieFor();
    const request = new Request(`${ORIGIN}/api/session`, {
      headers: { cookie: `${SESSION_COOKIE}=${sealed}`, "x-countersign-activity": "1" },
    });
    const result = await getSession(request, { adapter, directory, now: at(T0 + 120) });
    if (!result.ok) throw new Error(result.code);
    expect(cookieValue(result.setCookies, SESSION_COOKIE)).toBeTruthy();
  });
});

describe("resolveSession", () => {
  const due = T0 + REFRESH_INTERVAL_SEC;

  it("expires at exp whatever WorkOS says", async () => {
    const { payload } = await sessionCookieFor();
    const r = await resolveSession(payload, T0 + SESSION_MAX_AGE_SEC, fakeWorkOS());
    expect(r).toEqual({ status: "invalid", reason: "session expired" });
  });

  it("admits a racing tab within the race grace, then refuses", async () => {
    const { payload } = await sessionCookieFor();
    const refused = fakeWorkOS({
      refresh: async () => {
        throw new WorkOSError("invalid_grant", 400, "invalid_grant");
      },
    });
    expect(await resolveSession(payload, due + RACE_GRACE_SEC - 1, refused)).toMatchObject({
      status: "valid",
      rotated: false,
    });
    expect(await resolveSession(payload, due + RACE_GRACE_SEC, refused)).toMatchObject({
      status: "invalid",
      reason: "WorkOS ended the session",
    });
  });

  it("rides out a WorkOS outage for the outage grace only", async () => {
    const { payload } = await sessionCookieFor();
    const down = fakeWorkOS({
      refresh: async () => {
        throw new WorkOSError("unreachable", null);
      },
    });
    expect(await resolveSession(payload, due + OUTAGE_GRACE_SEC - 1, down)).toMatchObject({
      status: "valid",
    });
    expect(await resolveSession(payload, due + OUTAGE_GRACE_SEC, down)).toMatchObject({
      status: "invalid",
    });
  });

  it("ends after 30 minutes without the person's own requests", async () => {
    const { payload } = await sessionCookieFor();
    expect(await resolveSession(payload, T0 + IDLE_TIMEOUT_SEC - 1, fakeWorkOS())).toMatchObject({
      status: "valid",
    });
    expect(await resolveSession(payload, T0 + IDLE_TIMEOUT_SEC, fakeWorkOS())).toEqual({
      status: "invalid",
      reason: "signed out after 30 minutes without activity",
    });
  });

  it("moves the last activity only on the person's own requests, at most once a minute", async () => {
    const { payload } = await sessionCookieFor();
    const polled = await resolveSession(payload, T0 + 120, fakeWorkOS(), false);
    expect(polled).toMatchObject({ status: "valid", rotated: false, session: { lat: T0 } });
    const clicked = await resolveSession(payload, T0 + 120, fakeWorkOS(), true);
    expect(clicked).toMatchObject({ status: "valid", rotated: true, session: { lat: T0 + 120 } });
    const soon = await resolveSession(payload, T0 + 30, fakeWorkOS(), true);
    expect(soon).toMatchObject({ rotated: false, session: { lat: T0 } });
    // Active every 20 minutes, the session outlives the idle limit, up to 12 hours.
    let s = payload;
    for (let t = T0 + 20 * 60; t < T0 + SESSION_MAX_AGE_SEC; t += 20 * 60) {
      const r = await resolveSession(s, t, fakeWorkOS(), true);
      if (r.status !== "valid") throw new Error(`ended at ${t - T0}s: ${r.reason}`);
      s = r.session;
    }
    expect(await resolveSession(s, T0 + SESSION_MAX_AGE_SEC, fakeWorkOS(), true)).toMatchObject({
      status: "invalid",
      reason: "session expired",
    });
  });

  it("holds a cookie from before the limits to them: 12 hours from sign-in, idle from its refresh", async () => {
    const { payload } = await sessionCookieFor();
    const { lat: _lat, ...old } = { ...payload, exp: T0 + 30 * 24 * 60 * 60 };
    expect(await resolveSession(old, T0 + SESSION_MAX_AGE_SEC, fakeWorkOS(), true)).toMatchObject({
      status: "invalid",
      reason: "session expired",
    });
    // No `lat`: the last refresh (rat - 5 minutes, here sign-in) counts as the last activity.
    expect(await resolveSession(old, T0 + IDLE_TIMEOUT_SEC, fakeWorkOS())).toMatchObject({
      status: "invalid",
      reason: "signed out after 30 minutes without activity",
    });
  });

  it("refuses a refresh that comes back as another user", async () => {
    const { payload } = await sessionCookieFor();
    const other = fakeWorkOS({
      refresh: async () => auth({ user: { ...auth().user, id: "wu_other" } }),
    });
    expect(await resolveSession(payload, due, other)).toMatchObject({ status: "invalid" });
  });
});

describe("WorkOS client over fetch", () => {
  it("posts the refresh grant and reads the session id from the access token", async () => {
    const claims = btoa(JSON.stringify({ sid: "sess_9" })).replace(/=+$/, "");
    const fetchStub = vi.fn(async () =>
      Response.json({
        user: { id: "wu_1", email: "a@b.test", email_verified: true },
        refresh_token: "rt_9",
        access_token: `h.${claims}.s`,
      }),
    );
    const client = createWorkOS({ clientId: "client_1", apiKey: "sk", fetch: fetchStub });
    const result = await client.refresh("rt_1", "org_1");
    expect(result).toMatchObject({ refreshToken: "rt_9", sessionId: "sess_9" });
    const [url, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.workos.com/user_management/authenticate");
    expect(JSON.parse(String(init.body))).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "rt_1",
      organization_id: "org_1",
    });
  });

  it("turns an error answer into a WorkOSError carrying only the code", async () => {
    const client = createWorkOS({
      clientId: "c",
      apiKey: "k",
      fetch: async () =>
        Response.json({ code: "invalid_grant", message: "a@b.test" }, { status: 400 }),
    });
    await expect(client.authenticateWithCode("x")).rejects.toMatchObject({
      status: 400,
      code: "invalid_grant",
      message: "WorkOS answered 400",
    });
  });
});

describe("workosStateOf", () => {
  it("is off without a client id and misconfigured with a short password", () => {
    expect(workosStateOf({})).toEqual({ state: "off" });
    const bad = workosStateOf({ WORKOS_CLIENT_ID: "c", WORKOS_COOKIE_PASSWORD: "short" });
    expect(bad.state).toBe("misconfigured");
    expect(
      workosStateOf({
        WORKOS_CLIENT_ID: "c",
        WORKOS_API_KEY: "k",
        WORKOS_COOKIE_PASSWORD: PASSWORD,
        APP_ORIGIN: `${ORIGIN}/ignored/path`,
      }),
    ).toMatchObject({ state: "on", config: { appOrigin: ORIGIN } });
  });
});
