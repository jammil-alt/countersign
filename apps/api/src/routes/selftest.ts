// The connector self-test from the back office and the MCP server (2026-11-28): run it now on the
// Sandbox client, or read each connection's latest results. Operators only, audited by mountLong
// (invariant 14); the run holds no request transaction while it calls the providers.

import { selftestRoutes } from "@countersign/core";
import type { Hono } from "hono";
import { type AppEnv, ensureClient, HttpError, mountLong, type Services } from "../http";
import {
  lastSelftest,
  refuseUnlessSandbox,
  runSelftest,
  selftestDepsFrom,
} from "../selftest/runner";

function selftestDepsFor(services: Services) {
  const deps = selftestDepsFrom(services.env, services);
  if (!deps) throw new HttpError(503, "not_configured", "connections' keys aren't set up here");
  return deps;
}

export function selftestRouteHandlers(app: Hono<AppEnv>): void {
  mountLong(app, selftestRoutes.opsClientSelftestRun, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    await refuseUnlessSandbox(ctx.services.db, ctx.services.env.ENVIRONMENT, ctx.params.id);
    return runSelftest(selftestDepsFor(ctx.services), ctx.params.id, {
      kind: "operator",
      userId: ctx.session.user.id,
    });
  });
  mountLong(app, selftestRoutes.opsClientSelftestLast, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    return lastSelftest(ctx.services.db, ctx.params.id);
  });
}
