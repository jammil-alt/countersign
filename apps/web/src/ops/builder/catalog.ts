// What the builder knows besides the bundle: the skills, tools and event types it types steps with
// (the same context the server validates with), the palette built from them, and a client
// agent's bound connections.
import {
  type AgentBundle,
  type AnyAgentBundle,
  allSteps,
  type BrowserScriptTool,
  type BuilderCatalog,
  // P-4
  CONVERSE_SKILL,
  type EventTypeSpec,
  isToolWrapper,
  lookupSkill,
  type OpsConnection,
  type PermissionMatrix,
  type ProcessAgentBundle,
  parseSkillRef,
  processes,
  type SkillDefinition,
  type SkillKind,
  skillKind,
  type ToolSpec,
  type TriggerOn,
  type TypingContext,
  toolLookup,
  type ValidationError,
  validateBundle,
  writeStepLabel,
} from "@countersign/core";
import type { z } from "zod";
import {
  eventKind,
  TRIGGER_KINDS,
  type TriggerKind,
  toolLabel,
  whenEvent,
} from "../workflow/labels";
import { actionItem, type LogicKind, type PaletteItem } from "./model";
import { scriptPaletteItems } from "./scripts";

export interface CatalogEvent {
  type: string;
  description: string;
  subjectType: string | null;
  payload: Record<string, unknown>;
  sample: unknown;
  /** The connector that emits it; null or absent for the platform's own. */
  connector?: string | null | undefined;
}

export interface BuilderData {
  catalog: BuilderCatalog;
  events: CatalogEvent[];
  /** Wave 4: a client agent's client's published scripts (./scripts.ts). */
  scripts?: readonly BrowserScriptTool[] | undefined;
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

/** A validation problem of a bundle that holds processes (v4 codes). */
export type BuilderProblem = processes.BundleValidationError;

/**
 * R8: the server's check of a bundle that holds processes, in the browser: core's
 * `validateAnyBundle` with the same context, plus the refusal of agent skills it can't resolve.
 * Warnings are advice (a process that might be better split), never a reason to refuse.
 * `clientAgent` is always given, as the server's `validateForPublish` gives it (`row.kind ===
 * "client"`): a template's process step may not change an inner step's approval.
 */
export function validateProcessesLikeServer(
  bundle: ProcessAgentBundle | AnyAgentBundle,
  ctx: TypingContext,
  agent: {
    clientAgent: boolean;
    publish?: { matrices: Record<string, Partial<PermissionMatrix> | undefined> } | undefined;
  },
): { valid: boolean; errors: BuilderProblem[]; warnings: processes.BundleWarning[] } {
  const r = processes.validateAnyBundle(bundle, {
    ...ctx,
    ...(agent.publish ? { publish: agent.publish } : {}),
    clientAgent: agent.clientAgent,
  });
  const missing: BuilderProblem[] = bundle.definition.skills
    .filter((s) => !lookupSkill(s.skill, ctx))
    .filter((s) => !r.errors.some((e) => e.code === "unknown_skill" && e.message.includes(s.skill)))
    .map((s) => ({
      stepId: null,
      field: "definition.skills",
      code: "unknown_skill",
      message: `skill ${s.skill} not found`,
    }));
  const errors = [...r.errors, ...missing];
  return { valid: errors.length === 0, errors, warnings: r.warnings };
}

export function connectorName(data: BuilderData, id: string): string {
  return data.catalog.connectors.find((c) => c.id === id)?.name ?? id;
}

// ── The skill model (owner, 2026-11-10; ARCHITECTURE §10.14) ─────────────────────────────────────

/**
 * A skill's kind, Deterministic or AI: the catalog's (the server derives it with every tool's
 * `usesModel`), else derived here from the catalog's tools. Undefined for a skill it doesn't list.
 */
export function catalogSkillKind(data: BuilderData, ref: string): SkillKind | undefined {
  const s =
    data.catalog.skills.find((x) => x.ref === ref) ??
    data.catalog.skills.find((x) => parseSkillRef(x.ref).id === parseSkillRef(ref).id);
  if (!s) return undefined;
  return s.kind ?? skillKind(s.definition, toolLookup(data.catalog.tools));
}

/**
 * How a write step on this tool reads: "Save to records" (our own records) or "Change in
 * QuickBooks Online" (a client's tool, by its connector's name). Core's rule, so the run view and
 * the builder say the same.
 */
export function writeLabelOf(data: BuilderData, toolId: string): string {
  const tool = data.catalog.tools.find((t) => t.id === toolId);
  const c = tool ? (tool.connector ?? tool.source) : null;
  const name = c ? (data.catalog.connectors.find((x) => x.id === c)?.name ?? null) : null;
  return writeStepLabel({ kind: "write" }, tool, name).text;
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

export interface PaletteGroup {
  key: string;
  label: string;
  items: PaletteItem[];
}

export interface PaletteSection {
  key: string;
  label: string;
  items: PaletteItem[];
  /** Triggers come in kinds ("A document arrives"), each folded under its own heading. */
  groups?: PaletteGroup[];
}

const LOGIC: { logic: LogicKind; title: string; detail: string }[] = [
  { logic: "if", title: "If", detail: "Paths with rules; the first that matches runs" },
  { logic: "for_each", title: "For each", detail: "Run steps once per item of a list" },
  { logic: "wait", title: "Wait", detail: "Pause for a while" },
  { logic: "stop", title: "Stop", detail: "End the run here" },
];

function manualInput(): TriggerOn {
  return { type: "manual", input: { type: "object", properties: {} } };
}

/** Upload and forwarding is every client's: its documents start runs without a sign-in. */
export const BUILT_IN_CONNECTORS = ["upload"] as const;

/** The in-memory test system: offered only to the Sandbox client and a template's test copies. */
export const TESTKIT = "testkit";

/** The platform's own tools (alerts, prices) are grouped under our name. */
const PLATFORM = "platform";

/** The connectors a skill reads or writes through: those it requires and its tools'. */
export function skillConnectors(
  skill: Pick<SkillDefinition, "tools" | "requiresConnectors"> &
    Partial<Pick<SkillDefinition, "handler">>,
  data: BuilderData,
): string[] {
  const out = new Set(skill.requiresConnectors);
  for (const id of [...(skill.handler ? [skill.handler] : []), ...skill.tools]) {
    const c = toolConnector(id, data);
    if (c) out.add(c);
  }
  return [...out];
}

/** The connector a tool acts through, if it is a connector's (not the platform's or a pack's). */
export function toolConnector(id: string, data: BuilderData): string | null {
  const tool = data.catalog.tools.find((t) => t.id === id);
  if (!tool) return null;
  const c = tool.connector ?? tool.source;
  return data.catalog.connectors.some((x) => x.id === c) ? c : null;
}

/**
 * The connectors a bundle already reaches: its skills', its extra tools' and its tool steps'
 * (v3 actions, v4 reads and writes).
 */
export function bundleConnectors(
  bundle: AgentBundle | AnyAgentBundle | ProcessAgentBundle,
  data: BuilderData,
): Set<string> {
  const out = new Set<string>();
  const addSkill = (ref: string) => {
    const s = data.catalog.skills.find((x) => x.ref === ref || parseSkillRef(x.ref).id === ref);
    if (s) for (const c of skillConnectors(s.definition, data)) out.add(c);
  };
  const addTool = (id: string) => {
    const c = toolConnector(id, data);
    if (c) out.add(c);
  };
  for (const s of bundle.definition.skills) addSkill(s.skill);
  for (const id of bundle.definition.extraTools) addTool(id);
  for (const w of bundle.workflows) {
    if (w.workflow.schemaVersion === 4) {
      for (const { step } of processes.allSteps(w.workflow)) {
        if (step.kind === "skill") addSkill(step.skill);
        if ((step.kind === "read" || step.kind === "write") && step.tool !== undefined) {
          addTool(step.tool);
        }
      }
      continue;
    }
    for (const { step } of allSteps(w.workflow)) {
      if (step.kind === "skill") addSkill(step.skill);
      if (step.kind === "action") addTool(step.tool);
    }
  }
  return out;
}

/**
 * Whose tools the palette offers (UI cleanup, review 2 "Builder palette"): a client agent's, the
 * connectors its client has connected; a template's, those it already uses plus any the operator
 * adds for this session. Upload is always there. Testkit only for the Sandbox client and a
 * template's test copies.
 */
// DECISION: a connection that isn't disconnected counts as connected (a sign-in that needs
// attention is still the client's tool), and a template's "declared" connectors are the ones its
// skills and steps already reach, since a bundle has no separate list of them.
export function paletteConnectors(input: {
  agent: { kind: "template" | "client"; testCopy: boolean };
  bundle: AgentBundle | AnyAgentBundle | ProcessAgentBundle;
  data: BuilderData;
  connections: readonly { connector: string; status: string }[];
  sandbox: boolean;
  /** A template's connectors the operator chose to build with in this session. */
  extra?: readonly string[];
}): Set<string> {
  const out = new Set<string>(BUILT_IN_CONNECTORS);
  let templateUsesTestkit = false;
  if (input.agent.kind === "client") {
    for (const c of input.connections) if (c.status !== "disconnected") out.add(c.connector);
  } else {
    const used = bundleConnectors(input.bundle, input.data);
    templateUsesTestkit = used.has(TESTKIT);
    for (const c of used) out.add(c);
    for (const c of input.extra ?? []) out.add(c);
  }
  // A template built on the Testkit keeps it; nothing else offers it but the Sandbox.
  if (!input.sandbox && !input.agent.testCopy && !templateUsesTestkit) out.delete(TESTKIT);
  return out;
}

/**
 * The tools a step may call directly that aren't a connector's: the platform's or a pack's tools
 * a retired tool-mode skill wrapped (R2: those skills become read and write steps on the tool).
 */
// DECISION: the platform's and packs' own tools are offered only where a tool-mode skill wrapped
// them: those are built to run as a step on their own. Tools a skill calls inside its own work,
// and the handlers of step-only skills (a conversation, a reach-out), are not steps.
function wrappedTools(data: BuilderData): Set<string> {
  // Skill model (2026-11-10): the server lists them (`stepTools`), now the wrappers are gone.
  if (data.catalog.stepTools) return new Set(data.catalog.stepTools);
  const out = new Set<string>();
  for (const s of data.catalog.skills) {
    if (isToolWrapper(s.definition) && s.definition.handler) out.add(s.definition.handler);
  }
  for (const id of processes.STEP_ONLY_SKILLS) {
    const s = data.catalog.skills.find((x) => parseSkillRef(x.ref).id === id);
    if (s?.definition.handler) out.delete(s.definition.handler);
  }
  return out;
}

/**
 * The "Add a step" palette (ARCHITECTURE §10.5, §10.14; UI cleanup): triggers folded into a few
 * kinds, processes, the skills that think (the agent's own first), then one section per connector
 * the agent may use with its reads and its writes, then people (approve, ask, a conversation, a
 * notice) and logic. Everything reads by its name, never its id. Tool-mode skills are retiring
 * (R2): their tool is offered as a read or a write instead.
 */
export function paletteSections(
  bundle: ProcessAgentBundle | AnyAgentBundle,
  data: BuilderData,
  connectors: ReadonlySet<string> = new Set(data.catalog.connectors.map((c) => c.id)),
): PaletteSection[] {
  const offered = (c: string | null | undefined) => !c || connectors.has(c);

  const eventItem = (e: CatalogEvent): PaletteItem => ({
    type: "trigger",
    key: `trigger:event:${e.type}`,
    title: whenEvent(e.type),
    detail: e.description,
    on: { type: "event", event: e.type },
  });
  const byKind = new Map<TriggerKind, PaletteItem[]>();
  const push = (kind: TriggerKind, item: PaletteItem) =>
    byKind.set(kind, [...(byKind.get(kind) ?? []), item]);
  push("schedule", {
    type: "trigger",
    key: "trigger:schedule",
    title: "On a schedule",
    detail: "Weekdays at 7:00 to start; change it after",
    on: { type: "schedule", cron: "0 7 * * 1-5" },
  });
  push("person", {
    type: "trigger",
    key: "trigger:manual",
    title: "Started by hand",
    detail: "Someone starts it from the back office",
    on: manualInput(),
  });
  push("person", {
    type: "trigger",
    key: "trigger:command",
    title: "A thread command",
    detail: "Someone types /run in a thread",
    on: { type: "command", command: "run" },
  });
  for (const e of data.events) {
    // The schedule trigger is how a run starts on time; its tick isn't offered twice.
    if (e.type === "schedule.tick" || !offered(e.connector)) continue;
    push(eventKind(e.type), eventItem(e));
  }
  const groups = TRIGGER_KINDS.flatMap(({ kind, label }) => {
    const items = byKind.get(kind) ?? [];
    return items.length ? [{ key: kind, label, items }] : [];
  });

  const own = new Set(bundle.definition.skills.map((s) => parseSkillRef(s.skill).id));
  const platformSkills: PaletteItem[] = [];
  const perConnector = new Map<string, PaletteItem[]>();
  const add = (connector: string, item: PaletteItem) =>
    perConnector.set(connector, [...(perConnector.get(connector) ?? []), item]);
  for (const s of data.catalog.skills) {
    // A pinned reference is offered only when the agent already uses it.
    if (s.source === "pinned" && !bundle.definition.skills.some((x) => x.skill === s.ref)) continue;
    // R2: a skill that only wraps a tool is offered as that tool's read or write step; a
    // conversation is its own step kind (R7).
    if (isToolWrapper(s.definition) || parseSkillRef(s.ref).id === CONVERSE_SKILL) continue;
    // Skill model (2026-11-10): a retired kind (agent mode, rules then AI) is listed only so the
    // steps already using it type; it is never offered for a new step.
    if (s.palette === false) continue;
    const mine = own.has(parseSkillRef(s.ref).id);
    const through = skillConnectors(s.definition, data);
    // An agent's own skill stays offered; another needs every connector it reaches.
    if (!mine && !through.every((c) => connectors.has(c))) continue;
    const item: PaletteItem = {
      type: "skill",
      key: `skill:${s.ref}`,
      title: s.definition.name,
      detail: s.definition.description || toolsLine(s.definition, data),
      ref: s.ref,
      skill: s.definition,
      own: mine,
      kind: s.kind ?? skillKind(s.definition, toolLookup(data.catalog.tools)),
    };
    const home = through[0];
    if (home && through.length === 1) add(home, item);
    else platformSkills.push(item);
  }
  platformSkills.sort(
    (a, b) => Number(b.type === "skill" && b.own) - Number(a.type === "skill" && a.own),
  );

  const direct = wrappedTools(data);
  for (const t of data.catalog.tools) {
    const c = t.connector ?? t.source;
    const isConnector = data.catalog.connectors.some((x) => x.id === c);
    if (isConnector ? !connectors.has(c) : !direct.has(t.id)) continue;
    const home = isConnector ? c : t.source === "platform" ? PLATFORM : t.source;
    const group = home === PLATFORM ? "Mezonas" : connectorName(data, home);
    const reads = t.sideEffect === "none";
    add(home, {
      type: reads ? "read" : "write",
      key: `${reads ? "read" : "write"}:${t.id}`,
      title: toolLabel(t.id),
      // Skill model (2026-11-10): "Save to records" or "Change in QuickBooks Online".
      detail: reads ? `Reads ${group}` : writeLabelOf(data, t.id),
      tool: t,
      group,
    });
  }
  if (connectors.has("browser")) for (const s of scriptPaletteItems(data)) add("browser", s);
  const order = (i: PaletteItem) => (i.type === "read" ? 1 : i.type === "write" ? 2 : 0);
  const connectorSections: PaletteSection[] = [...perConnector]
    .map(([id, items]) => ({
      key: `connector:${id}`,
      label: id === PLATFORM ? "Mezonas" : connectorName(data, id),
      // Skills, then reads, then the changes it makes, each by name.
      items: [...items].sort((a, b) => order(a) - order(b) || a.title.localeCompare(b.title)),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  // A process used inside another is one step (§10.14; today's automations, pinned).
  const used = (data.catalog.automations ?? []).map(
    (a): PaletteItem => ({
      type: "process",
      key: `process:${a.ref}`,
      title: a.name,
      detail: `Version ${a.version}${a.source === "client" ? " · this client's" : ""}`,
      ref: a.ref,
    }),
  );

  return [
    { key: "triggers", label: "Triggers", items: groups.flatMap((g) => g.items), groups },
    { key: "processes", label: "Processes", items: used },
    { key: "skills", label: "Skills", items: platformSkills },
    // Skill model (2026-11-10): what to do, resolved from the agent's connections when it runs.
    {
      key: "actions",
      label: "Actions",
      items: processes.WRITE_ACTIONS.map((a) => actionItem(a)),
    },
    ...connectorSections,
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
        {
          type: "conversation",
          key: "conversation",
          title: "Talk with a person",
          detail: "Talk it through with someone until you have the answer, within limits",
        },
        {
          type: "notify",
          key: "notify",
          title: "Notify",
          detail: "Tell your team or ours that something happened",
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
  const matches = (i: PaletteItem) => {
    const text = `${i.title} ${i.detail}`.toLowerCase();
    return words.every((w) => text.includes(w));
  };
  return sections
    .map((s) => ({
      ...s,
      items: s.items.filter(matches),
      ...(s.groups
        ? {
            groups: s.groups
              .map((g) => ({ ...g, items: g.items.filter(matches) }))
              .filter((g) => g.items.length > 0),
          }
        : {}),
    }))
    .filter((s) => s.items.length > 0);
}
