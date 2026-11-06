// What the Builder knows when it drafts or revises an agent (ARCHITECTURE §9.6): the registered
// tools and the skills the agent may use (ids, descriptions, side effects, input and output
// schemas), the connectors and packs, and for a client what it has connected and enabled, the
// event types, the existing templates and the client's other agents. apps/api gathers it (it is
// the only place that wires the registries and the database together); this module only shapes it
// for the prompt. Nothing here touches the database.

import type { EventTypeSpec, JsonSchema, SkillDefinition, ToolSpec } from "@countersign/core";

export interface BuilderSkill {
  /** The reference a bundle names it by (`docs.extract`, `custom:<slug>`). */
  ref: string;
  definition: SkillDefinition;
  source: "builtin" | "shared" | "client";
}

export interface BuilderTemplate {
  slug: string;
  name: string;
  role: string | null;
  mission: string;
  /** Skill references its live version uses. */
  skills: string[];
  /** Its workflows' names. */
  workflows: string[];
}

export interface BuilderClient {
  id: string;
  name: string;
  /** Connections the client has, by connector, with their status (`active`, `pending`, …). */
  connections: { connector: string; status: string }[];
  /** Packs enabled for the client. */
  packs: string[];
}

export interface BuilderContext {
  tools: ToolSpec[];
  skills: BuilderSkill[];
  connectors: { id: string; name: string }[];
  /** Packs the platform has registered (none yet). */
  packs: { id: string; name: string }[];
  events: EventTypeSpec[];
  templates: BuilderTemplate[];
  /** Set when drafting or revising a client agent. */
  client: BuilderClient | null;
  /** Agents (by slug) a step may ask: the client's other agents, or other templates. */
  agentSlugs: string[];
  // v0.12 W3-A: what a conversation also knows (ARCHITECTURE §9.6).
  /** Automations a `use_automation` step may place, by their pinned reference (`slug@version`). */
  automations?: BuilderAutomationRef[];
  /** Model ids a skill step may run on (`packages/llm`'s priced list). */
  models?: string[];
  /** The client's people, by name and relationship (no contact details). */
  people?: { name: string; relationship: string | null }[];
}

/** v0.12 W3-A: an automation the Builder may place. */
export interface BuilderAutomationRef {
  ref: string;
  slug: string;
  name: string;
  description: string;
  input: JsonSchema;
  output: unknown;
}

/** Top-level property names of a JSON Schema: the "in → out" a skill's table row shows. */
export function schemaFields(schema: JsonSchema | undefined): string[] {
  const props = (schema as { properties?: Record<string, unknown> } | undefined)?.properties;
  return props ? Object.keys(props) : [];
}

/** The catalog as the model reads it: compact JSON, nothing it may not use. */
export function catalogForPrompt(ctx: BuilderContext): Record<string, unknown> {
  return {
    skills: ctx.skills.map((s) => ({
      id: s.ref,
      name: s.definition.name,
      description: s.definition.description,
      category: s.definition.category,
      tools: [
        ...new Set([
          ...(s.definition.handler ? [s.definition.handler] : []),
          ...s.definition.tools,
        ]),
      ],
      input: s.definition.input,
      output: s.definition.output,
      settings: s.definition.settings.map((x) => ({
        key: x.key,
        label: x.label,
        type: x.type,
        default: x.default,
        ...(x.options ? { options: x.options } : {}),
      })),
      requiresConnectors: s.definition.requiresConnectors,
      requiresPacks: s.definition.requiresPacks,
    })),
    tools: ctx.tools.map((t) => ({
      id: t.id,
      description: t.description,
      sideEffect: t.sideEffect,
      verb: t.verb,
      source: t.source,
      ...(t.connector ? { connector: t.connector } : {}),
      input: t.input,
      output: t.output,
    })),
    connectors: ctx.connectors,
    packs: ctx.packs,
    events: ctx.events.map((e) => ({
      type: e.type,
      description: e.description,
      payload: e.payload,
    })),
    templates: ctx.templates,
    otherAgents: ctx.agentSlugs,
    // v0.12 W3-A
    ...(ctx.automations
      ? {
          automations: ctx.automations.map((a) => ({
            ref: a.ref,
            name: a.name,
            description: a.description,
            input: a.input,
            output: a.output,
          })),
        }
      : {}),
    ...(ctx.models ? { models: ctx.models } : {}),
    ...(ctx.people ? { people: ctx.people } : {}),
    ...(ctx.client
      ? {
          client: {
            name: ctx.client.name,
            connections: ctx.client.connections,
            packs: ctx.client.packs,
          },
        }
      : {}),
  };
}
