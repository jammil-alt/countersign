// Search Console by Google sign-in (`gsc_oauth`, M50, docs/plan.md §1.78) against the fake: not
// available without the Google client; sign-in asks for `webmasters.readonly` only and keeps the
// properties the account can read; a grant with more or less access is refused; the property read
// is the only one, the only Domain one, or the site's; and the sync reads it as `gsc` does,
// refreshing the token when it is about to expire.

import type { JsonObject } from "@countersign/core";
import { describe, expect, it } from "vitest";
import type { ConnectionContext } from "../connector";
import { memoryCredentials } from "../credentials-accessor";
import { formDecode } from "../http";
import { memoryLogger } from "../logger";
import { SignInRefusedError } from "../oauth/tokens";
import { FAKE_GSC, fakeSearchConsole } from "./fake";
import { GSC_SCOPE } from "./index";
import {
  createGscOauthConnector,
  defaultGscProperty,
  GSC_OAUTH_CONNECTOR_ID,
  gscPropertyForDomain,
} from "./oauth";
import { addDays, SearchImportError, searchConnectorOf } from "./records";

const NOW = new Date("2026-11-08T03:11:00Z");
const TODAY = "2026-11-08";
const REDIRECT = "https://app.example/connections/gsc_oauth/callback";
const TENANT = "00000000-0000-4000-8000-0000000000a1";

async function setup() {
  const gsc = await fakeSearchConsole({
    finalThrough: "2026-11-04",
    rows: [
      {
        day: "2026-11-03",
        query: "invoice agent",
        url: "https://mezonas.com/",
        impressions: 40,
        clicks: 4,
        position: 9,
      },
    ],
  });
  const connector = createGscOauthConnector({
    clientId: gsc.oauth.clientId,
    clientSecret: gsc.oauth.clientSecret,
    fetch: () => gsc.fetch,
  });
  const callback = (code = gsc.oauth.code) =>
    connector.handleCallback?.(
      { code, state: "s" },
      { tenantId: TENANT, userId: "u1", redirectUri: REDIRECT },
    );
  return { gsc, connector, callback };
}

function ctx(credentials: JsonObject, config: JsonObject): ConnectionContext {
  return {
    tenantId: TENANT,
    connection: {
      id: "00000000-0000-4000-8000-0000000000c2",
      tenantId: TENANT,
      connector: GSC_OAUTH_CONNECTOR_ID,
      status: "connected",
      externalAccountId: null,
      config,
      permissions: {},
    },
    credentials: memoryCredentials(credentials),
    logger: memoryLogger(),
    now: () => NOW,
  };
}

describe("Search Console by Google sign-in", () => {
  it("is an OAuth connector with no tools, not available without the Google client", async () => {
    const off = createGscOauthConnector();
    expect(off.manifest).toMatchObject({ id: "gsc_oauth", auth: "oauth2", tools: [] });
    expect(off.isConfigured?.()).toBe(false);
    expect(searchConnectorOf(off)?.search.provider).toBe("google");
    await expect(
      off.authorize?.({ tenantId: TENANT, userId: "u1", redirectUri: REDIRECT, state: "s" }),
    ).rejects.toThrow(/not set up/);
    const { connector } = await setup();
    expect(connector.isConfigured?.()).toBe(true);
    const { redirectUrl } = (await connector.authorize?.({
      tenantId: TENANT,
      userId: "u1",
      redirectUri: REDIRECT,
      state: "s",
    })) ?? { redirectUrl: "" };
    const [base, search = ""] = redirectUrl.split("?");
    expect(base).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const q = formDecode(search);
    expect(q.scope).toBe(GSC_SCOPE);
    expect(q.access_type).toBe("offline");
    expect(q.redirect_uri).toBe(REDIRECT);
  });

  it("keeps the properties the account can read, and reads the only one", async () => {
    const { gsc, callback } = await setup();
    gsc.oauth.siteEntries = [
      { siteUrl: FAKE_GSC.property, permissionLevel: "siteRestrictedUser" },
      { siteUrl: "https://other.example/", permissionLevel: "siteUnverifiedUser" },
    ];
    const grant = await callback();
    expect(grant?.config).toEqual({
      property: FAKE_GSC.property,
      properties: [FAKE_GSC.property],
    });
    expect(grant?.externalAccountId).toBe(FAKE_GSC.property);
    expect(grant?.credentials).toMatchObject({ scope: GSC_SCOPE });
    expect(JSON.stringify(grant?.config)).not.toContain("ya29");
  });

  it("refuses a grant with more or less than webmasters.readonly, or no property", async () => {
    const { gsc, callback } = await setup();
    gsc.oauth.grantScope = "";
    await expect(callback()).rejects.toBeInstanceOf(SignInRefusedError);
    gsc.oauth.grantScope = `${GSC_SCOPE} https://www.googleapis.com/auth/webmasters`;
    await expect(callback()).rejects.toThrow(/more access/);
    gsc.oauth.grantScope = GSC_SCOPE;
    gsc.oauth.siteEntries = [];
    await expect(callback()).rejects.toThrow(/can't read any Search Console property/);
    await expect(callback("a-wrong-code")).rejects.toThrow(/invalid_grant/);
  });

  it("chooses a property only when it is clear which", () => {
    expect(defaultGscProperty(["https://a.example/"])).toBe("https://a.example/");
    expect(defaultGscProperty(["https://a.example/", "sc-domain:a.example"])).toBe(
      "sc-domain:a.example",
    );
    expect(defaultGscProperty(["sc-domain:a.example", "sc-domain:b.example"])).toBeNull();
    const all = ["https://www.b.example/", "sc-domain:a.example", "http://c.example/"];
    expect(gscPropertyForDomain(all, "a.example")).toBe("sc-domain:a.example");
    expect(gscPropertyForDomain(all, "b.example")).toBe("https://www.b.example/");
    expect(gscPropertyForDomain(all, "www.c.example")).toBe("http://c.example/");
    expect(gscPropertyForDomain(all, "d.example")).toBeNull();
  });

  it("reads the chosen property as the service account does, refreshing an old token", async () => {
    const { gsc, connector, callback } = await setup();
    const grant = await callback();
    const span = { from: "2026-11-01", to: addDays(TODAY, -1), today: TODAY, first: false };
    const expired = { ...(grant?.credentials ?? {}), expiresAt: "2026-11-01T00:00:00.000Z" };
    const c = ctx(expired, grant?.config ?? {});
    const read = await connector.search.read(c, span);
    // Nov 1 to Nov 3, the last day with figures: a page and a query record each.
    expect(read.lastDay).toBe("2026-11-03");
    expect(read.records.length).toBe(3 * 2);
    // The refreshed token was kept.
    const kept = (await c.credentials.get()) as { expiresAt: string } | null;
    expect(Date.parse(kept?.expiresAt ?? "")).toBeGreaterThan(NOW.getTime());
    expect(gsc.queries.every((q) => q.property === FAKE_GSC.property)).toBe(true);

    // No property chosen yet: a reason in our words, nothing read.
    await expect(
      connector.search.read(ctx(expired, { property: null, properties: ["a", "b"] }), span),
    ).rejects.toBeInstanceOf(SearchImportError);
    // A grant Google no longer honours asks for a new sign-in.
    const refresh = String(
      (grant?.credentials as { refreshToken?: string } | undefined)?.refreshToken,
    );
    gsc.oauth.revoked.add(refresh);
    await expect(
      connector.search.read(ctx({ ...expired, refreshToken: refresh }, grant?.config ?? {}), span),
    ).rejects.toThrow(/connect Search Console again/);
  });
});
