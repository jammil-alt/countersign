// The registries the API and the runs share (docs/plan.md §2): tools from the platform's own list
// and each registered connector's manifest, built-in skills, and event types. This is the one
// place that names connectors (and, later, packs); nothing in packages/* does.

import {
  DOCS_SKILLS,
  PLATFORM_TOOLS,
  type RegistryContext,
  SkillCatalog,
  ToolRegistry,
} from "@countersign/agents";
import {
  type Connector,
  ConnectorRegistry,
  createPodioConnector,
  createTestkitConnector,
  createTwilioConnector,
  createUploadConnector,
  createWebhookConnector,
  createZohoCrmConnector,
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
  // The platform's built-in skills (docs.*) come first, then the caller's, then a tool-mode skill
  // per connector read tool. Connectors' event types (e.g. webhook.received) join the catalogue;
  // packs register theirs here when they exist (registerPack); none yet.
  const catalog = new SkillCatalog(
    [...DOCS_SKILLS, ...(options.skills ?? []), ...connectorReadSkills(connectors)],
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
  | "ZOHO_CLIENT_ID"
  | "ZOHO_CLIENT_SECRET"
  | "PODIO_CLIENT_ID"
  | "PODIO_CLIENT_SECRET";

export function platformFor(env: Pick<Bindings, "ENVIRONMENT" | OAuthEnvKey>): Platform {
  const production = isProductionEnv(env);
  const key = [
    production ? "production" : "other",
    env.OAUTH_STATE_SECRET ? "state" : "-",
    env.ZOHO_CLIENT_ID ?? "-",
    env.PODIO_CLIENT_ID ?? "-",
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
// DECISION: Zoho CRM and Podio are registered even where their OAuth clients aren't set, so they
// can be offered and built with; each signs in only once its client id and secret and
// OAUTH_STATE_SECRET are all set (the portal shows "not available yet" until then).
export function deploymentConnectors(
  env: Pick<Bindings, OAuthEnvKey>,
  production: boolean,
): Connector[] {
  const zohoReady = Boolean(env.ZOHO_CLIENT_ID && env.ZOHO_CLIENT_SECRET && env.OAUTH_STATE_SECRET);
  const podioReady = Boolean(
    env.PODIO_CLIENT_ID && env.PODIO_CLIENT_SECRET && env.OAUTH_STATE_SECRET,
  );
  return [
    // Upload (with email forwarding) is built in everywhere (ARCHITECTURE §6.1).
    createUploadConnector(),
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
    ...(production
      ? []
      : [createTestkitConnector(new TestkitBackend({ samples: TESTKIT_SAMPLE_RECORDS }))]),
  ];
}
