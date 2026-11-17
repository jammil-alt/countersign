// The welcome page (docs/plan.md §1.125; docs/cases-plan.md §4.4): `/start/<token>`, seen without
// sign-in, opened by the signed welcome link (../onboarding/link.ts). Reading it logs `opened` on
// the intake once (no tracking pixels). It shows names, the lead's note and what's in it; never the
// file, an answer or anything of ours. The token is never a way in on its own.
//
// Stream EMAIL builds the handler; until then it answers 501 `not_built`.

import { routes } from "@countersign/core";
import type { Hono } from "hono";
import { type AppEnv, mountPublic } from "../http";
import { notBuilt } from "../onboarding/not-built";

export function welcomeRoutes(app: Hono<AppEnv>): void {
  mountPublic(app, routes.welcomePage, async () => {
    throw notBuilt("EMAIL", "welcomePage");
  });
}
