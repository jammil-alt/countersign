// The Hono app: every /api route, built from injectable dependencies so the same app runs in the
// Worker and in Node tests (with a test database and in-memory Workflow instances).

import { routes } from "@countersign/core";
import { Hono } from "hono";
import { billingTick } from "./billing/jobs";
import { raiseCodeAlerts } from "./codes/alerts";
import { codesFor } from "./codes/client";
import { purgeRetiredFiles } from "./compliance/retention";
import type { Bindings } from "./env";
import {
  type AppDeps,
  type AppEnv,
  defaultDeps,
  errorResponse,
  requestState,
  stripeFor,
} from "./http";
import { mcpRoutes } from "./mcp/routes";
import { reachOutTick } from "./reach/service";
import { accessRoutes } from "./routes/access";
import { approverRuleRoutes } from "./routes/approver-rules";
import { billingRouteHandlers } from "./routes/billing";
import { browserRoutes } from "./routes/browser";
import { callsSetupRoutes } from "./routes/calls-setup";
import { complianceRouteHandlers } from "./routes/compliance";
import { connectionRoutes } from "./routes/connections";
import { contactRoutes } from "./routes/contacts";
import { directoryRoutes } from "./routes/directory";
import { documentRoutes } from "./routes/documents";
import { exportRoutes } from "./routes/exports";
import { feedbackRouteHandlers } from "./routes/feedback";
import { hookRoutes } from "./routes/hooks";
import { knowledgeRouteHandlers } from "./routes/knowledge";
import { languageRouteHandlers } from "./routes/language";
import { messagingSetupRoutes } from "./routes/messaging-setup";
import { onboardingRouteHandlers } from "./routes/onboarding";
import { opsAgentRoutes } from "./routes/ops-agents";
import { opsBuilderRoutes } from "./routes/ops-builder";
import { opsClientRoutes } from "./routes/ops-clients";
import { opsEventRoutes } from "./routes/ops-events";
import { opsLineageRoutes } from "./routes/ops-lineage";
import { opsMergeRoutes } from "./routes/ops-merge";
import { opsSkillRoutes } from "./routes/ops-skills";
import { portalRouteHandlers } from "./routes/portal";
import { qboCronTick, qboRoutes, qboSyncFor } from "./routes/qbo";
import { reachRoutes } from "./routes/reach";
import { recordRouteHandlers } from "./routes/records";
import { releaseRoutes } from "./routes/release";
import { requestRouteHandlers } from "./routes/requests";
import { sessionRoutes } from "./routes/session";
import { supervisorRouteHandlers } from "./routes/supervisor";
// v0.12 W1-C
import { threadRouteHandlers } from "./routes/threads";
import { twilioHookRoutes } from "./routes/twilio-hooks";
import { twilioVoiceRoutes } from "./routes/twilio-voice";
import { usageRouteHandlers } from "./routes/usage";
import { voiceHookRoutes } from "./routes/voice-hooks";
import { webhookSetupRoutes } from "./routes/webhook-setup";
import { cronTick, USAGE_SWEEP_MINUTE } from "./runs/dispatch";
import { forClient, reachDepsFor, runDepsFromEnv } from "./runs/execute";
import { securityHeaders } from "./security-headers";
import { vaultTick } from "./vault/upkeep";

export function createApp(deps: AppDeps = defaultDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("/api/*", securityHeaders);
  // The MCP server (/mcp) and its OAuth metadata get the same headers (docs/plan.md §1.35).
  app.use("/mcp", securityHeaders);
  app.use("/.well-known/*", securityHeaders);
  // Liveness needs nothing: no database, no session.
  app.get(routes.health.path, (c) => c.json(routes.health.response.parse({ ok: true })));
  app.use("/api/*", requestState(deps));
  sessionRoutes(app);
  opsClientRoutes(app);
  opsAgentRoutes(app);
  opsLineageRoutes(app);
  opsSkillRoutes(app);
  opsBuilderRoutes(app);
  opsMergeRoutes(app);
  opsEventRoutes(app);
  supervisorRouteHandlers(app);
  portalRouteHandlers(app);
  qboRoutes(app);
  connectionRoutes(app);
  webhookSetupRoutes(app);
  hookRoutes(app);
  documentRoutes(app);
  feedbackRouteHandlers(app);
  onboardingRouteHandlers(app);
  requestRouteHandlers(app);
  languageRouteHandlers(app);
  usageRouteHandlers(app);
  recordRouteHandlers(app);
  approverRuleRoutes(app);
  contactRoutes(app);
  directoryRoutes(app);
  reachRoutes(app);
  messagingSetupRoutes(app);
  twilioHookRoutes(app);
  knowledgeRouteHandlers(app);
  callsSetupRoutes(app);
  twilioVoiceRoutes(app);
  voiceHookRoutes(app);
  billingRouteHandlers(app);
  accessRoutes(app);
  releaseRoutes(app);
  browserRoutes(app);
  complianceRouteHandlers(app);
  exportRoutes(app);
  // v0.12 W1-C
  threadRouteHandlers(app);
  // The back office's MCP server (/mcp and its .well-known metadata), after every route it reads.
  mcpRoutes(app, deps);
  app.all("/api/*", (c) => c.json({ error: { code: "not_found", message: "no such route" } }, 404));
  // An error no route handled (routes answer their own through errorResponse): reported to
  // Sentry there, and answered here in the API's error shape.
  app.onError((error, c) => errorResponse(c, error));
  return app;
}

/**
 * The every-minute cron: re-dispatch undispatched events, start due schedules; hourly, after the
 * usage rollup, the billing pass (agent counts, and yesterday's usage report once a day) and the
 * vault's upkeep (re-wrap client keys, re-encrypt v1 credentials as v2).
 */
export async function runCron(env: Bindings, scheduledTime: Date, deps: AppDeps = defaultDeps) {
  const { db, close } = deps.openDb(env);
  try {
    const instances = deps.instances(env);
    const platform = deps.platform(env);
    const codes = codesFor(env);
    await cronTick(
      {
        db,
        instances,
        reachTick: (tenantId, at) =>
          reachOutTick(
            reachDepsFor(forClient(runDepsFromEnv(env, { db, platform, instances }), tenantId)),
            tenantId,
            at,
          ),
        ...(codes
          ? { codesTick: (tenantId: string, at: Date) => raiseCodeAlerts(db, codes, tenantId, at) }
          : {}),
      },
      scheduledTime,
    );
    // QuickBooks: a sync of each connected company every 15 minutes (CDC since the last one).
    await qboCronTick(db, qboSyncFor(deps, env), scheduledTime).catch((error: unknown) =>
      console.error("qbo sync tick failed", error),
    );
    if (scheduledTime.getUTCMinutes() === USAGE_SWEEP_MINUTE) {
      await billingTick({ db, stripe: stripeFor(deps, env) }, scheduledTime);
      // Client data keys: re-wrap after a master key rotation, move v1 envelopes to v2. A failure
      // here waits for the next hour; it never holds up the next tick.
      await vaultTick(db, env).catch((error: unknown) =>
        console.error("vault upkeep failed", error),
      );
      // Retired clients' files, 30 days after retirement (docs/plan.md §1.35).
      await purgeRetiredFiles(db, deps.objects(env), scheduledTime).catch((error: unknown) =>
        console.error("retention sweep failed", error),
      );
    }
  } finally {
    await close();
  }
}

export const app = createApp();
