// The measurement area (M43; M44 adds the read screens' reports): a client's measured sites, the
// overview report, and the back office's site actions. Its collector and nightly build are the
// pack's `inbound` and `nightly` hooks (manifest.ts), not part of an area.
// Owned by the screens builder from M44 (docs/marketing-plan.md §11).

import type { z } from "zod";
import type { AreaModule } from "../pack";
import { overview, overviewCsv } from "../reports";
import { AddSiteInput, addSite, UpdateSiteInput, updateSite } from "../sites";

export const AREA: AreaModule = {
  TOOLS: [],
  SKILLS: [],
  TEMPLATES: [],
  EVENTS: [],
  SCREENS: [
    {
      route: "/reports/marketing/overview",
      title: "Website",
      roles: ["client_admin", "client_user"],
    },
  ],
  REPORTS: {
    overview: {
      title: "Website",
      json: async (tx, tenantId, today) => ({ ...(await overview(tx, tenantId, today)) }),
      csv: async (tx, tenantId, today) => overviewCsv(await overview(tx, tenantId, today)),
    },
  },
  /** People's actions in the back office: add a site, change one (its name, goals, on or off). */
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
  },
};
