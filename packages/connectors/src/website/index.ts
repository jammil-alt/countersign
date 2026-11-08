import { z } from "zod";
import { type Connector, defineConnector, defineWriteTool, type ToolContext } from "../connector";
import { type FetchLike, globalFetch, timeoutSignal } from "../http";
import { fromUtf8, utf8 } from "../runtime";
import type { ObjectStore } from "../storage/object-store";

/**
 * "website": a client's own website, the guides the Marketing area publishes on it
 * (docs/marketing-plan.md §4.5, §11.4). No sign-in: the operator points the client's connection at
 * one of its measured sites (`connection.config.domain`, the Marketing pack's `set-website`), and
 * the connector writes only under that domain's prefix in Mezonas' own bucket, which the site's
 * Worker reads (`SITE_CONTENT`):
 *
 * - `site/<domain>/guides/<slug>.json`: `{ title, description, html, publishedAt }`, the fragment
 *   the site's layout wraps;
 * - `site/<domain>/sitemap.json`: `{ updatedAt, urls: [{ path, lastmod }] }`, the live guides;
 * - `site/<domain>/redirects.json`: `[{ from, to }]`.
 *
 * Both tools are changes a person always signs (`approval: 'always'`, docs/plan.md §1.73): no
 * matrix, grant, step or mode lets them run on their own. Nothing public changes on merge: without
 * the bucket (`store` unset, the SITE_CONTENT binding absent) every write is refused with
 * "publishing isn't set up", and IndexNow is pinged only when its key is set.
 */
export const WEBSITE_CONNECTOR_ID = "website";
export const WEBSITE_PUBLISH_TOOL = "website.publish";
export const WEBSITE_META_TOOL = "website.meta";

// The same limits as the Marketing pack's checks (packs/marketing/src/content/checks.ts), kept
// here too: the connector is the last wall before the public site.
export const WEBSITE_TITLE_MAX = 60;
export const WEBSITE_DESCRIPTION_MAX = 155;
export const WEBSITE_HTML_MAX = 400_000;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
const INDEXNOW_TIMEOUT_MS = 5_000;

/** A write the connection can't make as it is set up; the external action fails with it. */
export class WebsiteSetupError extends Error {
  constructor(
    readonly code: "not_set_up" | "no_domain" | "unsafe_html" | "no_guide",
    message: string,
  ) {
    super(message);
    this.name = "WebsiteSetupError";
  }
}

export const websiteKeys = (domain: string) => ({
  guide: (slug: string) => `site/${domain}/guides/${slug}.json`,
  sitemap: `site/${domain}/sitemap.json`,
  redirects: `site/${domain}/redirects.json`,
});

export const GuideFragment = z.object({
  title: z.string(),
  description: z.string(),
  html: z.string(),
  publishedAt: z.iso.datetime({ offset: true }),
});
export type GuideFragment = z.infer<typeof GuideFragment>;

export const Sitemap = z.object({
  updatedAt: z.iso.datetime({ offset: true }),
  urls: z.array(z.object({ path: z.string(), lastmod: z.string() })),
});
export type Sitemap = z.infer<typeof Sitemap>;

const Path = z
  .string()
  .regex(/^\/[^\s?#]*$/, "a path on the site")
  .max(512);
const Redirect = z.object({ from: Path, to: Path });

/**
 * HTML the site would serve from the client's own domain: refused if it carries anything a
 * sanitised guide never has (the pack's sanitiser rebuilt it already; this is the second wall).
 */
// DECISION: a pattern check here rather than a second sanitiser: the connector refuses what the
// pack's renderer can never produce, so a write that didn't come through the checks fails loudly.
const UNSAFE_HTML =
  /<\s*\/?\s*(?:script|style|iframe|object|embed|form|input|button|link|meta|base|img|svg|math|template)\b|\son[a-z]+\s*=|javascript:|data:text\/html|<h1\b/i;
export function unsafeHtml(html: string): boolean {
  return UNSAFE_HTML.test(html);
}

const PublishInput = z
  .strictObject({
    action: z.enum(["publish", "unpublish"]),
    slug: z.string().regex(SLUG).max(80),
    title: z.string().trim().min(1).max(WEBSITE_TITLE_MAX).optional(),
    description: z.string().trim().min(1).max(WEBSITE_DESCRIPTION_MAX).optional(),
    html: z.string().min(1).max(WEBSITE_HTML_MAX).optional(),
    /** The site's redirects in full, written with every publish and unpublish. */
    redirects: z.array(Redirect).max(1000).default([]),
  })
  .refine((i) => i.action === "unpublish" || (i.title && i.description && i.html), {
    message: "a publish needs a title, a description and the html",
  });

const PublishBefore = z.object({
  /** The guide visitors see now, without its html (the record keeps what it was, not the bytes). */
  live: z
    .object({ title: z.string(), description: z.string(), publishedAt: z.string() })
    .nullable(),
});

const PublishOutput = z.object({
  action: z.enum(["publish", "unpublish"]),
  domain: z.string(),
  path: z.string(),
  url: z.string(),
  publishedAt: z.string().nullable(),
  /** Guides in the sitemap after the change. */
  guides: z.number().int(),
  pinged: z.boolean(),
});

const MetaInput = z.strictObject({
  /** A guide (`/guides/<slug>`) or one of the site's own pages (`/`, `/pricing`). */
  path: Path,
  title: z.string().trim().min(1).max(WEBSITE_TITLE_MAX),
  description: z.string().trim().min(1).max(WEBSITE_DESCRIPTION_MAX),
});
const MetaBefore = z.object({ title: z.string(), description: z.string() });
const MetaOutput = z.object({
  domain: z.string(),
  path: z.string(),
  /** Written to the live guide now; false for a page of the site's own, which a person changes. */
  applied: z.boolean(),
  note: z.string(),
});

export interface WebsiteConnectorOptions {
  /** Mezonas' bucket the sites read (the SITE_CONTENT binding); absent, publishing is off. */
  store?: ObjectStore | null;
  /** IndexNow's key for the sites; absent, nobody is pinged. */
  indexNowKey?: string | null;
  fetch?: FetchLike;
}

async function readJson<T>(
  store: ObjectStore,
  key: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  const found = await store.get(key);
  if (!found) return null;
  try {
    const r = schema.safeParse(JSON.parse(fromUtf8(found.bytes)));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

async function writeJson(store: ObjectStore, key: string, value: unknown, metadata = {}) {
  await store.put(key, utf8(JSON.stringify(value)), {
    contentType: "application/json; charset=utf-8",
    metadata,
  });
}

function domainOf(ctx: ToolContext): string {
  const d = (ctx.connection.config as { domain?: unknown }).domain;
  if (typeof d !== "string" || !DOMAIN.test(d)) {
    throw new WebsiteSetupError("no_domain", "this website connection isn't pointed at a site yet");
  }
  return d;
}

const guideSlug = (path: string) => {
  const m = /^\/guides\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(path);
  return m?.[1] ?? null;
};

/** The website connector. `store` and `indexNowKey` come from the deployment (apps/api). */
export function createWebsiteConnector(options: WebsiteConnectorOptions = {}): Connector {
  const store = options.store ?? null;
  const indexNowKey = options.indexNowKey?.trim() || null;
  const doFetch = (): FetchLike => options.fetch ?? globalFetch();

  const needStore = (): ObjectStore => {
    if (!store) throw new WebsiteSetupError("not_set_up", "publishing isn't set up");
    return store;
  };

  /** Tells IndexNow a page changed. Never fails a write: a missed ping costs a crawl's delay. */
  async function ping(ctx: ToolContext, domain: string, paths: string[]): Promise<boolean> {
    if (!indexNowKey) return false;
    try {
      const res = await doFetch()(INDEXNOW_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          host: domain,
          key: indexNowKey,
          keyLocation: `https://${domain}/${indexNowKey}.txt`,
          urlList: paths.map((p) => `https://${domain}${p}`),
        }),
        signal: timeoutSignal(INDEXNOW_TIMEOUT_MS),
      });
      if (!res.ok) ctx.logger.warn("indexnow refused the ping", { status: res.status });
      return res.ok;
    } catch (error) {
      ctx.logger.warn("indexnow unreachable", { error: (error as Error).message });
      return false;
    }
  }

  return defineConnector({
    id: WEBSITE_CONNECTOR_ID,
    name: "Website",
    description:
      "Publish guides on your own website, with its sitemap, once a person signs each change.",
    icon: "website",
    auth: "none",
    entities: [],
    // The record types its tools touch, for the matrix (docs/plan.md §1.44).
    permissionEntities: [
      { id: "guide", label: "Guides", verbs: ["update"] },
      { id: "page", label: "Page titles", verbs: ["update"] },
    ],
    tools: [
      defineWriteTool({
        id: WEBSITE_PUBLISH_TOOL,
        entity: "guide",
        description:
          "Publish a guide on the client's website at /guides/<slug>, or take one down, with the sitemap and redirects. Always signed by a person.",
        // DECISION: publishing and unpublishing are `update` (they change what the site shows,
        // and every version is kept), not `delete`, which stays off everywhere.
        verb: "update",
        approval: "always",
        summary: "{{action}}ed {{path}} on {{domain}}",
        input: PublishInput,
        output: PublishOutput,
        beforeSchema: PublishBefore,
        async before(input, ctx) {
          if (!store) return null;
          const domain = domainOf(ctx);
          const live = await readJson(store, websiteKeys(domain).guide(input.slug), GuideFragment);
          return {
            live: live
              ? { title: live.title, description: live.description, publishedAt: live.publishedAt }
              : null,
          };
        },
        async run(input, ctx) {
          const bucket = needStore();
          const domain = domainOf(ctx);
          const keys = websiteKeys(domain);
          const path = `/guides/${input.slug}`;
          const now = ctx.now().toISOString();
          let publishedAt: string | null = null;
          if (input.action === "publish") {
            if (unsafeHtml(input.html ?? "")) {
              throw new WebsiteSetupError("unsafe_html", "the page's html isn't a checked guide");
            }
            // A re-run of the same action (a retry after a crash) keeps its first time.
            const existing = await bucket.head(keys.guide(input.slug));
            publishedAt =
              existing?.metadata.idempotencyKey === ctx.idempotencyKey &&
              existing.metadata.publishedAt
                ? existing.metadata.publishedAt
                : now;
            await writeJson(
              bucket,
              keys.guide(input.slug),
              {
                title: input.title ?? "",
                description: input.description ?? "",
                html: input.html ?? "",
                publishedAt,
              } satisfies GuideFragment,
              { idempotencyKey: ctx.idempotencyKey, publishedAt },
            );
          } else {
            await bucket.delete(keys.guide(input.slug));
          }
          // DECISION: the sitemap is read, changed and written back by the one action; two
          // publishes at the same moment could lose an entry, which the next publish puts back
          // (a person signs each, so they are rare).
          const current = (await readJson(bucket, keys.sitemap, Sitemap)) ?? {
            updatedAt: now,
            urls: [],
          };
          const urls = current.urls.filter((u) => u.path !== path);
          if (input.action === "publish") urls.push({ path, lastmod: now.slice(0, 10) });
          urls.sort((a, b) => a.path.localeCompare(b.path));
          await writeJson(bucket, keys.sitemap, { updatedAt: now, urls } satisfies Sitemap);
          await writeJson(bucket, keys.redirects, input.redirects);
          const pinged = await ping(ctx, domain, [path]);
          ctx.logger.info("website changed", { action: input.action, path });
          return {
            action: input.action,
            domain,
            path,
            url: `https://${domain}${path}`,
            publishedAt,
            guides: urls.length,
            pinged,
          };
        },
      }),
      defineWriteTool({
        id: WEBSITE_META_TOOL,
        entity: "page",
        description:
          "Change a page's title and description as a search result shows them. A guide's change is written to the site; a change to one of the site's own pages is recorded for a person to make in the site's code. Always signed by a person.",
        verb: "update",
        approval: "always",
        summary: "New title and description for {{path}}",
        input: MetaInput,
        output: MetaOutput,
        beforeSchema: MetaBefore,
        async before(input, ctx) {
          const slug = guideSlug(input.path);
          if (!slug || !store) return null;
          const live = await readJson(store, websiteKeys(domainOf(ctx)).guide(slug), GuideFragment);
          return live ? { title: live.title, description: live.description } : null;
        },
        async run(input, ctx) {
          const domain = domainOf(ctx);
          const slug = guideSlug(input.path);
          if (!slug) {
            // DECISION (docs/marketing-plan.md §4.5): the site's own pages stay in git; a signed
            // change to one is recorded here, and a person opens the pull request.
            return {
              domain,
              path: input.path,
              applied: false,
              note: "Recorded: a person makes this change in the site's code.",
            };
          }
          const bucket = needStore();
          const key = websiteKeys(domain).guide(slug);
          const live = await readJson(bucket, key, GuideFragment);
          if (!live) throw new WebsiteSetupError("no_guide", `no live guide at ${input.path}`);
          const head = await bucket.head(key);
          await writeJson(
            bucket,
            key,
            { ...live, title: input.title, description: input.description },
            { ...(head?.metadata ?? {}), metaKey: ctx.idempotencyKey },
          );
          await ping(ctx, domain, [input.path]);
          return { domain, path: input.path, applied: true, note: "Written to the live guide." };
        },
      }),
    ],
  });
}
