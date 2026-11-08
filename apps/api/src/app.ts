// The Hono app: every /api route, built from injectable dependencies so the same app runs in the
// Worker and in Node tests (with a test database and in-memory Workflow instances).

import { credentialKeysFromEnv, globalFetch } from "@countersign/connectors";
import { routes } from "@countersign/core";
import type { Db } from "@countersign/db";
import { Hono } from "hono";
import { bankfeedCron } from "./bankfeed/sync";
import { billingTick } from "./billing/jobs";
import { raiseCodeAlerts } from "./codes/alerts";
import { codesFor } from "./codes/client";
import { purgeRetiredFiles } from "./compliance/retention";
import { CAPTURE_CRON_MINUTE, captureCronTick } from "./conversations/cron";
import { captureDepsFor, captureJobsFor } from "./conversations/start";
import type { Bindings } from "./env";
import {
  type AppDeps,
  type AppEnv,
  defaultDeps,
  errorResponse,
  requestState,
  stripeFor,
} from "./http";
// v0.12 W1-A: go-live stages and client controls
import { lifecycleTick } from "./lifecycle/cron";
import { mcpRoutes } from "./mcp/routes";
// P-8: US texting registration
import { a2pCronTick } from "./messaging/a2p";
// v0.12 W2-G
import { originOf } from "./notify/outbox";
// v0.12 W1-B: notifications, the Table and the Weekly Table
import { notifyDepsFromEnv, notifyTick } from "./notify/tick";
import { healthTick } from "./observability/health";
import { reportHandled } from "./observability/report";
import type { RegisteredPack } from "./packs";
// v0.12 W3-B
import { rampCron } from "./ramp/poll";
import { reachOutTick } from "./reach/service";
import { a2pRoutes } from "./routes/a2p";
import { accessRoutes } from "./routes/access";
// v0.12 W2-D: Sloan, the account agent
import { accountRoutes } from "./routes/account";
import { approverRuleRoutes } from "./routes/approver-rules";
import { auditExportRoutes } from "./routes/audit-export";
// v0.12 bankfeed
import { bankfeedRoutes } from "./routes/bankfeed";
import { billingRouteHandlers } from "./routes/billing";
import { browserRoutes } from "./routes/browser";
import { callsSetupRoutes } from "./routes/calls-setup";
import { clientViewRoutes } from "./routes/client-view";
// v0.12 W2-F: the command center, search and plain-words questions
import { commandCenterRoutes } from "./routes/command-center";
import { complianceRouteHandlers } from "./routes/compliance";
import { connectionRoutes } from "./routes/connections";
import { contactRoutes } from "./routes/contacts";
// v0.14 capture: WhatsApp conversations and their capture
import { conversationRouteHandlers } from "./routes/conversations";
import { deskRoutes } from "./routes/desk";
import { directoryRoutes } from "./routes/directory";
import { documentRoutes } from "./routes/documents";
import { exportRoutes } from "./routes/exports";
import { feedbackRouteHandlers } from "./routes/feedback";
// v0.14 W4-E: Google Chat
import { gchatRoutes } from "./routes/gchat";
// v0.14 W4-D: Google Sheets' picking
import { gsheetsRoutes } from "./routes/gsheets";
import { hookRoutes } from "./routes/hooks";
import { knowledgeRouteHandlers } from "./routes/knowledge";
// v0.12 W2-C: the test bench, skill tests and the agent lab
import { labRoutes } from "./routes/lab";
import { languageRouteHandlers } from "./routes/language";
import { lifecycleRoutes } from "./routes/lifecycle";
import { messagingSetupRoutes } from "./routes/messaging-setup";
import { notifyRouteHandlers } from "./routes/notify";
import { onboardingRouteHandlers } from "./routes/onboarding";
import { opsAgentRoutes } from "./routes/ops-agents";
// v0.12 W2-B: automations
import { opsAutomationRoutes } from "./routes/ops-automations";
import { opsBuilderRoutes } from "./routes/ops-builder";
import { opsClientRoutes } from "./routes/ops-clients";
// v0.12 W2-A: the connectors catalog
import { opsConnectorRoutes } from "./routes/ops-connectors";
import { opsEventRoutes } from "./routes/ops-events";
import { opsLineageRoutes } from "./routes/ops-lineage";
import { opsMergeRoutes } from "./routes/ops-merge";
import { opsModelRoutes } from "./routes/ops-models";
// v0.13 W2-I
import { opsOversightRoutes } from "./routes/ops-oversight";
import { opsSkillRoutes } from "./routes/ops-skills";
import { packInboundRoutes } from "./routes/pack-inbound";
// M46
import { packPreviewRoutes } from "./routes/pack-preview";
// P-1: packs (docs/plan.md §1.63).
import { packRouteHandlers } from "./routes/packs";
import { portalRouteHandlers } from "./routes/portal";
import { qboCronTick, qboRoutes, qboSyncFor } from "./routes/qbo";
import { reachRoutes } from "./routes/reach";
import { recordRouteHandlers } from "./routes/records";
import { releaseRoutes } from "./routes/release";
import { requestRouteHandlers } from "./routes/requests";
import { runControlRoutes } from "./routes/run-controls";
import { sessionRoutes } from "./routes/session";
// v0.14 W4-C: the Slack channel picker
import { slackRoutes } from "./routes/slack";
// v0.14 W4-A
// P-6
import { stepInRouteHandlers } from "./routes/step-in";
import { supervisorRouteHandlers } from "./routes/supervisor";
import { tableRouteHandlers } from "./routes/table";
// v0.12 W2-C
import { testbenchRoutes } from "./routes/testbench";
// v0.12 W1-C
import { threadRouteHandlers } from "./routes/threads";
// P-7: message translation
import { translationRoutes } from "./routes/translation";
// v0.12 W2-E
import { triggerRouteHandlers } from "./routes/triggers";
import { twilioHookRoutes } from "./routes/twilio-hooks";
import { twilioVoiceRoutes } from "./routes/twilio-voice";
import { usageRouteHandlers } from "./routes/usage";
import { voiceHookRoutes } from "./routes/voice-hooks";
import { webhookSetupRoutes } from "./routes/webhook-setup";
import { whatsappMetaRoutes } from "./routes/whatsapp-meta";
// v0.14 W4-B
import { zohoRoutes } from "./routes/zoho";
import { cronTick, dispatchByIds, USAGE_SWEEP_MINUTE } from "./runs/dispatch";
import { credentialsFor, forClient, reachDepsFor, runDepsFromEnv } from "./runs/execute";
import { securityHeaders } from "./security-headers";
import {
  TRANSLATION_SWEEP_MINUTE,
  translationDepsFor,
  translationSweep,
} from "./translate/service";
import { vaultTick } from "./vault/upkeep";
import { zohoCronTick } from "./zoho/sync";

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
  // v0.13 W2-H: models for task skills and skill steps.
  opsModelRoutes(app);
  supervisorRouteHandlers(app);
  // v0.12 W1-D: before the portal's routes, so `/api/inbox/batch/resolve` is not read as an item
  // id by `/api/inbox/:id/resolve` (Hono runs handlers in the order they were added).
  deskRoutes(app);
  portalRouteHandlers(app);
  // P-1: packs: enable per client, reports, review cards, actions.
  packRouteHandlers(app);
  qboRoutes(app);
  // v0.14 W4-B: Zoho CRM's notifications.
  zohoRoutes(app);
  // v0.12 bankfeed: Plaid's webhook
  bankfeedRoutes(app);
  connectionRoutes(app);
  // v0.14 W4-D: Google Sheets' picking
  gsheetsRoutes(app);
  webhookSetupRoutes(app);
  hookRoutes(app);
  // M43: what a pack takes from outside with no session (a measured website's beacon).
  packInboundRoutes(app);
  // M46: preview links to a pack's pages before they are public (docs/plan.md §1.76).
  packPreviewRoutes(app);
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
  // v0.12 W1-E
  runControlRoutes(app);
  // v0.12 W1-A: go-live stages and client controls
  lifecycleRoutes(app);
  exportRoutes(app);
  // v0.12 W1-B: notifications, the Table and the Weekly Table
  notifyRouteHandlers(app);
  tableRouteHandlers(app);
  // v0.12 W2-B: automations
  opsAutomationRoutes(app);
  // v0.12 W1-C
  threadRouteHandlers(app);
  // v0.12 W2-D: Sloan, the account agent
  accountRoutes(app);
  // v0.12 W2-G: KPIs and the client view, credits running out, the client's audit export
  clientViewRoutes(app);
  auditExportRoutes(app);
  // v0.12 W2-C: the test bench, skill tests and the agent lab
  testbenchRoutes(app);
  labRoutes(app);
  // v0.12 W2-F: the command center, search and plain-words questions
  commandCenterRoutes(app);
  // v0.12 W2-A: the connectors catalog
  opsConnectorRoutes(app);
  // v0.12 W2-E: the triggers list
  triggerRouteHandlers(app);
  // v0.13 W2-I: run oversight decisions for the agent lab
  opsOversightRoutes(app);
  // v0.14 W4-E: Google Chat's events and the portal's card
  gchatRoutes(app);
  // v0.14 W4-C: the Slack channel picker
  slackRoutes(app);
  // v0.14 capture: WhatsApp conversations and their capture
  conversationRouteHandlers(app);
  // v0.14 W4-A: WhatsApp through Meta (the webhook and the groups setting)
  whatsappMetaRoutes(app);
  // P-6: the client runs it, we step in (docs/plan.md §1.68)
  stepInRouteHandlers(app);
  // P-8: US texting registration, the client admin's details (docs/plan.md §1.70)
  a2pRoutes(app);
  // P-7: message translation's settings (docs/plan.md §1.69)
  translationRoutes(app);
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
    // v0.12 W1-A: pauses whose end passed resume (every minute); trials that met their minimums
    // move to signoff (hourly, at the usage sweep's minute).
    await lifecycleTick(db, scheduledTime).catch((error: unknown) =>
      reportHandled("lifecycle tick failed", error, { job: "lifecycle" }),
    );
    // v0.12 W1-B: the Weekly Table every minute (Friday draft, Monday send) and the notification
    // pass every 5 minutes.
    await notifyTick(db, notifyDepsFromEnv(env, deps.fetch?.(env)), platform, scheduledTime).catch(
      (error: unknown) => reportHandled("notification tick failed", error, { job: "notify" }),
    );
    // QuickBooks: a sync of each connected company every 15 minutes (CDC since the last one).
    await qboCronTick(db, qboSyncFor(deps, env), scheduledTime).catch((error: unknown) =>
      reportHandled("qbo sync tick failed", error, { job: "qbo_sync" }),
    );
    // The platform's own health, hourly (observability/health.ts): failed runs and writes, and once
    // a day what is stuck, to Sentry by error key.
    await healthTick(db, scheduledTime).catch((error: unknown) =>
      reportHandled("health tick failed", error, { job: "health" }),
    );
    // v0.12 W3-B: Ramp's new card transactions every 15 minutes, as events (docs/plan.md §1.52).
    await rampCron(env, { db, instances, platform }, scheduledTime).catch((error: unknown) =>
      reportHandled("ramp poll tick failed", error, { job: "ramp_poll" }),
    );
    // v0.14 W4-B: Zoho CRM, every 15 minutes: the watch renewed when due, then a poll of each
    // connected Zoho (docs/plan.md §1.9 "Sync (W4-B)"). Needs the credentials' key.
    if (env.ENCRYPTION_KEY) {
      await zohoCronTick(
        {
          db,
          platform,
          credentials: credentialsFor(db, credentialKeysFromEnv(env)),
          secret: env.OAUTH_STATE_SECRET,
          origin: env.APP_ORIGIN?.trim() ? originOf(env) : undefined,
        },
        (tenantId, ids) => dispatchByIds({ db, instances }, tenantId, ids),
        scheduledTime,
      ).catch((error: unknown) =>
        reportHandled("zoho sync tick failed", error, { job: "zoho_sync" }),
      );
    }
    // P-8: US texting registrations Twilio has, hourly (docs/plan.md §1.70).
    await a2pCronTick(db, { env, fetch: deps.fetch?.(env) ?? globalFetch() }, scheduledTime).catch(
      (error: unknown) => reportHandled("a2p status tick failed", error, { job: "a2p" }),
    );
    // v0.14 capture: captures left pending start again (every 10 minutes, docs/plan.md §1.55).
    if (scheduledTime.getUTCMinutes() % 10 === CAPTURE_CRON_MINUTE) {
      const capture = captureDepsFor({ db, env, deps, platform });
      await captureCronTick(db, captureJobsFor(env, capture), scheduledTime).catch(
        (error: unknown) => reportHandled("capture restart tick failed", error, { job: "capture" }),
      );
    }
    // v0.12 bankfeed: every connected bank feed once an hour, behind Plaid's webhook (§1.52).
    await bankfeedCron(env, { db, instances, platform }, scheduledTime).catch((error: unknown) =>
      reportHandled("bank feed sync tick failed", error, { job: "bankfeed_sync" }),
    );
    // P-7: hourly, every client with a working language: originals a lost job left untranslated.
    if (scheduledTime.getUTCMinutes() === TRANSLATION_SWEEP_MINUTE) {
      await translationSweep(translationDepsFor({ db, env, deps })).catch((error: unknown) =>
        reportHandled("translation sweep failed", error, { job: "translate" }),
      );
    }
    if (scheduledTime.getUTCMinutes() === USAGE_SWEEP_MINUTE) {
      // v0.12 W2-G: `origin` for the credits notifications the pass queues.
      await billingTick({ db, stripe: stripeFor(deps, env), origin: originOf(env) }, scheduledTime);
      // Client data keys: re-wrap after a master key rotation, move v1 envelopes to v2. A failure
      // here waits for the next hour; it never holds up the next tick.
      await vaultTick(db, env).catch((error: unknown) =>
        reportHandled("vault upkeep failed", error, { job: "vault" }),
      );
      // Retired clients' files, 30 days after retirement (docs/plan.md §1.35).
      await purgeRetiredFiles(db, deps.objects(env), scheduledTime).catch((error: unknown) =>
        reportHandled("retention sweep failed", error, { job: "retention" }),
      );
    }
    // M43: each pack's nightly pass (the Marketing pack's build of yesterday's visits and its
    // retention sweep), at the pack's own UTC hour and minute. One client's failure is reported
    // and the pass goes on with the next.
    await packNightly(db, platform.packs, scheduledTime).catch((error: unknown) =>
      reportHandled("pack nightly tick failed", error, { job: "pack_nightly" }),
    );
  } finally {
    await close();
  }
}

/** Runs every registered pack's nightly pass whose hour and minute this tick is. */
export async function packNightly(
  db: Db,
  packs: readonly RegisteredPack[],
  at: Date,
): Promise<number> {
  let ran = 0;
  for (const pack of packs) {
    const n = pack.nightly;
    if (!n || at.getUTCHours() !== n.hour || at.getUTCMinutes() !== n.minute) continue;
    ran += 1;
    const tags = { job: "pack_nightly", pack: pack.manifest.id };
    await n
      .run(db, at, (tenantId, error) =>
        reportHandled("pack nightly failed for a client", error, { ...tags, tenant: tenantId }),
      )
      .catch((error: unknown) => reportHandled("pack nightly failed", error, tags));
  }
  return ran;
}

export const app = createApp();
