/**
 * Storing what a measured site's pages report (docs/marketing-plan.md §4.3): the pack's handler
 * for the platform's public inbound route (`POST /api/in/marketing/:tenantId/:siteId`).
 *
 * One beacon, one client: everything runs in that client's transaction (invariant 1). The IP
 * address and the user agent go no further than the visit hash and the browser families; neither
 * is stored or logged. A reader who asked not to be measured (Do Not Track, Global Privacy
 * Control) is not counted at all, not even as a dropped request.
 *
 * The outcome is for tests and counting only: the route answers 204 to every beacon, so a page
 * learns nothing from it and nobody can probe which sites or clients exist.
 */

import { type Db, type Tx, withTenant } from "@countersign/db";
import { and, count, eq, sql } from "drizzle-orm";
import {
  SITE_VISIT_MAX_EVENTS,
  siteBotDaily,
  siteEvent,
  siteSalt,
  site as siteTable,
} from "../schema";
import {
  type BotReason,
  isBotAgent,
  languageOf,
  MAX_BEACON_BYTES,
  parseBeacon,
  placeOf,
  type SiteEvent,
  toSiteEvents,
  utcDay,
  visitHash,
} from "./events";

export interface CollectRequest {
  tenantId: string;
  siteId: string;
  /** The beacon's body, as text. */
  body: string;
  ip: string;
  userAgent: string;
  /** The `Origin` header: the page that sent the beacon. */
  origin: string | null;
  acceptLanguage: string | null;
  /** `DNT: 1` or `Sec-GPC: 1`. */
  optedOut: boolean;
  /** Cloudflare's `request.cf`: where it places the connection. */
  cf?: Record<string, unknown> | undefined;
  now: Date;
}

export type CollectOutcome =
  | { outcome: "stored"; events: number }
  | { outcome: "opted_out" | "unknown_site" | "wrong_origin" }
  | { outcome: "dropped"; reason: BotReason };

/** 32 random bytes as hex: the shape `site_salt_hex` checks. */
export function randomSalt(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A host without `www.`, lower case; null for anything that is not an http(s) origin. */
export function hostOf(origin: string | null): string | null {
  if (!origin) return null;
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * The salt for a site's day, made on first use. Two beacons at once both insert; the second is a
 * no-op and both read the one row that won, so a day never has two salts.
 */
export async function saltFor(
  tx: Tx,
  tenantId: string,
  siteId: string,
  day: string,
): Promise<string> {
  await tx
    .insert(siteSalt)
    .values({ tenantId, siteId, day, salt: randomSalt() })
    .onConflictDoNothing();
  const [row] = await tx
    .select({ salt: siteSalt.salt })
    .from(siteSalt)
    .where(
      and(eq(siteSalt.tenantId, tenantId), eq(siteSalt.siteId, siteId), eq(siteSalt.day, day)),
    );
  if (!row) throw new Error(`no salt for ${day} after making one`);
  return row.salt;
}

/** Counts a request that was not counted as a visit. */
export async function countDropped(
  tx: Tx,
  input: { tenantId: string; siteId: string; day: string; reason: BotReason },
): Promise<void> {
  await tx
    .insert(siteBotDaily)
    .values({ ...input, requests: 1 })
    .onConflictDoUpdate({
      target: [siteBotDaily.siteId, siteBotDaily.day, siteBotDaily.reason],
      set: { requests: sql`${siteBotDaily.requests} + 1` },
    });
}

/** Stores events for one site of one client. */
export async function recordEvents(
  tx: Tx,
  tenantId: string,
  siteId: string,
  events: readonly SiteEvent[],
): Promise<number> {
  if (events.length === 0) return 0;
  await tx.insert(siteEvent).values(
    events.map((e) => ({
      tenantId,
      siteId,
      at: new Date(e.at),
      day: e.day,
      visit: e.visit,
      viewId: e.viewId,
      kind: e.kind,
      path: e.path,
      referrerHost: e.referrerHost ?? null,
      referrerPath: e.referrerPath ?? null,
      utmSource: e.utmSource ?? null,
      utmMedium: e.utmMedium ?? null,
      utmCampaign: e.utmCampaign ?? null,
      utmContent: e.utmContent ?? null,
      sourceGroup: e.sourceGroup ?? null,
      sourceName: e.sourceName ?? null,
      country: e.country ?? null,
      region: e.region ?? null,
      city: e.city ?? null,
      timeZone: e.timeZone ?? null,
      device: e.device ?? null,
      browser: e.browser ?? null,
      os: e.os ?? null,
      language: e.language ?? null,
      engagedMs: e.engagedMs ?? null,
      scroll: e.scroll ?? null,
      target: e.target ?? null,
      position: e.position ?? null,
      form: e.form ?? null,
    })),
  );
  return events.length;
}

/** Checks one beacon and stores its events, in its client's transaction. */
export async function collect(db: Db, req: CollectRequest): Promise<CollectOutcome> {
  return withTenant(db, req.tenantId, async (tx) => {
    const [row] = await tx
      .select({ id: siteTable.id, domain: siteTable.domain, status: siteTable.status })
      .from(siteTable)
      .where(and(eq(siteTable.tenantId, req.tenantId), eq(siteTable.id, req.siteId)));
    if (row?.status !== "on") return { outcome: "unknown_site" };
    // DECISION: a beacon must come from a page on the site's own domain (or its www), so
    // another site can't fill a client's figures by copying the snippet. A forged header still
    // gets through; the bot rules and the rate ceiling are the next line.
    if (hostOf(req.origin) !== row.domain) return { outcome: "wrong_origin" };
    if (req.optedOut) return { outcome: "opted_out" };

    const day = utcDay(req.now);
    const base = { tenantId: req.tenantId, siteId: row.id, day };
    const events = req.body.length <= MAX_BEACON_BYTES ? parseBeacon(req.body) : null;
    if (!events) {
      await countDropped(tx, { ...base, reason: "malformed" });
      return { outcome: "dropped", reason: "malformed" };
    }
    if (isBotAgent(req.userAgent)) {
      await countDropped(tx, { ...base, reason: "user_agent" });
      return { outcome: "dropped", reason: "user_agent" };
    }
    if (events.some((e) => e.k === "view" && e.wd === true)) {
      await countDropped(tx, { ...base, reason: "webdriver" });
      return { outcome: "dropped", reason: "webdriver" };
    }

    const visit = await visitHash(
      await saltFor(tx, req.tenantId, row.id, day),
      req.ip,
      req.userAgent,
    );
    const [seen] = await tx
      .select({ n: count() })
      .from(siteEvent)
      .where(
        and(
          eq(siteEvent.tenantId, req.tenantId),
          eq(siteEvent.siteId, row.id),
          eq(siteEvent.day, day),
          eq(siteEvent.visit, visit),
        ),
      );
    if ((seen?.n ?? 0) + events.length > SITE_VISIT_MAX_EVENTS) {
      await countDropped(tx, { ...base, reason: "rate" });
      return { outcome: "dropped", reason: "rate" };
    }

    const stored = toSiteEvents(events, {
      day,
      visit,
      at: req.now.toISOString(),
      ua: req.userAgent,
      language: languageOf(req.acceptLanguage),
      place: placeOf(req.cf),
      siteHost: row.domain,
    });
    return { outcome: "stored", events: await recordEvents(tx, req.tenantId, row.id, stored) };
  });
}
