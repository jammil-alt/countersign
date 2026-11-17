import { describe, expect, it } from "vitest";
import {
  BROWSER_BLOCKED_HOSTS,
  BROWSER_DEFAULT_BLOCKED,
  BrowserConnectionConfig,
  BrowserSiteProfile,
  type BrowserSiteProfileInput,
  blockedHost,
  browserSiteHosts,
  browserWriteCeiling,
  checkBrowserUrl,
  effectiveTier,
  emptyBrowserState,
  mayKeepSession,
  onLoginOrigin,
  signInAllowed,
  signInDecision,
  siteTier,
  stricterLoosening,
  urlMatches,
} from "./site";

const PROFILE: BrowserSiteProfileInput = {
  login: {
    url: "https://portal.acme.test/login",
    origins: ["https://portal.acme.test"],
    usernameField: "#user",
    passwordField: "#pass",
    submitButton: "#go",
    secondFactor: {
      kind: "email",
      sender: "@acme.test",
      pattern: "code is (\\d{6})",
      codeField: "#code",
      codeButton: "#verify",
    },
    signedIn: { selector: "#account" },
  },
  signOut: { url: "https://portal.acme.test/logout" },
  allow: ["https://portal.acme.test/invoices*", "https://portal.acme.test/home"],
  block: ["/invoices/*/dispute*"],
};

describe("site profiles", () => {
  it("parse a full profile with defaults", () => {
    const p = BrowserSiteProfile.parse(PROFILE);
    expect(p.session).toEqual({ keep: false });
    expect(p.block).toEqual(["/invoices/*/dispute*"]);
    expect(p.login.stopSelectors).toEqual([]);
  });

  it("refuse a login page off its origins, plain http to a real host and loose allow patterns", () => {
    const bad = (patch: (p: BrowserSiteProfileInput) => void) => {
      const p = JSON.parse(JSON.stringify(PROFILE)) as BrowserSiteProfileInput;
      patch(p);
      return BrowserSiteProfile.safeParse(p).success;
    };
    expect(bad((p) => (p.login.url = "https://evil.test/login"))).toBe(false);
    expect(bad((p) => (p.login.origins = ["http://portal.acme.test"]))).toBe(false);
    expect(bad((p) => (p.login.origins = ["https://portal.acme.test/login"]))).toBe(false);
    expect(bad((p) => (p.allow = ["https://*"]))).toBe(false);
    expect(bad((p) => (p.allow = ["*/invoices"]))).toBe(false);
    expect(bad((p) => (p.allow = ["https://*.acme.test/*"]))).toBe(false);
    expect(bad((p) => (p.signOut = { url: "https://other.test/logout" }))).toBe(false);
    expect(bad((p) => (p.signOut = {}))).toBe(false);
    expect(bad((p) => (p.login.signedIn = {}))).toBe(false);
    // Loopback http is fine (fixture sites in tests).
    expect(
      bad((p) => {
        p.login.url = "http://127.0.0.1:4000/login";
        p.login.origins = ["http://127.0.0.1:4000"];
        p.signOut = { selector: "#logout" };
        p.allow = ["http://127.0.0.1:4000/*"];
      }),
    ).toBe(true);
  });
});

describe("site hosts (Browser Run's guardrails)", () => {
  it("are the login, sign-out and allowed pages' hosts plus the profile's extra hosts", () => {
    const p = BrowserSiteProfile.parse({
      ...PROFILE,
      allow: [...PROFILE.allow, "https://files.acme.test/*"],
      hosts: ["cdn.acme-assets.test"],
    });
    expect(browserSiteHosts(p).sort()).toEqual([
      "cdn.acme-assets.test",
      "files.acme.test",
      "portal.acme.test",
    ]);
    expect(BrowserSiteProfile.safeParse({ ...PROFILE, hosts: ["https://x.test"] }).success).toBe(
      false,
    );
  });
});

describe("URL rules", () => {
  const rules = BrowserSiteProfile.parse(PROFILE);

  it("allow only allowed pages, never blocked ones", () => {
    expect(checkBrowserUrl("https://portal.acme.test/invoices", rules).ok).toBe(true);
    expect(checkBrowserUrl("https://portal.acme.test/invoices/42.pdf", rules).ok).toBe(true);
    expect(checkBrowserUrl("https://portal.acme.test/orders", rules)).toMatchObject({
      ok: false,
      code: "not_allowed",
    });
    expect(checkBrowserUrl("https://other.test/invoices", rules)).toMatchObject({
      ok: false,
      code: "not_allowed",
    });
    expect(checkBrowserUrl("https://portal.acme.test/invoices/42/dispute", rules)).toMatchObject({
      ok: false,
      code: "blocked",
    });
  });

  it("always apply the platform's blocked pages, also percent-encoded and in the query", () => {
    const open = BrowserSiteProfile.parse({ ...PROFILE, allow: ["https://portal.acme.test/*"] });
    for (const path of [
      "/account/settings",
      "/change-password",
      "/%70assword",
      "/users/7",
      "/permissions",
      "/billing",
      "/payment-methods",
      "/invoices/9?action=delete",
      "/roles",
    ]) {
      expect(checkBrowserUrl(`https://portal.acme.test${path}`, open), path).toMatchObject({
        ok: false,
        code: "blocked",
      });
    }
    expect(BROWSER_DEFAULT_BLOCKED.length).toBeGreaterThan(5);
    expect(checkBrowserUrl("https://portal.acme.test/invoices", open).ok).toBe(true);
  });

  it("refuse other schemes and logins in the address; ignore fragments", () => {
    expect(checkBrowserUrl("javascript:alert(1)", rules).ok).toBe(false);
    expect(checkBrowserUrl("http://portal.acme.test/invoices", rules)).toMatchObject({
      code: "scheme",
    });
    expect(checkBrowserUrl("https://a:b@portal.acme.test/invoices", rules)).toMatchObject({
      code: "scheme",
    });
    expect(checkBrowserUrl("https://portal.acme.test/invoices#x", rules)).toEqual({
      ok: true,
      url: "https://portal.acme.test/invoices",
    });
    expect(urlMatches("/Invoices*", "https://portal.acme.test/invoices/1")).toBe(true);
  });

  it("pins login origins exactly: scheme, host and port", () => {
    const origins = ["https://portal.acme.test"];
    expect(onLoginOrigin("https://portal.acme.test/login?x=1", origins)).toBe(true);
    expect(onLoginOrigin("https://portal.acme.test:8443/login", origins)).toBe(false);
    expect(onLoginOrigin("https://evil.portal.acme.test/login", origins)).toBe(false);
    expect(onLoginOrigin("https://portal.acme.test.evil.test/login", origins)).toBe(false);
    expect(onLoginOrigin("not a url", origins)).toBe(false);
  });
});

describe("tier rules", () => {
  it("blocked never signs in; high needs a person (not built yet); low and medium sign in", () => {
    expect(signInDecision("blocked")).toMatchObject({ ok: false, code: "blocked" });
    expect(signInDecision("high")).toMatchObject({ ok: false, code: "needs_person" });
    expect(signInDecision("medium")).toEqual({ ok: true });
    expect(signInDecision("low")).toEqual({ ok: true });
    // A client asking for a person's sign-in makes a low site work as high.
    expect(effectiveTier("low", { personSignIn: true })).toBe("high");
    expect(signInDecision("low", { personSignIn: true })).toMatchObject({ code: "needs_person" });
    expect(signInDecision("blocked", { personSignIn: true })).toMatchObject({ code: "blocked" });
  });

  it("medium writes always need approval; blocked and no-writes are off; low follows the matrix", () => {
    expect(browserWriteCeiling("low")).toBe("matrix");
    expect(browserWriteCeiling("medium")).toBe("approval");
    expect(browserWriteCeiling("high")).toBe("approval");
    expect(browserWriteCeiling("blocked")).toBe("off");
    expect(browserWriteCeiling("low", { noWrites: true })).toBe("off");
    expect(browserWriteCeiling("low", { personSignIn: true })).toBe("approval");
  });

  it("keeps a session only on low tier, when the site allows it", () => {
    const keep = { session: { keep: true } };
    expect(mayKeepSession("low", undefined, keep)).toBe(true);
    expect(mayKeepSession("medium", undefined, keep)).toBe(false);
    expect(mayKeepSession("low", { personSignIn: true }, keep)).toBe(false);
    expect(mayKeepSession("low", undefined, { session: { keep: false } })).toBe(false);
  });

  it("lets a client only tighten", () => {
    const off = { noWrites: false, personSignIn: false };
    expect(stricterLoosening(off, { noWrites: true, personSignIn: false })).toEqual([]);
    expect(stricterLoosening({ noWrites: true, personSignIn: true }, off)).toEqual([
      "noWrites",
      "personSignIn",
    ]);
  });
});

describe("the blocked tier's hosts", () => {
  /** The profile moved onto `origin`, with every page there. */
  const on = (origin: string, extra: Partial<BrowserSiteProfileInput> = {}) =>
    BrowserSiteProfile.parse({
      ...PROFILE,
      login: { ...PROFILE.login, url: `${origin}/login`, origins: [origin] },
      signOut: { selector: "#logout" },
      allow: [`${origin}/*`],
      ...extra,
    });

  it("match a listed domain and its subdomains, never a look-alike", () => {
    expect(blockedHost("paypal.com")).toBe("paypal.com");
    expect(blockedHost("www.PayPal.com")).toBe("paypal.com");
    expect(blockedHost("secure.chase.com.")).toBe("chase.com");
    expect(blockedHost("accounts.google.com")).toBe("accounts.google.com");
    expect(blockedHost("login.microsoftonline.com:443")).toBe("login.microsoftonline.com");
    expect(blockedHost("*.okta.com")).toBe("okta.com");
    expect(blockedHost("notpaypal.com")).toBeNull();
    expect(blockedHost("paypal.com.example.test")).toBeNull();
    expect(blockedHost("portal.acme.test")).toBeNull();
    expect(blockedHost("docs.google.com")).toBeNull();
  });

  it("cover each category, as lower-case domains with no scheme, path or wildcard", () => {
    for (const host of ["chase.com", "stripe.com", "mail.google.com", "okta.com"]) {
      expect(BROWSER_BLOCKED_HOSTS).toContain(host);
    }
    for (const host of BROWSER_BLOCKED_HOSTS) {
      expect(host).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/);
    }
    expect(new Set(BROWSER_BLOCKED_HOSTS).size).toBe(BROWSER_BLOCKED_HOSTS.length);
  });

  it("make a site the blocked tier whatever tier was picked", () => {
    expect(siteTier("low", on("https://www.paypal.com"))).toBe("blocked");
    expect(siteTier("medium", on("https://portal.acme.test"))).toBe("medium");
    // An extra host the browser may reach counts too.
    expect(
      siteTier("low", on("https://portal.acme.test", { hosts: ["login.microsoftonline.com"] })),
    ).toBe("blocked");
    expect(siteTier("low", null)).toBe("low");
  });

  it("strip every trailing dot", () => {
    expect(blockedHost("paypal.com..")).toBe("paypal.com");
    expect(checkBrowserUrl("https://paypal.com../", { allow: ["*"], block: [] })).toMatchObject({
      ok: false,
      code: "blocked",
    });
  });

  it("block a wildcard host that covers a listed one", () => {
    expect(blockedHost("*.google.com")).not.toBeNull();
    expect(blockedHost("*.yahoo.com")).not.toBeNull();
    expect(blockedHost("*.googleusercontent.com")).toBeNull();
    expect(blockedHost("*.acme.test")).toBeNull();
    expect(siteTier("low", on("https://portal.acme.test", { hosts: ["*.google.com"] }))).toBe(
      "blocked",
    );
  });

  const CASES: [string, boolean][] = [
    ["https://paypal.com/", true],
    ["https://PAYPAL.COM/", true],
    ["https://www.paypal.com./", true],
    ["https://paypal.com../", true],
    ["https://paypal.com:443/", true],
    ["https://user:pw@paypal.com/", true],
    ["https://paypal.com@evil.test/", false],
    ["https://paypal.com.evil.test/", false],
    ["https://x.paypal.com/", true],
    ["https://ｐａｙｐａｌ．ｃｏｍ/", true],
    ["https://pay%70al.com/", true],
    ["https://xn--paypal-xx.com/", false],
    ["https://mail.google.com/", true],
    ["https://MAIL.google.com/mail/u/0", true],
    ["https://accounts.google.com/", true],
    ["https://accounts.google.com./", true],
    ["https://docs.google.com/", false],
    ["https://google.com/", false],
    ["https://www.google.com/accounts", false],
    ["https://login.microsoftonline.com/", true],
    ["https://login.microsoftonline.us/", false],
    ["https://outlook.office365.com/", true],
    ["https://outlook.cloud.microsoft/", false],
    ["https://login.live.com/", true],
    ["https://live.com/", false],
    ["https://mail.proton.me/", true],
    ["https://dashboard.stripe.com/", true],
    ["https://connect.stripe.com/", true],
    ["https://squareup.com/", true],
    ["https://app.squareup.com/", true],
    ["https://square.com/", false],
    ["https://onlinebanking.usbank.com/", true],
    ["https://www.amex.com/", false],
    ["https://global.americanexpress.com/", true],
    ["https://www.paypal.me/", false],
    ["https://www.td.com/", true],
    ["https://easyweb.td.com/", true],
    ["https://www.53.com/", true],
    ["https://acme.okta.com/", true],
    ["https://acme.okta-emea.com/", false],
    ["https://login.okta.com/", true],
    ["https://acme.oktapreview.com/", true],
    ["https://acme.my.onelogin.com/", true],
    ["https://auth0.com/", false],
    ["https://acme.us.auth0.com/", false],
    ["https://login.salesforce.com/", false],
    ["https://identity.intuit.com/", false],
    ["https://accounts.intuit.com/", false],
    ["https://qbo.intuit.com/", false],
    ["https://[::1]/", false],
    ["https://64.4.250.36/", false],
    ["https://mail.yahoo.com/", true],
    ["https://outlook.office.com/mail/", true],
    ["https://www.icloud.com/mail", true],
    ["https://wise.com/", true],
    ["https://otherwise.com/", false],
    ["https://key.com/", true],
    ["https://monkey.com/", false],
    ["https://id.me/", true],
    ["https://api.id.me/", true],
  ];

  it.each(CASES)("decide %s (blocked: %s) as the list says", (url, blocked) => {
    const r = checkBrowserUrl(url, { allow: ["*"], block: [] });
    expect(!r.ok && r.code === "blocked").toBe(blocked);
  });

  it("are never opened, even when the site's rules allow them", () => {
    const rules = on("https://secure.chase.com");
    expect(checkBrowserUrl("https://secure.chase.com/accounts", rules)).toMatchObject({
      ok: false,
      code: "blocked",
    });
    const acme = BrowserSiteProfile.parse(PROFILE);
    expect(checkBrowserUrl("https://portal.acme.test/invoices", acme).ok).toBe(true);
  });
});

describe("caps", () => {
  const at = new Date("2026-11-05T15:30:00Z");
  const config = BrowserConnectionConfig.parse({
    site: "acme",
    siteVersionId: "0190f5e8-8a3c-7d6e-8f00-000000000001",
    identity: null,
  });

  it("defaults to 10 sign-ins a day and any hour", () => {
    expect(config.caps).toEqual({ signInsPerDay: 10, hours: null });
    expect(config.stricter).toEqual({ noWrites: false, personSignIn: false });
  });

  it("refuses once stopped, past the daily cap (counted per UTC day) and outside hours", () => {
    const state = emptyBrowserState("2026-11-05");
    expect(signInAllowed(config.caps, state, at)).toEqual({ ok: true });
    expect(signInAllowed(config.caps, { ...state, signIns: 10 }, at)).toMatchObject({
      code: "daily_cap",
    });
    // Yesterday's count does not hold today.
    expect(signInAllowed(config.caps, { ...state, day: "2026-11-04", signIns: 10 }, at)).toEqual({
      ok: true,
    });
    expect(
      signInAllowed(config.caps, { ...state, stopped: { reason: "a CAPTCHA", at: "x" } }, at),
    ).toMatchObject({ code: "stopped" });
    const hours = { start: "08:00", end: "18:00", timezone: "America/Chicago" };
    // 15:30 UTC is 09:30 in Chicago (CST).
    expect(signInAllowed({ ...config.caps, hours }, state, at)).toEqual({ ok: true });
    expect(
      signInAllowed({ ...config.caps, hours: { ...hours, start: "10:00" } }, state, at),
    ).toMatchObject({ code: "hours" });
    // Overnight windows wrap.
    expect(
      signInAllowed(
        { ...config.caps, hours: { start: "22:00", end: "10:00", timezone: "UTC" } },
        state,
        new Date("2026-11-05T09:00:00Z"),
      ),
    ).toEqual({ ok: true });
  });
});
