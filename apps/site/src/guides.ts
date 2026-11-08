/**
 * Guides and the sitemap, the site Worker's one job (docs/marketing-plan.md §4.5 and §11.4;
 * ported from Plenary Labs' `apps/site/src/{index,guides,chrome}.ts`, copied, not shared).
 * ./worker.ts is the Worker's entry and exports only its handler (a Worker's main module may
 * export nothing else); everything is here so it can be tested.
 *
 * Everything on mezonas.com is a static file, served by the assets binding before this code is
 * reached. The Worker runs first only for `/guides`, `/guides/*` and `/sitemap.xml`
 * (`run_worker_first` in wrangler.jsonc), and for those it does one of two things:
 *
 * - **Guides off** (no `SITE_CONTENT` bucket, or `SITE_GUIDES` is not `on`; as deployed today):
 *   hands the request to the assets, so the answer is exactly what it was with no code: the
 *   static sitemap, and the 404 page for any guide path.
 * - **Guides on**: serves the published guides from the bucket the platform's `website.publish`
 *   writes (`site/mezonas.com/guides/<slug>.json`, `site/mezonas.com/sitemap.json`,
 *   `site/mezonas.com/redirects.json`), wrapped in the site's own layout at serve time, and adds
 *   them to the sitemap. The layout is the built 404 page's: its header, footer, styles and (when
 *   the build measures) the measuring script, with the head and the main content replaced, so the
 *   layout has one source (src/layout.html) and a guide looks like every other page.
 *
 * The bucket is the published copy: if the platform's API or database is down, the guides are
 * still served. A guide's body arrives rendered and checked by the content checks; this code
 * escapes everything it writes around it and refuses a body with active content in it.
 * It imports nothing: the site has no runtime dependencies (scripts/check-deps.mjs).
 */

/** The parts of the Workers types this code uses (the site has no Workers types package). */
export interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}
export interface ContentObject {
  text(): Promise<string>;
}
export interface ContentBucket {
  get(key: string): Promise<ContentObject | null>;
}
export interface Env {
  ASSETS: AssetsBinding;
  /** The published guides (R2). Absent: guides are off. Added by the owner (apps/site/README.md). */
  SITE_CONTENT?: ContentBucket;
  /** `on` to serve guides from SITE_CONTENT; anything else is off. */
  SITE_GUIDES?: string;
}

export const ORIGIN = "https://mezonas.com";
/** The measured site's domain, as the bucket's keys name it (no `www.`). */
export const DOMAIN = "mezonas.com";
const PREFIX = `site/${DOMAIN}`;

/** A guide's address (`content_page.path` = `/guides/<slug>`). */
export const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_SLUG = 80;
/** At most this many guides are listed on /guides and in the sitemap. */
const MAX_GUIDES = 200;
const MAX_HTML = 512 * 1024;

/** A published guide, as `site/<domain>/guides/<slug>.json` holds it. */
export interface Guide {
  title: string;
  description: string;
  html: string;
  publishedAt: string;
}

const ISO = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2}))?$/;
const DATE = /^\d{4}-\d{2}-\d{2}/;

const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;

/**
 * Markup a guide's body must never carry: scripts, frames, embeds, forms, styles, anything that
 * changes the document's head, inline event handlers and script addresses. The content checks
 * produce none of these; this is the site's own check, in case something else wrote the bucket.
 */
const ACTIVE = [
  /<\s*\/?\s*(script|iframe|frame|frameset|object|embed|applet|form|input|button|textarea|select|style|link|meta|base|svg|math|template)\b/i,
  /<[^>]*\son[a-z]+\s*=/i,
  /<[^>]*\s(href|src|srcset|action|formaction|poster|background)\s*=\s*["']?\s*(javascript|vbscript|data):/i,
];

/** A guide's JSON, checked field by field; null for anything else. */
export function parseGuide(raw: string): Guide | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const g = value as Record<string, unknown>;
  if (!text(g.title, 200) || !text(g.description, 400) || !text(g.html, MAX_HTML)) return null;
  if (typeof g.publishedAt !== "string" || !ISO.test(g.publishedAt)) return null;
  if (Number.isNaN(Date.parse(g.publishedAt))) return null;
  const body = g.html;
  if (ACTIVE.some((pattern) => pattern.test(body))) return null;
  return { title: g.title, description: g.description, html: body, publishedAt: g.publishedAt };
}

/** The guides live now, from `sitemap.json`: their slugs and dates, newest first. */
export function parseSitemap(raw: string): { slug: string; lastmod: string }[] | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const urls = (value as { urls?: unknown } | null)?.urls;
  if (!Array.isArray(urls)) return null;
  const out: { slug: string; lastmod: string }[] = [];
  for (const entry of urls) {
    const path = (entry as { path?: unknown } | null)?.path;
    const lastmod = (entry as { lastmod?: unknown } | null)?.lastmod;
    if (typeof path !== "string" || !path.startsWith("/guides/")) continue;
    const slug = path.slice("/guides/".length);
    if (!SLUG.test(slug) || slug.length > MAX_SLUG || out.some((x) => x.slug === slug)) continue;
    out.push({
      slug,
      lastmod: typeof lastmod === "string" && DATE.test(lastmod) ? lastmod.slice(0, 10) : "",
    });
    if (out.length >= MAX_GUIDES) break;
  }
  return out.sort((a, b) => b.lastmod.localeCompare(a.lastmod) || a.slug.localeCompare(b.slug));
}

/** Redirects for guide paths, from `redirects.json`: same-site paths only. */
export function parseRedirects(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!Array.isArray(value)) return out;
  for (const entry of value) {
    const from = (entry as { from?: unknown } | null)?.from;
    const to = (entry as { to?: unknown } | null)?.to;
    if (typeof from !== "string" || typeof to !== "string") continue;
    if (!from.startsWith("/guides/") || !/^\/(?![/\\])[^\s]{0,511}$/.test(to)) continue;
    out.set(from.replace(/\/$/, ""), to);
  }
  return out;
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
/** JSON for a `<script>` block: `<` escaped so the data cannot close the element it sits in. */
const jsonScript = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");

const DAY = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

interface Head {
  title: string;
  description: string;
  canonical: string;
  type: "article" | "website";
  data?: unknown;
}

/**
 * The 404 page with its head and main content replaced. Throws when the template is not the
 * site's 404 page as build.mjs writes it, so a changed layout fails loudly, never half-wrapped.
 */
export function wrap(template: string, head: Head, main: string): string {
  let html = template;
  // A function as the replacement, so a `$` in a guide's text is never read as a pattern.
  const swap = (pattern: RegExp, value: string) => {
    if (!pattern.test(html)) throw new Error(`layout: no ${pattern.source}`);
    html = html.replace(pattern, () => value);
  };
  const title = `${escapeHtml(head.title)} · Mezonas`;
  const description = escapeHtml(head.description);
  swap(/<title>[^<]*<\/title>/, `<title>${title}</title>`);
  swap(
    /<meta name="description" content="[^"]*">/,
    `<meta name="description" content="${description}">`,
  );
  swap(/\n *<meta name="robots" content="noindex">/, "");
  swap(/<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${head.canonical}">`);
  swap(
    /<meta property="og:type" content="[^"]*">/,
    `<meta property="og:type" content="${head.type}">`,
  );
  swap(
    /<meta property="og:title" content="[^"]*">/,
    `<meta property="og:title" content="${title}">`,
  );
  swap(
    /<meta property="og:description" content="[^"]*">/,
    `<meta property="og:description" content="${description}">`,
  );
  swap(
    /<meta property="og:url" content="[^"]*">/,
    `<meta property="og:url" content="${head.canonical}">`,
  );
  if (head.data !== undefined) {
    swap(
      /\n {2}<\/head>/,
      `\n    <script type="application/ld+json">${jsonScript(head.data)}</script>\n  </head>`,
    );
  }
  swap(
    /<main id="main" tabindex="-1">[\s\S]*?\n {4}<\/main>/,
    `<main id="main" tabindex="-1">\n      ${main.trim()}\n    </main>`,
  );
  return html;
}

/** Whether the built site measures: its pages then carry `data-track` names. */
const measuring = (template: string) => template.includes(' data-track="');
const track = (on: boolean, name: string) => (on ? ` data-track="${name}"` : "");

/** One guide's page. Its own `<h1>`, if the body has one, is the page's heading. */
export function renderGuide(template: string, slug: string, guide: Guide): string {
  const on = measuring(template);
  const canonical = `${ORIGIN}/guides/${slug}`;
  const date = guide.publishedAt.slice(0, 10);
  const heading = /<h1[\s>]/i.test(guide.html) ? "" : `\n      <h1>${escapeHtml(guide.title)}</h1>`;
  const main = `<div class="wrap">
  <article class="doc">
    <header class="doc__head">
      <p class="eyebrow">Guide</p>${heading}
      <p class="doc__updated">Published <time datetime="${date}">${DAY.format(new Date(guide.publishedAt))}</time></p>
    </header>
    <p class="doc__intro">${escapeHtml(guide.description)}</p>
    <section aria-label="Guide">
${guide.html.trim()}
    </section>
    <p class="doc__intro"><a href="/guides"${track(on, "guide-all")}>All guides</a> · <a href="/#contact"${track(on, "guide-talk")}>Talk to us</a></p>
  </article>
</div>`;
  return wrap(
    template,
    {
      title: guide.title,
      description: guide.description,
      canonical,
      type: "article",
      data: {
        "@context": "https://schema.org",
        "@type": "Article",
        headline: guide.title,
        description: guide.description,
        mainEntityOfPage: canonical,
        datePublished: guide.publishedAt,
        author: { "@type": "Organization", name: "Mezonas", url: `${ORIGIN}/` },
        publisher: { "@type": "Organization", name: "Mezonas", url: `${ORIGIN}/` },
      },
    },
    main,
  );
}

/** The guides index; only rendered with at least one guide (an empty index is the 404 page). */
export function renderIndex(template: string, guides: { slug: string; guide: Guide }[]): string {
  const on = measuring(template);
  const cards = guides
    .map(
      ({ slug, guide }) => `      <li class="card">
        <h2><a href="/guides/${slug}"${track(on, `guides-${slug}`.slice(0, 64).replace(/-+$/, ""))}>${escapeHtml(guide.title)}</a></h2>
        <p>${escapeHtml(guide.description)}</p>
      </li>`,
    )
    .join("\n");
  const main = `<div class="wrap">
  <div class="doc doc--wide">
    <header class="doc__head">
      <p class="eyebrow">Guides</p>
      <h1>Guides</h1>
    </header>
    <p class="doc__intro">Plain guides to back-office work: what to automate, what to check and how we keep a person in charge.</p>
    <ul class="grid grid--2">
${cards}
    </ul>
  </div>
</div>`;
  return wrap(
    template,
    {
      title: "Guides",
      description:
        "Plain guides to back-office work from Mezonas: what to automate, what to check and how a person stays in charge.",
      canonical: `${ORIGIN}/guides`,
      type: "website",
    },
    main,
  );
}

/** The static sitemap with `/guides` and each live guide added, with its date. */
export function withGuides(sitemap: string, guides: { slug: string; lastmod: string }[]): string {
  if (guides.length === 0 || !sitemap.includes("</urlset>")) return sitemap;
  const lastmod = (date: string) => (date ? `<lastmod>${date}</lastmod>` : "");
  const newest =
    guides
      .map((g) => g.lastmod)
      .sort()
      .at(-1) ?? "";
  const entries = [
    `  <url><loc>${ORIGIN}/guides</loc>${lastmod(newest)}</url>\n`,
    ...guides.map(
      (g) => `  <url><loc>${ORIGIN}/guides/${g.slug}</loc>${lastmod(g.lastmod)}</url>\n`,
    ),
  ];
  return sitemap.replace("</urlset>", `${entries.join("")}</urlset>`);
}

const HTML = "text/html; charset=utf-8";
const html = (body: string) =>
  new Response(body, { headers: { "content-type": HTML, "cache-control": "public, max-age=300" } });
const unavailable = () =>
  new Response("This page is unavailable for a moment. Please try again shortly.", {
    status: 503,
    headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "60" },
  });

const guidesOn = (env: Env): env is Env & { SITE_CONTENT: ContentBucket } =>
  env.SITE_GUIDES === "on" && env.SITE_CONTENT !== undefined && env.SITE_CONTENT !== null;

async function read(bucket: ContentBucket, key: string): Promise<string | null> {
  const object = await bucket.get(`${PREFIX}/${key}`);
  return object === null ? null : object.text();
}

/** The built 404 page, the layout guides are wrapped in. */
async function layoutOf(env: Env, url: URL): Promise<string> {
  const answer = await env.ASSETS.fetch(new Request(new URL("/404", url), { method: "GET" }));
  return answer.text();
}

async function liveGuides(bucket: ContentBucket) {
  const raw = await read(bucket, "sitemap.json");
  return raw === null ? [] : (parseSitemap(raw) ?? []);
}

async function serveGuides(request: Request, env: Env & { SITE_CONTENT: ContentBucket }, url: URL) {
  const bucket = env.SITE_CONTENT;
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
  const notFound = () => env.ASSETS.fetch(request);

  if (path === "/sitemap.xml") {
    const sitemap = await env.ASSETS.fetch(request);
    if (!sitemap.ok) return sitemap;
    const body = await sitemap.text();
    const guides = await liveGuides(bucket).catch(() => []);
    return new Response(withGuides(body, guides), {
      headers: {
        "content-type": "application/xml; charset=utf-8",
        "cache-control": "public, max-age=3600",
      },
    });
  }

  try {
    if (path === "/guides") {
      const live = await liveGuides(bucket);
      const guides: { slug: string; guide: Guide }[] = [];
      for (const { slug } of live) {
        const raw = await read(bucket, `guides/${slug}.json`);
        const guide = raw === null ? null : parseGuide(raw);
        if (guide) guides.push({ slug, guide });
      }
      if (guides.length === 0) return notFound();
      return html(renderIndex(await layoutOf(env, url), guides));
    }

    if (!path.startsWith("/guides/")) return notFound();
    const slug = path.slice("/guides/".length);
    if (!SLUG.test(slug) || slug.length > MAX_SLUG) return notFound();
    const raw = await read(bucket, `guides/${slug}.json`);
    const guide = raw === null ? null : parseGuide(raw);
    if (guide === null) {
      const redirects = await read(bucket, "redirects.json");
      const to = redirects === null ? undefined : parseRedirects(redirects).get(path);
      if (to !== undefined) return Response.redirect(new URL(to, ORIGIN).toString(), 301);
      if (raw !== null) console.error("site: a published guide failed its checks", { slug });
      return notFound();
    }
    return html(renderGuide(await layoutOf(env, url), slug, guide));
  } catch (error) {
    console.error("site: guides unavailable", { error: String(error) });
    return unavailable();
  }
}

/** Is this one of the paths the Worker runs first for (wrangler.jsonc `run_worker_first`)? */
export const isWorkerPath = (pathname: string) =>
  pathname === "/sitemap.xml" || pathname === "/guides" || pathname.startsWith("/guides/");

/** The Worker's answer to any request it runs for. */
export async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const reading = request.method === "GET" || request.method === "HEAD";
  if (!reading || !isWorkerPath(url.pathname) || !guidesOn(env)) return env.ASSETS.fetch(request);
  const answer = await serveGuides(request, env, url);
  // HEAD: the same status and headers, no body.
  return request.method === "HEAD" ? new Response(null, answer) : answer;
}
