import { describe, expect, it, vi } from "vitest";
import { readCookie } from "../cookies";
import { getSession } from "../session";
import type { ProvisionInput, ProvisionOutcome } from "../types";
import { createWorkOSAdapter } from "./adapter";
import { createWorkOS, type WorkOSAuthentication, type WorkOSClient, WorkOSError } from "./client";
import { workosStateOf } from "./config";
import {
  newSession,
  OUTAGE_GRACE_SEC,
  RACE_GRACE_SEC,
  REFRESH_INTERVAL_SEC,
  resolveSession,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SEC,
  STATE_COOKIE,
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
