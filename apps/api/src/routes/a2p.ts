// P-8: US texting registration (A2P 10DLC) by API (docs/plan.md §1.70). The client admin gives
// the business details in the portal (the EIN write-only, into the vault); the operator's submit
// is in messaging-setup.ts with the rest of the client's texting setup. The portal's answers carry
// no SID, fee or cost.

import { readTwilioConfig } from "@countersign/connectors";
import { A2P_USES, A2pBusinessDetails, normalizeEin, routes } from "@countersign/core";
import type { Hono } from "hono";
import { z } from "zod";
import { type AppEnv, HttpError, mount } from "../http";
import { portalView, saveDetails, twilioConnectionOf } from "../messaging/a2p";

export function a2pRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.portalTextingRegistration, async ({ tx, tenantIds }) => {
    const tenantId = tenantIds[0] as string;
    const row = await twilioConnectionOf(tx, tenantId);
    return { registration: portalView(row, row ? readTwilioConfig(row.config) : null) };
  });

  mount(
    app,
    routes.portalSaveTextingRegistration,
    async ({ tx, tenantIds, body, session, services }) => {
      const tenantId = tenantIds[0] as string;
      const row = await twilioConnectionOf(tx, tenantId);
      const config = row ? readTwilioConfig(row.config) : null;
      if (!row || !config || row.status !== "connected") {
        throw new HttpError(
          409,
          "not_available",
          "texting isn't set up for you yet; ask us to set it up",
        );
      }
      // DECISION: a use the form doesn't offer is refused by name when it is marketing, so the
      // client reads why (owner, 2026-11-08: never marketing).
      const unknown = body.details.uses.filter((u) => !(A2P_USES as readonly string[]).includes(u));
      if (unknown.some((u) => u.toLowerCase().includes("marketing"))) {
        throw new HttpError(
          422,
          "marketing_refused",
          "we register texting for your own team, vendors and customer care, never marketing",
        );
      }
      const parsed = A2pBusinessDetails.safeParse(body.details);
      if (!parsed.success) {
        throw new HttpError(422, "invalid_details", z.prettifyError(parsed.error));
      }
      let ein: string | null = null;
      if (body.ein !== undefined) {
        ein = normalizeEin(body.ein);
        if (!ein)
          throw new HttpError(422, "invalid_ein", "an EIN has nine digits, like 12-3456789");
      }
      const next = await saveDetails(tx, services.env, {
        row,
        config,
        details: parsed.data,
        ein,
        actorId: session.user.id,
        now: new Date(),
      });
      return { registration: portalView(row, next) };
    },
  );
}
