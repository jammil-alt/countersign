// The registries the API and the runs share (docs/plan.md §2): tools from the platform's own list
// and each registered connector's manifest, built-in skills, and event types. This is the one
// place that names connectors (and, later, packs); nothing in packages/* does.

import {
  // v0.12 W2-D
  ACCOUNT_SKILLS,
  DIRECTORY_SKILLS,
  DOCS_SKILLS,
  KNOWLEDGE_SKILLS,
  PLATFORM_TOOLS,
  REACH_SKILLS,
  type RegistryContext,
  SkillCatalog,
  SUPERVISOR_SKILLS,
  ToolRegistry,
} from "@countersign/agents";
import {
  type Connector,
  ConnectorRegistry,
  // v0.12 bankfeed
  createBankfeedConnector,
  createBrowserConnector,
  // v0.14 W4-E
  createGchatConnector,
  createGdriveConnector,
  createGmailConnector,
  // v0.14 W4-D
  createGsheetsConnector,
  // v0.12 W3-B
  createHubspotConnector,
  createOutlookConnector,
  createPodioConnector,
  createQboConnector,
  // v0.12 W3-B
  createRampConnector,
  createResendConnector,
  // v0.14 W4-C
  createSlackConnector,
  createTestkitConnector,
  createTwilioConnector,
  createUploadConnector,
  createWebhookConnector,
  createZohoCrmConnector,
  plaidEnvironment,
  QBO_CONNECTOR_ID,
  QBO_SKILLS,
  TESTKIT_SAMPLE_RECORDS,
  TestkitBackend,
} from "@countersign/connectors";
import { SkillDefinition } from "@countersign/core";
import { EventTypeRegistry } from "@countersign/senses";
import type { Bindings } from "./env";

export interface Platform {
  connectors: ConnectorRegistry;
  tools: ToolRegistry;
  catalog: SkillCatalog;
  events: EventTypeRegistry;
  /** What publishing and validation need: tools, skills, event types. */
  ctx: RegistryContext;
}

export interface PlatformOptions {
  connectors?: readonly Connector[];
  skills?: readonly SkillDefinition[];
}

/**
 * A built-in tool-mode skill for every connector read tool (e.g. "Search records" for
 * `zoho_crm.record.search`), so a workflow can read a client's tool in a skill step without a
 * model, and the builder's library lists the reads of every registered connector.
 */
// DECISION: read tools become skills here, generated from their specs (same id, input and output),
// rather than each connector shipping skill definitions; writes stay action steps behind approval.
/** `zoho_crm.record.search` → "Search record", like the builder names actions. */
function readSkillName(toolId: string): string {
  const [entity = "", verb = ""] = toolId.split(".").slice(-2);
  const words = `${verb} ${entity}`.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function connectorReadSkills(connectors: ConnectorRegistry): SkillDefinition[] {
  return connectors.list().flatMap((c) =>
    c.manifest.tools
      .filter((t) => t.sideEffect === "none")
      .map((t) =>
        SkillDefinition.parse({
          schemaVersion: 1,
          id: t.id,
          name: readSkillName(t.id),
          description: t.description,
          category: c.manifest.name,
          mode: "tool",
          handler: t.id,
          tools: [],
          input: t.input,
          output: t.output,
          ...(t.summary ? { summary: t.summary } : {}),
          requiresConnectors: [c.manifest.id],
        }),
      ),
  );
}

export function createPlatform(options: PlatformOptions = {}): Platform {
  const connectors = new ConnectorRegistry(options.connectors ?? []);
  const tools = new ToolRegistry({ platform: PLATFORM_TOOLS, connectors });
  // The platform's built-in skills (docs.*, knowledge.search, directory.lookup, comms.reach-out,
  // supervisor.*) come first, then the caller's, QuickBooks' own, then a tool-mode skill
  // per connector read tool. Connectors' event types (e.g. webhook.received) join the catalogue;
  // packs register theirs here when they exist (registerPack); none yet.
  const catalog = new SkillCatalog(
    [
      ...DOCS_SKILLS,
      ...KNOWLEDGE_SKILLS,
      ...DIRECTORY_SKILLS,
      ...REACH_SKILLS,
      ...SUPERVISOR_SKILLS,
      // v0.12 W2-D: Sloan's conversation (account.chat)
      ...ACCOUNT_SKILLS,
      ...(options.skills ?? []),
      // DECISION: QuickBooks' one agent-mode skill (the Bill clerk's line mapping) ships with the
      // connector, beside the tools it reads with, and is offered wherever qbo is registered.
      ...(connectors.has(QBO_CONNECTOR_ID) ? QBO_SKILLS : []),
      ...connectorReadSkills(connectors),
    ],
    tools,
  );
  const events = new EventTypeRegistry();
  for (const c of connectors.list()) {
    if (c.manifest.events?.length) {
      events.registerConnector(c.manifest.id, c.manifest.events, c.manifest.sharedNamespaces);
    }
  }
  return { connectors, tools, catalog, events, ctx: { tools, catalog, events: events.byType() } };
}

/** QBO_ENV, read leniently: anything but `production` is the sandbox. */
export function qboEnvironment(env: Pick<Bindings, "QBO_ENV">): "sandbox" | "production" {
  return env.QBO_ENV?.trim().toLowerCase() === "production" ? "production" : "sandbox";
}

export function isProductionEnv(env: Pick<Bindings, "ENVIRONMENT">): boolean {
  return env.ENVIRONMENT?.trim().toLowerCase() === "production";
}

let cached: { key: string; platform: Platform } | undefined;

/**
 * The deployment's platform, built once per isolate.
 */
// DECISION: the testkit connector (an in-memory system with one read and one write tool) is
// registered everywhere except production, so the Sandbox client and local work can exercise
// connections, approvals and external actions before any real connector exists. Its records live
// in the isolate's memory and are lost when the isolate goes. Each connection starts with the same
// three sample records (TESTKIT_SAMPLE_RECORDS), so a Sandbox workflow on staging has something
// to find and change.
type OAuthEnvKey =
  | "OAUTH_STATE_SECRET"
  | "QBO_CLIENT_ID"
  | "QBO_CLIENT_SECRET"
  | "QBO_WEBHOOK_VERIFIER"
  | "QBO_ENV"
  | "ZOHO_CLIENT_ID"
  | "ZOHO_CLIENT_SECRET"
  | "PODIO_CLIENT_ID"
  | "PODIO_CLIENT_SECRET"
  | "GOOGLE_CLIENT_ID"
  | "GOOGLE_CLIENT_SECRET"
  // v0.12 W3-B
  | "RAMP_CLIENT_ID"
  | "RAMP_CLIENT_SECRET"
  | "HUBSPOT_CLIENT_ID"
  | "HUBSPOT_CLIENT_SECRET"
  // v0.12 W3-B: Outlook's Entra app.
  | "OUTLOOK_CLIENT_ID"
  | "OUTLOOK_CLIENT_SECRET"
  // v0.14 W4-E: the Google Chat app.
  | "GOOGLE_CHAT_SERVICE_ACCOUNT"
  | "GOOGLE_CHAT_PROJECT_NUMBER"
  // v0.14 W4-C: our Slack app.
  | "SLACK_CLIENT_ID"
  | "SLACK_CLIENT_SECRET"
  // v0.12 bankfeed: Plaid.
  | "PLAID_CLIENT_ID"
  | "PLAID_SECRET"
  | "PLAID_ENV";

export function platformFor(
  env: Pick<Bindings, "ENVIRONMENT" | OAuthEnvKey | "BROWSER">,
): Platform {
  const production = isProductionEnv(env);
  const key = [
    production ? "production" : "other",
    env.BROWSER ? "browser" : "-",
    env.OAUTH_STATE_SECRET ? "state" : "-",
    env.ZOHO_CLIENT_ID ?? "-",
    env.PODIO_CLIENT_ID ?? "-",
    env.QBO_CLIENT_ID ?? "-",
    qboEnvironment(env),
    env.QBO_WEBHOOK_VERIFIER ? "qbo-hook" : "-",
    env.GOOGLE_CLIENT_ID ?? "-",
    // v0.12 W3-B
    env.RAMP_CLIENT_ID ?? "-",
    env.HUBSPOT_CLIENT_ID ?? "-",
    env.OUTLOOK_CLIENT_ID ?? "-",
    // v0.14 W4-E: whether the key is set, never the key.
    env.GOOGLE_CHAT_SERVICE_ACCOUNT ? "gchat" : "-",
    env.GOOGLE_CHAT_PROJECT_NUMBER ?? "-",
    // v0.14 W4-C
    env.SLACK_CLIENT_ID ?? "-",
    // v0.12 bankfeed
    env.PLAID_CLIENT_ID ?? "-",
    env.PLAID_SECRET ? "plaid-secret" : "-",
    plaidEnvironment(env.PLAID_ENV),
  ].join(":");
  if (cached?.key !== key) {
    cached = {
      key,
      platform: createPlatform({ connectors: deploymentConnectors(env, production) }),
    };
  }
  return cached.platform;
}

/**
 * The connectors every deployment registers. Each appears in the operator's offering, the portal's
 * Connections page and the builder's palette through the registry; nothing else names them.
 */
// DECISION: Zoho CRM, Podio and Gmail are registered even where their OAuth clients aren't set, so
// they can be offered and built with; each signs in only once its client id and secret and
// OAUTH_STATE_SECRET are all set (the portal shows "not available yet" until then).
export function deploymentConnectors(
  env: Pick<Bindings, OAuthEnvKey | "BROWSER">,
  production: boolean,
): Connector[] {
  const zohoReady = Boolean(env.ZOHO_CLIENT_ID && env.ZOHO_CLIENT_SECRET && env.OAUTH_STATE_SECRET);
  const podioReady = Boolean(
    env.PODIO_CLIENT_ID && env.PODIO_CLIENT_SECRET && env.OAUTH_STATE_SECRET,
  );
  const qboReady = Boolean(env.QBO_CLIENT_ID && env.QBO_CLIENT_SECRET && env.OAUTH_STATE_SECRET);
  const googleReady = Boolean(
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.OAUTH_STATE_SECRET,
  );
  // v0.12 W3-B
  const microsoftReady = Boolean(
    env.OUTLOOK_CLIENT_ID && env.OUTLOOK_CLIENT_SECRET && env.OAUTH_STATE_SECRET,
  );
  // v0.14 W4-C
  const slackReady = Boolean(
    env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET && env.OAUTH_STATE_SECRET,
  );
  // v0.12 bankfeed
  const plaidReady = Boolean(env.PLAID_CLIENT_ID && env.PLAID_SECRET && env.OAUTH_STATE_SECRET);
  return [
    // Upload (with email forwarding) is built in everywhere (ARCHITECTURE §6.1).
    createUploadConnector(),
    // QuickBooks Online (plan M9): offered and built with everywhere; signs in once QBO_CLIENT_ID,
    // QBO_CLIENT_SECRET and OAUTH_STATE_SECRET are set. QBO_ENV picks sandbox or production.
    createQboConnector({
      ...(qboReady ? { clientId: env.QBO_CLIENT_ID, clientSecret: env.QBO_CLIENT_SECRET } : {}),
      environment: qboEnvironment(env),
      webhookVerifier: env.QBO_WEBHOOK_VERIFIER,
    }),
    createWebhookConnector(),
    createZohoCrmConnector(
      zohoReady ? { clientId: env.ZOHO_CLIENT_ID, clientSecret: env.ZOHO_CLIENT_SECRET } : {},
    ),
    createPodioConnector(
      podioReady ? { clientId: env.PODIO_CLIENT_ID, clientSecret: env.PODIO_CLIENT_SECRET } : {},
    ),
    // Texts and WhatsApp: registered everywhere; a client gets a connection only when the
    // operator makes its subaccount, which needs TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.
    createTwilioConnector(),
    // Gmail, send only (ARCHITECTURE §6.4): registered everywhere like Zoho; a person signs in once
    // GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and OAUTH_STATE_SECRET are set.
    createGmailConnector(
      googleReady ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } : {},
    ),
    // v0.12 W3-B: Google Drive (drive.file, on Gmail's Google client) and Outlook (send only), like
    // Gmail: registered everywhere, signing in once their client and OAUTH_STATE_SECRET are set.
    createGdriveConnector(
      googleReady ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } : {},
    ),
    // v0.14 W4-D: Google Sheets (drive.file, picked sheets only), on the same Google client.
    createGsheetsConnector(
      googleReady ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } : {},
    ),
    createOutlookConnector(
      microsoftReady
        ? { clientId: env.OUTLOOK_CLIENT_ID, clientSecret: env.OUTLOOK_CLIENT_SECRET }
        : {},
    ),
    // v0.14 W4-E: Google Chat, the app of Mezonas' own: registered everywhere; a client connects it
    // once GOOGLE_CHAT_SERVICE_ACCOUNT and GOOGLE_CHAT_PROJECT_NUMBER are set.
    createGchatConnector({
      serviceAccount: env.GOOGLE_CHAT_SERVICE_ACCOUNT,
      projectNumber: env.GOOGLE_CHAT_PROJECT_NUMBER,
    }),
    // v0.14 W4-C: Slack (posts to the channels a client picks), like Outlook: registered
    // everywhere, signing in once SLACK_CLIENT_ID, SLACK_CLIENT_SECRET and OAUTH_STATE_SECRET
    // are set.
    createSlackConnector(
      slackReady ? { clientId: env.SLACK_CLIENT_ID, clientSecret: env.SLACK_CLIENT_SECRET } : {},
    ),
    // Email sending (Resend): registered everywhere; a client gets a connection only when the
    // operator sets it up, which needs RESEND_API_KEY.
    createResendConnector(),
    // v0.12 W3-B: Ramp and HubSpot, registered everywhere like Zoho; each signs in once its client
    // id and secret and OAUTH_STATE_SECRET are set (ARCHITECTURE §6.11, docs/plan.md §1.52).
    createRampConnector(oauthClient(env.RAMP_CLIENT_ID, env.RAMP_CLIENT_SECRET, env)),
    createHubspotConnector(oauthClient(env.HUBSPOT_CLIENT_ID, env.HUBSPOT_CLIENT_SECRET, env)),
    // v0.12 bankfeed: bank and card feeds through Plaid (ARCHITECTURE §6.11, docs/plan.md §1.52),
    // registered everywhere like Zoho; a client connects in Plaid Link once PLAID_CLIENT_ID,
    // PLAID_SECRET and OAUTH_STATE_SECRET are set. PLAID_ENV picks sandbox or production.
    createBankfeedConnector({
      ...(plaidReady ? { clientId: env.PLAID_CLIENT_ID, secret: env.PLAID_SECRET } : {}),
      environment: plaidEnvironment(env.PLAID_ENV),
    }),
    // Website logins (docs/plan.md §1.26): registered everywhere, so sites can be offered and
    // built with; agents sign in only where Browser Run is bound (BROWSER).
    createBrowserConnector({ available: Boolean(env.BROWSER) }),
    ...(production
      ? []
      : [createTestkitConnector(new TestkitBackend({ samples: TESTKIT_SAMPLE_RECORDS }))]),
  ];
}

// v0.12 W3-B: an OAuth client for a connector, only when its id, secret and OAUTH_STATE_SECRET are
// all set; otherwise none, and the portal shows "not available yet".
function oauthClient(
  clientId: string | undefined,
  clientSecret: string | undefined,
  env: Pick<Bindings, "OAUTH_STATE_SECRET">,
): { clientId?: string; clientSecret?: string } {
  return clientId && clientSecret && env.OAUTH_STATE_SECRET ? { clientId, clientSecret } : {};
}
