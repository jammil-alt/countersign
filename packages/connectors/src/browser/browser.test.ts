// The browser connector against a fake browser and a fake supplier portal (docs/plan.md §1.26
// phase 3): sign-in by code with an emailed code, origin pinning, failures and stops, caps,
// allowed and blocked pages, what reads return, sign-out in every case, and kept sessions.

import { beforeEach, describe, expect, it } from "vitest";
import { bindingKeyFor } from "../connector";
import { runReadTool } from "../invoke";
import { failure, ORIGIN, PASSWORD, type S, setUp, USERNAME } from "./browser.test-helper";
import {
  BROWSER_FILE_DOWNLOAD_TOOL,
  BROWSER_PAGE_READ_TOOL,
  type BrowserTab,
  type BrowserTabService,
  BrowseScope,
  HELD_SESSION_REOPENS,
  remoteBrowserTab,
} from "./index";

/** Every value typed, with where it was typed. */
const typed = (s: S) =>
  s.driver.events.flatMap((e) => (e.op === "fill" ? [{ url: e.url, value: e.value }] : []));

describe("browser connector: signing in by code", () => {
  let s: S;
  beforeEach(async () => {
    s = setUp();
    await s.identify();
  });

  it("signs in with the emailed code, reads an allowed page, signs out and closes", async () => {
    const r = await s.read(`${ORIGIN}/invoices`);
    expect(r.output).toMatchObject({
      url: `${ORIGIN}/invoices`,
      tables: [{ headers: ["Invoice", "Total", "Status"], rows: [["INV-1001", "120.00", "open"]] }],
      truncated: false,
    });
    // The code was asked for before submitting and handed out once.
    expect(s.codes.waits).toHaveLength(1);
    expect(s.codes.waits[0]).toMatchObject({ channel: "email", sender: "@supplier.test" });
    expect(s.codes.alertsRaised).toEqual([]);
    expect(s.portal.signIns).toBe(1);
    expect(s.portal.signOuts).toBe(1);
    expect(s.portal.sessions.size).toBe(0);
    expect(s.driver.closed).toBe(1);
    expect(s.records[0]).toMatchObject({
      signIn: "fresh",
      outcome: "done",
      signedOut: true,
      keptSession: false,
      pages: [`${ORIGIN}/invoices`],
      actions: [{ kind: "read", url: `${ORIGIN}/invoices` }],
    });
    expect(s.state.value).toMatchObject({ signIns: 1, failures: 0, stopped: null });
    // Typed only on the login origin: the username, the password, then the code.
    expect(typed(s)).toEqual([
      { url: `${ORIGIN}/login`, value: USERNAME },
      { url: `${ORIGIN}/login`, value: PASSWORD },
      { url: `${ORIGIN}/verify`, value: "481516" },
    ]);
  });

  it("returns page data only: no password, hidden field, cookie or code", async () => {
    const r = await s.read(`${ORIGIN}/invoices`);
    const out = JSON.stringify(r.output);
    expect(out).toContain("PO-77");
    for (const secret of [
      PASSWORD,
      "csrf-token-abc123",
      "should-never-show",
      "481516",
      "pending-",
    ]) {
      expect(out).not.toContain(secret);
    }
    // A page that echoes the password back still never shows it.
    const echo = await s.read(`${ORIGIN}/invoices/echo`);
    expect(JSON.stringify(echo.output)).not.toContain(PASSWORD);
    expect(String((echo.output as { text: string }).text)).toContain("[hidden]");
  });

  it("takes screenshots only after sign-in", async () => {
    await s.read(`${ORIGIN}/invoices`);
    const shots = s.driver.events.filter((e) => e.op === "screenshot");
    expect(shots.map((e) => (e as { url: string }).url)).toEqual([
      `${ORIGIN}/home`,
      `${ORIGIN}/invoices`,
    ]);
    const firstShot = s.driver.events.findIndex((e) => e.op === "screenshot");
    const lastFill = s.driver.events.map((e) => e.op).lastIndexOf("fill");
    expect(firstShot).toBeGreaterThan(lastFill);
    expect(s.records[0]?.screenshots).toEqual(["shot-1", "shot-2"]);
  });

  it("downloads an invoice into documents", async () => {
    const r = await s.download(`${ORIGIN}/invoices/INV-1001.pdf`);
    expect(r.output).toMatchObject({
      documentId: "doc-1",
      filename: "INV-1001.pdf",
      mimeType: "application/pdf",
      alreadyHad: false,
    });
    expect(s.documents[0]).toMatchObject({
      filename: "INV-1001.pdf",
      sourceUrl: `${ORIGIN}/invoices/INV-1001.pdf`,
    });
    expect(s.records[0]?.actions).toEqual([
      { kind: "download", url: `${ORIGIN}/invoices/INV-1001.pdf`, documentId: "doc-1" },
    ]);
    // A file that is not a document is refused, and the browser still signs out.
    expect(await failure(s.download(`${ORIGIN}/invoices/statement.csv`))).toMatch(
      /documents are PDFs or images/,
    );
    expect(s.portal.signOuts).toBe(2);
  });

  it("takes the binding key from the input's site", () => {
    expect(bindingKeyFor(s.connector, { site: "supplier", url: "x" })).toBe("browser:supplier");
    expect(bindingKeyFor(s.connector, { url: "x" })).toBeNull();
    expect(bindingKeyFor(s.connector, { site: "Not A Slug" })).toBeNull();
  });
});

describe("browser connector: pages", () => {
  let s: S;
  beforeEach(async () => {
    s = setUp();
    await s.identify();
  });

  it("opens only allowed pages, never blocked ones, and re-checks redirects", async () => {
    expect(await failure(s.read(`${ORIGIN}/account/settings`))).toMatch(/agents never open/);
    expect(await failure(s.read(`${ORIGIN}/orders`))).toMatch(/not one agents may open/);
    expect(await failure(s.read("https://elsewhere.test/invoices"))).toMatch(/not one agents/);
    // Allowed address, redirected to a blocked one or another site: left without reading.
    expect(await failure(s.read(`${ORIGIN}/invoices/old-link`))).toMatch(
      /went to a page agents may not open/,
    );
    expect(await failure(s.read(`${ORIGIN}/invoices/moved`))).toMatch(
      /went to a page agents may not open/,
    );
    const reads = s.driver.events
      .filter((e) => e.op === "read")
      .map((e) => (e as { url: string }).url);
    expect(reads.some((u) => u.includes("settings") || u.includes("elsewhere"))).toBe(false);
    // Every attempt signed out and closed.
    expect(s.driver.closed).toBe(s.driver.opened);
  });

  it("refuses another site's input on this connection", async () => {
    expect(await failure(s.read(`${ORIGIN}/invoices`, "other-site"))).toMatch(
      /for supplier, not other-site/,
    );
  });
});

/**
 * The fake tab as apps/api holds a browser-service tab (./remote.ts): `url()` is the address as of
 * the last call, while the page's own address is `live`. A page that moves by itself (`moveTo`)
 * changes `live` only, as a real one does between calls; the service's `fill` holds the typing to
 * the origins it is given, on the live address (apps/browser's serveTab).
 */
function asRemote(inner: BrowserTab) {
  let movedTo: string | null = null;
  const live = () => movedTo ?? inner.url();
  const on = async <T>(value: Promise<T>) => ({ value: await value, url: live() });
  const unset = async (p: Promise<void>) => {
    await p;
    return { url: live(), value: null };
  };
  const service: BrowserTabService = {
    goto: (u) => unset(inner.goto(u)),
    where: async () => ({ url: live(), value: null }),
    fill: async (sel, value, onlyOn) => {
      if (onlyOn && !onlyOn.some((o) => live().startsWith(`${o}/`) || live() === o)) {
        throw new Error("the page is not on an allowed origin; nothing was typed");
      }
      return unset(inner.fill(sel, value));
    },
    click: (sel) => unset(inner.click(sel)),
    has: (sel) => on(inner.has(sel)),
    readText: () => on(inner.readText()),
    readTables: () => on(inner.readTables()),
    textOf: (sel) => on(inner.textOf?.(sel) ?? Promise.resolve(null)),
    controls: () => on(inner.controls?.() ?? Promise.resolve([])),
    sendsForm: (sel) => on(inner.sendsForm?.(sel) ?? Promise.resolve(false)),
    readOnly: (v) => unset(inner.readOnly?.(v) ?? Promise.resolve()),
    download: (u) => on(inner.download(u)),
    cookies: () => on(inner.cookies()),
    setCookies: (c) => unset(inner.setCookies(c)),
    screenshot: () => on(inner.screenshot()),
    alive: async () => true,
    close: () => inner.close(),
  };
  return {
    tab: remoteBrowserTab(service, inner.url()),
    moveTo(address: string) {
      movedTo = address;
    },
  };
}

describe("browser connector: a remote tab whose page moves during the code wait", () => {
  it("asks the browser where it is before typing the code, types nothing, and stops", async () => {
    const s = setUp();
    await s.identify();
    let remote: ReturnType<typeof asRemote> | null = null;
    const open = s.driver.open.bind(s.driver);
    s.driver.open = async () => {
      remote = asRemote(await open());
      return remote.tab;
    };
    // The page navigates by itself while sign-in waits for the code: no call reaches the tab
    // between the claim and the typing, so apps/api's copy of the address is from before it.
    const claim = s.codes.claim.bind(s.codes);
    s.codes.claim = async (input) => {
      const r = await claim(input);
      if (r.ok && r.value.status === "code") remote?.moveTo("https://login.evil.test/verify");
      return r;
    };
    expect(await failure(s.read(`${ORIGIN}/invoices`))).toMatch(
      /BrowserStop: .*login\.evil\.test.*nothing was typed/,
    );
    const values = typed(s).map((t) => t.value);
    expect(values).toContain(USERNAME);
    expect(values).toHaveLength(2);
    expect(s.stops).toHaveLength(1);
  });

  it("the tab refuses the typing itself when the page moves after the check", async () => {
    const s = setUp();
    await s.identify();
    let remote: ReturnType<typeof asRemote> | null = null;
    const open = s.driver.open.bind(s.driver);
    s.driver.open = async () => {
      const r = asRemote(await open());
      remote = r;
      // Live address answered right before the code's fill, then the page moves: only the tab's
      // own check on the fill stands between the code and the other origin.
      const where = r.tab.where?.bind(r.tab);
      let asks = 0;
      r.tab.where = async () => {
        const at = (await where?.()) ?? r.tab.url();
        if (codeClaimed && ++asks === 1) remote?.moveTo("https://login.evil.test/verify");
        return at;
      };
      return r.tab;
    };
    let codeClaimed = false;
    const claim = s.codes.claim.bind(s.codes);
    s.codes.claim = async (input) => {
      const r = await claim(input);
      if (r.ok && r.value.status === "code") codeClaimed = true;
      return r;
    };
    expect(await failure(s.read(`${ORIGIN}/invoices`))).toMatch(
      /BrowserStop: .*login\.evil\.test.*nothing was typed/,
    );
    expect(typed(s)).toHaveLength(2);
  });
});

describe("browser connector: origin pinning, failures and stops", () => {
  it("types nothing when the login page moves to another origin, and stops", async () => {
    const s = setUp();
    await s.identify();
    s.portal.loginTwist = "redirect_away";
    expect(await failure(s.read(`${ORIGIN}/invoices`))).toMatch(
      /BrowserStop: .*login\.evil\.test.*nothing was typed/,
    );
    expect(typed(s)).toEqual([]);
    expect(s.stops).toHaveLength(1);
    expect(s.state.value?.stopped?.reason).toMatch(/nothing was typed/);
    expect(s.driver.closed).toBe(1);
  });

  it("stops at a CAPTCHA or a new-device check, without retrying", async () => {
    for (const twist of ["captcha", "new_device"] as const) {
      const s = setUp();
      await s.identify();
      s.portal.loginTwist = twist;
      expect(await failure(s.read(`${ORIGIN}/invoices`))).toMatch(/BrowserStop: /);
      expect(s.stops).toHaveLength(1);
      // Further sign-ins are refused before a browser opens.
      const opened = s.driver.opened;
      // (The connection needs attention, and its state is stopped too.)
      expect(await failure(s.read(`${ORIGIN}/invoices`))).toMatch(/connection is error/);
      s.connection.status = "connected";
      expect(await failure(s.read(`${ORIGIN}/invoices`))).toMatch(/sign-ins are stopped/);
      expect(s.driver.opened).toBe(opened);
    }
  });

  it("counts failed sign-ins: two in a row stop the connection", async () => {
    const s = setUp({ password: "wrong-password" });
    await s.identify();
    expect(await failure(s.read(`${ORIGIN}/invoices`))).toMatch(/SignInFailed: .*may be wrong/);
    expect(s.state.value).toMatchObject({ failures: 1, stopped: null });
    expect(s.stops).toEqual([]);
    expect(await failure(s.read(`${ORIGIN}/invoices`))).toMatch(/BrowserStop: 2 failed sign-ins/);
    expect(s.stops).toHaveLength(1);
    expect(s.connection.status).toBe("error");
    // Nothing is tried again: the connection needs attention.
    expect(await failure(s.read(`${ORIGIN}/invoices`))).toMatch(/connection is error/);
    expect(s.portal.signIns).toBe(0);
    // The failure messages never carry what was typed.
    expect(JSON.stringify(s.records)).not.toContain("wrong-password");
  });

  it("a success resets the failure count", async () => {
    const s = setUp();
    await s.identify();
    s.state.value = { day: "2026-11-05", signIns: 1, failures: 1, stopped: null };
    await s.read(`${ORIGIN}/invoices`);
    expect(s.state.value).toMatchObject({ signIns: 2, failures: 0 });
  });

  it("needs the code service for a site that sends codes, and an identity", async () => {
    const noCodes = setUp({ codes: false });
    await noCodes.identify();
    expect(await failure(noCodes.read(`${ORIGIN}/invoices`))).toMatch(
      /code service is not available/,
    );
    const noIdentity = setUp();
    expect(await failure(noIdentity.read(`${ORIGIN}/invoices`))).toMatch(/no agent identity/);
    expect(typed(noIdentity)).toEqual([]);
  });

  it("a code that arrives with no wait open is an alert and never used", async () => {
    const s = setUp();
    await s.identify();
    s.codes.deliver(
      "email",
      [...s.codes.identities.values()][0]?.email ?? "",
      "no-reply@supplier.test",
      "Your sign-in code is 999999.",
    );
    expect(s.codes.alertsRaised).toHaveLength(1);
    await s.read(`${ORIGIN}/invoices`);
    expect(typed(s).map((t) => t.value)).not.toContain("999999");
  });
});

describe("browser connector: caps and tiers", () => {
  it("refuses past the daily cap and outside hours, before opening a browser", async () => {
    const s = setUp({ caps: { signInsPerDay: 2 } });
    await s.identify();
    await s.read(`${ORIGIN}/invoices`);
    await s.read(`${ORIGIN}/invoices`);
    expect(await failure(s.read(`${ORIGIN}/invoices`))).toMatch(/already signed in 2 times today/);
    expect(s.driver.opened).toBe(2);
    // A new day starts the count again.
    s.later(24 * 3600 * 1000);
    await s.read(`${ORIGIN}/invoices`);
    expect(s.state.value).toMatchObject({ day: "2026-11-06", signIns: 1 });

    const night = setUp({
      caps: { signInsPerDay: 10, hours: { start: "08:00", end: "12:00", timezone: "UTC" } },
    });
    await night.identify();
    expect(await failure(night.read(`${ORIGIN}/invoices`))).toMatch(/only between 08:00 and 12:00/);
    expect(night.driver.opened).toBe(0);
  });

  it("never signs in to a blocked site; high tier (or a client's 'a person signs in') refuses", async () => {
    for (const [tier, stricter, pattern] of [
      ["blocked", {}, /never sign in to this site/],
      ["high", {}, /a person must sign in.*not available yet/],
      ["low", { personSignIn: true }, /you asked for a person to sign in/],
    ] as const) {
      const s = setUp({ tier, stricter });
      await s.identify();
      expect(await failure(s.read(`${ORIGIN}/invoices`))).toMatch(pattern);
      expect(s.driver.opened).toBe(0);
    }
    // A tier change applies at once to a working connection.
    const s = setUp();
    await s.identify();
    await s.read(`${ORIGIN}/invoices`);
    s.setTier("blocked");
    expect(await failure(s.read(`${ORIGIN}/invoices`))).toMatch(/never sign in/);
  });

  it("medium tier signs in on its own and never keeps a session", async () => {
    const s = setUp({ tier: "medium", keep: true });
    await s.identify();
    await s.read(`${ORIGIN}/invoices`);
    await s.read(`${ORIGIN}/invoices`);
    expect(s.credentials.current()).toEqual({ username: USERNAME, password: PASSWORD });
    expect(s.portal.signIns).toBe(2);
    expect(s.portal.signOuts).toBe(2);
    expect(s.records.map((r) => r.keptSession)).toEqual([false, false]);
  });
});

describe("browser connector: kept sessions (low tier)", () => {
  it("keeps the session encrypted with the login and reuses it until it fails", async () => {
    const s = setUp({ keep: true });
    await s.identify();
    await s.read(`${ORIGIN}/invoices`);
    const stored = s.credentials.current() as { session?: { cookies: { name: string }[] } };
    expect(stored.session?.cookies.map((c) => c.name)).toEqual(["sid"]);
    expect(s.portal.signOuts).toBe(0);
    expect(s.records[0]).toMatchObject({ signIn: "fresh", keptSession: true, signedOut: false });

    // The next call signs in by the kept session: no password typed, no code asked for.
    const fills = typed(s).length;
    await s.read(`${ORIGIN}/invoices`);
    expect(typed(s).length).toBe(fills);
    expect(s.codes.waits).toHaveLength(1);
    expect(s.records[1]).toMatchObject({ signIn: "kept_session", keptSession: true });
    expect(s.state.value?.signIns).toBe(1);

    // The site ends the session: the next call forgets it and signs in afresh.
    s.portal.sessions.clear();
    await s.read(`${ORIGIN}/invoices`);
    expect(s.records[2]).toMatchObject({ signIn: "fresh", keptSession: true });
    expect(s.portal.signIns).toBe(2);
  });

  it("signs out and forgets the session when a call fails", async () => {
    const s = setUp({ keep: true });
    await s.identify();
    await s.read(`${ORIGIN}/invoices`);
    expect(await failure(s.read(`${ORIGIN}/orders`))).toMatch(/not one agents may open/);
    expect(s.credentials.current()).toEqual({ username: USERNAME, password: PASSWORD });
    expect(s.portal.signOuts).toBe(1);
    expect(s.records[1]).toMatchObject({ outcome: "failed", signedOut: true, keptSession: false });
  });
});

// v0.16 (docs/plan.md §1.86): an `ai` skill that browses, through its scope (./scope.ts).
describe("browser connector: a browsing skill's pages", () => {
  const SKILL_PAGES = ["/invoices/*", "/invoices"];
  const statements = {
    allow: [`${ORIGIN}/home`, `${ORIGIN}/invoices*`, `${ORIGIN}/statements*`],
  };
  const scoped = (s: S, url: string, within: string[] = SKILL_PAGES) =>
    runReadTool(s.connector, BROWSER_PAGE_READ_TOOL, { site: "supplier", url, within }, s.ctx);

  it("refuses off-site, protocol-relative and traversing addresses before a browser opens", async () => {
    const s = setUp({ profile: statements });
    await s.identify();
    for (const [url, pattern] of [
      ["https://elsewhere.test/invoices/1", /not one agents may open/],
      ["//elsewhere.test/invoices/1", /not a web address/],
      [`${ORIGIN}/invoices/../statements`, /climbs out of its path/],
      [`${ORIGIN}/invoices/%2e%2e/statements`, /climbs out of its path/],
      [`${ORIGIN}/invoices/..%2fstatements`, /climbs out of its path/],
      // On the site's allowed pages, but not the skill's: the intersection holds.
      [`${ORIGIN}/statements`, /not one of this skill's pages/],
    ] as const) {
      expect(await failure(scoped(s, url))).toMatch(pattern);
    }
    expect(s.driver.opened).toBe(0);
    expect(s.portal.signIns).toBe(0);
    expect(s.state.value).toBeNull();
  });

  it("can't widen the site: pages the site doesn't allow stay shut whatever `within` says", async () => {
    const s = setUp();
    await s.identify();
    expect(await failure(scoped(s, `${ORIGIN}/orders/7`, ["/orders/*"]))).toMatch(
      /not one agents may open/,
    );
    expect(await failure(scoped(s, `${ORIGIN}/invoices/settings`, ["/invoices/*"]))).toMatch(
      /agents never open this page/,
    );
    expect(s.driver.opened).toBe(0);
  });

  it("leaves a redirect off the skill's pages without reading it, and signs out", async () => {
    const s = setUp({ profile: statements });
    await s.identify();
    expect(await failure(scoped(s, `${ORIGIN}/invoices/to-statements`))).toMatch(
      /went to a page agents may not open: not one of this skill's pages/,
    );
    const reads = s.driver.events.flatMap((e) => (e.op === "read" ? [e.url] : []));
    expect(reads.some((u) => u.includes("statements"))).toBe(false);
    expect(s.portal.signOuts).toBe(1);
    expect(s.driver.closed).toBe(s.driver.opened);
  });

  it("reads a listed page and returns its evidence screenshot", async () => {
    const s = setUp();
    await s.identify();
    const r = await scoped(s, `${ORIGIN}/invoices`);
    expect(r.output).toMatchObject({ url: `${ORIGIN}/invoices`, screenshot: "shot-2" });
    // Without `within`, reads are as they were: no screenshot key.
    const plain = await s.read(`${ORIGIN}/invoices`);
    expect(plain.output).not.toHaveProperty("screenshot");
  });

  it("through a BrowseScope: off-site refused, then the page limit asks for help", async () => {
    const s = setUp();
    await s.identify();
    const scope = new BrowseScope({
      skill: "custom:find-invoice@3",
      browse: { sites: ["supplier"], pages: SKILL_PAGES },
      goal: "Find the invoice for PO-77",
      limits: { pages: 2 },
    });
    const call = async (toolId: string, input: Record<string, unknown>) => {
      const checked = scope.check(toolId, input);
      if (!checked.ok) {
        scope.observe(toolId, input, { status: "refused", reason: checked.reason });
        return checked;
      }
      try {
        const r = await runReadTool(s.connector, toolId, checked.input, s.ctx);
        scope.observe(toolId, checked.input, { status: "done", output: r.output });
        return { ok: true as const };
      } catch (error) {
        scope.observe(toolId, checked.input, { status: "failed", error: String(error) });
        return { ok: false as const };
      }
    };
    // The model writes its own `within` to widen: it is replaced by the skill's pages.
    await call(BROWSER_PAGE_READ_TOOL, {
      site: "supplier",
      url: "https://elsewhere.test/x",
      within: ["/*"],
    });
    await call(BROWSER_PAGE_READ_TOOL, { site: "supplier", url: `${ORIGIN}/invoices` });
    await call(BROWSER_PAGE_READ_TOOL, { site: "supplier", url: `${ORIGIN}/invoices/INV-1001` });
    expect(scope.overLimit()).toBeNull();
    const third = await call(BROWSER_PAGE_READ_TOOL, {
      site: "supplier",
      url: `${ORIGIN}/invoices/INV-1002`,
    });
    expect(third).toMatchObject({ ok: false, reason: expect.stringMatching(/limit of 2 pages/) });
    expect(scope.overLimit()).toBe("pages");
    expect(s.driver.opened).toBe(2);
    expect(scope.needsHelp()).toEqual({
      question:
        'We looked for "Find the invoice for PO-77" on supplier and didn\'t find it within 2 pages. Where on the site should we look?',
      tried: [
        "Looked for: Find the invoice for PO-77",
        "Refused https://elsewhere.test/x: https://elsewhere.test/x: not one of this skill's pages (/invoices/*, /invoices)",
        `Read ${ORIGIN}/invoices`,
        `Read ${ORIGIN}/invoices/INV-1001`,
        expect.stringMatching(/^Refused .*INV-1002: .*limit of 2 pages/),
      ],
      screenshots: ["shot-2", "shot-4"],
      remember: "[browse-help skill=custom:find-invoice sites=supplier]",
    });
  });
});

// v0.16: a browsing skill's calls share one signed-in session per site for the skill run.
describe("browser connector: one session for a browsing skill's run", () => {
  const SKILL_PAGES = ["/invoices/*", "/invoices"];
  const scopeOf = () =>
    new BrowseScope({
      skill: "custom:find-invoice",
      browse: { sites: ["supplier"], pages: SKILL_PAGES },
      goal: "Find the invoice for PO-77",
    });
  const inRun = (s: S, scope: BrowseScope) => ({ ...s.ctx, sessions: scope.sessions });
  const read = (s: S, scope: BrowseScope, url: string) =>
    runReadTool(
      s.connector,
      BROWSER_PAGE_READ_TOOL,
      { site: "supplier", url, within: SKILL_PAGES },
      inRun(s, scope),
    );

  it("signs in once for many pages and a download, and signs out when the run closes", async () => {
    const s = setUp({ tier: "medium" });
    await s.identify();
    const scope = scopeOf();
    const first = await read(s, scope, `${ORIGIN}/invoices`);
    const second = await read(s, scope, `${ORIGIN}/invoices/INV-1001`);
    const file = await runReadTool(
      s.connector,
      BROWSER_FILE_DOWNLOAD_TOOL,
      { site: "supplier", url: `${ORIGIN}/invoices/INV-1001.pdf`, within: SKILL_PAGES },
      inRun(s, scope),
    );
    expect(file.output).toMatchObject({ documentId: "doc-1" });
    // Each page's own evidence: the screenshot after it, never the sign-in's or another page's.
    expect(first.output).toMatchObject({ screenshot: "shot-2" });
    expect(second.output).toMatchObject({ screenshot: "shot-3" });
    expect(s.portal.signIns).toBe(1);
    expect(s.state.value?.signIns).toBe(1);
    expect(s.driver.opened).toBe(1);
    expect(s.portal.signOuts).toBe(0);
    await scope.close();
    expect(s.portal.signOuts).toBe(1);
    expect(s.driver.closed).toBe(1);
    // One record for the session, with every page it opened.
    expect(s.records).toHaveLength(1);
    expect(s.records[0]).toMatchObject({
      outcome: "done",
      signedOut: true,
      pages: [`${ORIGIN}/invoices`, `${ORIGIN}/invoices/INV-1001`],
      actions: [
        { kind: "read", url: `${ORIGIN}/invoices` },
        { kind: "read", url: `${ORIGIN}/invoices/INV-1001` },
        { kind: "download", url: `${ORIGIN}/invoices/INV-1001.pdf`, documentId: "doc-1" },
      ],
    });
  });

  it("refuses a bad first address without spending a sign-in or spoiling the session", async () => {
    const s = setUp({
      tier: "medium",
      profile: { allow: [`${ORIGIN}/invoices*`, `${ORIGIN}/statements*`] },
    });
    await s.identify();
    const scope = scopeOf();
    expect(await failure(read(s, scope, "https://elsewhere.test/invoices"))).toMatch(
      /^BrowserRefused: .*not one agents may open/,
    );
    expect(s.driver.opened).toBe(0);
    // A redirect off the skill's pages is refused inside the session, which stays open.
    expect(await failure(read(s, scope, `${ORIGIN}/invoices/to-statements`))).toMatch(
      /^BrowserRefused: .*went to a page agents may not open/,
    );
    expect(await read(s, scope, `${ORIGIN}/invoices`)).toMatchObject({
      output: { url: `${ORIGIN}/invoices` },
    });
    expect(s.portal.signIns).toBe(1);
    await scope.close();
    expect(s.portal.signOuts).toBe(1);
  });

  it("at the daily sign-in cap: refused as a cap, and the scope asks for help", async () => {
    const s = setUp({ tier: "medium", caps: { signInsPerDay: 1, hours: null } });
    await s.identify();
    await s.read(`${ORIGIN}/invoices`);
    const scope = scopeOf();
    expect(await failure(read(s, scope, `${ORIGIN}/invoices`))).toMatch(
      /^BrowserCapReached: .*signed in 1 times today/,
    );
    expect(scope.overLimit()).toBe("sign_in");
    expect(scope.needsHelp().question).toMatch(/^We couldn't sign in to supplier/);
    expect(
      scope.check(BROWSER_PAGE_READ_TOOL, { site: "supplier", url: `${ORIGIN}/invoices` }),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/can't be signed in to now/) });
    await scope.close();
  });

  it("a failed sign-in is not retried within the run, and the scope asks for help", async () => {
    const s = setUp({ tier: "medium", password: "wrong-password" });
    await s.identify();
    const scope = scopeOf();
    expect(await failure(read(s, scope, `${ORIGIN}/invoices`))).toMatch(/^SignInFailed/);
    expect(await failure(read(s, scope, `${ORIGIN}/invoices/INV-1001`))).toMatch(/^SignInFailed/);
    expect(s.state.value?.signIns).toBe(1);
    expect(s.state.value?.failures).toBe(1);
    // Every later read would fail the same way: the run asks for help instead.
    expect(scope.overLimit()).toBe("session");
    expect(scope.needsHelp().question).toMatch(/^We couldn't go on browsing supplier/);
    expect(
      scope.check(BROWSER_PAGE_READ_TOOL, { site: "supplier", url: `${ORIGIN}/invoices` }),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/session ended/) });
    await scope.close();
    expect(s.driver.closed).toBe(s.driver.opened);
  });

  it("asks Browser Run to keep a held browser as long as the run may wait; one call keeps its default", async () => {
    const s = setUp({ tier: "medium" });
    await s.identify();
    await s.read(`${ORIGIN}/invoices`);
    const scope = scopeOf();
    await read(s, scope, `${ORIGIN}/invoices`);
    await scope.close();
    expect(s.opens.map((o) => o.keepAliveMs)).toEqual([undefined, 5 * 60_000]);
  });

  it("a browser closed between calls is opened again and signed in again, within the caps", async () => {
    const s = setUp({ tier: "medium" });
    await s.identify();
    const scope = scopeOf();
    await read(s, scope, `${ORIGIN}/invoices`);
    // The model took its time: Browser Run closed the idle browser.
    s.driver.killOpen();
    expect(await read(s, scope, `${ORIGIN}/invoices/INV-1001`)).toMatchObject({
      output: { url: `${ORIGIN}/invoices/INV-1001` },
    });
    expect(await read(s, scope, `${ORIGIN}/invoices`)).toMatchObject({
      output: { url: `${ORIGIN}/invoices` },
    });
    // The second sign-in counts against the connection's daily cap.
    expect(s.portal.signIns).toBe(2);
    expect(s.state.value?.signIns).toBe(2);
    expect(s.driver.opened).toBe(2);
    expect(scope.overLimit()).toBeNull();
    await scope.close();
    expect(s.driver.closed).toBe(2);
    // One record per browser; the closed one couldn't sign out.
    expect(s.records.map((r) => [r.outcome, r.signedOut])).toEqual([
      ["failed", false],
      ["done", true],
    ]);
  });

  it("a browser closed between calls at the daily cap: the run asks for help", async () => {
    const s = setUp({ tier: "medium", caps: { signInsPerDay: 1, hours: null } });
    await s.identify();
    const scope = scopeOf();
    await read(s, scope, `${ORIGIN}/invoices`);
    s.driver.killOpen();
    expect(await failure(read(s, scope, `${ORIGIN}/invoices/INV-1001`))).toMatch(
      /^BrowserCapReached: .*signed in 1 times today/,
    );
    expect(scope.overLimit()).toBe("sign_in");
    expect(s.portal.signIns).toBe(1);
    await scope.close();
    expect(s.driver.closed).toBe(s.driver.opened);
  });

  it("a browser that keeps closing ends the session after two fresh ones", async () => {
    const s = setUp({ tier: "medium" });
    await s.identify();
    const scope = scopeOf();
    await read(s, scope, `${ORIGIN}/invoices`);
    for (let i = 0; i < HELD_SESSION_REOPENS; i++) {
      s.driver.killOpen();
      await read(s, scope, `${ORIGIN}/invoices`);
    }
    s.driver.killOpen();
    expect(await failure(read(s, scope, `${ORIGIN}/invoices`))).toMatch(
      /browser closed between pages/,
    );
    expect(scope.overLimit()).toBe("session");
    expect(s.portal.signIns).toBe(1 + HELD_SESSION_REOPENS);
    await scope.close();
    expect(s.driver.closed).toBe(s.driver.opened);
  });

  it("a stop page mid-session ends it, and the run asks for help before its next call", async () => {
    const s = setUp({ tier: "medium" });
    await s.identify();
    const scope = scopeOf();
    await read(s, scope, `${ORIGIN}/invoices`);
    expect(await failure(read(s, scope, `${ORIGIN}/invoices/check`))).toMatch(
      /^BrowserStop: .*CAPTCHA/,
    );
    // Told before the failed call came back.
    expect(scope.overLimit()).toBe("session");
    expect(scope.needsHelp().question).toMatch(/CAPTCHA/);
    expect(s.portal.signOuts).toBe(1);
    await scope.close();
    expect(s.driver.closed).toBe(s.driver.opened);
  });
});
