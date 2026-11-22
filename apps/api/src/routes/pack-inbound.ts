// M43 (docs/plan.md §1.72): `POST /api/in/:pack/:tenantId/:target`, what a pack takes from
// outside with no session: for the Marketing pack, a measured website's beacon. Nothing here
// names a pack (invariant 2): the platform checks that the pack is registered with an inbound
// handler, that the request is within the limits per sending address and per target, and that
// the client has it on, caps the body, and hands the pack the request's facts.
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
import { type RateLimiter, rateLimiterFor, targetRateLimiterFor } from "../mcp/limits";
import { reportHandled, reportProblem } from "../observability/report";
import { sampled } from "../observability/sampled";

const spec = routes.packInbound;
// The ids' shape is the first check, then the pack (in memory), then the address and target
// limits, all before any database work. DECISION: any UUID, not only v7: the first client `add-operator`
// makes has a random (v4) id (packages/db/src/operators.ts).
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

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const HEXTET = /^[0-9a-f]{1,4}$/;

/**
 * What one sender is, for the limit: an IPv4 address whole, an IPv6 address by its /64 (one
 * network hands out the rest of its addresses freely). Anything else stays as it was sent.
 */
// DECISION: a /64, the smallest network an IPv6 host is normally given, so rotating the low 64
// bits gets past nothing. An IPv4 address written as IPv6 (`::ffff:a.b.c.d`) counts as itself.
export function addressScope(ip: string): string {
  const raw = ip.trim().toLowerCase().replace(/%.*$/, "");
  if (!raw.includes(":")) return raw;
  const halves = raw.split("::");
  if (halves.length > 2) return ip;
  const parts = (half: string | undefined) => (half ? half.split(":") : []);
  const head = parts(halves[0]);
  const tail = parts(halves[1]);
  const last = tail.at(-1) ?? head.at(-1) ?? "";
  if (IPV4.test(last)) {
    const prefix = [...head, ...tail.slice(0, -1)];
    const mapped =
      halves.length === 2 && prefix.length === 1 && prefix[0] === "ffff" && head.length === 0;
    if (mapped) return last;
    return ip;
  }
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return ip;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (!groups.every((g) => HEXTET.test(g))) return ip;
  return `${groups
    .slice(0, 4)
    .map((g) => Number.parseInt(g, 16).toString(16))
    .join(":")}::/64`;
}

/** The sender as a limiter key: a hash of its scope, so the address itself goes nowhere. */
async function addressKey(ip: string): Promise<string> {
  const scope = addressScope(ip);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`in:${scope}`));
  return Array.from(new Uint8Array(digest).subarray(0, 16), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/** The limiters the inbound route checks: per sending address, then per target. */
export interface InboundLimiters {
  address: RateLimiter;
  target: RateLimiter;
}

/**
 * Which inbound limit a request is over, if any: first per sending address, so a new user agent
 * gets past nothing, then per target (for the Marketing pack, a measured site).
 */
// DECISION: the address limit uses the Rate Limiting binding the Worker already has
// (`MCP_RATE_LIMIT`, 120 a minute per key, per Cloudflare location), with keys of its own. The
// target limit has a binding of its own (`INBOUND_TARGET_RATE_LIMIT`, 3,000 a minute per target,
// per location; docs/plan.md §1.198), keyed by pack, client and target. A request the address
// limit refuses never counts toward its target, so one address can't use up a site's allowance;
// the target limit caps what many addresses together can send for one site. Both are checked
// before any database work. A request over either gets the same 204 and is counted in this
// isolate, reported at most once a minute per limit.
export async function inboundLimitHit(
  limiters: InboundLimiters,
  req: { pack: string; tenantId: string; target: string; ip: string },
): Promise<"address" | "target" | null> {
  if (!(await limiters.address.allow(`in:ip:${await addressKey(req.ip)}`))) return "address";
  if (!(await limiters.target.allow(`in:target:${req.pack}:${req.tenantId}:${req.target}`))) {
    return "target";
  }
  return null;
}

/** Counts requests over the limit and reports the count at most once a minute (no address). */
export function droppedReporter(
  report: (count: number) => void,
  now: () => number = Date.now,
): () => void {
  const counted = sampled((count) => report(count), 60_000, now);
  return () => counted(undefined);
}

const droppedBy = {
  address: droppedReporter((count) =>
    reportProblem("pack inbound requests over the address limit", {
      job: "pack_inbound",
      dropped: String(count),
    }),
  ),
  target: droppedReporter((count) =>
    reportProblem("pack inbound requests over the target limit", {
      job: "pack_inbound",
      dropped: String(count),
    }),
  ),
};

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
      const limiters = {
        address: rateLimiterFor(c.env, "inbound"),
        target: targetRateLimiterFor(c.env),
      };
      const over = await inboundLimitHit(limiters, { pack: packId, tenantId, target, ip });
      if (over) {
        droppedBy[over]();
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
