// The client file and saved starts (docs/plan.md §1.125; docs/cases-plan.md §4.1, §4.3): operator
// only, in a transaction scoped to the clients the operator serves (a prospect's file names none).
// Facts are only added; a correction names the fact it replaces. Starts are seeded in code (General
// only, one per area, one per template, Just the account) and archived, never deleted.
//
// Stream SALES builds the handlers; until then each answers 501 `not_built`.

import { routes } from "@countersign/core";
import type { Hono } from "hono";
import { type AppEnv, mount } from "../http";
import { notBuilt } from "../onboarding/not-built";

export function clientFileRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.opsClientFiles, async () => {
    throw notBuilt("SALES", "opsClientFiles");
  });
  mount(app, routes.opsCreateClientFile, async () => {
    throw notBuilt("SALES", "opsCreateClientFile");
  });
  mount(app, routes.opsClientFile, async () => {
    throw notBuilt("SALES", "opsClientFile");
  });
  mount(app, routes.opsUpdateClientFile, async () => {
    throw notBuilt("SALES", "opsUpdateClientFile");
  });
  mount(app, routes.opsAddClientFacts, async () => {
    throw notBuilt("SALES", "opsAddClientFacts");
  });
  mount(app, routes.opsStarts, async () => {
    throw notBuilt("SALES", "opsStarts");
  });
  mount(app, routes.opsCreateStart, async () => {
    throw notBuilt("SALES", "opsCreateStart");
  });
  mount(app, routes.opsUpdateStart, async () => {
    throw notBuilt("SALES", "opsUpdateStart");
  });
}
