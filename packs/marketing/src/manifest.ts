// The Marketing pack's manifest (ARCHITECTURE §12.1; docs/marketing-plan.md §4.1), added up from
// its areas (§11, the wave contract): measure (M43–M44), search (M45), content (M46), the agent
// set (M47–M49) and the forum watch (M48). Each area's index.ts exports one AreaModule; nothing
// here changes when an area grows.
// DECISION (owner, 2026-11-08): the pack ships the agent set as templates, unlike Materials; until
// those milestones there are none, so enabling it installs nothing.

import { PackManifest } from "@countersign/core";
import type { Db } from "@countersign/db";
import { AREA as AGENTS } from "./agents";
import { AREA as CONTENT } from "./content";
import { AREA as FORUM } from "./forum";
import { PACK_ID } from "./ids";
import { AREA as MEASURE } from "./measure";
import { type CollectOutcome, collect } from "./measure/collect";
import { MAX_BEACON_BYTES } from "./measure/events";
import { type NightlyResult, nightly } from "./measure/rollup";
import type { AreaModule, PackActionHandler, PackReportHandler, PackTool } from "./pack";
import { AREA as SEARCH } from "./search";
import { listSites } from "./sites";

export { PACK_ID };

/** The pack's areas, in the order their milestones come. */
export const MARKETING_AREAS: Readonly<Record<string, AreaModule>> = {
  measure: MEASURE,
  search: SEARCH,
  content: CONTENT,
  agents: AGENTS,
  forum: FORUM,
};

const areas = Object.entries(MARKETING_AREAS);

/** Every area's named things in one record; a name two areas use is a mistake caught at load. */
function merged<T>(pick: (a: AreaModule) => Readonly<Record<string, T>>, what: string) {
  const out: Record<string, T> = {};
  for (const [area, a] of areas) {
    for (const [name, value] of Object.entries(pick(a))) {
      if (name in out) throw new Error(`marketing: ${what} "${name}" is defined twice (${area})`);
      out[name] = value;
    }
  }
  return out;
}

const all = <T>(pick: (a: AreaModule) => readonly T[]) => areas.flatMap(([, a]) => pick(a));

/** The pack's tool handlers by id, for apps/api to adapt into the tool registry. */
export const MARKETING_HANDLERS: Readonly<Record<string, PackTool>> = merged(
  (a) => Object.fromEntries(a.TOOLS.map((t) => [t.spec.id, t])),
  "tool",
);

/** Its reports, in the shape apps/api's generic report routes take. */
export const MARKETING_REPORTS: Readonly<Record<string, PackReportHandler>> = merged(
  (a) => a.REPORTS,
  "report",
);

/** People's actions on a client's marketing data in the back office. */
export const MARKETING_ACTIONS: Readonly<Record<string, PackActionHandler>> = merged(
  (a) => a.ACTIONS,
  "action",
);

export const MARKETING_SKILLS = all((a) => a.SKILLS);

export const marketingManifest: PackManifest = PackManifest.parse({
  id: PACK_ID,
  name: "Marketing",
  version: "0.1.0",
  description:
    "The Marketing area for the client's own websites: measurement without cookies or kept IP addresses, search figures, the content of its guides, a weekly report, and agents that draft articles, posts and forum replies for a person to sign.",
  requiresConnectors: [],
  events: all((a) => a.EVENTS),
  tools: Object.values(MARKETING_HANDLERS).map((t) => t.spec),
  skills: MARKETING_SKILLS,
  templates: all((a) => a.TEMPLATES),
  screens: all((a) => a.SCREENS),
});

/** What the platform's public inbound route hands a pack (`POST /api/in/:pack/:tenantId/:target`). */
export interface PackInboundRequest {
  tenantId: string;
  target: string;
  body: string;
  ip: string;
  headers: Readonly<Record<string, string>>;
  cf?: Record<string, unknown> | undefined;
  now: Date;
}

/** The collector: a measured site's beacons. `target` is the site's id. */
export const MARKETING_INBOUND = {
  maxBytes: MAX_BEACON_BYTES,
  async receive(db: Db, req: PackInboundRequest): Promise<CollectOutcome> {
    return collect(db, {
      tenantId: req.tenantId,
      siteId: req.target,
      body: req.body,
      ip: req.ip,
      userAgent: req.headers["user-agent"] ?? "",
      origin: req.headers.origin ?? null,
      acceptLanguage: req.headers["accept-language"] ?? null,
      optedOut: req.headers.dnt === "1" || req.headers["sec-gpc"] === "1",
      cf: req.cf,
      now: req.now,
    });
  },
};

/** Its nightly job: build each site's finished days and sweep past the retention limits. */
export const MARKETING_NIGHTLY = {
  /** The hour (UTC) and minute it runs at. DECISION: 03:41, a minute no other pass uses. */
  hour: 3,
  minute: 41,
  async run(
    db: Db,
    now: Date,
    onError?: (tenantId: string, error: unknown) => void,
  ): Promise<NightlyResult & { areas: Record<string, unknown> }> {
    const measured = await nightly(db, now, onError);
    const done: Record<string, unknown> = {};
    for (const [name, area] of areas) {
      if (!area.NIGHTLY) continue;
      try {
        done[name] = await area.NIGHTLY(db, now, onError);
      } catch (error) {
        // One area's failure never stops another's; no client in it, so no client is named.
        onError?.("", error);
        done[name] = { failed: true };
      }
    }
    return { ...measured, areas: done };
  },
};

export { listSites };
