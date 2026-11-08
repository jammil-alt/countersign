// The site Worker (src/worker.ts): with guides off (as deployed) every path it runs for answers
// exactly as the static files do; with the bucket bound and SITE_GUIDES on, it serves guides from
// R2 in the site's layout and adds them to the sitemap.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "../build.mjs";
import {
  type ContentBucket,
  DOMAIN,
  type Env,
  isWorkerPath,
  parseGuide,
  parseRedirects,
  parseSitemap,
} from "./guides";
import * as entry from "./worker";

const worker = entry.default;

const NOW = new Date("2026-11-05T12:00:00Z");
const URL_ON = "https://collect.mezonas.com/api/in/marketing/a/b";
let offDir: string;
let onDir: string;

beforeAll(() => {
  offDir = mkdtempSync(join(tmpdir(), "mezonas-worker-off-"));
  onDir = mkdtempSync(join(tmpdir(), "mezonas-worker-on-"));
  build(offDir, NOW);
  build(onDir, NOW, { measureUrl: URL_ON, requirePolicy: false });
});

afterAll(() => {
  rmSync(offDir, { recursive: true, force: true });
  rmSync(onDir, { recursive: true, force: true });
});

/** The assets binding as wrangler.jsonc sets it up: auto-trailing-slash and the 404 page. */
function assets(dir: string) {
  const types: Record<string, string> = {
    html: "text/html; charset=utf-8",
    xml: "application/xml",
    txt: "text/plain",
  };
  const asked: string[] = [];
  return {
    asked,
    async fetch(request: Request): Promise<Response> {
      const { pathname } = new URL(request.url);
      asked.push(pathname);
      const candidates =
        pathname === "/" ? ["index.html"] : [pathname.slice(1), `${pathname.slice(1)}.html`];
      const file = candidates.find((f) => /\.[a-z0-9]+$/.test(f) && existsSync(join(dir, f)));
      const status = file ? 200 : 404;
      const name = file ?? "404.html";
      const body = request.method === "HEAD" ? null : readFileSync(join(dir, name));
      return new Response(body, {
        status,
        headers: {
          "content-type": types[name.split(".").pop() ?? ""] ?? "application/octet-stream",
        },
      });
    },
  };
}

function bucket(objects: Record<string, unknown>, options: { fail?: boolean } = {}) {
  const read: string[] = [];
  const b: ContentBucket = {
    async get(key) {
      read.push(key);
      if (options.fail) throw new Error("R2 is down");
      const value = objects[key];
      if (value === undefined) return null;
      return { text: async () => (typeof value === "string" ? value : JSON.stringify(value)) };
    },
  };
  return { bucket: b, read };
}

const key = (rest: string) => `site/${DOMAIN}/${rest}`;
const GUIDE = {
  title: "Matching vendor bills to invoices",
  description:
    "How to check each bill against its invoice before it is paid, and what to do when they differ.",
  html: "<h2>Why it matters</h2>\n<p>A bill paid twice costs $&amp; more than you think.</p>",
  publishedAt: "2026-11-06T09:30:00Z",
};
const OBJECTS = {
  [key("guides/matching-bills.json")]: GUIDE,
  [key("guides/older-guide.json")]: {
    ...GUIDE,
    title: "An older guide",
    publishedAt: "2026-10-01T00:00:00Z",
  },
  [key("sitemap.json")]: {
    updatedAt: "2026-11-06T09:30:00Z",
    urls: [
      { path: "/guides/older-guide", lastmod: "2026-10-01" },
      { path: "/guides/matching-bills", lastmod: "2026-11-06" },
      { path: "/guides/Not-A-Slug", lastmod: "2026-11-06" },
      { path: "/terms", lastmod: "2026-11-06" },
    ],
  },
  [key("redirects.json")]: [
    { from: "/guides/old-name", to: "/guides/matching-bills" },
    { from: "/guides/elsewhere", to: "https://example.com/" },
  ],
};

async function get(env: Env, path: string, method = "GET") {
  const response = await worker.fetch(new Request(`https://mezonas.com${path}`, { method }), env);
  return { response, body: method === "HEAD" ? "" : await response.text() };
}

const PATHS = ["/guides", "/guides/", "/guides/matching-bills", "/guides/../x", "/sitemap.xml"];

describe("guides off", () => {
  it.each([
    ["no bucket, no switch", {}],
    ["the bucket without the switch", { SITE_CONTENT: bucket(OBJECTS).bucket }],
    ["the switch without the bucket", { SITE_GUIDES: "on" }],
    [
      "the bucket with the switch not on",
      { SITE_CONTENT: bucket(OBJECTS).bucket, SITE_GUIDES: "yes" },
    ],
  ])("with %s, answers as the static files do", async (_, extra) => {
    for (const path of PATHS) {
      const a = assets(offDir);
      const env = { ASSETS: a, ...extra } as Env;
      const { response, body } = await get(env, path);
      const direct = await assets(offDir).fetch(new Request(`https://mezonas.com${path}`));
      expect(response.status, path).toBe(direct.status);
      expect(body, path).toBe(await direct.text());
      // The request went to the assets unchanged, once.
      expect(a.asked).toHaveLength(1);
    }
  });

  it("answers /guides with the 404 page and /sitemap.xml with the static sitemap", async () => {
    const env = { ASSETS: assets(offDir) } as Env;
    const guides = await get(env, "/guides/matching-bills");
    expect(guides.response.status).toBe(404);
    expect(guides.body).toBe(readFileSync(join(offDir, "404.html"), "utf8"));
    const sitemap = await get(env, "/sitemap.xml");
    expect(sitemap.body).toBe(readFileSync(join(offDir, "sitemap.xml"), "utf8"));
  });

  it("never reads the bucket", async () => {
    const b = bucket(OBJECTS);
    await get({ ASSETS: assets(offDir), SITE_CONTENT: b.bucket } as Env, "/guides/matching-bills");
    expect(b.read).toEqual([]);
  });
});

describe("guides on", () => {
  const on = (dir = offDir, objects: Record<string, unknown> = OBJECTS, options = {}) => {
    const b = bucket(objects, options);
    return {
      env: { ASSETS: assets(dir), SITE_CONTENT: b.bucket, SITE_GUIDES: "on" } as Env,
      read: b.read,
    };
  };

  it("serves a guide in the site's layout", async () => {
    const { response, body } = await get(on().env, "/guides/matching-bills");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(body).toMatch(/^<!doctype html>\n<html lang="en">/);
    expect(body).toContain("<title>Matching vendor bills to invoices · Mezonas</title>");
    expect(body).toContain(`<meta name="description" content="${GUIDE.description}">`);
    expect(body).toContain(
      '<link rel="canonical" href="https://mezonas.com/guides/matching-bills">',
    );
    expect(body).toContain('<meta property="og:type" content="article">');
    expect(body).not.toContain("noindex");
    expect(body).not.toContain("We couldn't find that page.");
    for (const tag of ["<header", '<main id="main"', "<footer", 'href="/site.css"']) {
      expect(body).toContain(tag);
    }
    expect(body.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(body).toContain("<h1>Matching vendor bills to invoices</h1>");
    // `$&` in the body is kept as written, not read as a replacement pattern.
    expect(body).toContain("costs $&amp; more");
    expect(body).toContain('<time datetime="2026-11-06">November 6, 2026</time>');
    const data = /<script type="application\/ld\+json">(.*?)<\/script>/.exec(body)?.[1] ?? "";
    expect(JSON.parse(data)).toMatchObject({ "@type": "Article", headline: GUIDE.title });
  });

  it("uses the body's own h1 when it has one", async () => {
    const objects = {
      ...OBJECTS,
      [key("guides/matching-bills.json")]: {
        ...GUIDE,
        html: "<h1>Its own heading</h1><p>Text.</p>",
      },
    };
    const { body } = await get(on(offDir, objects).env, "/guides/matching-bills");
    expect(body.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(body).toContain("<h1>Its own heading</h1>");
  });

  it("escapes the title and description it writes around the body", async () => {
    const objects = {
      ...OBJECTS,
      [key("guides/matching-bills.json")]: {
        ...GUIDE,
        title: 'Bills <b>"two"</b>',
        description: "A & B <i>",
      },
    };
    const { body } = await get(on(offDir, objects).env, "/guides/matching-bills");
    expect(body).toContain("<title>Bills &lt;b&gt;&quot;two&quot;&lt;/b&gt; · Mezonas</title>");
    expect(body).toContain('content="A &amp; B &lt;i&gt;"');
    expect(body).not.toContain("<b>");
  });

  it("carries the measuring script and track names only when the build measures", async () => {
    const offPage = (await get(on(offDir).env, "/guides/matching-bills")).body;
    expect(offPage).not.toContain("data-track");
    expect(offPage).not.toContain("<script>");
    const onPage = (await get(on(onDir).env, "/guides/matching-bills")).body;
    expect(onPage).toContain(JSON.stringify(URL_ON));
    expect(onPage).toContain('data-track="guide-all"');
    const names = [...onPage.matchAll(/ data-track="([^"]*)"/g)].map((m) => m[1]);
    expect(new Set(names).size).toBe(names.length);
  });

  it.each([
    ["a script", "<p>Hi</p><script>alert(1)</script>"],
    ["an event handler", '<p onclick="x()">Hi</p>'],
    ["a script address", '<a href="javascript:alert(1)">x</a>'],
    ["a frame", '<iframe src="https://example.com"></iframe>'],
    ["a style", "<style>body{display:none}</style>"],
  ])("refuses a body with %s, as if it were missing", async (_, html) => {
    const objects = { ...OBJECTS, [key("guides/matching-bills.json")]: { ...GUIDE, html } };
    const { response, body } = await get(on(offDir, objects).env, "/guides/matching-bills");
    expect(response.status).toBe(404);
    expect(body).toBe(readFileSync(join(offDir, "404.html"), "utf8"));
  });

  it("answers the 404 page for a guide that is not there, a bad slug or bad JSON", async () => {
    const objects = { ...OBJECTS, [key("guides/broken.json")]: "{not json" };
    for (const path of ["/guides/missing", "/guides/Bad_Slug", "/guides/a/b", "/guides/broken"]) {
      const { response, body } = await get(on(offDir, objects).env, path);
      expect(response.status, path).toBe(404);
      expect(body, path).toBe(readFileSync(join(offDir, "404.html"), "utf8"));
    }
  });

  it("redirects a guide's old address, to our own site only", async () => {
    const moved = await get(on().env, "/guides/old-name");
    expect(moved.response.status).toBe(301);
    expect(moved.response.headers.get("location")).toBe(
      "https://mezonas.com/guides/matching-bills",
    );
    const elsewhere = await get(on().env, "/guides/elsewhere");
    expect(elsewhere.response.status).toBe(404);
  });

  it("lists the live guides on /guides, newest first", async () => {
    const { response, body } = await get(on().env, "/guides/");
    expect(response.status).toBe(200);
    expect(body).toContain("<title>Guides · Mezonas</title>");
    expect(body).toContain('<link rel="canonical" href="https://mezonas.com/guides">');
    expect(body.indexOf("/guides/matching-bills")).toBeLessThan(
      body.indexOf("/guides/older-guide"),
    );
    expect(body).not.toContain("Not-A-Slug");
    expect(body.match(/<h1[\s>]/g)).toHaveLength(1);
  });

  it("answers /guides with the 404 page when no guide is live", async () => {
    const { response } = await get(
      on(offDir, { [key("sitemap.json")]: { urls: [] } }).env,
      "/guides",
    );
    expect(response.status).toBe(404);
  });

  it("adds /guides and each live guide to the static sitemap", async () => {
    const { response, body } = await get(on().env, "/sitemap.xml");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    const staticMap = readFileSync(join(offDir, "sitemap.xml"), "utf8");
    for (const line of staticMap.split("\n").filter((l) => l.includes("<loc>"))) {
      expect(body).toContain(line);
    }
    expect(body).toContain(
      "<url><loc>https://mezonas.com/guides</loc><lastmod>2026-11-06</lastmod></url>",
    );
    expect(body).toContain(
      "<url><loc>https://mezonas.com/guides/matching-bills</loc><lastmod>2026-11-06</lastmod></url>",
    );
    expect(body).not.toContain("Not-A-Slug");
    expect(body.trim().endsWith("</urlset>")).toBe(true);
  });

  it("keeps the static sitemap and answers 503 for a guide when R2 fails", async () => {
    const { env } = on(offDir, OBJECTS, { fail: true });
    const sitemap = await get(env, "/sitemap.xml");
    expect(sitemap.response.status).toBe(200);
    expect(sitemap.body).toBe(readFileSync(join(offDir, "sitemap.xml"), "utf8"));
    const guide = await get(env, "/guides/matching-bills");
    expect(guide.response.status).toBe(503);
    expect(guide.response.headers.get("retry-after")).toBe("60");
  });

  it("hands anything but GET and HEAD to the static files, and answers HEAD with no body", async () => {
    const { env, read } = on();
    const post = await worker.fetch(
      new Request("https://mezonas.com/guides/matching-bills", { method: "POST" }),
      env,
    );
    expect(post.status).toBe(404);
    expect(read).toEqual([]);
    const head = await get(env, "/guides/matching-bills", "HEAD");
    expect(head.response.status).toBe(200);
    expect(head.response.body).toBeNull();
  });

  it("reads only this site's keys", async () => {
    const { env, read } = on();
    await get(env, "/guides/matching-bills");
    await get(env, "/guides");
    for (const k of read) expect(k.startsWith("site/mezonas.com/")).toBe(true);
  });
});

describe("parsers", () => {
  it("checks a guide field by field", () => {
    expect(parseGuide(JSON.stringify(GUIDE))).toEqual(GUIDE);
    expect(parseGuide(JSON.stringify({ ...GUIDE, title: "" }))).toBeNull();
    expect(parseGuide(JSON.stringify({ ...GUIDE, publishedAt: "yesterday" }))).toBeNull();
    expect(parseGuide(JSON.stringify({ ...GUIDE, html: 42 }))).toBeNull();
    // Prose that mentions data: or on= is not active content.
    expect(
      parseGuide(
        JSON.stringify({ ...GUIDE, html: "<p>Your data: invoices; pay once = save.</p>" }),
      ),
    ).not.toBeNull();
  });

  it("reads only guide paths from the sitemap", () => {
    expect(parseSitemap(JSON.stringify(OBJECTS[key("sitemap.json")]))?.map((g) => g.slug)).toEqual([
      "matching-bills",
      "older-guide",
    ]);
    expect(parseSitemap("nope")).toBeNull();
  });

  it("keeps only same-site redirects from guide paths", () => {
    const redirects = parseRedirects(
      JSON.stringify([
        { from: "/guides/a", to: "/guides/b" },
        { from: "/guides/c/", to: "/" },
        { from: "/terms", to: "/privacy" },
        { from: "/guides/d", to: "//evil.example" },
        { from: "/guides/e", to: "https://evil.example" },
      ]),
    );
    expect([...redirects]).toEqual([
      ["/guides/a", "/guides/b"],
      ["/guides/c", "/"],
    ]);
  });
});

describe("wrangler.jsonc", () => {
  const config = JSON.parse(
    readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")
      .split("\n")
      .filter((line) => !/^\s*\/\//.test(line))
      .join("\n"),
  );

  it("has a main module that exports only its handler (workerd refuses any other export)", () => {
    expect(Object.keys(entry)).toEqual(["default"]);
    expect(typeof worker.fetch).toBe("function");
  });

  it("runs the Worker first only for the guides and the sitemap", () => {
    expect(config.main).toBe("src/worker.ts");
    expect(config.assets.binding).toBe("ASSETS");
    expect(config.assets.run_worker_first).toEqual(["/guides", "/guides/*", "/sitemap.xml"]);
    for (const path of ["/guides", "/guides/x", "/sitemap.xml"])
      expect(isWorkerPath(path)).toBe(true);
    for (const path of ["/", "/terms", "/guidesx", "/robots.txt"])
      expect(isWorkerPath(path)).toBe(false);
  });

  it("binds no bucket and sets no switch: guides are the owner's to turn on", () => {
    expect(config.r2_buckets).toBeUndefined();
    expect(config.vars).toBeUndefined();
  });
});
