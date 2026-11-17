// Invite and Sign up now (docs/plan.md §1.125; docs/cases-plan.md §4.2, §4.3): the operator's
// confirm, always (cases-plan §6). The previews change nothing; the sends run `runInvite`
// (../onboarding/invite.ts) as slow routes, since they call other routes through `invokeRoute`.
//
// Stream SALES builds the handlers; until then each answers 501 `not_built`.

import { routes } from "@countersign/core";
import type { Hono } from "hono";
import { type AppEnv, mount, mountLong } from "../http";
import { notBuilt } from "../onboarding/not-built";

export function inviteRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.opsInvitePreview, async () => {
    throw notBuilt("SALES", "opsInvitePreview");
  });
  mountLong(app, routes.opsInviteSend, async () => {
    throw notBuilt("SALES", "opsInviteSend");
  });
  mount(app, routes.opsSignUpPreview, async () => {
    throw notBuilt("SALES", "opsSignUpPreview");
  });
  mountLong(app, routes.opsSignUp, async () => {
    throw notBuilt("SALES", "opsSignUp");
  });
}
