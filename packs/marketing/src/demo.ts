// Sample traffic for the Sandbox client (M44, docs/plan.md §1.74), so staging's Marketing screens
// have figures before any real site sends a beacon. Ported from Plenary Labs'
// `apps/api/src/site/sample.ts` (copied, not shared), reshaped for a small business's site like
// mezonas.com: a few dozen visits a day, a Hacker News comment linking to How it works three days
// before the end, and a newsletter over the last five days.
//
// `sampleTraffic` is pure and deterministic for its days and seed, so a screenshot, a QA run and a
// test see the same figures. The `sample-traffic` action writes it for the last 28 finished days
// of one of the Sandbox's sites through the same nightly build real beacons go through, replacing
// those days, and refuses every other client: it is never real data.

import { type Db, tenant, withTenant } from "@countersign/db";
import { and, between, eq } from "drizzle-orm";
import { z } from "zod";
import type { BotReason, SiteEvent } from "./measure/events";
import { buildDay } from "./measure/rollup";
import { defineAction, PackRefusal } from "./pack";
import { site, siteBotDaily, siteEvent } from "./schema";
import { listSites } from "./sites";

export interface Sample {
  events: SiteEvent[];
  bots: { day: string; reason: BotReason; requests: number }[];
  visits: number;
}

/** mulberry32: small, fast and good enough to look like traffic. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type Random = ReturnType<typeof prng>;

function pick<T>(random: Random, weighted: readonly (readonly [T, number])[]): T {
  const total = weighted.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = random() * total;
  for (const [value, weight] of weighted) {
    roll -= weight;
    if (roll <= 0) return value;
  }
  return (weighted[weighted.length - 1] as readonly [T, number])[0];
}

const hex = (random: Random, length: number) =>
  Array.from({ length }, () => Math.floor(random() * 16).toString(16)).join("");
const uuid = (random: Random) => {
  const h = hex(random, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${"89ab"[Math.floor(random() * 4)]}${h.slice(17, 20)}-${h.slice(20)}`;
};

const HOME = "/";
const HOW = "/how-it-works";
const CLOSE = "/guides/month-end-close";
const PRICES = "/guides/vendor-price-changes";
const PRIVACY = "/privacy";
/** The tracked element a reader clicks to go to a page. */
const NAV: Record<string, string> = {
  [HOME]: "nav-home",
  [HOW]: "nav-how-it-works",
  [CLOSE]: "nav-guides",
  [PRICES]: "guide-related",
  [PRIVACY]: "footer-privacy",
};
/** The sample site's goals: "Talk to us" on the home page, and the email address in the footer. */
export const SAMPLE_GOALS = ["hero-talk", "contact-email"] as const;

type Source = Pick<
  SiteEvent,
  | "sourceGroup"
  | "sourceName"
  | "referrerHost"
  | "referrerPath"
  | "utmSource"
  | "utmMedium"
  | "utmCampaign"
  | "utmContent"
>;

const SOURCES: readonly (readonly [Source, number])[] = [
  [{ sourceGroup: "direct" }, 30],
  [{ sourceGroup: "search", sourceName: "google", referrerHost: "google.com" }, 26],
  [{ sourceGroup: "search", sourceName: "bing", referrerHost: "bing.com" }, 4],
  [{ sourceGroup: "search", sourceName: "duckduckgo", referrerHost: "duckduckgo.com" }, 2],
  [{ sourceGroup: "social", sourceName: "linkedin", referrerHost: "linkedin.com" }, 12],
  [{ sourceGroup: "referral", sourceName: "reddit.com", referrerHost: "reddit.com" }, 3],
  [
    {
      sourceGroup: "referral",
      sourceName: "quickbooks.intuit.com",
      referrerHost: "quickbooks.intuit.com",
    },
    2,
  ],
];

const ENTRY_BY_GROUP: Record<string, readonly (readonly [string, number])[]> = {
  direct: [
    [HOME, 80],
    [HOW, 12],
    [CLOSE, 8],
  ],
  search: [
    [HOME, 30],
    [CLOSE, 35],
    [PRICES, 25],
    [HOW, 10],
  ],
  social: [
    [HOME, 55],
    [CLOSE, 45],
  ],
  referral: [
    [HOME, 50],
    [HOW, 30],
    [PRICES, 20],
  ],
};

/** How often a reader leaves from a page, and where they go next when they don't. */
const LEAVE: Record<string, number> = {
  [HOME]: 0.32,
  [HOW]: 0.42,
  [CLOSE]: 0.48,
  [PRICES]: 0.55,
  [PRIVACY]: 0.7,
};
const NEXT: Record<string, readonly (readonly [string, number])[]> = {
  [HOME]: [
    [HOW, 55],
    [CLOSE, 30],
    [PRIVACY, 15],
  ],
  [HOW]: [
    [HOME, 60],
    [CLOSE, 30],
    [PRIVACY, 10],
  ],
  [CLOSE]: [
    [HOME, 50],
    [PRICES, 35],
    [HOW, 15],
  ],
  [PRICES]: [
    [HOME, 60],
    [CLOSE, 40],
  ],
  [PRIVACY]: [[HOME, 100]],
};

const PLACES: readonly (readonly [
  Pick<SiteEvent, "country" | "region" | "city" | "timeZone">,
  number,
])[] = [
  [{ country: "US", region: "Texas", city: "Austin", timeZone: "America/Chicago" }, 14],
  [{ country: "US", region: "Texas", city: "Dallas", timeZone: "America/Chicago" }, 8],
  [
    { country: "US", region: "California", city: "Los Angeles", timeZone: "America/Los_Angeles" },
    10,
  ],
  [{ country: "US", region: "New York", city: "New York", timeZone: "America/New_York" }, 10],
  [{ country: "US", region: "Florida", city: "Miami", timeZone: "America/New_York" }, 6],
  [{ country: "US", region: "Illinois", timeZone: "America/Chicago" }, 5],
  [{ country: "CA", region: "Ontario", city: "Toronto", timeZone: "America/Toronto" }, 5],
  [{ country: "MX", region: "Nuevo León", city: "Monterrey", timeZone: "America/Monterrey" }, 4],
  [{ country: "GB", region: "England", city: "London", timeZone: "Europe/London" }, 4],
  [{ country: "DE", region: "Berlin", city: "Berlin", timeZone: "Europe/Berlin" }, 2],
  [{}, 1],
];

const DEVICES: readonly (readonly [Pick<SiteEvent, "device" | "browser" | "os">, number])[] = [
  [{ device: "desktop", browser: "Chrome", os: "Windows" }, 30],
  [{ device: "desktop", browser: "Chrome", os: "macOS" }, 18],
  [{ device: "desktop", browser: "Safari", os: "macOS" }, 8],
  [{ device: "desktop", browser: "Edge", os: "Windows" }, 8],
  [{ device: "phone", browser: "Safari", os: "iOS" }, 22],
  [{ device: "phone", browser: "Chrome", os: "Android" }, 10],
  [{ device: "tablet", browser: "Safari", os: "iOS" }, 4],
];

const LANGUAGES = [
  ["en-US", 72],
  ["es-US", 8],
  ["en-GB", 5],
  ["en-CA", 5],
  ["es-MX", 5],
  ["de-DE", 2],
  ["fr-CA", 2],
] as const;

/** Engaged time for one view: long-tailed around a median. */
function engagedMs(random: Random, median: number): number {
  const z = Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
  return Math.min(1_800_000, Math.round(median * Math.exp(0.9 * z)));
}

const HACKER_NEWS: Source = {
  sourceGroup: "referral",
  sourceName: "news.ycombinator.com",
  referrerHost: "news.ycombinator.com",
  referrerPath: "/item",
};
const newsletter = (content: string): Source => ({
  sourceGroup: "campaign",
  sourceName: "newsletter-nov",
  utmSource: "newsletter",
  utmMedium: "email",
  utmCampaign: "newsletter-nov",
  utmContent: content,
});

/** The sample for `days` (UTC, oldest first) of a site on `domain`. Pure. */
export function sampleTraffic(days: readonly string[], domain: string, seed = 1234): Sample {
  const random = prng(seed);
  const events: SiteEvent[] = [];
  const bots: Sample["bots"] = [];
  let visits = 0;
  const last = days.length - 1;

  days.forEach((day, index) => {
    const fromEnd = last - index;
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    const base = Math.round((weekday === 0 || weekday === 6 ? 32 : 58) * (0.85 + random() * 0.3));
    const arrivals: { source: Source; entry?: string }[] = [];
    for (let i = 0; i < base; i++) arrivals.push({ source: pick(random, SOURCES) });
    const hn = [0, 0, 0, 140, 48, 15, 6][6 - fromEnd] ?? 0;
    for (let i = 0; i < hn; i++) arrivals.push({ source: HACKER_NEWS, entry: HOW });
    const sent = [30, 16, 9, 5, 3][4 - fromEnd];
    if (fromEnd <= 4 && sent !== undefined) {
      for (const [content, share, entry] of [
        ["lead", 0.55, CLOSE],
        ["body", 0.3, HOW],
        ["footer", 0.15, HOME],
      ] as const) {
        const n = Math.round(sent * share);
        for (let i = 0; i < n; i++) arrivals.push({ source: newsletter(content), entry });
      }
    }

    for (const arrival of arrivals) {
      visits++;
      const visit = hex(random, 32);
      const passing = arrival.source.sourceName === "news.ycombinator.com";
      const place = pick(random, PLACES);
      const device = pick(random, DEVICES);
      const language = pick(random, LANGUAGES);
      // Readers cluster in the US working day (UTC 14:00–23:00).
      const hour = Math.min(
        23,
        Math.max(0, Math.round(18 + 4 * (random() + random() + random() - 1.5))),
      );
      let at = Date.parse(`${day}T00:00:00Z`) + hour * 3_600_000 + Math.floor(random() * 1_800_000);
      const stamp = (plus = 0) =>
        new Date(Math.min(at + plus, Date.parse(`${day}T23:59:59Z`))).toISOString();
      let path =
        arrival.entry ??
        pick(
          random,
          ENTRY_BY_GROUP[arrival.source.sourceGroup ?? "direct"] ?? ENTRY_BY_GROUP.direct ?? [],
        );
      const goalChance = arrival.source.sourceGroup === "campaign" ? 0.08 : passing ? 0.01 : 0.035;
      const glance = random() < (passing ? 0.55 : 0.3);
      const willReach = !glance && random() < goalChance / 0.7;
      const ids = { day, visit };

      for (let step = 0; step < (glance ? 1 : 6); step++) {
        const viewId = uuid(random);
        events.push({
          ...ids,
          viewId,
          at: stamp(),
          kind: "view",
          path,
          ...(step === 0 ? arrival.source : { sourceGroup: "internal", referrerHost: domain }),
          ...place,
          ...device,
          language,
        });
        const ms = glance
          ? Math.min(9_500, engagedMs(random, 4_000))
          : engagedMs(
              random,
              passing ? 25_000 : path === CLOSE || path === PRICES ? 95_000 : 45_000,
            );
        const scroll = glance
          ? random() < 0.6
            ? 0
            : 1
          : Math.min(4, Math.max(0, Math.floor(ms / (passing ? 22_000 : 20_000) + random() * 1.2)));
        if (path === HOME && scroll >= 3) {
          events.push({
            ...ids,
            viewId,
            at: stamp(ms / 2),
            kind: "form_seen",
            path,
            form: "contact",
          });
        }
        events.push({ ...ids, viewId, at: stamp(ms), kind: "engage", path, engagedMs: ms, scroll });
        at += ms;
        if (glance) break;

        const endsHere = step === 5 || random() < (passing ? 0.7 : (LEAVE[path] ?? 0.4));
        if (endsHere) {
          if (willReach) {
            const target = path === HOME && random() < 0.7 ? "hero-talk" : "contact-email";
            events.push({
              ...ids,
              viewId,
              at: stamp(200),
              kind: "click",
              path,
              target,
              position: target === "hero-talk" ? 12 : 97,
            });
          }
          break;
        }
        const next = pick(random, NEXT[path] ?? NEXT[HOME] ?? []);
        events.push({
          ...ids,
          viewId,
          at: stamp(300),
          kind: "click",
          path,
          target: NAV[next] ?? "nav-home",
          position: next === PRIVACY ? 99 : next === PRICES ? 88 : 0,
        });
        at += 1_000;
        path = next;
      }
    }

    bots.push({
      day,
      reason: "user_agent",
      requests: 40 + Math.floor(random() * 30) + (fromEnd === 3 ? 60 : 0),
    });
    bots.push({ day, reason: "rate", requests: Math.floor(random() * 3) });
    bots.push({ day, reason: "malformed", requests: Math.floor(random() * 2) });
  });

  return { events, bots: bots.filter((b) => b.requests > 0), visits };
}

/** How many finished days the sample fills. */
export const SAMPLE_DAYS = 28;
const SAMPLE_DOMAIN = "sample.example.com";

export const SampleTrafficInput = z.strictObject({
  /** One of the Sandbox's sites; absent, its first, or a sample site made for it. */
  siteId: z.uuid().optional(),
});

const dayOf = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Fills the last 28 finished days of one of the Sandbox's sites with the sample (its events and
 * filtered requests, replacing those days', then the nightly build of each day). Any other client
 * is refused: sample figures are never mixed into a real client's.
 */
export async function fillSampleTraffic(
  db: Db,
  input: { tenantId: string; userId: string; siteId?: string | undefined; now?: Date },
): Promise<{ siteId: string; days: number; visits: number; events: number }> {
  const today = dayOf(input.now ?? new Date());
  const days = Array.from({ length: SAMPLE_DAYS }, (_, i) =>
    dayOf(new Date(Date.parse(`${today}T00:00:00Z`) - (SAMPLE_DAYS - i) * 86_400_000)),
  );
  const from = days[0] ?? today;
  const to = days[days.length - 1] ?? today;
  return withTenant(db, input.tenantId, async (tx) => {
    const [t] = await tx
      .select({ settings: tenant.settings })
      .from(tenant)
      .where(eq(tenant.id, input.tenantId));
    if ((t?.settings as Record<string, unknown> | undefined)?.sandbox !== true) {
      throw new PackRefusal("not_sandbox", "Sample traffic is for the Sandbox client only.");
    }
    const sites = await listSites(tx, input.tenantId);
    let target = input.siteId ? sites.find((s) => s.id === input.siteId) : sites[0];
    if (input.siteId && !target)
      throw new PackRefusal("unknown_site", "No such site for this client.");
    if (!target) {
      const [made] = await tx
        .insert(site)
        .values({
          tenantId: input.tenantId,
          domain: SAMPLE_DOMAIN,
          name: "Sample site",
          goals: [...SAMPLE_GOALS],
          createdByUserId: input.userId,
        })
        .returning();
      if (!made) throw new PackRefusal("unknown_site", "We couldn't add the sample site.");
      target = { ...made, createdAt: made.createdAt.toISOString() };
    } else if (SAMPLE_GOALS.some((g) => !target?.goals.includes(g))) {
      // The sample's goals, so its visits reach one; a person's own goals are kept.
      await tx
        .update(site)
        .set({ goals: [...new Set([...target.goals, ...SAMPLE_GOALS])].slice(0, 20) })
        .where(and(eq(site.tenantId, input.tenantId), eq(site.id, target.id)));
    }
    const siteId = target.id;
    const sample = sampleTraffic(days, target.domain);
    const scope = and(
      eq(siteEvent.tenantId, input.tenantId),
      eq(siteEvent.siteId, siteId),
      between(siteEvent.day, from, to),
    );
    await tx.delete(siteEvent).where(scope);
    await tx
      .delete(siteBotDaily)
      .where(
        and(
          eq(siteBotDaily.tenantId, input.tenantId),
          eq(siteBotDaily.siteId, siteId),
          between(siteBotDaily.day, from, to),
        ),
      );
    for (let i = 0; i < sample.events.length; i += 1_000) {
      await tx.insert(siteEvent).values(
        sample.events.slice(i, i + 1_000).map((e) => ({
          ...e,
          tenantId: input.tenantId,
          siteId,
          at: new Date(e.at),
        })),
      );
    }
    if (sample.bots.length > 0) {
      await tx
        .insert(siteBotDaily)
        .values(sample.bots.map((b) => ({ ...b, tenantId: input.tenantId, siteId })));
    }
    let visits = 0;
    for (const day of days) visits += await buildDay(tx, { tenantId: input.tenantId, siteId, day });
    return { siteId, days: days.length, visits, events: sample.events.length };
  });
}

export const SAMPLE_TRAFFIC_ACTION = defineAction({
  input: SampleTrafficInput,
  run: async (db, ctx) => ({
    sample: await fillSampleTraffic(db, {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      siteId: ctx.input.siteId,
    }),
  }),
});
