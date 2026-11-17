// M43 (docs/plan.md §1.72): `POST /api/in/:pack/:tenantId/:target`, what a pack takes from
// outside with no session: for the Marketing pack, a measured website's beacon. Nothing here
// names a pack (invariant 2): the platform checks that the pack is registered with an inbound
// handler, that the request is within the limits per address and per target, and that the client
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
import type { AppEnv } from "../http";
import { type RateLimiter, rateLimiterFor } from "../mcp/limits";
import { reportHandled } from "../observability/report";

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

/** Reads at most `limit + 1` bytes as text, so an oversized body is refused without reading it. */
async function readText(req: Request, limit: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > limit || !req.body) return declared > limit ? null : "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return new TextDecoder().decode(out);
}

const noContent = (c: Context<AppEnv>) => c.body(null, 204);

/** The address as a limiter key: a hash, so the address itself goes nowhere. */
async function addressKey(ip: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`in:${ip}`));
  return Array.from(new Uint8Array(digest).subarray(0, 16), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Whether a request is within the inbound limits: per sending address, then per target (for the
 * Marketing pack, per measured site), so neither a new user agent nor a new address gets past them.
 */
// DECISION: the limits use the Rate Limiting binding the Worker already has (`MCP_RATE_LIMIT`,
// 120 a minute per key, per Cloudflare location), with keys of their own, rather than a new
// binding or a database counter: they are checked before any database work, and a refused request
// costs nothing. A request over a limit is not counted as dropped (that would be a write per
// request); it gets the same 204. A site that outgrows 120 beacons a minute needs its own binding.
export async function withinInboundLimits(
  limiter: RateLimiter,
  req: { pack: string; tenantId: string; target: string; ip: string },
): Promise<boolean> {
  if (!(await limiter.allow(`in:ip:${await addressKey(req.ip)}`))) return false;
  return limiter.allow(`in:target:${req.pack}:${req.tenantId}:${req.target}`);
}

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
      const allowed = await withinInboundLimits(rateLimiterFor(c.env, "inbound"), {
        pack: packId,
        tenantId,
        target,
        ip,
      });
      if (!allowed) return noContent(c);
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
      const body = (await readText(c.req.raw, pack.inbound.maxBytes)) ?? "{";
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
