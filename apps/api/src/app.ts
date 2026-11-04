// The Hono app: every /api route, built from injectable dependencies so the same app runs in the
// Worker and in Node tests (with a test database and in-memory Workflow instances).

import { routes } from "@countersign/core";
import { Hono } from "hono";
import type { Bindings } from "./env";
import { type AppDeps, type AppEnv, defaultDeps, errorResponse, requestState } from "./http";
import { connectionRoutes } from "./routes/connections";
import { opsAgentRoutes } from "./routes/ops-agents";
import { opsClientRoutes } from "./routes/ops-clients";
import { opsLineageRoutes } from "./routes/ops-lineage";
import { portalRouteHandlers } from "./routes/portal";
import { sessionRoutes } from "./routes/session";
import { cronTick } from "./runs/dispatch";

export function createApp(deps: AppDeps = defaultDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  // Liveness needs nothing: no database, no session.
  app.get(routes.health.path, (c) => c.json(routes.health.response.parse({ ok: true })));
  app.use("/api/*", requestState(deps));
  sessionRoutes(app);
  opsClientRoutes(app);
  opsAgentRoutes(app);
  opsLineageRoutes(app);
  portalRouteHandlers(app);
  connectionRoutes(app);
  app.all("/api/*", (c) => c.json({ error: { code: "not_found", message: "no such route" } }, 404));
  // An error no route handled (routes answer their own through errorResponse): reported to
  // Sentry there, and answered here in the API's error shape.
  app.onError((error, c) => errorResponse(c, error));
  return app;
}

/** The every-minute cron: re-dispatch undispatched events, start due schedules. */
export async function runCron(env: Bindings, scheduledTime: Date, deps: AppDeps = defaultDeps) {
  const { db, close } = deps.openDb(env);
  try {
    await cronTick({ db, instances: deps.instances(env) }, scheduledTime);
  } finally {
    await close();
  }
}

export const app = createApp();
