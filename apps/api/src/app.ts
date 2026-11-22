// The Hono app: every /api route, built from injectable dependencies so the same app runs in the
// Worker and in Node tests (with a test database and in-memory Workflow instances).

import { credentialKeysFromEnv, globalFetch } from "@countersign/connectors";
import { parseCoveredProcessors, routes } from "@countersign/core";
import type { Db } from "@countersign/db";
import { checkMissingReports } from "@countersign/documents";
import { Hono } from "hono";
import { sloanTick } from "./account/sloan";
import { SUMMARY_CALL_TIMEOUT_MS, summaryPass } from "./account/summaries";
import { assuranceTick } from "./assurance/run";
// §1.124 back office work: Reggie's pass, email, chases, questions and spotting
import { backOfficeTick } from "./backoffice/tick";
import { bankfeedCron } from "./bankfeed/sync";
import { billingTick } from "./billing/jobs";
import { raiseCodeAlerts } from "./codes/alerts";
import { codesFor } from "./codes/client";
import { clientModels } from "./compliance/models";
import { purgeRetiredFiles } from "./compliance/retention";
import { CAPTURE_CRON_MINUTE, captureCronTick } from "./conversations/cron";
import { captureDepsFor, captureJobsFor } from "./conversations/start";
import { shipDue, shipPass } from "./dev-queue/ship";
import { readingSweep } from "./documents/sweep";
import type { Bindings } from "./env";
// §1.121: forms, "Request info"
import { formsTick } from "./forms/service";
import { platformHealthTick } from "./health/watch";
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
import { closeRetiredTwilio } from "./messaging/close";
import { mailerFromEnv } from "./notify/mailer";
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
import { deployedSha, readyRoutes } from "./ready";
import { requestOrigin } from "./request-origin";
import { a2pRoutes } from "./routes/a2p";
import { accessRoutes } from "./routes/access";
// v0.12 W2-D: Sloan, the account agent
import { accountRoutes } from "./routes/account";
import { agentReportRouteHandlers } from "./routes/agent-report";
import { approverRuleRoutes } from "./routes/approver-rules";
import { assistDraftRoutes } from "./routes/assist";
import { assuranceEnv, assuranceRouteHandlers } from "./routes/assurance";
import { auditExportRoutes } from "./routes/audit-export";
// §1.124 back office work: Reggie and Autopilot
import { autopilotRoutes } from "./routes/autopilot";
// v0.12 bankfeed
import { bankfeedRoutes } from "./routes/bankfeed";
import { billingRouteHandlers } from "./routes/billing";
import { browserRoutes } from "./routes/browser";
import { browserScriptRoutes } from "./routes/browser-scripts";
import { buildTryRoutes } from "./routes/build-tries";
import { callsSetupRoutes } from "./routes/calls-setup";
// R4: business hours, person hours and channels (docs/plan.md §1.86)
import { channelRoutes } from "./routes/channels";
import { clientFileRoutes } from "./routes/client-files";
import { clientViewRoutes } from "./routes/client-view";
// v0.12 W2-F: the command center, search and plain-words questions
import { commandCenterRoutes } from "./routes/command-center";
import { complianceRouteHandlers } from "./routes/compliance";
import { connectionRoutes } from "./routes/connections";
import { connectorAccessRouteHandlers } from "./routes/connector-access";
import { contactRoutes } from "./routes/contacts";
// v0.14 capture: WhatsApp conversations and their capture
import { conversationRouteHandlers } from "./routes/conversations";
// §1.124 back office work: Sales
import { dealRoutes } from "./routes/deals";
import { deskRoutes } from "./routes/desk";
import { desktopApiRoutes } from "./routes/desktop";
import { directoryRoutes } from "./routes/directory";
import { documentRoutes } from "./routes/documents";
import { evidenceRouteHandlers } from "./routes/evidence";
import { excelRoutes } from "./routes/excel";
import { exportRoutes } from "./routes/exports";
import { feedbackRouteHandlers } from "./routes/feedback";
// §1.121: forms, "Request info"
import { formRoutes } from "./routes/forms";
// v0.14 W4-E: Google Chat
import { gchatRoutes } from "./routes/gchat";
import { gettingStartedRoutes } from "./routes/getting-started";
// v0.14 W4-D: Google Sheets' picking
import { gsheetsRoutes } from "./routes/gsheets";
import { hookRoutes } from "./routes/hooks";
import { hoursRoutes } from "./routes/hours";
import { intakeRoutes } from "./routes/intake";
import { inviteRoutes } from "./routes/invite";
import { knowledgeRouteHandlers } from "./routes/knowledge";
// v0.12 W2-C: the test bench, skill tests and the agent lab
import { labRoutes } from "./routes/lab";
import { languageRouteHandlers } from "./routes/language";
import { leadRequestRoutes } from "./routes/lead-requests";
import { ledgerRoutes } from "./routes/ledger";
// R8: the Library's banks (docs/plan.md §1.86)
import { libraryRoutes } from "./routes/library";
import { lifecycleRoutes } from "./routes/lifecycle";
// docs/builder-plan.md §5 (B3): the agent manual
import { manualRouteHandlers } from "./routes/manual";
import { messagingSetupRoutes } from "./routes/messaging-setup";
// §1.116: the phone app
import { mobileRoutes, mobileSession } from "./routes/mobile";
import { notifyRouteHandlers } from "./routes/notify";
import { onboardingRouteHandlers } from "./routes/onboarding";
import { operatorRouteHandlers } from "./routes/operators";
import { opsAgentRoutes } from "./routes/ops-agents";
// v0.12 W2-B: automations
import { opsAutomationRoutes } from "./routes/ops-automations";
import { opsBuilderRoutes } from "./routes/ops-builder";
import { opsBuildRoutes } from "./routes/ops-builds";
import { opsClientRoutes } from "./routes/ops-clients";
import { opsCodeRequestRoutes } from "./routes/ops-code-requests";
// v0.12 W2-A: the connectors catalog
import { opsConnectorRoutes } from "./routes/ops-connectors";
import { opsEventRoutes } from "./routes/ops-events";
// Reshape data (2026-11-11)
// §1.164: Read table's sample-file check
import { opsIntakeReportRoutes } from "./routes/ops-intake-reports";
import { opsLabClearRoutes } from "./routes/ops-lab-clear";
import { opsLineageRoutes } from "./routes/ops-lineage";
import { opsMergeRoutes } from "./routes/ops-merge";
import { opsModelRoutes } from "./routes/ops-models";
// v0.13 W2-I
import { opsOversightRoutes } from "./routes/ops-oversight";
import { opsReadTableRoutes } from "./routes/ops-read-table";
import { opsReshapeRoutes } from "./routes/ops-reshape";
import { opsSkillRoutes } from "./routes/ops-skills";
import { ownerRoutes } from "./routes/owners";
import { packInboundRoutes } from "./routes/pack-inbound";
// M46
import { packPreviewRoutes } from "./routes/pack-preview";
// P-1: packs (docs/plan.md §1.63).
import { packRouteHandlers } from "./routes/packs";
import { portalRouteHandlers } from "./routes/portal";
import { portalIssueRouteHandlers } from "./routes/portal-issues";
import { qboCronTick, qboRoutes, qboSyncFor } from "./routes/qbo";
import { reachRoutes } from "./routes/reach";
import { recordRouteHandlers } from "./routes/records";
import { reggieRoutes } from "./routes/reggie";
import { releaseRoutes } from "./routes/release";
import { requestRouteHandlers } from "./routes/requests";
import { resendHookRoutes } from "./routes/resend-hooks";
import { runAuditRouteHandlers } from "./routes/run-audit";
import { runControlRoutes } from "./routes/run-controls";
import {
  claudeConnectionRoutes,
  secondFactorRoutes,
  setupLinkRoutes,
} from "./routes/second-factor";
import { sessionRoutes } from "./routes/session";
import { signInApprovalRoutes } from "./routes/sign-in-approvals";
// v0.14 W4-C: the Slack channel picker
import { slackRoutes } from "./routes/slack";
// §1.150: Sloan by email and text
import { sloanReachRoutes } from "./routes/sloan-reach";
import { sopRouteHandlers } from "./routes/sop";
// v0.14 W4-A
// P-6
import { stepInRouteHandlers } from "./routes/step-in";
import { supervisorRouteHandlers } from "./routes/supervisor";
import { tableRouteHandlers } from "./routes/table";
// §1.114
import { teamsRoutes } from "./routes/teams";
// v0.12 W2-C
import { testbenchRoutes } from "./routes/testbench";
import { textSignupRoutes } from "./routes/text-signup";
// v0.12 W1-C
import { threadRouteHandlers } from "./routes/threads";
// §1.124.3 back office work: Your call
import { todoRoutes } from "./routes/todos";
// P-7: message translation
import { translationRoutes } from "./routes/translation";
// v0.12 W2-E
import { portalTriggerRoutes, triggerRouteHandlers } from "./routes/triggers";
import { twilioHookRoutes } from "./routes/twilio-hooks";
import { twilioVoiceRoutes } from "./routes/twilio-voice";
import { usageRouteHandlers } from "./routes/usage";
import { voiceRoutes } from "./routes/voice";
import { voiceHookRoutes } from "./routes/voice-hooks";
import { webhookSetupRoutes } from "./routes/webhook-setup";
import { welcomeRoutes } from "./routes/welcome";
import { whatsappMetaRoutes } from "./routes/whatsapp-meta";
// §1.124 back office work
import { workRouteHandlers } from "./routes/work";
// v0.14 W4-B
import { zohoRoutes } from "./routes/zoho";
import { cronTick, dispatchByIds, senseEmitter, USAGE_SWEEP_MINUTE } from "./runs/dispatch";
import {
  credentialsFor,
  forClient,
  reachDepsFor,
  runDepsFromEnv,
  runtimeFor,
} from "./runs/execute";
import { reconcileRuns } from "./runs/reconcile";
import { staleWritesTick } from "./runs/stale-writes";
// docs/plan.md §1.188
import { runSubjectBackfillTick } from "./runs/subject-log";
// M45: Search Console and Bing, nightly (docs/plan.md §1.75).
import { searchSyncTick } from "./search-sync";
import { securityHeaders } from "./security-headers";
import { sopCheckTick } from "./sop/revisions";
import {
  TRANSLATION_SWEEP_MINUTE,
  translationDepsFor,
  translationSweep,
} from "./translate/service";
// R5: the undo a late no is offered (docs/plan.md §9)
import { undoRouteHandlers } from "./undo/routes";
import { vaultTick } from "./vault/upkeep";
import { adoptLegacy } from "./work/legacy";
import { zohoCronTick } from "./zoho/sync";

export function createApp(deps: AppDeps = defaultDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("/api/*", securityHeaders);
  // The MCP server (/mcp) and its OAuth metadata get the same headers (docs/plan.md §1.35).
  app.use("/mcp", securityHeaders);
  app.use("/.well-known/*", securityHeaders);
  // State-changing requests come from the app's own pages (./request-origin.ts), checked before
  // the phone app's header is read as a cookie.
  app.use("/api/*", requestOrigin);
  // Liveness needs nothing: no database, no session.
  app.get(routes.health.path, (c) => c.json(routes.health.response.parse({ ok: true })));
  // §1.116: the phone app's session header, read as the session cookie (before anything reads it).
  app.use("/api/*", mobileSession);
  app.use("/api/*", requestState(deps));
  // docs/plan.md §1.125: the first request on a newly deployed commit checks the Dev queue's
  // expected parts against this catalog (after the response, beside its deferred work).
  app.use("/api/*", async (c, next) => {
    await next();
    const sha = deployedSha(c.env?.DEPLOYED_SHA);
    if (!sha || !shipDue(sha, Date.now())) return;
    const state = c.get("req");
    state.deferred.push(async () => {
      const services = state.services();
      await shipPass(
        {
          db: services.db,
          platform: services.platform,
          notify: notifyDepsFromEnv(services.env, deps.fetch?.(services.env)),
          environment: services.env.ENVIRONMENT,
        },
        new Date(),
      ).catch((error: unknown) =>
        reportHandled("dev queue ship pass failed", error, { job: "dev_queue" }),
      );
    });
  });
  // Readiness reaches the database through the request's client, so it comes after requestState.
  readyRoutes(app);
  sessionRoutes(app);
  // §1.100
  secondFactorRoutes(app);
  // Owner, 2026-11-19: the emailed link that sets up a first method
  setupLinkRoutes(app);
  // §1.116: the phone app
  mobileRoutes(app);
  // docs/plan.md §1.204: the desktop app (pairing, folders, and the computer's signed routes).
  desktopApiRoutes(app);
  // §1.154: approving a sign-in on the phone
  signInApprovalRoutes(app);
  claudeConnectionRoutes(app);
  opsClientRoutes(app);
  opsAgentRoutes(app);
  opsLineageRoutes(app);
  opsSkillRoutes(app);
  opsBuilderRoutes(app);
  // Reshape data (2026-11-11): propose a Reshape step's mapping, and its sample values.
  opsReshapeRoutes(app);
  opsReadTableRoutes(app);
  opsIntakeReportRoutes(app);
  opsMergeRoutes(app);
  opsEventRoutes(app);
  // v0.13 W2-H: models for task skills and skill steps.
  opsModelRoutes(app);
  supervisorRouteHandlers(app);
  // v0.12 W1-D: before the portal's routes, so `/api/inbox/batch/resolve` is not read as an item
  // id by `/api/inbox/:id/resolve` (Hono runs handlers in the order they were added).
  deskRoutes(app);
  undoRouteHandlers(app);
  portalRouteHandlers(app);
  // P-1: packs: enable per client, reports, review cards, actions.
  packRouteHandlers(app);
  qboRoutes(app);
  // v0.14 W4-B: Zoho CRM's notifications.
  zohoRoutes(app);
  // v0.12 bankfeed: Plaid's webhook
  bankfeedRoutes(app);
  connectionRoutes(app);
  // Connectors C4 (docs/connectors-plan.md §3, §7): the Connectors place and the back office's tab.
  connectorAccessRouteHandlers(app);
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
  operatorRouteHandlers(app);
  requestRouteHandlers(app);
  languageRouteHandlers(app);
  usageRouteHandlers(app);
  // R4 (docs/plan.md §1.214): the report per agent, both surfaces.
  agentReportRouteHandlers(app);
  recordRouteHandlers(app);
  approverRuleRoutes(app);
  // Round 4 D (docs/plan.md §1.211)
  evidenceRouteHandlers(app);
  contactRoutes(app);
  // docs/plan.md §1.98
  textSignupRoutes(app);
  sloanReachRoutes(app);
  // §1.121: forms, "Request info": the public page's routes
  formRoutes(app);
  // docs/plan.md §1.101: Reggie, and the lead's requests on a client admin's Desk
  leadRequestRoutes(app);
  reggieRoutes(app);
  // docs/plan.md §1.108: builds, from intake to go-live
  opsBuildRoutes(app);
  opsLabClearRoutes(app);
  // builder-plan.md B1: try the draft on real examples in the POC test
  buildTryRoutes(app);
  // docs/plan.md §1.125: the Dev queue
  opsCodeRequestRoutes(app);
  // §1.124 back office work
  dealRoutes(app);
  // §1.149 onboarding v1: client files and starts, Invite and Sign up now, the intake, the welcome page
  clientFileRoutes(app);
  inviteRoutes(app);
  intakeRoutes(app);
  welcomeRoutes(app);
  // §1.220: onboarding emails delivered or bounced, from Resend's webhook
  resendHookRoutes(app);
  // docs/plan.md §1.109: voice typing
  voiceRoutes(app);
  // docs/plan.md §1.168: Draft for long text fields
  assistDraftRoutes(app);
  directoryRoutes(app);
  // The back office's chart of accounts (docs/plan.md §1.79).
  ledgerRoutes(app);
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
  // Wave 4 (docs/plan.md §1.86 "Scripts (wave 4)")
  browserScriptRoutes(app);
  complianceRouteHandlers(app);
  // v0.12 W1-E
  runControlRoutes(app);
  // v0.12 W1-A: go-live stages and client controls
  lifecycleRoutes(app);
  // docs/setup-plan.md (§1.206): Getting started's chapters and the Setup tab.
  gettingStartedRoutes(app);
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
  // docs/builder-plan.md §5 (B3): the agent manual
  manualRouteHandlers(app);
  sopRouteHandlers(app);
  assuranceRouteHandlers(app);
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
  portalTriggerRoutes(app);
  // v0.13 W2-I: run oversight decisions for the agent lab
  opsOversightRoutes(app);
  // v0.19: area owners (ARCHITECTURE §10.15)
  ownerRoutes(app);
  // Wave 6: the audit queue, marks, stats, sampling settings and the run export (plan §1.86)
  runAuditRouteHandlers(app);
  // v0.14 W4-E: Google Chat's events and the portal's card
  gchatRoutes(app);
  // v0.14 W4-C: the Slack channel picker
  slackRoutes(app);
  // §1.114: Microsoft Teams (the bot's endpoint and the channels card).
  teamsRoutes(app);
  // §1.114: Excel's picking.
  excelRoutes(app);
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
  // R4: business hours, person hours and channels (docs/plan.md §1.86)
  hoursRoutes(app);
  channelRoutes(app);
  // R8: the Library's banks (docs/plan.md §1.86)
  libraryRoutes(app);
  // §1.124 back office work
  workRouteHandlers(app);
  portalIssueRouteHandlers(app);
  todoRoutes(app);
  autopilotRoutes(app);
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
        reachTick: async (tenantId, at) => {
          await reachOutTick(
            reachDepsFor(forClient(runDepsFromEnv(env, { db, platform, instances }), tenantId)),
            tenantId,
            at,
          );
          // §1.121: form requests past their due date close, and answered ones wake their runs.
          await formsTick({ db, instances }, tenantId, at);
        },
        ...(codes
          ? { codesTick: (tenantId: string, at: Date) => raiseCodeAlerts(db, codes, tenantId, at) }
          : {}),
        // v0.19: Sloan's old watches, as platform code (ARCHITECTURE §10.15).
        healthTick: async (tenantId, at, timeZone) => {
          const run = forClient(runDepsFromEnv(env, { db, platform, instances }), tenantId);
          await platformHealthTick({ db, runtime: runtimeFor(run) }, tenantId, at, timeZone);
        },
        // docs/plan.md §1.213: a scheduled report that didn't arrive raises its alert.
        intakeTick: (tenantId, at, timeZone) =>
          checkMissingReports(db, tenantId, { now: at, timezone: timeZone ?? "UTC" }),
      },
      scheduledTime,
    );
    // v0.12 W1-A: pauses whose end passed resume (every minute); trials that met their minimums
    // move to signoff (hourly, at the usage sweep's minute).
    // §1.124 back office work: change requests and Feedback raised before Build, adopted hourly.
    await adoptLegacy(db, scheduledTime).catch((error: unknown) =>
      reportHandled("adopting requests failed", error, { job: "work_adopt" }),
    );
    // §1.124 back office work: Reggie reads new issues (every minute), emails go, chases, questions
    // (hourly) and expansion spotting (nightly).
    await backOfficeTick(
      {
        db,
        // No one client: the tick works across clients, and its model reads (Reggie's, readOne)
        // refuse a client in HIPAA mode without a BAA themselves (backoffice/reggie-pass.ts).
        transport: clientModels({ deps, env }, { clients: [], read: db }),
        mailer: mailerFromEnv(env, deps.fetch?.(env)),
        domain: env.EMAIL_FORWARDING_DOMAIN,
        covered: parseCoveredProcessors(env.BAA_PROCESSORS),
      },
      scheduledTime,
    ).catch((error: unknown) =>
      reportHandled("back office tick failed", error, { job: "backoffice" }),
    );
    await lifecycleTick(db, scheduledTime).catch((error: unknown) =>
      reportHandled("lifecycle tick failed", error, { job: "lifecycle" }),
    );
    // docs/sop-plan.md §6: hourly, an agent whose SOP changed without a revision gets one.
    await sopCheckTick(db, platform, scheduledTime).catch((error: unknown) =>
      reportHandled("sop check tick failed", error, { job: "sop_check" }),
    );
    // docs/plan.md §1.188: hourly, what the last 90 days of runs were about, until all are kept.
    await runSubjectBackfillTick(db, platform, scheduledTime).catch((error: unknown) =>
      reportHandled("run subject backfill failed", error, { job: "run_subject" }),
    );
    // docs/agent-assurance-plan.md §6: nightly, every live client agent's security checks.
    await assuranceTick(db, platform, assuranceEnv(env, deps.objects(env)), scheduledTime).catch(
      (error: unknown) => reportHandled("assurance tick failed", error, { job: "assurance" }),
    );
    // Sloan on by default (docs/plan.md §1.47): hourly, clients without it get it turned on.
    await sloanTick(db, platform, scheduledTime).catch((error: unknown) =>
      reportHandled("sloan tick failed", error, { job: "sloan" }),
    );
    // v0.12 W1-B: the Weekly Table every minute (Friday draft, Monday send) and the notification
    // pass every 5 minutes.
    await notifyTick(db, notifyDepsFromEnv(env, deps.fetch?.(env)), platform, scheduledTime).catch(
      (error: unknown) => reportHandled("notification tick failed", error, { job: "notify" }),
    );
    // docs/plan.md §1.125: after a deploy (a commit this isolate hasn't checked) and every 15
    // minutes, requests whose expected part is in the catalog now are shipped, and claims lapse.
    if (shipDue(deployedSha(env.DEPLOYED_SHA), scheduledTime.getTime())) {
      await shipPass(
        {
          db,
          platform,
          notify: notifyDepsFromEnv(env, deps.fetch?.(env)),
          environment: env.ENVIRONMENT,
        },
        scheduledTime,
      ).catch((error: unknown) =>
        reportHandled("dev queue ship pass failed", error, { job: "dev_queue" }),
      );
    }
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
    // M45: search figures (Search Console, Bing), nightly at 03:11 UTC, and hourly for a
    // connection never synced yet (docs/plan.md §1.75). Needs the credentials' key.
    if (env.ENCRYPTION_KEY) {
      await searchSyncTick(
        { db, platform, credentials: credentialsFor(db, credentialKeysFromEnv(env)) },
        scheduledTime,
      ).catch((error: unknown) =>
        reportHandled("search sync tick failed", error, { job: "search_sync" }),
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
      // A failure is reported; the vault, retention and pack passes below still run.
      await billingTick(
        { db, stripe: stripeFor(deps, env), origin: originOf(env) },
        scheduledTime,
      ).catch((error: unknown) => reportHandled("billing tick failed", error, { job: "billing" }));
      // Client data keys: re-wrap after a master key rotation, move v1 envelopes to v2. A failure
      // here waits for the next hour; it never holds up the next tick.
      await vaultTick(db, env).catch((error: unknown) =>
        reportHandled("vault upkeep failed", error, { job: "vault" }),
      );
      // §1.160: retired clients' Twilio numbers released and subaccounts closed.
      await closeRetiredTwilio(
        db,
        { env, fetch: deps.fetch?.(env) ?? globalFetch() },
        scheduledTime,
      ).catch((error: unknown) =>
        reportHandled("closing retired clients' Twilio failed", error, { job: "twilio_close" }),
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
    // Audit 3.2: writes left executing that no run will take over go to the operator's review.
    await staleWritesTick(db, scheduledTime, senseEmitter(platform.events)).catch(
      (error: unknown) => reportHandled("stale writes tick failed", error, { job: "stale_writes" }),
    );
    // Last, after every other pass, so their slower work never holds the others up:
    // every 10 minutes, runs that never started are started or failed, runs whose instance ended
    // without finishing them are failed (runs/reconcile.ts);
    await reconcileRuns({ db, instances }, scheduledTime).catch((error: unknown) =>
      reportHandled("run reconciler failed", error, { job: "reconcile" }),
    );
    // every 5 minutes, documents whose reading on arrival was cut off are read again, within a
    // time budget (documents/sweep.ts).
    await readingSweep({ db, env, deps }, scheduledTime).catch((error: unknown) =>
      reportHandled("reading sweep failed", error, { job: "reading_sweep" }),
    );
    // and last of all, the only pass that calls a model every minute: each person's quiet
    // conversations summarized for next time (v0.19, §10.15). Audit 4.1: within a budget, each
    // call with its own time limit and never retried, so a slow model holds up no other pass.
    await summaryPass(
      {
        db,
        // Each person's conversations are their client's: held to its HIPAA mode (§1.35).
        transportFor: (tenantId) =>
          clientModels(
            { deps, env },
            { clients: [tenantId], read: db },
            { timeoutMs: SUMMARY_CALL_TIMEOUT_MS, maxRetries: 0 },
          ),
        report: (tenantId, error) =>
          reportHandled(`summaries for client ${tenantId} failed`, error, {
            job: "summaries",
            client: tenantId,
          }),
      },
      new Date(Math.floor(scheduledTime.getTime() / 60_000) * 60_000),
    ).catch((error: unknown) => reportHandled("summaries failed", error, { job: "summaries" }));
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
