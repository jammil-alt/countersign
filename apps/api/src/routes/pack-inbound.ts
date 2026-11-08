// M43 (docs/plan.md §1.72): `POST /api/in/:pack/:tenantId/:target`, what a pack takes from
// outside with no session: for the Marketing pack, a measured website's beacon. Nothing here
// names a pack (invariant 2): the platform checks that the pack is registered with an inbound
// handler and that the client has it on, caps the body, and hands the pack the request's facts.
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

export function packInboundRoutes(app: Hono<AppEnv>): void {
  app.post(spec.path, async (c) => {
    const params = Params.safeParse(c.req.param());
    if (!params.success) return noContent(c);
    const { pack: packId, tenantId, target } = params.data;
    try {
      const services = c.get("req").services();
      const pack = services.platform.packs.find((p) => p.manifest.id === packId);
      if (!pack?.inbound) return noContent(c);
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
        ip: c.req.header("cf-connecting-ip") ?? "",
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
