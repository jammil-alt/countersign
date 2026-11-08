// M46 (docs/plan.md §1.76): preview links. An operator asks for a short-lived link to a page a pack
// renders before it is public (a guide's draft, docs/marketing-plan.md §4.5), to read it as a
// visitor would or to send it to someone without a session. The link is signed (an HMAC over the
// pack, client, report, item and expiry, with a key derived from ENCRYPTION_KEY, as document links
// are), works for PREVIEW_TTL_HOURS, and serves a page search engines are told not to index.
// Nothing here names a pack: the pack declares which report's items are previews
// (`RegisteredPack.previews`), and each such item is a fragment ({ title, description, html, … })
// the pack has already checked and sanitised. The page escapes the title and description again.
//
// The public route is not `mount()`ed: no session or cookie is read and no audit row is written
// (the request is anonymous); a bad or expired link is a plain 404 that says nothing about why.

import { routes, trimTrailingSlashes } from "@countersign/core";
import { tenantPack, withTenant } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { Bindings } from "../env";
import { type AppEnv, ensureClient, HttpError, mount, notFound } from "../http";
import { reportHandled } from "../observability/report";
import { isProductionEnv } from "../platform";

/** How long a preview link works. */
export const PREVIEW_TTL_HOURS = 24;

const encoder = new TextEncoder();
let devKey: Uint8Array | undefined;

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(text: string): Uint8Array {
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

// DECISION: preview links are signed like the Worker's own document links (src/storage.ts): a key
// derived from ENCRYPTION_KEY under its own label, so neither kind of link opens the other; in
// development without it, a random key per isolate; production without it makes no links.
async function previewKey(env: Pick<Bindings, "ENCRYPTION_KEY" | "ENVIRONMENT">) {
  let raw: Uint8Array;
  if (env.ENCRYPTION_KEY?.trim()) {
    raw = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        encoder.encode(`mezonas-preview-link:${env.ENCRYPTION_KEY.trim()}`),
      ),
    );
  } else if (!isProductionEnv(env)) {
    devKey ??= crypto.getRandomValues(new Uint8Array(32));
    raw = devKey;
  } else {
    throw new HttpError(409, "not_available", "preview links need ENCRYPTION_KEY");
  }
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

const Payload = z.object({
  /** Pack, client, report and item. */
  p: z.string(),
  t: z.uuid(),
  r: z.string(),
  i: z.uuid(),
  /** Expiry, Unix seconds. */
  e: z.number().int(),
});
type Payload = z.infer<typeof Payload>;

export async function signPreview(
  env: Pick<Bindings, "ENCRYPTION_KEY" | "ENVIRONMENT">,
  payload: Payload,
): Promise<string> {
  const body = encoder.encode(JSON.stringify(payload));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await previewKey(env), body));
  return `${b64url(body)}.${b64url(sig)}`;
}

export async function verifyPreview(
  env: Pick<Bindings, "ENCRYPTION_KEY" | "ENVIRONMENT">,
  token: string,
  now: number = Date.now(),
): Promise<Payload | null> {
  const [bodyText, sigText, extra] = token.split(".");
  if (!bodyText || !sigText || extra !== undefined || token.length > 2000) return null;
  try {
    const body = unb64url(bodyText);
    const ok = await crypto.subtle.verify("HMAC", await previewKey(env), unb64url(sigText), body);
    if (!ok) return null;
    const parsed = Payload.safeParse(JSON.parse(new TextDecoder().decode(body)));
    if (!parsed.success || parsed.data.e * 1000 < now) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

/** What a pack's preview item must be: a checked fragment and its head. */
const Fragment = z.object({
  title: z.string().max(400),
  description: z.string().max(1000),
  html: z.string().max(500_000),
  path: z.string().max(512),
  domain: z.string().max(253),
  version: z.number().int().optional(),
});

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);

/** The preview's page: the fragment inside a plain layout, marked as a preview and noindex. */
export function previewPage(f: z.infer<typeof Fragment>, expiresAt: Date): string {
  const where = `${f.domain}${f.path}`;
  const version = f.version ? `version ${f.version} of ` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(f.title)}</title>
<meta name="description" content="${esc(f.description)}">
<style>
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.6}
.note{border-bottom:1px solid;padding:12px 16px;font-size:14px}
main{max-width:720px;margin:0 auto;padding:32px 16px 64px}
h1{line-height:1.2}
pre{overflow-x:auto}
</style>
</head>
<body>
<div class="note">Preview of ${esc(version)}${esc(where)}. Not public. This link stops working at ${esc(expiresAt.toISOString().slice(0, 16).replace("T", " "))} UTC.</div>
<main>
<h1>${esc(f.title)}</h1>
${f.html}
</main>
</body>
</html>`;
}

const PREVIEW_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const gone = (c: Context<AppEnv>) =>
  c.html(
    "<!doctype html><title>Not found</title><p>This preview link has expired or doesn't exist.</p>",
    404,
    {
      "X-Robots-Tag": "noindex, nofollow",
      "Content-Security-Policy": PREVIEW_CSP,
    },
  );

export function packPreviewRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.opsClientPackPreview, async (ctx) => {
    const { tx, params, services, body } = ctx;
    ensureClient(ctx, params.id);
    const pack = services.platform.packs.find((p) => p.manifest.id === params.pack);
    if (!pack) throw notFound("pack");
    const [on] = await tx
      .select({ pack: tenantPack.pack })
      .from(tenantPack)
      .where(and(eq(tenantPack.tenantId, params.id), eq(tenantPack.pack, pack.manifest.id)));
    if (!on) throw notFound("pack");
    const report = pack.reports?.[body.report];
    if (!report?.item || !pack.previews?.includes(body.report)) throw notFound("preview");
    const item = await report.item(
      tx,
      params.id,
      body.itemId,
      new Date().toISOString().slice(0, 10),
      {},
    );
    if (!item || !Fragment.safeParse(item).success) throw notFound("preview");
    const expiresAt = new Date(Date.now() + PREVIEW_TTL_HOURS * 3600_000);
    const token = await signPreview(services.env, {
      p: pack.manifest.id,
      t: params.id,
      r: body.report,
      i: body.itemId,
      e: Math.floor(expiresAt.getTime() / 1000),
    });
    const origin = trimTrailingSlashes(services.env.APP_ORIGIN ?? "");
    return { url: `${origin}/api/preview/${token}`, expiresAt: expiresAt.toISOString() };
  });

  app.get(routes.packPreview.path, async (c) => {
    try {
      const services = c.get("req").services();
      const payload = await verifyPreview(services.env, c.req.param("token") ?? "");
      if (!payload) return gone(c);
      const pack = services.platform.packs.find((p) => p.manifest.id === payload.p);
      const report = pack?.reports?.[payload.r];
      if (!pack || !report?.item || !pack.previews?.includes(payload.r)) return gone(c);
      const fragment = await withTenant(services.db, payload.t, async (tx) => {
        const [on] = await tx
          .select({ pack: tenantPack.pack })
          .from(tenantPack)
          .where(and(eq(tenantPack.tenantId, payload.t), eq(tenantPack.pack, payload.p)));
        if (!on) return null;
        const item = await report.item?.(
          tx,
          payload.t,
          payload.i,
          new Date().toISOString().slice(0, 10),
          {},
        );
        const parsed = Fragment.safeParse(item);
        return parsed.success ? parsed.data : null;
      });
      if (!fragment) return gone(c);
      return c.html(previewPage(fragment, new Date(payload.e * 1000)), 200, {
        "X-Robots-Tag": "noindex, nofollow",
        "Content-Security-Policy": PREVIEW_CSP,
        "Cache-Control": "no-store",
      });
    } catch (error) {
      reportHandled("pack preview failed", error, { job: "pack_preview" });
      return gone(c);
    }
  });
}
