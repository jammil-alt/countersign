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
  createTestkitConnector,
  createUploadConnector,
} from "@countersign/connectors";
import type { SkillDefinition } from "@countersign/core";
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

export function createPlatform(options: PlatformOptions = {}): Platform {
  const connectors = new ConnectorRegistry(options.connectors ?? []);
  const tools = new ToolRegistry({ platform: PLATFORM_TOOLS, connectors });
  // The platform's built-in skills (docs.*) come first; callers add their own.
  const catalog = new SkillCatalog([...DOCS_SKILLS, ...(options.skills ?? [])], tools);
  // Packs register their event types here when they exist (registerPack); none yet.
  const events = new EventTypeRegistry();
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
// in the isolate's memory and are lost when the isolate goes.
export function platformFor(env: Pick<Bindings, "ENVIRONMENT">): Platform {
  const key = isProductionEnv(env) ? "production" : "other";
  if (cached?.key !== key) {
    // Upload (with email forwarding) is built in everywhere (ARCHITECTURE §6.1).
    const upload = createUploadConnector();
    const connectors = key === "production" ? [upload] : [upload, createTestkitConnector()];
    cached = { key, platform: createPlatform({ connectors }) };
  }
  return cached.platform;
}
