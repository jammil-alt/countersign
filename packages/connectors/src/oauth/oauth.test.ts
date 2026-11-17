import type { JsonObject } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { defineConnector } from "../connector";
import { CredentialCipher, generateEncryptionKey, memoryTenantKeys } from "../credentials";
import { encryptedCredentials, memoryCredentials } from "../credentials-accessor";
import { fromBase64Url, fromUtf8, toBase64Url, utf8 } from "../runtime";
import { beginAuthorization, completeAuthorization, type OAuthCallbackError } from "./flow";
import { createOAuthState, OAUTH_STATE_TTL_MS, readOAuthState, verifyOAuthState } from "./state";
import {
  AccessFailingError,
  DEAD_GRANT_CODES,
  needsRefresh,
  type OAuthTokens,
  ReconnectRequiredError,
  refreshRefused,
  TokenRefreshError,
  type TokenRefresher,
  tokenManager,
} from "./tokens";

/** The runtime's timers (the Workers types leave `setTimeout` out of this package). */
const timers = globalThis as unknown as { setTimeout: (f: () => void, ms: number) => unknown };
const secret = "a-test-secret-that-is-at-least-32-bytes-long";
const who = {
  tenantId: "0190f0c8-0000-7000-8000-000000000001",
  connector: "qbo",
  userId: "0190f0c8-0000-7000-8000-0000000000u1",
};
const t0 = new Date("2026-11-03T12:00:00Z");

describe("OAuth state", () => {
  it("verifies for the same client, connector and user", async () => {
    const { state, claims } = await createOAuthState(who, { secret, now: t0 });
    const r = await verifyOAuthState(state, who, { secret, now: new Date(t0.getTime() + 60_000) });
    expect(r).toEqual({ ok: true, claims });
    expect(claims.expiresAt - claims.issuedAt).toBe(OAUTH_STATE_TTL_MS / 1000);
  });

  it("is URL-safe and carries a random nonce", async () => {
    const a = await createOAuthState(who, { secret, now: t0 });
    const b = await createOAuthState(who, { secret, now: t0 });
    expect(a.state).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(a.claims.nonce).not.toBe(b.claims.nonce);
  });

  it("rejects a tampered payload or signature", async () => {
    const { state } = await createOAuthState(who, { secret, now: t0 });
    const [payload, sig] = state.split(".") as [string, string];
    const claims = JSON.parse(fromUtf8(fromBase64Url(payload)));
    const forged = toBase64Url(utf8(JSON.stringify({ ...claims, t: "someone-else" })));
    expect(await verifyOAuthState(`${forged}.${sig}`, who, { secret, now: t0 })).toEqual({
      ok: false,
      reason: "signature",
    });
    const badSig = `${sig.slice(0, -2)}${sig.endsWith("AA") ? "BB" : "AA"}`;
    expect(await verifyOAuthState(`${payload}.${badSig}`, who, { secret, now: t0 })).toMatchObject({
      ok: false,
      reason: "signature",
    });
    expect(
      await verifyOAuthState(state, who, { secret: `${secret}-other`, now: t0 }),
    ).toMatchObject({ ok: false, reason: "signature" });
  });

  it("rejects malformed states", async () => {
    for (const bad of ["", "abc", "a.b.c", "!!.??", "."]) {
      expect(await verifyOAuthState(bad, who, { secret, now: t0 })).toMatchObject({
        ok: false,
        reason: "malformed",
      });
    }
  });

  it("expires", async () => {
    const { state } = await createOAuthState(who, { secret, now: t0, ttlMs: 60_000 });
    const at = (ms: number) => ({ secret, now: new Date(t0.getTime() + ms) });
    expect((await verifyOAuthState(state, who, at(59_000))).ok).toBe(true);
    expect(await verifyOAuthState(state, who, at(60_000))).toEqual({
      ok: false,
      reason: "expired",
    });
    // Issued in the future beyond the tolerated skew.
    expect(await verifyOAuthState(state, who, at(-5 * 60_000))).toMatchObject({
      reason: "expired",
    });
  });

  it("is bound to tenant, connector and user", async () => {
    const { state } = await createOAuthState(who, { secret, now: t0 });
    for (const other of [
      { ...who, tenantId: "0190f0c8-0000-7000-8000-000000000002" },
      { ...who, connector: "gmail" },
      { ...who, userId: "someone-else" },
    ]) {
      expect(await verifyOAuthState(state, other, { secret, now: t0 })).toEqual({
        ok: false,
        reason: "mismatch",
      });
    }
  });

  it("refuses a short secret", async () => {
    await expect(createOAuthState(who, { secret: "short" })).rejects.toThrow(/32 bytes/);
  });

  it("keeps a portal state's payload as it was: no origin field", async () => {
    const { state, claims } = await createOAuthState(who, { secret, now: t0 });
    const payload = JSON.parse(fromUtf8(fromBase64Url(state.split(".")[0] ?? "")));
    expect(Object.keys(payload).sort()).toEqual(["c", "exp", "iat", "n", "t", "u", "v"]);
    expect(claims.origin).toBe("portal");
  });

  it("binds the origin: a back-office state completes only in the back office", async () => {
    const ops = { ...who, origin: "ops" as const };
    const { state, claims } = await createOAuthState(ops, { secret, now: t0 });
    expect(claims.origin).toBe("ops");
    expect(await verifyOAuthState(state, ops, { secret, now: t0 })).toEqual({ ok: true, claims });
    expect(await verifyOAuthState(state, who, { secret, now: t0 })).toEqual({
      ok: false,
      reason: "mismatch",
    });
    const portal = await createOAuthState(who, { secret, now: t0 });
    expect(await verifyOAuthState(portal.state, ops, { secret, now: t0 })).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("reads a state without a session only once its signature holds", async () => {
    const { state, claims } = await createOAuthState(
      { ...who, origin: "ops" },
      { secret, now: t0, ttlMs: 60_000 },
    );
    expect(await readOAuthState(state, { secret, now: t0 })).toEqual({ ok: true, claims });
    // An unsigned "ops" claim is not believed.
    const [payload, sig] = state.split(".") as [string, string];
    const portal = await createOAuthState(who, { secret, now: t0 });
    const [portalPayload] = portal.state.split(".") as [string];
    const raised = toBase64Url(
      utf8(JSON.stringify({ ...JSON.parse(fromUtf8(fromBase64Url(portalPayload))), o: "ops" })),
    );
    expect(await readOAuthState(`${raised}.${portal.state.split(".")[1]}`, { secret })).toEqual({
      ok: false,
      reason: "signature",
    });
    expect(await readOAuthState(`${payload}.${sig}`, { secret: `${secret}-x` })).toMatchObject({
      reason: "signature",
    });
    expect(
      await readOAuthState(state, { secret, now: new Date(t0.getTime() + 60_000) }),
    ).toMatchObject({ ok: false, reason: "expired" });
  });
});

/** Stored credentials: tokens plus whatever else the connector keeps (JSON). */
function tokens(over: JsonObject = {}): JsonObject {
  return {
    accessToken: "at-1",
    refreshToken: "rt-1",
    expiresAt: new Date(t0.getTime() + 3600_000).toISOString(),
    ...over,
  };
}

describe("tokenManager", () => {
  const tick = () => new Promise<void>((resolve) => timers.setTimeout(resolve, 0));
  /**
   * A provider's token endpoint. With `rotate`, it behaves like Intuit's and Microsoft's: every
   * refresh issues a new refresh token, and one already spent is refused (`invalid_grant`).
   */
  function refresher(rotate = true): TokenRefresher & { calls: number; live: string } {
    const r = {
      calls: 0,
      live: "rt-1",
      async refresh(current: OAuthTokens, { now }: { now: Date }) {
        r.calls += 1;
        if (rotate && current.refreshToken !== r.live) {
          throw new ReconnectRequiredError("the provider refused the refresh: invalid_grant");
        }
        const serial = r.calls + 1;
        if (rotate) r.live = `rt-${serial}`;
        for (let i = 0; i < 5; i++) await Promise.resolve();
        return {
          accessToken: `at-${serial}`,
          ...(rotate ? { refreshToken: `rt-${serial}` } : {}),
          expiresAt: new Date(now.getTime() + 3600_000).toISOString(),
          ...(current.scope ? { scope: current.scope } : {}),
        };
      },
    };
    return r;
  }

  /**
   * One connection's stored envelope, and an accessor per isolate over it: each caches what it
   * read, as `encryptedCredentials` does for a run step.
   */
  async function sharedStore(initial: JsonObject) {
    const cipher = (await CredentialCipher.create({ current: generateEncryptionKey() })).forClients(
      memoryTenantKeys(),
    );
    const binding = {
      tenantId: who.tenantId,
      connectionId: "0190f0c8-0000-7000-8000-0000000000aa",
    };
    let stored: unknown = await cipher.encrypt(initial, binding);
    return {
      async current() {
        return cipher.decrypt(stored, binding);
      },
      isolate() {
        return encryptedCredentials({
          cipher,
          binding,
          load: async () => stored,
          save: async (env) => {
            stored = env;
          },
          saveIf: async (env, expected) => {
            if (JSON.stringify(stored) !== JSON.stringify(expected)) return false;
            stored = env;
            return true;
          },
        });
      },
    };
  }

  it("uses the stored token until it is about to expire", async () => {
    const credentials = memoryCredentials({ ...tokens(), realmId: "9130" });
    const r = refresher();
    const m = tokenManager({ credentials, refresher: r, now: () => t0 });
    expect(await m.accessToken()).toBe("at-1");
    expect(r.calls).toBe(0);
    expect(needsRefresh(tokens() as OAuthTokens, new Date(t0.getTime() + 56 * 60_000))).toBe(true);
  });

  it("refreshes before expiry, persists the new refresh token and keeps other fields", async () => {
    const credentials = memoryCredentials({
      ...tokens({ expiresAt: new Date(t0.getTime() + 60_000).toISOString() }),
      realmId: "9130",
    });
    const r = refresher();
    const m = tokenManager({ credentials, refresher: r, now: () => t0 });
    expect(await m.accessToken()).toBe("at-2");
    expect(credentials.current()).toMatchObject({
      accessToken: "at-2",
      refreshToken: "rt-2",
      realmId: "9130",
    });
    expect(credentials.writes).toBe(1);
  });

  it("keeps the old refresh token when the provider doesn't send one", async () => {
    const credentials = memoryCredentials(tokens({ expiresAt: t0.toISOString() }));
    const m = tokenManager({ credentials, refresher: refresher(false), now: () => t0 });
    await m.accessToken();
    expect(credentials.current()).toMatchObject({ accessToken: "at-2", refreshToken: "rt-1" });
  });

  it("shares one refresh between concurrent callers", async () => {
    const credentials = memoryCredentials(tokens({ expiresAt: t0.toISOString() }));
    const r = refresher();
    const m = tokenManager({ credentials, refresher: r, now: () => t0 });
    const got = await Promise.all([m.accessToken(), m.accessToken(), m.accessToken()]);
    expect(got).toEqual(["at-2", "at-2", "at-2"]);
    expect(r.calls).toBe(1);
  });

  it("retries once with a fresh token after a 401", async () => {
    const credentials = memoryCredentials(tokens());
    const r = refresher();
    const m = tokenManager({ credentials, refresher: r, now: () => t0 });
    const seen: string[] = [];
    const result = await m.withAccessToken(
      async (token) => {
        seen.push(token);
        return { status: token === "at-1" ? 401 : 200 };
      },
      (res) => res.status === 401,
    );
    expect(result.status).toBe(200);
    expect(seen).toEqual(["at-1", "at-2"]);
  });

  it("keeps the connection when two isolates refresh a rotating token at once", async () => {
    const store = await sharedStore(tokens({ expiresAt: t0.toISOString(), realmId: "9130" }));
    const provider = refresher();
    const a = store.isolate();
    const b = store.isolate();
    // Both isolates read the tokens before either refreshes.
    await Promise.all([a.get(), b.get()]);
    const ma = tokenManager({ credentials: a, refresher: provider, now: () => t0, sleep: tick });
    const mb = tokenManager({ credentials: b, refresher: provider, now: () => t0, sleep: tick });
    const got = await Promise.all([ma.accessToken(), mb.accessToken()]);
    expect(got).toEqual(["at-2", "at-2"]);
    expect(await store.current()).toMatchObject({
      accessToken: "at-2",
      refreshToken: "rt-2",
      realmId: "9130",
    });
    expect(provider.live).toBe("rt-2");
  });

  it("uses another isolate's newer tokens instead of refreshing with a spent one", async () => {
    const store = await sharedStore(tokens({ expiresAt: t0.toISOString() }));
    const provider = refresher();
    const a = store.isolate();
    const b = store.isolate();
    await b.get();
    await tokenManager({ credentials: a, refresher: provider, now: () => t0 }).accessToken();
    // b's cache still has rt-1, which the provider would now refuse.
    const mb = tokenManager({ credentials: b, refresher: provider, now: () => t0 });
    expect(await mb.accessToken()).toBe("at-2");
    expect(provider.calls).toBe(1);
    expect(await store.current()).toMatchObject({ refreshToken: "rt-2" });
  });

  it("never overwrites a newer refresh token with an older one", async () => {
    const store = await sharedStore(tokens({ expiresAt: t0.toISOString() }));
    const a = store.isolate();
    const b = store.isolate();
    await Promise.all([a.get(), b.get()]);
    // A provider that answers both refreshes; the first saved wins and the other is dropped.
    let n = 0;
    const lenient: TokenRefresher = {
      async refresh(_current, { now }) {
        n += 1;
        const serial = n + 1;
        for (let i = 0; i < 5 * n; i++) await Promise.resolve();
        return {
          accessToken: `at-${serial}`,
          refreshToken: `rt-${serial}`,
          expiresAt: new Date(now.getTime() + 3600_000).toISOString(),
        };
      },
    };
    const ma = tokenManager({ credentials: a, refresher: lenient, now: () => t0 });
    const mb = tokenManager({ credentials: b, refresher: lenient, now: () => t0 });
    const got = await Promise.all([ma.accessToken(), mb.accessToken()]);
    expect(got).toEqual(["at-2", "at-2"]);
    expect(await store.current()).toMatchObject({ accessToken: "at-2", refreshToken: "rt-2" });
  });

  it("asks for a reconnect when the provider refuses the stored refresh token", async () => {
    const credentials = memoryCredentials(tokens({ expiresAt: t0.toISOString() }));
    const provider = refresher();
    provider.live = "rt-other";
    const m = tokenManager({ credentials, refresher: provider, now: () => t0, sleep: tick });
    await expect(m.accessToken()).rejects.toBeInstanceOf(ReconnectRequiredError);
    expect(credentials.current()).toMatchObject({ refreshToken: "rt-1" });
  });

  it("disconnects only for a dead grant, not for our keys or a provider incident", () => {
    expect(refreshRefused("Intuit", "invalid_grant")).toBeInstanceOf(ReconnectRequiredError);
    for (const code of ["invalid_client", "server_error", "temporarily_unavailable", 42]) {
      const error = refreshRefused("Intuit", code);
      expect(error).toBeInstanceOf(TokenRefreshError);
      expect(error).not.toBeInstanceOf(ReconnectRequiredError);
      expect(error).toMatchObject({ notWritten: true, retryable: true });
    }
    expect(refreshRefused("Zoho", "invalid_code", ["invalid_code"])).toBeInstanceOf(
      ReconnectRequiredError,
    );
    // Where the provider's token errors are unchecked, a code we can't read still disconnects,
    // as a bare 400 did before; our keys never do.
    for (const code of [undefined, "HTTP_400", "something_new"]) {
      expect(refreshRefused("Ramp", code, DEAD_GRANT_CODES, "reconnect")).toBeInstanceOf(
        ReconnectRequiredError,
      );
    }
    for (const code of ["invalid_client", "BAD_CLIENT_ID", "unauthorized_client"]) {
      expect(refreshRefused("HubSpot", code, DEAD_GRANT_CODES, "reconnect")).toBeInstanceOf(
        TokenRefreshError,
      );
    }
    // Client-facing words carry no provider code.
    expect(refreshRefused("Intuit", "invalid_client").message).not.toMatch(/invalid_client/);
    expect(refreshRefused("Intuit", "invalid_grant").message).not.toMatch(/invalid_grant/);
  });

  it("says nothing was written only while no call of this tool reached the provider", async () => {
    const down: TokenRefresher = {
      async refresh() {
        throw new TokenRefreshError("server_error", "the provider didn't renew our access");
      },
    };
    // The refresh fails before any call: nothing was written.
    const fresh = memoryCredentials(tokens({ expiresAt: t0.toISOString() }));
    const m1 = tokenManager({ credentials: fresh, refresher: down, now: () => t0 });
    await expect(
      m1.withAccessToken(
        async () => ({ status: 200 }),
        () => false,
      ),
    ).rejects.toMatchObject({ notWritten: true });
    // A read went through, then the refresh failed: still nothing written.
    const read = memoryCredentials(tokens());
    const m2 = tokenManager({ credentials: read, refresher: down, now: () => t0 });
    await m2.withAccessToken(
      async () => ({ status: 200 }),
      () => false,
      { write: false },
    );
    await expect(
      m2.withAccessToken(
        async () => ({ status: 401 }),
        (r) => r.status === 401,
      ),
    ).rejects.toMatchObject({ notWritten: true });
    // A write went through first (one tool making two calls): the claim is no longer made.
    const wrote = memoryCredentials(tokens());
    const m3 = tokenManager({ credentials: wrote, refresher: down, now: () => t0 });
    await m3.withAccessToken(
      async () => ({ status: 201 }),
      () => false,
    );
    const second = tokenManager({ credentials: wrote, refresher: down, now: () => t0 });
    await expect(
      second.withAccessToken(
        async () => ({ status: 401 }),
        (r) => r.status === 401,
      ),
    ).rejects.toMatchObject({ notWritten: false });
  });

  it("keeps when renewing access started failing, clears it once a call works", async () => {
    let failing = true;
    const flaky: TokenRefresher = {
      async refresh(current, { now }) {
        if (failing) throw new TokenRefreshError("invalid_client", "not renewed");
        return {
          ...current,
          accessToken: "at-9",
          expiresAt: new Date(now.getTime() + 3600_000).toISOString(),
        };
      },
    };
    const credentials = memoryCredentials(tokens({ expiresAt: t0.toISOString() }));
    const at = (h: number) => new Date(t0.getTime() + h * 3600_000);
    const call = (h: number) =>
      tokenManager({ credentials, refresher: flaky, now: () => at(h) }).withAccessToken(
        async () => ({ status: 200 }),
        () => false,
      );
    await expect(call(0)).rejects.toBeInstanceOf(TokenRefreshError);
    expect(credentials.current()).toMatchObject({
      accessFailingSince: t0.toISOString(),
      accessFailingCode: "invalid_client",
    });
    // Later failures keep the first time.
    await expect(call(12)).rejects.toBeInstanceOf(TokenRefreshError);
    expect(credentials.current()).toMatchObject({ accessFailingSince: t0.toISOString() });
    // Fixed within the day: the record goes, and a later failure starts the clock again.
    failing = false;
    await call(20);
    expect(credentials.current()).not.toHaveProperty("accessFailingSince");
    failing = true;
    await credentials.set({ ...(credentials.current() ?? {}), expiresAt: at(30).toISOString() });
    await expect(call(30)).rejects.toBeInstanceOf(TokenRefreshError);
    await expect(call(53)).rejects.toBeInstanceOf(TokenRefreshError);
    await expect(call(54)).rejects.toBeInstanceOf(AccessFailingError);
  });

  it("asks for a reconnect when there is nothing to refresh with", async () => {
    const none = tokenManager({ credentials: memoryCredentials(null), refresher: refresher() });
    await expect(none.accessToken()).rejects.toBeInstanceOf(ReconnectRequiredError);
    const noRefresh = tokenManager({
      credentials: memoryCredentials({ accessToken: "x", expiresAt: t0.toISOString() }),
      refresher: refresher(),
      now: () => t0,
    });
    await expect(noRefresh.accessToken()).rejects.toBeInstanceOf(ReconnectRequiredError);
  });
});

describe("authorization flow", () => {
  const connector = defineConnector({
    id: "fakeoauth",
    name: "Fake OAuth",
    description: "test",
    icon: "key",
    auth: "oauth2",
    entities: [],
    tools: [],
    async authorize(req) {
      return {
        redirectUrl: `https://provider.test/auth?state=${req.state}&redirect_uri=${req.redirectUri}`,
      };
    },
    async handleCallback(params) {
      return {
        externalAccountId: params.realmId ?? null,
        credentials: { ...tokens(), code: params.code ?? "" },
      };
    },
  });
  const session = { tenantId: who.tenantId, userId: who.userId };
  const connectionId = "0190f0c8-0000-7000-8000-0000000000cc";

  it("signs a state, exchanges the code and encrypts the credentials", async () => {
    const cipher = (await CredentialCipher.create({ current: generateEncryptionKey() })).forClients(
      memoryTenantKeys(),
    );
    const begun = await beginAuthorization({
      connector,
      ...session,
      redirectUri: "https://app.test/cb",
      stateSecret: secret,
      now: t0,
    });
    expect(begun.redirectUrl).toContain(`state=${begun.state}`);
    const done = await completeAuthorization({
      connector,
      params: { code: "c-1", state: begun.state, realmId: "9130" },
      session,
      connectionId,
      redirectUri: "https://app.test/cb",
      stateSecret: secret,
      cipher,
      now: t0,
    });
    expect(done.grant).toEqual({ externalAccountId: "9130" });
    expect(JSON.stringify(done.credentials)).not.toContain("at-1");
    expect(
      await cipher.decrypt(done.credentials, { tenantId: session.tenantId, connectionId }),
    ).toMatchObject({ accessToken: "at-1", code: "c-1" });
  });

  it("refuses a callback from another session, a provider error or a missing state", async () => {
    const cipher = (await CredentialCipher.create({ current: generateEncryptionKey() })).forClients(
      memoryTenantKeys(),
    );
    const { state } = await createOAuthState(
      { ...who, connector: "fakeoauth" },
      { secret, now: t0 },
    );
    const base = {
      connector,
      connectionId,
      redirectUri: "https://app.test/cb",
      stateSecret: secret,
      cipher,
      now: t0,
    };
    const err = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e: unknown) => e as OAuthCallbackError,
      );
    expect(
      (
        await err(
          completeAuthorization({
            ...base,
            params: { code: "c", state },
            session: { ...session, userId: "intruder" },
          }),
        )
      )?.reason,
    ).toBe("mismatch");
    expect(
      (await err(completeAuthorization({ ...base, params: { error: "access_denied" }, session })))
        ?.reason,
    ).toBe("provider_error");
    expect(
      (await err(completeAuthorization({ ...base, params: { code: "c" }, session })))?.reason,
    ).toBe("missing_state");
  });

  it("refuses OAuth on a connector without it", async () => {
    const { createTestkitConnector } = await import("../testkit/index");
    await expect(
      beginAuthorization({
        connector: createTestkitConnector(),
        ...session,
        redirectUri: "https://app.test/cb",
        stateSecret: secret,
      }),
    ).rejects.toThrow(/does not sign in with OAuth/);
  });
});
