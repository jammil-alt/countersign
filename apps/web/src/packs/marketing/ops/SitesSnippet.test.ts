// The snippet a site owner pastes (M44): one script tag, the site's own address in it and nothing
// that can close the tag; run on a page, it reports a view and a tracked click in the collector's
// shape to that address, and nothing at all for a reader who asked not to be measured.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beaconUrl, siteSnippet } from "./SitesSnippet";

const CLIENT = "00000000-0000-4000-8000-00000000a011";
const SITE = "00000000-0000-4000-8000-00000000b022";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const codeOf = (snippet: string) =>
  snippet.replace(/^[\s\S]*<script>\n/, "").replace(/\n<\/script>$/, "");

describe("the site snippet", () => {
  let sent: { url: string; body: unknown }[];
  const eventOf = (i: number) =>
    (sent[i]?.body as { events: Record<string, unknown>[] } | undefined)?.events[0];
  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    Object.defineProperty(navigator, "sendBeacon", {
      configurable: true,
      value: (url: string, body: string) => {
        sent.push({ url, body: JSON.parse(body) });
        return true;
      },
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(navigator, "globalPrivacyControl", {
      configurable: true,
      value: undefined,
    });
    document.body.innerHTML = "";
  });

  it("is one script tag posting to the client's site on our origin", () => {
    const s = siteSnippet({ origin: "https://app.mezonas.com/", clientId: CLIENT, siteId: SITE });
    expect(beaconUrl("https://app.mezonas.com/", CLIENT, SITE)).toBe(
      `https://app.mezonas.com/api/in/marketing/${CLIENT}/${SITE}`,
    );
    // Counted as text: the snippet writes its tags exactly so.
    const count = (text: string, tag: string) => text.split(tag).length - 1;
    expect(count(s, "<script>")).toBe(1);
    expect(count(s, "</script>")).toBe(1);
    expect(s).toContain(`"https://app.mezonas.com/api/in/marketing/${CLIENT}/${SITE}"`);
    expect(s).not.toMatch(/document\.cookie|localStorage\.setItem/);
    // An origin with markup in it can't close the tag.
    const odd = siteSnippet({ origin: "https://x</script><b>", clientId: CLIENT, siteId: SITE });
    expect(count(odd, "</script>")).toBe(1);
  });

  it("reports a view, then a tracked click, in the collector's shape", () => {
    document.body.innerHTML = `<a href="#" data-track="hero-talk">Talk to us</a>`;
    new Function(
      codeOf(siteSnippet({ origin: "https://app.mezonas.com", clientId: CLIENT, siteId: SITE })),
    )();
    expect(sent).toHaveLength(1);
    const [view] = sent;
    expect(view?.url).toBe(beaconUrl("https://app.mezonas.com", CLIENT, SITE));
    const event = eventOf(0);
    expect(event).toMatchObject({ k: "view", p: "/" });
    expect(String(event?.id)).toMatch(UUID);

    document.querySelector("a")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const click = eventOf(1);
    expect(click).toMatchObject({ k: "click", id: event?.id, p: "/", n: "hero-talk" });
    expect(click?.y).toBeGreaterThanOrEqual(0);

    window.dispatchEvent(new Event("pagehide"));
    const engage = eventOf(2);
    expect(engage).toMatchObject({ k: "engage", id: event?.id, s: expect.any(Number) });
  });

  it("reports nothing for a reader who sends Global Privacy Control", () => {
    Object.defineProperty(navigator, "globalPrivacyControl", { configurable: true, value: true });
    new Function(
      codeOf(siteSnippet({ origin: "https://app.mezonas.com", clientId: CLIENT, siteId: SITE })),
    )();
    expect(sent).toEqual([]);
  });
});
