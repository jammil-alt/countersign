// The Marketing pack's manifest (ARCHITECTURE §12.1; docs/marketing-plan.md §4.1). M43 brings
// measurement only: the measured sites, the collector, the nightly build and the overview report.
// Its tools, skills and the agent set (weekly report, titles, articles, forum watch) come with
// M45–M48.
// DECISION (owner, 2026-11-08): the pack will ship the agent set as templates, unlike Materials;
// until those milestones there are none, so enabling it installs nothing.

import { PackManifest } from "@countersign/core";
import type { Db, Tx } from "@countersign/db";
import type { z } from "zod";
import { PACK_ID } from "./ids";
import { type CollectOutcome, collect } from "./measure/collect";
import { MAX_BEACON_BYTES } from "./measure/events";
import { type NightlyResult, nightly } from "./measure/rollup";
import { overview, overviewCsv } from "./reports";
import { AddSiteInput, addSite, listSites, UpdateSiteInput, updateSite } from "./sites";

export { PACK_ID };

export const marketingManifest: PackManifest = PackManifest.parse({
  id: PACK_ID,
  name: "Marketing",
  version: "0.1.0",
  description:
    "Website measurement for the client's own site: visits, pages, sources and goals, counted without cookies and without keeping IP addresses. Search figures, content and the marketing agents come next.",
  requiresConnectors: [],
  events: [],
  tools: [],
  skills: [],
  templates: [],
  screens: [
    {
      route: "/reports/marketing/overview",
      title: "Website",
      roles: ["client_admin", "client_user"],
    },
  ],
});

/** Its reports, in the shape apps/api's generic report routes take. */
export const MARKETING_REPORTS = {
  overview: {
    title: "Website",
    json: async (tx: Tx, tenantId: string, today: string) => ({
      ...(await overview(tx, tenantId, today)),
    }),
    csv: async (tx: Tx, tenantId: string, today: string) =>
      overviewCsv(await overview(tx, tenantId, today)),
  },
} as const;

/** People's actions in the back office: add a site, change one (its name, goals, on or off). */
export const MARKETING_ACTIONS = {
  "add-site": {
    input: AddSiteInput as z.ZodType,
    run: async (db: Db, ctx: { tenantId: string; userId: string; input: unknown }) => ({
      site: await addSite(db, { ...ctx, input: ctx.input as z.infer<typeof AddSiteInput> }),
    }),
  },
  "update-site": {
    input: UpdateSiteInput as z.ZodType,
    run: async (db: Db, ctx: { tenantId: string; userId: string; input: unknown }) => ({
      site: await updateSite(db, {
        tenantId: ctx.tenantId,
        input: ctx.input as z.infer<typeof UpdateSiteInput>,
      }),
    }),
  },
} as const;

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
  run: (db: Db, now: Date, onError?: (tenantId: string, error: unknown) => void) =>
    nightly(db, now, onError) as Promise<NightlyResult>,
};

export { listSites };
