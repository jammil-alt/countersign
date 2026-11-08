// The pure half of measuring a client's site (./events.ts; ported from Plenary Labs): what a
// beacon may say, where a visit came from, what a reader reads with, and that nothing identifying
// goes further.
import { describe, expect, it } from "vitest";
import {
  browserOf,
  classifySource,
  deviceOf,
  isBotAgent,
  languageOf,
  osOf,
  parseBeacon,
  placeOf,
  toSiteEvents,
  visitHash,
} from "./events";

const SITE = "mezonas.com";
const ID = "3f1c2a4e-9b7d-4c1e-8a2f-5d6e7f809a1b";

describe("where a visit came from", () => {
  const from = (referrer?: string, search?: string) =>
    classifySource({ referrer, search, siteHost: SITE });

  it("calls no referrer direct, and a referrer on this site or the app internal", () => {
    expect(from()).toEqual({ sourceGroup: "direct" });
    expect(from("")).toEqual({ sourceGroup: "direct" });
    expect(from("android-app://com.slack/")).toEqual({ sourceGroup: "direct" });
    expect(from("https://mezonas.com/terms")).toEqual({
      sourceGroup: "internal",
      referrerHost: "mezonas.com",
    });
    expect(from("https://app.mezonas.com/desk")).toMatchObject({ sourceGroup: "internal" });
  });

  it("knows the search engines, Google in every country, and the social networks", () => {
    expect(from("https://www.google.co.uk/")).toMatchObject({
      sourceGroup: "search",
      sourceName: "google",
    });
    expect(from("https://www.google.com/search?q=back+office+agents")).toMatchObject({
      sourceGroup: "search",
      sourceName: "google",
    });
    expect(from("https://www.bing.com/")).toMatchObject({
      sourceGroup: "search",
      sourceName: "bing",
    });
    expect(from("https://duckduckgo.com/")).toMatchObject({ sourceName: "duckduckgo" });
    expect(from("https://www.linkedin.com/feed/")).toEqual({
      sourceGroup: "social",
      sourceName: "linkedin",
      referrerHost: "linkedin.com",
    });
    expect(from("https://t.co/abc")).toMatchObject({ sourceGroup: "social", sourceName: "x" });
    // Not Google: a site whose name merely contains it.
    expect(from("https://notgoogle.dev/")).toMatchObject({ sourceGroup: "referral" });
  });

  it("keeps another site's host and path, never its query", () => {
    expect(from("https://news.ycombinator.com/item?id=41987123")).toEqual({
      sourceGroup: "referral",
      sourceName: "news.ycombinator.com",
      referrerHost: "news.ycombinator.com",
      referrerPath: "/item",
    });
    expect(from("https://news.ycombinator.com/")).not.toHaveProperty("referrerPath");
  });

  it("lets campaign tags win over the referrer, named by the campaign", () => {
    expect(
      from(
        "https://www.linkedin.com/",
        "?utm_source=linkedin&utm_medium=social&utm_campaign=oct20",
      ),
    ).toEqual({
      sourceGroup: "campaign",
      sourceName: "oct20",
      referrerHost: "linkedin.com",
      utmSource: "linkedin",
      utmMedium: "social",
      utmCampaign: "oct20",
    });
    expect(from(undefined, "?utm_source=newsletter")).toMatchObject({
      sourceGroup: "campaign",
      sourceName: "newsletter",
    });
  });
});

describe("what a reader reads with", () => {
  it("tells phone, tablet and computer from the user agent alone", () => {
    const of = (ua: string) => deviceOf(ua);
    expect(
      of(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
      ),
    ).toBe("phone");
    expect(of("Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/141.0 Mobile Safari/537.36")).toBe(
      "phone",
    );
    expect(of("Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15")).toBe("tablet");
    expect(of("Mozilla/5.0 (Linux; Android 15; SM-X910) Chrome/141.0 Safari/537.36")).toBe(
      "tablet",
    );
    expect(of("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/141.0")).toBe("desktop");
    expect(of("")).toBe("desktop");
  });

  it("takes the first language from the request, and none it cannot read", () => {
    expect(languageOf("en-GB,en;q=0.9,fr;q=0.8")).toBe("en-GB");
    expect(languageOf("de")).toBe("de");
    expect(languageOf("*")).toBeUndefined();
    expect(languageOf("not a language")).toBeUndefined();
    expect(languageOf(null)).toBeUndefined();
  });

  it("names browser and system families only", () => {
    const safariIos =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
    const edge =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 Edg/141.0";
    const firefoxLinux = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0";
    const chromeAndroid =
      "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36";
    expect([browserOf(safariIos), osOf(safariIos)]).toEqual(["Safari", "iOS"]);
    expect([browserOf(edge), osOf(edge)]).toEqual(["Edge", "Windows"]);
    expect([browserOf(firefoxLinux), osOf(firefoxLinux)]).toEqual(["Firefox", "Linux"]);
    expect([browserOf(chromeAndroid), osOf(chromeAndroid)]).toEqual(["Chrome", "Android"]);
  });

  it("tells crawlers and scripts from browsers", () => {
    for (const ua of [
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      "curl/8.7.1",
      "python-requests/2.32",
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2)",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 HeadlessChrome/141.0 Safari/537.36",
      "",
    ]) {
      expect({ ua, bot: isBotAgent(ua) }).toEqual({ ua, bot: true });
    }
    expect(
      isBotAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/141.0 Safari/537.36",
      ),
    ).toBe(false);
  });

  it("places a visitor without the address, and not on Tor or nowhere", () => {
    expect(
      placeOf({ country: "CA", region: "Ontario", city: "Toronto", timezone: "America/Toronto" }),
    ).toEqual({
      country: "CA",
      region: "Ontario",
      city: "Toronto",
      timeZone: "America/Toronto",
    });
    expect(placeOf({ country: "T1" })).toEqual({});
    expect(placeOf({ country: "XX", city: "" })).toEqual({});
    expect(placeOf(undefined)).toEqual({});
  });
});

describe("a beacon", () => {
  const body = (events: unknown) => JSON.stringify({ events });

  it("takes each kind with its own fields", () => {
    expect(
      parseBeacon(
        body([
          { k: "view", id: ID, p: "/", q: "", r: "" },
          { k: "engage", id: ID, p: "/", ms: 1200, s: 2 },
          { k: "click", id: ID, p: "/", n: "nav-home", y: 0 },
          { k: "form_seen", id: ID, p: "/", f: "contact" },
        ]),
      ),
    ).toHaveLength(4);
  });

  it("refuses anything else whole", () => {
    for (const events of [
      [],
      [{ k: "signup", id: ID, p: "/", f: "contact" }],
      [{ k: "engage", id: ID, p: "/", ms: -1, s: 2 }],
      [{ k: "engage", id: ID, p: "/", ms: 1, s: 5 }],
      [{ k: "click", id: ID, p: "/", n: "nav-home", y: 101 }],
      [{ k: "view", id: ID, p: "https://mezonas.com/" }],
      [{ k: "view", id: ID, p: `/${"a".repeat(600)}` }],
    ]) {
      expect({ events, parsed: parseBeacon(body(events)) }).toEqual({ events, parsed: null });
    }
    expect(parseBeacon("{")).toBeNull();
    expect(parseBeacon(body([{ k: "view", id: ID, p: "/" }]).padEnd(20_000, " "))).toBeNull();
  });
});

describe("the events stored", () => {
  const context = {
    day: "2026-10-25",
    visit: "0123456789abcdef0123456789abcdef",
    at: "2026-10-25T12:00:00.000Z",
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/141.0 Safari/537.36",
    place: { country: "GB" },
    siteHost: SITE,
  };

  it("gives a view the visit's context, its device from the user agent, and nothing it was not given", () => {
    const [view] = toSiteEvents([{ k: "view", id: ID, p: "/" }], context);
    expect(view).toEqual({
      day: "2026-10-25",
      visit: context.visit,
      viewId: ID,
      at: context.at,
      path: "/",
      kind: "view",
      sourceGroup: "direct",
      country: "GB",
      device: "desktop",
      browser: "Chrome",
      os: "macOS",
    });
  });

  it("gives the other kinds their own fields and nothing of the visitor", () => {
    expect(
      toSiteEvents([{ k: "click", id: ID, p: "/use-cases", n: "nav-home", y: 2 }], context),
    ).toEqual([
      {
        day: "2026-10-25",
        visit: context.visit,
        viewId: ID,
        at: context.at,
        path: "/use-cases",
        kind: "click",
        target: "nav-home",
        position: 2,
      },
    ]);
  });
});

describe("the visit hash", () => {
  it("is the same for one browser on one salt, and another on another salt or address", async () => {
    const one = await visitHash("a".repeat(64), "203.0.113.7", "UA");
    expect(one).toMatch(/^[0-9a-f]{32}$/);
    expect(await visitHash("a".repeat(64), "203.0.113.7", "UA")).toBe(one);
    expect(await visitHash("b".repeat(64), "203.0.113.7", "UA")).not.toBe(one);
    expect(await visitHash("a".repeat(64), "203.0.113.8", "UA")).not.toBe(one);
  });
});
