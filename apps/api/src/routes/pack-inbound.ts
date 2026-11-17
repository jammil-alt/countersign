// M43 (docs/plan.md §1.72): `POST /api/in/:pack/:tenantId/:target`, what a pack takes from
// outside with no session: for the Marketing pack, a measured website's beacon. Nothing here
// names a pack (invariant 2): the platform checks that the pack is registered with an inbound
// handler, that the request is within the limit per sending address, and that the client
// has it on, caps the body, and hands the pack the request's facts.
//
// Always 204 with no body, whatever happened, so a sender learns nothing about which clients,
// packs or targets exist; a failure is reported (never with the request's address or body) and
// still answered 204, so measurement never breaks a page. No session is read: the route is not
// `mount()`ed, writes no audit row (the request is anonymous and holds no person's data), and
// never reads a cookie. M50: for a client in HIPAA mode the pack is never called (`inboundHeld`,
// packages/core/src/compliance). The IP address is handed to the pack for the visit hash and goes no
// further: it is not logged, stored or sent anywhere.

import { complianceOf, inboundHeld, routes } from "@countersign/core";
import { tenant, tenantPack, withTenant } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { readTextLimited } from "../body";
import type { AppEnv } from "../http";
import { type RateLimiter, rateLimiterFor } from "../mcp/limits";
import { reportHandled, reportProblem } from "../observability/report";
import { sampled } from "../observability/sampled";

const spec = routes.packInbound;
const Params = z.object({ pack: z.string(), tenantId: z.uuid(), target: z.uuid() });

/** The request headers a pack may read; nothing else (no cookie, no authorization) is passed. */
export const INBOUND_HEADERS = [
  "user-agent",
  "origin",
  "accept-language",
  "dnt",
  "sec-gpc",
  "content-type",
] as const;

const noContent = (c: Context<AppEnv>) => c.body(null, 204);

/** The address as a limiter key: a hash, so the address itself goes nowhere. */
async function addressKey(ip: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`in:${ip}`));
  return Array.from(new Uint8Array(digest).subarray(0, 16), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Whether a request is within the inbound limit: per sending address, so a new user agent gets
 * past nothing.
 */
// DECISION: the limit uses the Rate Limiting binding the Worker already has (`MCP_RATE_LIMIT`,
// 120 a minute per key, per Cloudflare location), with keys of its own, checked before any
// database work. There is no per-site limit: on the same binding it would be 120 a minute too, so
// one address could use up a site's allowance and a busy site would lose real beacons. A per-site
// limit needs its own binding, set well above the address limit; that is a later change. A request
// over the limit gets the same 204 and is counted in this isolate, reported at most once a minute.
export async function withinInboundLimits(
  limiter: RateLimiter,
  req: { ip: string },
): Promise<boolean> {
  return limiter.allow(`in:ip:${await addressKey(req.ip)}`);
}

/** Counts requests over the limit and reports the count at most once a minute (no address). */
export function droppedReporter(
  report: (count: number) => void,
  now: () => number = Date.now,
): () => void {
  const counted = sampled((count) => report(count), 60_000, now);
  return () => counted(undefined);
}

const dropped = droppedReporter((count) =>
  reportProblem("pack inbound requests over the address limit", {
    job: "pack_inbound",
    dropped: String(count),
  }),
);

export function packInboundRoutes(app: Hono<AppEnv>): void {
  app.post(spec.path, async (c) => {
    const params = Params.safeParse(c.req.param());
    if (!params.success) return noContent(c);
    const { pack: packId, tenantId, target } = params.data;
    try {
      const services = c.get("req").services();
      const pack = services.platform.packs.find((p) => p.manifest.id === packId);
      if (!pack?.inbound) return noContent(c);
      const ip = c.req.header("cf-connecting-ip") ?? "";
      const allowed = await withinInboundLimits(rateLimiterFor(c.env, "inbound"), { ip });
      if (!allowed) {
        dropped();
        return noContent(c);
      }
      const on = await withTenant(services.db, tenantId, (tx) =>
        tx
          .select({ pack: tenantPack.pack })
          .from(tenantPack)
          .where(and(eq(tenantPack.tenantId, tenantId), eq(tenantPack.pack, packId))),
      );
      if (on.length === 0) return noContent(c);
      // M50 (docs/plan.md §1.78): a client in HIPAA mode has its inbound held: nothing stored,
      // the pack never called, the same 204.
      const [row] = await services.db
        .select({ settings: tenant.settings })
        .from(tenant)
        .where(eq(tenant.id, tenantId));
      if (inboundHeld(complianceOf(row?.settings as Record<string, unknown> | undefined))) {
        return noContent(c);
      }
      // An oversized body is the pack's to count, as an empty one.
      const body = (await readTextLimited(c.req.raw, pack.inbound.maxBytes)) ?? "{";
      const headers: Record<string, string> = {};
      for (const name of INBOUND_HEADERS) {
        const value = c.req.header(name);
        if (value !== undefined) headers[name] = value;
      }
      const cf = (c.req.raw as Request & { cf?: Record<string, unknown> }).cf;
      await pack.inbound.receive(services.db, {
        tenantId,
        target,
        body,
        ip,
        headers,
        cf,
        now: new Date(),
      });
    } catch (error) {
      reportHandled("pack inbound failed", error, { job: "pack_inbound", pack: packId });
    }
    return noContent(c);
  });
}
