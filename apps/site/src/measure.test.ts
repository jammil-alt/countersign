// Measuring mezonas.com (docs/plan.md §1.72, the "Site:" rows): off unless the build is given
// the collector's address, and then byte for byte the same site plus the script, the `data-track`
// names and /no-measure. The script itself runs here in a sandbox with a stub browser.

import { webcrypto } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { runInNewContext } from "node:vm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build, measureScript, measureUrlOf, TRACK_NAME } from "../build.mjs";

type Page = ReturnType<typeof build>[number];

const URL_ON =
  "https://collect.mezonas.com/api/in/marketing/0b7c4a52-0d3f-4f43-9d9b-3f1d2c3b4a5e/9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
const NOW = new Date("2026-11-05T12:00:00Z");

let offDir: string;
let onDir: string;
let off: Page[];
let on: Page[];

beforeAll(() => {
  offDir = mkdtempSync(join(tmpdir(), "mezonas-site-off-"));
  onDir = mkdtempSync(join(tmpdir(), "mezonas-site-on-"));
  off = build(offDir, NOW);
  on = build(onDir, NOW, { measureUrl: URL_ON, requirePolicy: false });
});

afterAll(() => {
  rmSync(offDir, { recursive: true, force: true });
  rmSync(onDir, { recursive: true, force: true });
});

function files(root: string, dir = root): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(root, path) : [relative(root, path)];
  });
}

const page = (pages: Page[], name: string) => {
  const p = pages.find((x) => x.name === name);
  if (!p) throw new Error(`no page ${name}`);
  return p;
};

/** What measuring adds to a page, taken out again. */
const withoutMeasuring = (html: string) =>
  html
    .replace(/\n {4}<script>\n[\s\S]*?\n<\/script>/, "")
    .replace(/\n {10}<a href="\/no-measure"[^\n]*/, "")
    .replace(/ data-track="[^"]*"/g, "");

describe("the collector's address", () => {
  it("is off when unset or empty", () => {
    expect(measureUrlOf(undefined)).toBeNull();
    expect(measureUrlOf(null)).toBeNull();
    expect(measureUrlOf("  ")).toBeNull();
  });

  it("takes an https address, or http for a local collector", () => {
    expect(measureUrlOf(URL_ON)).toBe(URL_ON);
    expect(measureUrlOf("http://localhost:8787/api/in/marketing/a/b")).toBe(
      "http://localhost:8787/api/in/marketing/a/b",
    );
  });

  it.each([
    "collect.mezonas.com/e",
    "http://collect.mezonas.com/e",
    "https://collect.mezonas.com/e?x=1",
    "https://collect.mezonas.com/e#x",
    "https://user:pw@collect.mezonas.com/e",
    "javascript:alert(1)",
  ])("refuses %s, failing the build", (value) => {
    expect(() => measureUrlOf(value)).toThrow(/MEZONAS_MEASURE_URL/);
  });

  it("goes into the script as a JSON string that cannot close the element", () => {
    const script = measureScript("https://collect.mezonas.com/e</script><b>");
    expect(script).toContain('"https://collect.mezonas.com/e\\u003c/script>\\u003cb>"');
    expect(script.match(/<\/script>/g)).toHaveLength(1);
    expect(script).not.toContain("__MEASURE_URL__");
    // The file's header comment is not inlined.
    expect(script).not.toContain("build.mjs inlines it");
  });
});

describe("measuring off (as deployed)", () => {
  it("adds no script, no data-track name and no /no-measure", () => {
    for (const p of off) {
      expect(p.html, p.name).not.toContain("<script");
      expect(p.html, p.name).not.toContain("data-track");
      expect(p.html, p.name).not.toContain("/no-measure");
      expect(p.tracks).toEqual([]);
    }
    expect(off.map((p) => p.name)).not.toContain("no-measure");
    expect(files(offDir)).not.toContain("no-measure.html");
  });

  it("is the measuring build with measuring taken out, byte for byte", () => {
    // Today's output is the off build (checked against main's build when this was written;
    // docs/plan.md §1.72 "Site:"); this holds the two builds together from here on.
    const offFiles = files(offDir).sort();
    expect(files(onDir).sort()).toEqual([...offFiles, "no-measure.html"].sort());
    for (const file of offFiles) {
      const a = readFileSync(join(offDir, file));
      const b = readFileSync(join(onDir, file));
      if (file.endsWith(".html")) expect(withoutMeasuring(b.toString()), file).toBe(a.toString());
      else expect(b.equals(a), file).toBe(true);
    }
  });
});

describe("measuring on", () => {
  it("refuses to build while the privacy policy says the site has no analytics", () => {
    const dir = mkdtempSync(join(tmpdir(), "mezonas-site-refused-"));
    try {
      expect(() => build(dir, NOW, { measureUrl: URL_ON })).toThrow(/privacy policy/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("inlines the script once on every page but /no-measure", () => {
    for (const p of on) {
      const scripts = p.html.match(/<script>/g) ?? [];
      expect(scripts.length, p.name).toBe(p.name === "no-measure" ? 0 : 1);
      if (p.name !== "no-measure") expect(p.html).toContain(JSON.stringify(URL_ON));
    }
  });

  it("builds /no-measure, linked from every footer, not indexed and not in the sitemap", () => {
    const nm = page(on, "no-measure");
    expect(nm.html).toContain('<meta name="robots" content="noindex">');
    expect(nm.html.match(/<h1[\s>]/g)).toHaveLength(1);
    const text = nm.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(text).toContain("Global Privacy Control");
    expect(text).toContain("Do Not Track");
    expect(text).toMatch(/No cookies, and nothing stored in your browser/);
    expect(text).not.toContain("!");
    for (const p of on) {
      const footer = p.html.slice(p.html.indexOf("<footer"));
      expect(footer, p.name).toContain('href="/no-measure"');
    }
    expect(readFileSync(join(onDir, "sitemap.xml"), "utf8")).not.toContain("no-measure");
  });
});

describe("data-track names", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  /** The names the README's "Tracked names" table lists. */
  const listed = () => {
    const section = readme.slice(readme.indexOf("### Tracked names"));
    const table = section.slice(0, section.indexOf("\n\n", section.indexOf("|")));
    return new Set([...table.matchAll(/^\| `([a-z0-9-]+)` \|/gm)].map((m) => m[1] ?? ""));
  };

  it("are valid and unique on each page", () => {
    for (const p of on) {
      for (const name of p.tracks) expect(name, p.name).toMatch(TRACK_NAME);
      expect(new Set(p.tracks).size, p.name).toBe(p.tracks.length);
    }
  });

  it("name every link and button on the landing page", () => {
    const { html } = page(on, "index");
    for (const [tag] of html.matchAll(/<(a|button)\s[^>]*>/g)) {
      if (/aria-hidden|class="skip-link"/.test(tag)) continue;
      expect(tag).toMatch(/ data-track="/);
    }
    for (const name of ["hero-talk", "hero-how", "contact-email", "nav-how-it-works"]) {
      expect(page(on, "index").tracks).toContain(name);
    }
    expect(page(on, "index").tracks.filter((t) => t.startsWith("policies-"))).toHaveLength(4);
  });

  it("are each listed in the README, and the README lists no name the site lacks", () => {
    const names = new Set(on.flatMap((p) => p.tracks));
    const inReadme = listed();
    for (const name of names) expect(inReadme.has(name), name).toBe(true);
    for (const name of inReadme) expect(names.has(name), name).toBe(true);
  });
});

/** A stub browser, enough for the script: records what it sends and the listeners it adds. */
function browser(options: { dnt?: string; gpc?: boolean; beacon?: boolean } = {}) {
  const sent: { url: string; body: string }[] = [];
  const fetched: { url: string; init: Record<string, unknown> }[] = [];
  const listeners: Record<string, ((event: unknown) => void)[]> = {};
  const listen = (type: string, fn: (event: unknown) => void) => {
    listeners[type] ??= [];
    listeners[type]?.push(fn);
  };
  class Element {
    constructor(
      private name: string | null,
      public parentElement: Element | null = null,
    ) {}
    closest() {
      return this.name ? this : null;
    }
    getAttribute() {
      return this.name;
    }
    getBoundingClientRect() {
      return { top: 600 };
    }
  }
  const body = {};
  const document = {
    referrer: "https://www.google.com/",
    visibilityState: "visible",
    body,
    documentElement: { scrollHeight: 2000 },
    addEventListener: listen,
    querySelectorAll: () => [],
  };
  const context = {
    navigator: {
      doNotTrack: options.dnt ?? "unspecified",
      globalPrivacyControl: options.gpc ?? false,
      sendBeacon:
        options.beacon === false
          ? undefined
          : (url: string, data: string) => {
              sent.push({ url, body: data });
              return true;
            },
    },
    location: { pathname: "/", search: "?utm_source=linkedin" },
    document,
    window: { addEventListener: listen, scrollY: 0, innerHeight: 1000 },
    crypto: webcrypto,
    Element,
    getComputedStyle: () => ({ position: "static" }),
    setInterval: () => 0,
    fetch: (url: string, init: Record<string, unknown>) => {
      fetched.push({ url, init });
      return Promise.resolve();
    },
    Date,
    Math,
    JSON,
    Set,
    Array,
    Uint8Array,
  };
  const run = () =>
    runInNewContext(measureScript(URL_ON).replace(/^<script>|<\/script>$/g, ""), context);
  const fire = (type: string, event: unknown = {}) => {
    for (const fn of listeners[type] ?? []) fn(event);
  };
  const events = () => sent.flatMap((s) => JSON.parse(s.body).events as Record<string, unknown>[]);
  return { run, fire, sent, fetched, events, Element, document };
}

describe("the page's script", () => {
  it("sends nothing at all with Do Not Track or Global Privacy Control", () => {
    for (const options of [{ dnt: "1" }, { gpc: true }]) {
      const b = browser(options);
      b.run();
      b.fire("click", { target: new b.Element("hero-talk") });
      b.fire("pagehide");
      expect(b.sent).toEqual([]);
      expect(b.fetched).toEqual([]);
    }
  });

  it("sends a view to the collector, as text, with the path, tags and referrer", () => {
    const b = browser();
    b.run();
    expect(b.sent).toHaveLength(1);
    expect(b.sent[0]?.url).toBe(URL_ON);
    expect(typeof b.sent[0]?.body).toBe("string");
    const [view] = b.events();
    expect(view).toMatchObject({
      k: "view",
      p: "/",
      q: "?utm_source=linkedin",
      r: "https://www.google.com/",
    });
    expect(view?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(view).not.toHaveProperty("wd");
  });

  it("sends a tracked click with its name and place, and ignores untracked ones", () => {
    const b = browser();
    b.run();
    b.fire("click", { target: new b.Element(null) });
    b.fire("click", { target: new b.Element("hero-talk") });
    const clicks = b.events().filter((e) => e.k === "click");
    expect(clicks).toHaveLength(1);
    expect(clicks[0]).toMatchObject({ k: "click", p: "/", n: "hero-talk", y: 30 });
  });

  it("sends engagement with the scroll quarter when the page is left, once if nothing changed", () => {
    const b = browser();
    b.run();
    b.fire("pagehide");
    b.fire("pagehide");
    const engaged = b.events().filter((e) => e.k === "engage");
    expect(engaged).toHaveLength(1);
    expect(engaged[0]).toMatchObject({ k: "engage", p: "/", s: 2 });
    const [view] = b.events();
    expect(engaged[0]?.id).toBe(view?.id);
  });

  it("falls back to fetch with no credentials when there is no sendBeacon", () => {
    const b = browser({ beacon: false });
    b.run();
    expect(b.fetched).toHaveLength(1);
    expect(b.fetched[0]?.url).toBe(URL_ON);
    expect(b.fetched[0]?.init).toMatchObject({
      method: "POST",
      keepalive: true,
      credentials: "omit",
      mode: "no-cors",
    });
  });

  it("stores nothing in the browser and sets no cookie", () => {
    const code = readFileSync(new URL("./measure.js", import.meta.url), "utf8").replace(
      /^\/\*[\s\S]*?\*\/\n/,
      "",
    );
    expect(code).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|caches/);
  });
});
