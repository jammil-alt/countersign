// The measurement area (M43; M44 the read screens' reports, docs/plan.md §1.74): a client's
// measured sites, the reports the back office's Marketing pages read (overview, pages, one page,
// sources, journeys, audience, visits, one visit, sites), the back office's site actions and the
// Sandbox's sample traffic. Its collector and nightly build are the pack's `inbound` and `nightly`
// hooks (manifest.ts), not part of an area. Owned by the screens builder from M44
// (docs/marketing-plan.md §11).

import type { z } from "zod";
import { SAMPLE_TRAFFIC_ACTION } from "../demo";
import { type AreaModule, defineReport } from "../pack";
import {
  WEEKLY_REPORT,
  WeeklyQuery,
  weeklyCsv,
  weeklyReport,
  weeklyReports,
} from "../portal/weekly";
import { overview, overviewCsv } from "../reports";
import { AddSiteInput, addSite, sitesReport, UpdateSiteInput, updateSite } from "../sites";
import { AudienceQuery, audienceCsv, audienceReport } from "./audience";
import { journeysCsv, journeysReport } from "./journeys";
import { PageQuery, pageCsv, pageReport, pagesCsv, pagesReport } from "./pages";
import { PeriodQuery, toCsv } from "./range";
import { SourcesQuery, sourcesCsv, sourcesReport } from "./sources";
import { VisitQuery, VisitsQuery, visitCsv, visitReport, visitsCsv, visitsReport } from "./visits";

export const AREA: AreaModule = {
  TOOLS: [],
  SKILLS: [],
  TEMPLATES: [],
  EVENTS: [],
  // M50 (docs/plan.md §1.78): the client's portal reads these and only these (apps/api's
  // `portalReports` comes from their routes): its website, its search figures and its weekly
  // reports, read only. The area's other reports are the back office's.
  SCREENS: [
    {
      route: "/reports/marketing/overview",
      title: "Website",
      roles: ["client_admin", "client_user"],
    },
    {
      route: "/reports/marketing/search",
      title: "Search",
      roles: ["client_admin", "client_user"],
    },
    {
      route: `/reports/marketing/${WEEKLY_REPORT}`,
      title: "Weekly report",
      roles: ["client_admin", "client_user"],
    },
  ],
  REPORTS: {
    overview: defineReport({
      title: "Website",
      query: PeriodQuery,
      json: (tx, tenantId, today, q) => overview(tx, tenantId, today, q),
      csv: async (tx, tenantId, today, q) => overviewCsv(await overview(tx, tenantId, today, q)),
    }),
    pages: defineReport({
      title: "Pages",
      query: PeriodQuery,
      json: (tx, tenantId, today, q) => pagesReport(tx, tenantId, today, q),
      csv: async (tx, tenantId, today, q) => pagesCsv(await pagesReport(tx, tenantId, today, q)),
    }),
    page: defineReport({
      title: "Page",
      query: PageQuery,
      json: (tx, tenantId, today, q) => pageReport(tx, tenantId, today, q),
      csv: async (tx, tenantId, today, q) => pageCsv(await pageReport(tx, tenantId, today, q)),
    }),
    sources: defineReport({
      title: "Sources",
      query: SourcesQuery,
      json: (tx, tenantId, today, q) => sourcesReport(tx, tenantId, today, q),
      csv: async (tx, tenantId, today, q) =>
        sourcesCsv(await sourcesReport(tx, tenantId, today, q)),
    }),
    journeys: defineReport({
      title: "Journeys",
      query: PeriodQuery,
      json: (tx, tenantId, today, q) => journeysReport(tx, tenantId, today, q),
      csv: async (tx, tenantId, today, q) =>
        journeysCsv(await journeysReport(tx, tenantId, today, q)),
    }),
    audience: defineReport({
      title: "Audience",
      query: AudienceQuery,
      json: (tx, tenantId, today, q) => audienceReport(tx, tenantId, today, q),
      csv: async (tx, tenantId, today, q) =>
        audienceCsv(await audienceReport(tx, tenantId, today, q)),
    }),
    visits: defineReport({
      title: "Visits",
      query: VisitsQuery,
      json: (tx, tenantId, today, q) => visitsReport(tx, tenantId, today, q),
      csv: async (tx, tenantId, today, q) => visitsCsv(await visitsReport(tx, tenantId, today, q)),
    }),
    visit: defineReport({
      title: "Visit",
      query: VisitQuery,
      json: (tx, tenantId, today, q) => visitReport(tx, tenantId, today, q),
      csv: async (tx, tenantId, today, q) => visitCsv(await visitReport(tx, tenantId, today, q)),
    }),
    // M50: the weekly report as the portal reads it (../portal/weekly.ts), read only.
    [WEEKLY_REPORT]: defineReport({
      title: "Weekly report",
      query: WeeklyQuery,
      json: (tx, tenantId, _today, q) => weeklyReports(tx, tenantId, q),
      csv: (tx, tenantId, _today, q) => weeklyCsv(tx, tenantId, q),
      item: (tx, tenantId, id) => weeklyReport(tx, tenantId, id),
    }),
    sites: defineReport({
      title: "Sites",
      json: (tx, tenantId, today) => sitesReport(tx, tenantId, today),
      csv: async (tx, tenantId, today) =>
        toCsv([
          ["domain", "name", "status", "goals", "data_through", "visits_last_7_days"],
          ...(await sitesReport(tx, tenantId, today)).sites.map((s) => [
            s.domain,
            s.name,
            s.status,
            s.goals.join(" "),
            s.dataThrough,
            s.visitsLast7,
          ]),
        ]),
    }),
  },
  /**
   * People's actions in the back office: add a site, change one (its name, goals, on or off), and
   * fill the Sandbox's last 28 days with sample traffic.
   */
  ACTIONS: {
    "add-site": {
      input: AddSiteInput as z.ZodType,
      run: async (db, ctx) => ({
        site: await addSite(db, { ...ctx, input: ctx.input as z.infer<typeof AddSiteInput> }),
      }),
    },
    "update-site": {
      input: UpdateSiteInput as z.ZodType,
      run: async (db, ctx) => ({
        site: await updateSite(db, {
          tenantId: ctx.tenantId,
          input: ctx.input as z.infer<typeof UpdateSiteInput>,
        }),
      }),
    },
    "sample-traffic": SAMPLE_TRAFFIC_ACTION,
  },
};
