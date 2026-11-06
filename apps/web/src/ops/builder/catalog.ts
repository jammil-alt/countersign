// What the builder knows besides the bundle: the skills, tools and event types it types steps with
// (the same context the server validates with), the palette built from them, and a client
// agent's bound connections.
import {
  type AgentBundle,
  type BuilderCatalog,
  type EventTypeSpec,
  lookupSkill,
  type OpsConnection,
  type PermissionMatrix,
  parseSkillRef,
  type SkillDefinition,
  type ToolSpec,
  type TriggerOn,
  type TypingContext,
  type ValidationError,
  validateBundle,
} from "@countersign/core";
import type { z } from "zod";
import type { LogicKind, PaletteItem } from "./model";
import { toolTitle } from "./model";

export interface CatalogEvent {
  type: string;
  description: string;
  subjectType: string | null;
  payload: Record<string, unknown>;
  sample: unknown;
}

export interface BuilderData {
  catalog: BuilderCatalog;
  events: CatalogEvent[];
}

/** The typing and validation context: skills by the reference bundles use, tools, event types. */
export function typingContext(data: BuilderData): TypingContext {
  const skills: Record<string, SkillDefinition> = {};
  for (const s of data.catalog.skills) skills[s.ref] = s.definition;
  const tools: Record<string, ToolSpec> = {};
  for (const t of data.catalog.tools) tools[t.id] = t;
  const events: Record<string, EventTypeSpec> = {};
  // v0.12 W2-B: the automations use steps pin, as the server validates with them.
  const automations: NonNullable<TypingContext["automations"]> = {};
  for (const a of data.catalog.automations ?? []) automations[a.ref] = a.definition;
  for (const e of data.events) {
    events[e.type] = {
      type: e.type,
      description: e.description,
      payload: e.payload,
      sample: e.sample,
      ...(e.subjectType ? { subjectType: e.subjectType } : {}),
    };
  }
  return { skills, tools, events, automations };
}

/**
 * The server's check, in the browser: core's validateBundle with the same context (and, for a
 * client agent's publish, its bound connections' matrices), plus the publish check's refusal of
 * agent skills it can't resolve. Shared by the builder and the merge view.
 */
export function validateLikeServer(
  bundle: AgentBundle,
  ctx: TypingContext,
  publish?: { matrices: Record<string, Partial<PermissionMatrix> | undefined> },
): { valid: boolean; errors: ValidationError[] } {
  const r = validateBundle(bundle, { ...ctx, ...(publish ? { publish } : {}) });
  const missing: ValidationError[] = bundle.definition.skills
    .filter((s) => !lookupSkill(s.skill, ctx))
    .filter((s) => !r.errors.some((e) => e.code === "unknown_skill" && e.message.includes(s.skill)))
    .map((s) => ({
      stepId: null,
      field: "definition.skills",
      code: "unknown_skill",
      message: `skill ${s.skill} not found`,
    }));
  const errors = [...r.errors, ...missing];
  return { valid: errors.length === 0, errors };
}

export function connectorName(data: BuilderData, id: string): string {
  return data.catalog.connectors.find((c) => c.id === id)?.name ?? id;
}

type Connection = z.infer<typeof OpsConnection>;

/**
 * A client agent's bound connections' matrices by connector, as the server's publish check reads
 * them (`boundMatrices`): the binding's connection, if it is that connector's.
 */
export function boundMatrices(
  bindings: Record<string, string>,
  connections: readonly Pick<Connection, "id" | "connector" | "permissions">[],
): Record<string, Partial<PermissionMatrix> | undefined> {
  const out: Record<string, Partial<PermissionMatrix> | undefined> = {};
  for (const [connector, id] of Object.entries(bindings)) {
    const c = connections.find((x) => x.id === id && x.connector === connector);
    if (c) out[connector] = c.permissions as Partial<PermissionMatrix>;
  }
  return out;
}

export interface PaletteSection {
  key: string;
  label: string;
  items: PaletteItem[];
}

const LOGIC: { logic: LogicKind; title: string; detail: string }[] = [
  { logic: "fork", title: "Fork", detail: "Paths with rules; the first that matches runs" },
  { logic: "for_each", title: "For each", detail: "Run steps once per item of a list" },
  { logic: "wait", title: "Wait", detail: "Pause for a while" },
  { logic: "notify", title: "Notify", detail: "Post a message" },
  { logic: "stop", title: "Stop", detail: "End the run here" },
];

function manualInput(): TriggerOn {
  return { type: "manual", input: { type: "object", properties: {} } };
}

/**
 * The "Add a step" palette (ARCHITECTURE §10.5): triggers from the event catalogue, the agent's
 * skills then the library, actions grouped by the connector whose tool they change, people, logic.
 */
export function paletteSections(bundle: AgentBundle, data: BuilderData): PaletteSection[] {
  const triggers: PaletteItem[] = [
    ...data.events.map(
      (e): PaletteItem => ({
        type: "trigger",
        key: `trigger:event:${e.type}`,
        title: `When ${e.type}`,
        detail: e.description,
        on: { type: "event", event: e.type },
      }),
    ),
    {
      type: "trigger",
      key: "trigger:schedule",
      title: "On a schedule",
      detail: "Platform",
      on: { type: "schedule", cron: "0 7 * * 1-5" },
    },
    {
      type: "trigger",
      key: "trigger:manual",
      title: "Started by hand",
      detail: "Manual input",
      on: manualInput(),
    },
    {
      type: "trigger",
      key: "trigger:command",
      title: "A thread command",
      detail: "/command",
      on: { type: "command", command: "run" },
    },
  ];

  const own = new Set(bundle.definition.skills.map((s) => parseSkillRef(s.skill).id));
  const skills = data.catalog.skills
    // A pinned reference is offered only when the agent already uses it.
    .filter((s) => s.source !== "pinned" || bundle.definition.skills.some((x) => x.skill === s.ref))
    .map(
      (s): PaletteItem => ({
        type: "skill",
        key: `skill:${s.ref}`,
        title: s.definition.name,
        detail: toolsLine(s.definition, data),
        ref: s.ref,
        skill: s.definition,
        own: own.has(parseSkillRef(s.ref).id),
      }),
    )
    .sort((a, b) => Number(b.type === "skill" && b.own) - Number(a.type === "skill" && a.own));

  const actions = data.catalog.tools
    .filter((t) => t.sideEffect === "external")
    .map((t): PaletteItem => {
      const group = connectorName(data, t.connector ?? t.source);
      return {
        type: "action",
        key: `action:${t.id}`,
        title: toolTitle(t),
        detail: group,
        tool: t,
        group,
      };
    })
    .sort((a, b) =>
      a.type === "action" && b.type === "action"
        ? a.group.localeCompare(b.group) || a.title.localeCompare(b.title)
        : 0,
    );

  return [
    { key: "triggers", label: "Triggers", items: triggers },
    { key: "skills", label: "Skills", items: skills },
    { key: "actions", label: "Actions · change your tools", items: actions },
    {
      key: "people",
      label: "People",
      items: [
        {
          type: "person",
          key: "person:approve",
          title: "Approve",
          detail: "A person approves before the run goes on",
          mode: "approve",
        },
        {
          type: "person",
          key: "person:ask",
          title: "Ask",
          detail: "A person answers a question",
          mode: "ask",
        },
      ],
    },
    {
      key: "logic",
      label: "Logic",
      items: LOGIC.map((l) => ({ type: "logic", key: `logic:${l.logic}`, ...l })),
    },
  ];
}

/** "QuickBooks, Gmail", or "No tool", under a skill's name. */
export function toolsLine(
  skill: Pick<SkillDefinition, "tools"> & Partial<Pick<SkillDefinition, "handler">>,
  data: BuilderData,
): string {
  const names = new Set<string>();
  // A tool-mode skill's handler counts too: a connector's read skill names its connector.
  for (const id of [...(skill.handler ? [skill.handler] : []), ...skill.tools]) {
    const tool = data.catalog.tools.find((t) => t.id === id);
    if (tool && tool.source !== "platform") names.add(connectorName(data, tool.source));
  }
  return names.size ? [...names].join(", ") : "No tool";
}

/** Narrows the palette to items whose title or detail contain every word of the search. */
export function filterSections(sections: PaletteSection[], search: string): PaletteSection[] {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return sections;
  return sections
    .map((s) => ({
      ...s,
      items: s.items.filter((i) => {
        const text = `${i.title} ${i.detail}`.toLowerCase();
        return words.every((w) => text.includes(w));
      }),
    }))
    .filter((s) => s.items.length > 0);
}
