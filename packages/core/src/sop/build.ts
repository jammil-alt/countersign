// The agent's SOP, made by code (docs/sop-plan.md §3–§5). `sopView` is pure: the API gathers the
// agent's live version, its row's settings, its connections and grants, the client's approver rules
// and the names of the people it names, and this turns them into the thirteen sections. Same input,
// same SOP: no model call, no clock (the caller passes `asOf`).
//
// What a write does is worked out by the gate's own code (`decideToolCall`), and which model an AI
// step runs on by the runtime's own rule (`runModel`), so the SOP can't disagree with either.

import type { ApproverRule, ApproverTarget } from "../approvals/rules";
import { effectiveMode } from "../lifecycle/stage";
import { processStepWords, readManual } from "../manual/manual";
import { formatAmount } from "../money";
import type { OwnerArea } from "../owners/areas";
import { decideToolCall } from "../permissions/decide";
import { effectiveMatrix, type GrantLimits } from "../permissions/grants";
import { ACTION_SPECS } from "../process/actions";
import { loopStepNumber, pathLetter, pathStepNumber } from "../process/numbers";
import { SELF_AGENT } from "../process/schema";
import type { AgentDefinition, AnyAgentBundle } from "../schemas/agent";
import type { PermissionLevel, PermissionMatrix, Verb } from "../schemas/permissions";
import type { Rules } from "../schemas/rules";
import { type SkillDefinition, skillMethod, skillTools } from "../schemas/skill";
import { isAlwaysSigned, type ToolSpec } from "../schemas/tool";
import { runModel } from "../skills/model";
import { scheduleText } from "../triggers/schedule";
import { type SopSay, type SopSayKey, say, sopEntityKey } from "./say";
import type {
  SopApprover,
  SopChartKind,
  SopControl,
  SopData,
  SopLevel,
  SopMethod,
  SopOutlineStep,
  SopParty,
  SopPathLine,
  SopProcedureLine,
  SopRevisionEntry,
  SopStepLine,
  SopSystem,
  SopView,
} from "./view";

// ── Inputs ───────────────────────────────────────────────────────────────────────────────────

/** One connection the agent is bound to, as the API reads it (the client's own). */
export interface SopConnection {
  /** The binding's key: the connector id, or `connector:name`. */
  key: string;
  connector: string;
  /** The connection's id; null when the binding names none that exists. */
  id: string | null;
  /** The connector's name ("QuickBooks Online"). */
  name: string;
  /** The connection's own label: the account ("Harbor Millwork LLC"). */
  account: string | null;
  connected: boolean;
  connectedBy: string | null;
  matrix: Partial<PermissionMatrix> | null;
  grant: GrantLimits | null;
}

export interface SopInput {
  agent: {
    id: string;
    slug: string;
    name: string;
    area: OwnerArea;
    stage: string | null;
    runStatus: string | null;
    /** The client agent's approver override (`agent.approver`). */
    approver: string | null;
  };
  client: string;
  /** "SOP-PUR-03": worked out by the caller from the client's agents in the area. */
  code: string;
  bundle: AnyAgentBundle;
  skills: Readonly<Record<string, SkillDefinition>>;
  tools: Readonly<Record<string, ToolSpec>>;
  connections: readonly SopConnection[];
  /** A role, a user id or a contact id in words; never an id. */
  party: (who: string) => SopParty;
  /** Another agent of this client by slug, as a party; null when it isn't found. */
  agentParty: (slug: string) => SopParty | null;
  accountable: readonly SopParty[];
  owner: { party: SopParty; model: string | null } | null;
  lead: SopParty | null;
  approverRules: readonly ApproverRule[];
  /** The client's default approver setting (a role or a user id), when it has one. */
  clientApprover: string | null;
  /** The client's business hours in words, when set. */
  businessHours: string | null;
  /** A model id by name and maker ("Claude Sonnet 5.5, Anthropic"); null when it has no name. */
  modelName: (id: string) => string | null;
  hipaa: boolean;
  measures: readonly { label: string; value: string }[];
  /** Titles of the policies its steps read (ours and the client's). */
  policies: readonly string[];
  takesOverFrom: readonly string[];
  knowledge: readonly string[];
  settings: readonly {
    label: string;
    value: string;
    limits: string | null;
    changedBy: string | null;
  }[];
  /** What it learned for this client; null when the reader may not see it. */
  learned: readonly { id: string; note: string; at: string }[] | null;
  /** The client's description of the agent, when no build wrote its purpose. */
  fallbackPurpose: string | null;
  asOf: string;
  revision: SopRevisionEntry | null;
  previous: { number: string; at: string } | null;
  history: readonly SopRevisionEntry[];
}

/**
 * How Mezonas writes SOPs. Raise it with any change to `sopView` that changes what an SOP says for
 * the same setup (wording, sections, what a step shows): the next revision of each agent then reads
 * "We changed how SOPs are written" instead of listing changes nobody made (docs/sop-plan.md §6).
 */
export const SOP_FORMAT = 1;

// ── Words ────────────────────────────────────────────────────────────────────────────────────

export const AREA_WORDS: Record<OwnerArea, string> = {
  purchasing: "Purchasing",
  sales: "Sales",
  receivables: "Receivables",
  bookkeeping: "Bookkeeping",
  marketing: "Marketing",
  general: "Operations",
};

/** Three letters per area for the SOP's code ("SOP-PUR-03"). */
export const AREA_CODES: Record<OwnerArea, string> = {
  purchasing: "PUR",
  sales: "SAL",
  receivables: "REC",
  bookkeeping: "BKP",
  marketing: "MKT",
  general: "OPS",
};

/** The SOP's code: the area's letters and the agent's place in that area, from 1. */
export function sopCode(area: OwnerArea, place: number): string {
  return `SOP-${AREA_CODES[area]}-${String(Math.max(1, place)).padStart(2, "0")}`;
}

const STAGE_WORDS: Record<string, string> = {
  bench: "Being set up",
  trial: "Trial: every change is signed",
  signoff: "Sign-off: every change is signed",
  live: "Live",
};

/** What every SOP says the agent never does (the guardrails, in words). */
export const SOP_NEVER = [
  "Deletes anything in your tools",
  "Moves money",
  "Changes its own permissions or steps",
] as const;

const PLATFORM_CONTROLS = {
  no_delete: {
    name: "Nothing is ever deleted in your tools",
    kind: "prevents",
    how: "automatic",
    evidence: "Platform",
  },
  once: {
    name: "Each change is made once, with what it was before",
    kind: "prevents",
    how: "automatic",
    evidence: "The changes to your tools, in each run",
  },
  signed_stage: {
    name: "Every change is signed while it is in trial or sign-off",
    kind: "prevents",
    how: "person",
    evidence: "Each run's audit trail",
  },
  data_is_data: {
    name: "Text in documents and messages is read as data, never as instructions",
    kind: "prevents",
    how: "automatic",
    evidence: "Platform",
  },
  own_permissions: {
    name: "The agent can't change its own permissions or steps",
    kind: "prevents",
    how: "automatic",
    evidence: "Platform",
  },
  logged: {
    name: "Everything a person does is logged",
    kind: "catches",
    how: "automatic",
    evidence: "Your audit export",
  },
  hipaa: {
    name: "Only vendors ready for HIPAA receive your data",
    kind: "prevents",
    how: "automatic",
    evidence: "Platform",
  },
} as const satisfies Record<string, Pick<SopControl, "name" | "kind" | "how" | "evidence">>;

const MEZONAS: SopParty = { key: "mezonas", kind: "mezonas", name: "Mezonas" };

function sentence(text: string): string {
  const t = text.trim();
  if (!t) return t;
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

function capital(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

const SYMBOLS: Record<string, string> = { USD: "$", CAD: "CA$", EUR: "€", GBP: "£", AUD: "A$" };

/** "$5,000" from a decimal string, by string (never a float). */
export function moneyWords(value: string, currency: string): string {
  const fixed = formatAmount(value, 2).replace(/\.00$/, "");
  const [whole, cents] = fixed.split(".");
  const neg = (whole ?? "").startsWith("-");
  const digits = (whole ?? "").replace("-", "");
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const symbol = SYMBOLS[currency];
  const amount = `${grouped}${cents ? `.${cents}` : ""}`;
  return `${neg ? "-" : ""}${symbol ?? `${currency} `}${amount}`;
}

function durationWords(d: string): string {
  const m = /^(\d+)\s*([smhdw])$/.exec(d.trim());
  if (!m) return d;
  const n = Number(m[1]);
  const unit = { s: "second", m: "minute", h: "hour", d: "day", w: "week" }[m[2] as string];
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

function deadlineWords(d: { after: string; hours?: string | undefined } | undefined | null) {
  if (!d) return null;
  const base = durationWords(d.after);
  return d.hours === "business" ? `${base.replace(/days?$/, (x) => `business ${x}`)}` : base;
}

const EVENT_WORDS: Record<string, string> = {
  "document.received": "A document arrives",
  "document.extracted": "A document has been read",
  "transaction.created": "A record is added in your tools",
  "transaction.updated": "A record changes in your tools",
  "message.received": "A message arrives",
  "inbound.message": "A message arrives",
  "run.succeeded": "Another agent finishes",
};

const EVENT_SAY: Record<string, SopSayKey> = {
  "document.received": "sop.say.trigger.documentReceived",
  "document.extracted": "sop.say.trigger.documentExtracted",
  "transaction.created": "sop.say.trigger.transactionCreated",
  "transaction.updated": "sop.say.trigger.transactionUpdated",
  "message.received": "sop.say.trigger.messageReceived",
  "inbound.message": "sop.say.trigger.messageReceived",
  "run.succeeded": "sop.say.trigger.runSucceeded",
};

/** A trigger by key (S5.7), or null for one said only in English (a schedule, an unknown event). */
export function sopTriggerSay(
  on: { type: string } & Record<string, unknown>,
  agentName: (slug: string) => string | null,
): SopSay | null {
  switch (on.type) {
    case "event": {
      const key = EVENT_SAY[String(on.event)];
      return key ? say(key) : null;
    }
    case "manual":
      return (on.client as { canRun?: boolean } | undefined)?.canRun
        ? say("sop.say.trigger.manualTeam")
        : say("sop.say.trigger.manualUs");
    case "command":
      return say("sop.say.trigger.command", { command: String(on.command) });
    case "webhook":
      return say("sop.say.trigger.webhook");
    case "message":
      return say("sop.say.trigger.message");
    case "handoff": {
      const from = on.from as { agent?: string } | undefined;
      const name = from?.agent ? agentName(from.agent) : null;
      return name ? say("sop.say.trigger.handoff", { name }) : say("sop.say.trigger.handoffAny");
    }
    case "schedule":
      return null;
    default:
      return say("sop.say.trigger.started");
  }
}

/** A trigger in words. */
export function sopTriggerWords(
  on: { type: string } & Record<string, unknown>,
  agentName: (slug: string) => string | null,
): string {
  switch (on.type) {
    case "event": {
      const ev = String(on.event);
      return EVENT_WORDS[ev] ?? `When ${ev.replaceAll(/[._]/g, " ")}`;
    }
    case "schedule":
      return capital(scheduleText({ cron: String(on.cron), tz: (on.tz as string) ?? null }));
    case "manual": {
      const client = on.client as { canRun?: boolean } | undefined;
      return client?.canRun ? "Someone on your team starts it (Run now)" : "We start it by hand";
    }
    case "command":
      return `Someone types /${String(on.command)} in a thread`;
    case "webhook":
      return "Another system sends it a delivery";
    case "message":
      return "A message arrives from someone it may hear from";
    case "handoff": {
      const from = on.from as { agent?: string } | undefined;
      const name = from?.agent ? agentName(from.agent) : null;
      return name ? `${name} hands over to it` : "Another agent hands over to it";
    }
    // Collect reports (owner, 2026-11-24)
    case "report":
      return "The first report arrives by email";
    default:
      return "It is started";
  }
}

function ruleValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "a value";
}

const OP_WORDS: Record<string, string> = {
  "=": "is",
  "!=": "is not",
  ">": "is over",
  ">=": "is at least",
  "<": "is under",
  "<=": "is at most",
  contains: "contains",
  exists: "is there",
  in: "is one of",
  is: "is",
};

/** A rule's field in words: `{{steps.match.output.unit_price}}` → "unit price". */
function fieldWords(field: string): string {
  const plain = field.replaceAll(/[{}]/g, "").trim();
  const last =
    plain
      .split(".")
      .filter((p) => p && p !== "output" && p !== "steps" && p !== "trigger")
      .pop() ?? plain;
  return last.replaceAll(/[_-]+/g, " ");
}

/** A path's condition for a reader: the operator's description, else the rules in words. */
export function pathWords(path: { name?: string; describe?: string; when?: Rules }): string {
  if (path.describe?.trim()) return path.describe.trim();
  const rules = path.when?.rules ?? [];
  if (rules.length > 0) {
    const parts = rules.map((r) => {
      const field = fieldWords(r.field);
      const op = OP_WORDS[r.op] ?? r.op;
      return r.op === "exists" ? `${field} ${op}` : `${field} ${op} ${ruleValue(r.value)}`;
    });
    return parts.join(path.when?.match === "any" ? ", or " : ", and ");
  }
  return path.name?.trim() || "this path";
}

// ── Steps ────────────────────────────────────────────────────────────────────────────────────

/** A step of either schema, read structurally. */
type AnyStep = { id: string; name: string; kind: string; purpose?: string } & Record<
  string,
  unknown
>;

interface Visited {
  step: AnyStep;
  number: string;
  depth: number;
  workflow: string | null;
  v4: boolean;
  /** Where it sits, as the builder names it: `root`, `path:<id>`, `otherwise:<id>`, `loop:<id>`. */
  container: string;
  /** A decision's paths, then Otherwise, for the chart. */
  paths: SopOutlineStep["paths"];
}

/** The steps in run order with their numbers, and a line before each path of an `if`. */
function walk(bundle: AnyAgentBundle): {
  visited: Visited[];
  lines: (Visited | Omit<SopPathLine, "line">)[];
} {
  const visited: Visited[] = [];
  const lines: (Visited | Omit<SopPathLine, "line">)[] = [];
  const enabled = bundle.workflows.filter((w) => w.enabled !== false);
  const many = enabled.length > 1;
  for (const w of enabled) {
    const v4 = (w.workflow as { schemaVersion: number }).schemaVersion === 4;
    const workflow = many ? w.name : null;
    // One step, then what it holds, at any depth: an `if`'s paths, lettered A, B… then Otherwise,
    // each numbered from 1 ("5 A1"), a `for_each`'s or a `repeat`'s steps ("6.2"). The chart's
    // numbers (`process/numbers.ts`), so a step has one number on every screen.
    const visit = (step: AnyStep, number: string, depth: number, container: string) => {
      const v: Visited = { step, number, depth, workflow, v4, container, paths: null };
      visited.push(v);
      lines.push(v);
      if (step.kind === "if" || step.kind === "fork") {
        const paths =
          (step.paths as {
            id?: string;
            name: string;
            describe?: string;
            when: Rules;
            steps: AnyStep[];
          }[]) ?? [];
        const other = step.otherwise as { id?: string; steps: AnyStep[] } | undefined;
        const otherwise = other?.steps ?? [];
        const otherwiseId = other?.id ?? `${step.id}:otherwise`;
        v.paths = [];
        const inner = (children: AnyStep[], letter: string, into: string) => {
          children.forEach((c, i) => {
            visit(c, pathStepNumber(number, letter, i), depth + 1, into);
          });
        };
        paths.forEach((p, i) => {
          const letter = pathLetter(i);
          const words = pathWords(p);
          const id = p.id ?? `${step.id}:path${i}`;
          v.paths?.push({ id, letter, name: p.name.trim(), words, otherwise: false });
          lines.push({ depth: depth + 1, label: "if", letter, words, empty: p.steps.length === 0 });
          inner(p.steps, letter, `path:${id}`);
        });
        const letter = pathLetter(paths.length);
        v.paths.push({ id: otherwiseId, letter, name: "", words: "", otherwise: true });
        lines.push({
          depth: depth + 1,
          label: "otherwise",
          letter,
          words: otherwise.length === 0 ? "straight on" : "",
          empty: otherwise.length === 0,
        });
        inner(otherwise, letter, `otherwise:${otherwiseId}`);
      } else if (step.kind === "for_each" || step.kind === "repeat") {
        ((step.steps as AnyStep[]) ?? []).forEach((c, i) => {
          visit(c, loopStepNumber(number, i), depth + 1, `loop:${step.id}`);
        });
      }
    };
    ((w.workflow as { steps: unknown[] }).steps ?? []).forEach((step, i) => {
      visit(step as AnyStep, String(i + 1), 0, "root");
    });
  }
  return { visited, lines };
}

const CHART_KINDS = new Set<string>([
  "read",
  "skill",
  "write",
  "person",
  "conversation",
  "notify",
  "wait",
  "stop",
  "process",
  "handoff",
  "missing",
  "if",
  "for_each",
  "repeat",
]);

/**
 * A step's kind as the chart draws it: a v4 step's own; a v3 step's as the builder reads it when it
 * converts (an action that writes to a client's tool is a write, else a read; a fork is a
 * decision; an automation is a sub-process).
 */
function chartKind(v: Visited, input: SopInput): SopChartKind {
  const kind = v.step.kind;
  // Collect reports (owner, 2026-11-24): drawn as a conversation, a step that contacts people.
  if (v.v4 && kind === "collect") return "conversation";
  if (v.v4) return (CHART_KINDS.has(kind) ? kind : "missing") as SopChartKind;
  switch (kind) {
    case "action":
      return toolsOf(v.step, input).some((t) => t.sideEffect === "external") ? "write" : "read";
    case "fork":
      return "if";
    case "use_automation":
      return "process";
    default:
      return (CHART_KINDS.has(kind) ? kind : "missing") as SopChartKind;
  }
}

function lookupSkill(ref: string, skills: SopInput["skills"]): SkillDefinition | undefined {
  return skills[ref] ?? skills[ref.split("@")[0] ?? ref];
}

/** The tools a step may call, from its own tool, its action, or its skill. */
function toolsOf(step: AnyStep, input: SopInput): ToolSpec[] {
  const ids: string[] = [];
  if (step.kind === "read" || step.kind === "action") ids.push(String(step.tool));
  if (step.kind === "write") {
    if (step.tool) ids.push(String(step.tool));
    else if (step.action) {
      const tools = ACTION_SPECS[step.action as keyof typeof ACTION_SPECS]?.tools ?? {};
      const via = step.via as string | undefined;
      // An action resolves from the agent's bindings when it runs: the bound connector's tool.
      const bound = new Set(input.connections.map((c) => c.connector));
      const pick = via ? tools[via] : Object.entries(tools).find(([c]) => bound.has(c))?.[1];
      if (pick) ids.push(pick);
    }
  }
  if (step.kind === "skill") {
    const def = lookupSkill(String(step.skill), input.skills);
    if (def) ids.push(...skillTools(def));
  }
  return ids.map((id) => input.tools[id]).filter((t): t is ToolSpec => t !== undefined);
}

function methodOf(step: AnyStep, input: SopInput): SopMethod | null {
  switch (step.kind) {
    case "person":
    case "missing":
      return "person";
    case "skill": {
      const def = lookupSkill(String(step.skill), input.skills);
      return def ? skillMethod(def) : null;
    }
    case "conversation":
      return "ai";
    case "if":
      return step.decide === "agent" ? "ai" : "rules";
    case "repeat":
      return (step.until as { agent?: unknown } | undefined)?.agent ? "ai" : "rules";
    case "read":
    case "write":
    case "action":
      return toolsOf(step, input).some((t) => t.usesModel !== undefined) ? "ai" : "rules";
    default:
      return "rules";
  }
}

/**
 * The model id an AI step runs on, as the runtime picks it (`runModel`); "tool" for a tool that
 * calls a model inside and picks its own; null for a step no model does.
 */
function modelIdOf(step: AnyStep, method: SopMethod | null, input: SopInput): string | null {
  if (method !== "ai" && method !== "rules_then_ai") return null;
  const definition = input.bundle.definition as AgentDefinition;
  if (step.kind === "skill") {
    const def = lookupSkill(String(step.skill), input.skills);
    if (!def) return null;
    const agentSkill = definition.skills.find((s) => s.skill === step.skill)?.model;
    return runModel({
      agentModel: definition.model,
      skill: def,
      step: step.model as { id: string } | undefined,
      agentSkill,
    }).id;
  }
  if (step.kind === "if" || step.kind === "repeat") {
    // §10.15: an agent's choice runs on the owner's model when the process names none.
    return definition.oversight?.model?.id ?? input.owner?.model ?? definition.model.id;
  }
  if (step.kind === "conversation") return definition.model.id;
  return "tool";
}

function modelOf(step: AnyStep, method: SopMethod | null, input: SopInput): string | null {
  const id = modelIdOf(step, method, input);
  // A tool that calls a model inside picks its own; it has no name to show.
  if (id === "tool") return "An AI model";
  return id ? (input.modelName(id) ?? "An AI model") : null;
}

/**
 * Each AI step's model id, as the runtime picks it: the agent assurance view's AI providers
 * (docs/agent-assurance-plan.md §4b) read the same answer the SOP shows.
 */
export function sopStepModels(input: SopInput): { stepId: string; model: string }[] {
  const out: { stepId: string; model: string }[] = [];
  for (const v of walk(input.bundle).visited) {
    const id = modelIdOf(v.step, methodOf(v.step, input), input);
    if (id && id !== "tool") out.push({ stepId: String(v.step.id), model: id });
  }
  return out;
}

/** A tool's purpose by key (S5.7): "Adds {what} to {where}.", its record type translated. */
function toolPurposeSay(tool: ToolSpec, systemsOf: (t: ToolSpec) => string | null): SopSay {
  const system = systemsOf(tool);
  const entity = tool.entity ?? null;
  const what = entity ? plural(entity.replaceAll("_", " ")) : "records";
  const key: SopSayKey =
    tool.sideEffect === "none"
      ? "sop.say.purpose.reads"
      : tool.verb === "create"
        ? "sop.say.purpose.adds"
        : tool.verb === "delete"
          ? "sop.say.purpose.removes"
          : "sop.say.purpose.updates";
  const whatKey = entity ? sopEntityKey(entity) : "sop.say.what.records";
  return say(
    key,
    { what, where: system ?? "your records in Mezonas" },
    {
      ...(whatKey ? { what: whatKey } : {}),
      ...(system ? {} : { where: "sop.say.where.mezonas" }),
    },
  );
}

/** "Reads vendors from QuickBooks Online.": what one tool does, in words. */
function toolPurpose(tool: ToolSpec, systemsOf: (t: ToolSpec) => string | null): string {
  const where = systemsOf(tool) ?? "your records in Mezonas";
  const what = tool.entity ? plural(tool.entity.replaceAll("_", " ")) : "records";
  const [verb, prep] =
    tool.sideEffect === "none"
      ? ["Reads", "from"]
      : tool.verb === "create"
        ? ["Adds", "to"]
        : tool.verb === "delete"
          ? ["Removes", "from"]
          : ["Updates", "in"];
  return `${verb} ${what} ${prep} ${where}.`;
}

/** The step's purpose by key, when it is a tool's (S5.7); null for words from elsewhere. */
function purposeSayFor(
  step: AnyStep,
  input: SopInput,
  systemsOf: (t: ToolSpec) => string | null,
): SopSay | null {
  const first = toolsOf(step, input)[0];
  if ((step.kind === "read" || step.kind === "write" || step.kind === "action") && first) {
    return toolPurposeSay(first, systemsOf);
  }
  if (step.kind === "skill" && first) {
    const def = lookupSkill(String(step.skill), input.skills);
    if (!def || def.mode === "tool") return toolPurposeSay(first, systemsOf);
  }
  return null;
}

function purposeFor(
  step: AnyStep,
  v4: boolean,
  input: SopInput,
  systemsOf: (t: ToolSpec) => string | null,
): string {
  const first = toolsOf(step, input)[0];
  if ((step.kind === "read" || step.kind === "write" || step.kind === "action") && first) {
    return toolPurpose(first, systemsOf);
  }
  if (step.kind === "missing") return sentence(String(step.need ?? "A person does this part"));
  if (step.kind === "skill") {
    const def = lookupSkill(String(step.skill), input.skills);
    // DECISION: an AI skill's own description is written for people (what it does, never its
    // instructions): its first sentence, when short enough for one line. A code skill's is its
    // tool's, written for developers, so it reads as its first tool does, like a read or a write.
    if (def && def.mode !== "tool") {
      const line = def.description
        ?.trim()
        .split(/(?<=[.!?])\s/)[0]
        ?.trim();
      if (line && line.length <= 200) return sentence(line);
    } else if (first) {
      return toolPurpose(first, systemsOf);
    }
  }
  return sentence(kindWords(step, v4));
}

/** "bill" → "bills", "company" → "companies": enough for record types' names. */
function plural(word: string): string {
  if (/s$/.test(word)) return word;
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

function kindWords(step: AnyStep, v4: boolean): string {
  if (v4) return processStepWords(step as never);
  switch (step.kind) {
    case "action":
      return "Uses one of your tools";
    case "fork":
      return "Chooses a path";
    case "use_automation":
      return "Runs a shared process";
    case "skill":
      return "Works it out";
    default:
      return processStepWords(step as never);
  }
}

function levelOf(decision: "run" | "approval" | "refused"): SopLevel {
  return decision === "run" ? "auto" : decision === "approval" ? "ask" : "off";
}

function levelFromMatrix(l: PermissionLevel): SopLevel {
  return l === "auto" ? "auto" : l === "approval" ? "ask" : "off";
}

const STRICT: Record<SopLevel, number> = { auto: 0, ask: 1, off: 2 };

function targetParty(t: ApproverTarget, input: SopInput): SopParty {
  switch (t.kind) {
    case "client_admin":
      return input.party("client_admin");
    case "role":
      return input.party(t.role);
    case "user":
      return input.party(t.userId);
    case "operator":
      return input.party("operator");
  }
}

/** `ifNoAnswerWords` by key (S5.7). */
function ifNoAnswerSay(then: unknown, input: SopInput): SopSay | undefined {
  if (then === undefined || then === null || then === "stop") return say("sop.say.then.stop");
  if (then === "proceed") return say("sop.say.then.proceed");
  if (then === "skip") return say("sop.say.then.skip");
  const esc = (then as { escalate?: { to: string } }).escalate;
  if (esc) return say("sop.say.then.escalate", { name: input.party(esc.to).name });
  return undefined;
}

function ifNoAnswerWords(then: unknown, input: SopInput): string | null {
  if (then === undefined || then === null || then === "stop") return "the run stops";
  if (then === "proceed") return "it goes on";
  if (then === "skip") return "the step is skipped";
  const esc = (then as { escalate?: { to: string } }).escalate;
  if (esc) return `${input.party(esc.to).name} is asked`;
  return null;
}

// ── The view ─────────────────────────────────────────────────────────────────────────────────

export function sopView(input: SopInput): SopView {
  const definition = input.bundle.definition as AgentDefinition;
  const manual = readManual((definition as { manual?: unknown }).manual);
  const self: SopParty = {
    key: `agent:${input.agent.slug}`,
    kind: "agent",
    name: input.agent.name,
  };
  const mode = effectiveMode(definition, input.agent.stage);
  const signingStage = input.agent.stage === "trial" || input.agent.stage === "signoff";

  // Systems: each bound connection, numbered in the order the steps first use them.
  const conns = input.connections;
  const connFor = (tool: ToolSpec): SopConnection | undefined =>
    tool.connector ? conns.find((c) => c.connector === tool.connector) : undefined;
  const systemName = (tool: ToolSpec): string | null => connFor(tool)?.name ?? null;

  const { visited, lines } = walk(input.bundle);
  const numberOf = new Map(visited.map((v) => [v.step.id, v.number]));

  // Controls collected while the steps are read; numbered at the end.
  const controls = new Map<string, Omit<SopControl, "id">>();
  const addControl = (
    key: string,
    c: Omit<SopControl, "id" | "key" | "steps" | "allSteps">,
    step?: string,
  ) => {
    const had = controls.get(key);
    if (had) {
      if (step && !had.steps.includes(step)) had.steps.push(step);
      return;
    }
    controls.set(key, { key, ...c, steps: step ? [step] : [], allSteps: !step });
  };

  const systemUse = new Map<string, { conn: SopConnection; steps: string[]; verbs: Set<Verb> }>();
  const dataUse = new Map<
    string,
    {
      record: string;
      livesIn: string;
      does: Set<string>;
      steps: string[];
      ai: string[];
      kept: string;
    }
  >();

  const stepLines = new Map<string, SopStepLine>();
  let anyAi = false;
  let anyWrite = false;
  let writesByRules = true;

  for (const v of visited) {
    const { step, number } = v;
    const method = methodOf(step, input);
    const model = modelOf(step, method, input);
    if (method === "ai" || method === "rules_then_ai") anyAi = true;
    const tools = toolsOf(step, input);
    const lineControls: string[] = [];

    // Who does it, only when it isn't this agent.
    let who: SopParty | null = null;
    if (step.kind === "person") who = input.party(String(step.assignee));
    else if (step.kind === "missing")
      who = { key: "role:client_user", kind: "team", name: "A person on your team" };
    else if (
      step.kind === "skill" &&
      typeof step.agent === "string" &&
      step.agent !== input.agent.slug
    ) {
      who = input.agentParty(step.agent);
    } else if (step.kind === "handoff") {
      const to = (step.to as { agent?: string } | undefined)?.agent;
      // Ways in, ways out (2026-11-23): a hand-off to this agent's own workflow names no other party.
      who = to && to !== SELF_AGENT ? input.agentParty(to) : null;
    }

    // Systems and data the step touches.
    const systems: SopStepLine["systems"] = [];
    const data: SopStepLine["data"] = [];
    let approval: SopStepLine["approval"] = null;
    for (const tool of tools) {
      const conn = connFor(tool);
      if (conn) {
        const use = systemUse.get(conn.key) ?? { conn, steps: [], verbs: new Set<Verb>() };
        if (!use.steps.includes(number)) use.steps.push(number);
        use.verbs.add(tool.sideEffect === "none" ? "read" : tool.verb);
        systemUse.set(conn.key, use);
      }
      const verb: Verb = tool.sideEffect === "none" ? "read" : tool.verb;
      const where = conn
        ? `Your ${conn.name}`
        : tool.area && tool.area !== "shared"
          ? `Your records in Mezonas: ${AREA_WORDS[tool.area as OwnerArea] ?? capital(tool.area)}`
          : "Your records in Mezonas";
      const record = tool.entity ? capital(tool.entity.replaceAll("_", " ")) : "Records";
      const dkey = `${record}|${where}`;
      const d = dataUse.get(dkey) ?? {
        record,
        livesIn: where,
        does: new Set<string>(),
        steps: [],
        ai: [],
        kept: conn ? `In ${conn.name}` : "While you're a client; deleted 30 days after you leave",
      };
      d.does.add(
        tool.sideEffect === "none" ? "reads" : tool.sideEffect === "internal" ? "saves" : "changes",
      );
      if (!d.steps.includes(number)) d.steps.push(number);
      if (model && (method === "ai" || method === "rules_then_ai")) {
        const line = `Step ${number}, ${model}`;
        if (!d.ai.includes(line)) d.ai.push(line);
      }
      dataUse.set(dkey, d);

      // A write to a client's tool: the gate's own decision.
      if (tool.sideEffect === "external") {
        anyWrite = true;
        if (method !== "rules") writesByRules = false;
        const stepApproval = v.v4
          ? (step.checks as { approval?: { required?: "required" | "not_required" } } | undefined)
              ?.approval?.required
          : (step.approval as { required?: "required" | "not_required" } | undefined)?.required;
        const decision = !conn?.connected
          ? "refused"
          : decideToolCall({
              sideEffect: tool.sideEffect,
              verb: tool.verb,
              matrix: conn.matrix ?? undefined,
              grant: conn.grant,
              stepApproval,
              agentMode: mode,
              alwaysSigned: isAlwaysSigned(tool),
            });
        const level = levelOf(decision);
        systems.push({
          id: conn?.key ?? tool.connector ?? tool.id,
          name: conn?.name ?? tool.connector ?? "A tool",
          verb: capital(verb),
          level,
        });
        if (!approval || STRICT[level] > STRICT[approval.level]) {
          approval = { level, approvers: [], byWhen: null, ifNoAnswer: null, ifRejected: null };
          if (level === "ask") {
            approval.approvers = approversFor(step, v.v4, tool, input);
            const first = v.v4
              ? (
                  step.checks as
                    | {
                        approval?: {
                          approvers?: { deadline?: { after: string; hours?: string } }[];
                          ifNoAnswer?: unknown;
                          onReject?: string;
                        };
                      }
                    | undefined
                )?.approval
              : undefined;
            approval.byWhen = deadlineWords(first?.approvers?.[0]?.deadline ?? null);
            approval.ifNoAnswer = approval.byWhen
              ? ifNoAnswerWords(first?.ifNoAnswer, input)
              : null;
            const noAnswerSay = approval.byWhen
              ? ifNoAnswerSay(first?.ifNoAnswer, input)
              : undefined;
            if (noAnswerSay) approval.ifNoAnswerSay = noAnswerSay;
            const onReject = v.v4
              ? first?.onReject
              : (step.approval as { onReject?: string } | undefined)?.onReject;
            approval.ifRejected =
              onReject === "continue"
                ? "it goes on without the change"
                : "the change isn't made and the run stops";
            approval.ifRejectedSay = say(
              onReject === "continue" ? "sop.say.rejected.continue" : "sop.say.rejected.stop",
            );
          }
        }
      } else if (tool.sideEffect === "none" && conn) {
        const m = conn.grant ? effectiveMatrix(conn.matrix ?? undefined, conn.grant) : conn.matrix;
        const level = m?.read ? levelFromMatrix(m.read) : "auto";
        if (!systems.some((s) => s.id === conn.key && s.verb === "Read")) {
          systems.push({ id: conn.key, name: conn.name, verb: "Read", level });
        }
      }
      const words = `${capital(tool.sideEffect === "none" ? "reads" : tool.sideEffect === "internal" ? "saves" : tool.verb === "create" ? "creates" : "changes")} ${record.toLowerCase()}`;
      if (!data.some((x) => x.words === words)) data.push({ id: dkey, words });
    }

    // Controls on the step.
    if (approval?.level === "ask") {
      const key = `approval:${step.id}`;
      addControl(
        key,
        {
          name: `A person approves before "${step.name}" changes ${systems[0]?.name ?? "your tools"}`,
          kind: "prevents",
          how: "person",
          model: null,
          owner: approval.approvers.at(-1)?.party ?? input.party("client_admin"),
          evidence: "The approval in each run's audit trail",
        },
        number,
      );
      lineControls.push(key);
      for (const rule of rulesFor(tools, input)) {
        if (!rule.match.amountOver) continue;
        const rkey = `rule:${rule.id}`;
        addControl(
          rkey,
          {
            name: `Changes over ${moneyWords(rule.match.amountOver.value, rule.match.amountOver.currency)} need ${targetParty(rule.approver, input).name}'s approval`,
            kind: "prevents",
            how: "person",
            model: null,
            owner: targetParty(rule.approver, input),
            evidence: "Your approval rules; each run's audit trail",
          },
          number,
        );
        lineControls.push(rkey);
      }
    }
    for (const s of systems) {
      const key = `system:${s.id}`;
      addControl(
        key,
        {
          name: `What ${input.agent.name} may do in ${s.name}`,
          kind: "prevents",
          how: "automatic",
          model: null,
          owner: input.party("client_admin"),
          evidence: `${s.name}'s change history on Connectors`,
        },
        number,
      );
      if (!lineControls.includes(key)) lineControls.push(key);
    }
    if ((step.kind === "if" || step.kind === "fork") && method === "rules") {
      const key = `paths:${step.id}`;
      addControl(
        key,
        {
          name: `Fixed rules choose the path at "${step.name}"`,
          kind: "prevents",
          how: "rules",
          model: null,
          owner: MEZONAS,
          evidence: "The run timeline",
        },
        number,
      );
      lineControls.push(key);
    }
    const confer = v.v4
      ? (step.checks as { confer?: { with: { ai?: unknown; person?: string }[] } } | undefined)
          ?.confer
      : undefined;
    for (const c of confer?.with ?? []) {
      if (c.person) {
        const p = input.party(c.person);
        const key = `check:${step.id}:${p.key}`;
        addControl(
          key,
          {
            name: `${p.name} checks "${step.name}"`,
            kind: "catches",
            how: "person",
            model: null,
            owner: p,
            evidence: "The step's check in the run",
          },
          number,
        );
        lineControls.push(key);
      } else if (c.ai) {
        const key = `check:${step.id}:ai`;
        addControl(
          key,
          {
            name: `A second AI checks "${step.name}"`,
            kind: "catches",
            how: "ai",
            model: null,
            owner: MEZONAS,
            evidence: "The step's check in the run",
          },
          number,
        );
        lineControls.push(key);
      }
    }
    const deadline =
      step.kind === "person"
        ? v.v4
          ? (step.deadline as {
              after: string;
              hours?: string;
              ifNoAnswer?: unknown;
              remind?: string[];
            })
          : { after: String(step.timeout) }
        : null;
    const byWhen = deadlineWords(deadline) ?? null;
    if (byWhen || approval?.byWhen) {
      addControl(
        "deadlines",
        {
          name: "Deadlines, reminders and what happens when nobody answers",
          kind: "catches",
          how: "automatic",
          model: null,
          owner: input.lead ?? MEZONAS,
          evidence: "The item's history in your inbox",
        },
        number,
      );
      lineControls.push("deadlines");
    }
    if (method === "ai" || method === "rules_then_ai") lineControls.push("platform:data_is_data");
    if (input.owner && step.review !== "off" && step.kind !== "person" && step.kind !== "missing") {
      lineControls.push("owner");
    }

    // Who is told.
    const told: SopParty[] = [];
    const notices = v.v4
      ? [
          ...((step.checks as { notify?: { to: string[] }[] } | undefined)?.notify ?? []),
          ...(step.kind === "notify" ? [step.notify as { to: string[] }] : []),
        ]
      : [];
    for (const n of notices)
      for (const to of n.to ?? []) {
        const p = input.party(to);
        if (!told.some((t) => t.key === p.key)) told.push(p);
      }
    if (deadline && v.v4) {
      for (const to of (deadline as { tell?: string[] }).tell ?? []) {
        const p = input.party(to);
        if (!told.some((t) => t.key === p.key)) told.push(p);
      }
      const esc = (deadline as { ifNoAnswer?: { escalate?: { to: string } } }).ifNoAnswer;
      if (esc && typeof esc === "object" && esc.escalate) {
        const p = input.party(esc.escalate.to);
        if (!told.some((t) => t.key === p.key)) told.push(p);
      }
    }

    const purposeWritten = typeof step.purpose === "string" && step.purpose.trim() !== "";
    const purposeSay = purposeWritten ? null : purposeSayFor(step, input, systemName);
    stepLines.set(step.id, {
      line: "step",
      id: step.id,
      number,
      depth: v.depth,
      workflow: v.workflow,
      name: step.name,
      kindWords: kindWords(step, v.v4),
      method,
      model,
      purpose: purposeWritten
        ? sentence(String(step.purpose))
        : purposeFor(step, v.v4, input, systemName),
      ...(purposeSay ? { purposeSay } : {}),
      purposeWritten,
      who,
      approval,
      told,
      systems,
      data,
      controls: lineControls,
      onError:
        step.onError === "continue" ? "the run goes on and a later step can deal with it" : null,
      ...(step.onError === "continue" ? { onErrorSay: say("sop.say.onError.continue") } : {}),
      byWhen: byWhen
        ? `${byWhen}${deadline && v.v4 ? `; if nobody answers, ${ifNoAnswerWords((deadline as { ifNoAnswer?: unknown }).ifNoAnswer, input)}` : ""}`
        : null,
    });
  }

  // The owner's review and the platform's controls, after the steps' own.
  const allNumbers = visited
    .filter((v) => v.step.kind !== "person" && v.step.kind !== "missing" && v.step.review !== "off")
    .map((v) => v.number);
  if (input.owner && allNumbers.length > 0) {
    addControl("owner", {
      name: `${input.owner.party.name} reviews failed steps and steps that lead to a change`,
      kind: "catches",
      how: "ai",
      model: input.owner.model ? (input.modelName(input.owner.model) ?? "An AI model") : null,
      owner: input.owner.party,
      evidence: `${input.owner.party.name}'s decisions in each run`,
    });
    const own = controls.get("owner");
    if (own) {
      own.steps = allNumbers;
      own.allSteps = false;
    }
  }
  const platform = (k: keyof typeof PLATFORM_CONTROLS, when: boolean) => {
    if (!when) return;
    const c = PLATFORM_CONTROLS[k];
    addControl(`platform:${k}`, { ...c, model: null, owner: MEZONAS });
  };
  platform("no_delete", anyWrite);
  platform("once", anyWrite);
  platform("signed_stage", anyWrite && signingStage);
  platform("data_is_data", anyAi);
  platform("own_permissions", true);
  platform("logged", true);
  platform("hipaa", input.hipaa);

  // Number the controls: the steps' own in step order, then the owner's, then the platform's.
  const ordered = [...controls.values()].sort((a, b) => controlRank(a.key) - controlRank(b.key));
  const ids = new Map(ordered.map((c, i) => [c.key, `C${i + 1}`]));
  const sopControls: SopControl[] = ordered.map((c) => ({ ...c, id: ids.get(c.key) as string }));

  const sysOrder = [...systemUse.values()];
  // Bound connections no step uses still show: the agent may use them.
  for (const c of conns)
    if (!systemUse.has(c.key)) sysOrder.push({ conn: c, steps: [], verbs: new Set() });
  const sysIds = new Map(sysOrder.map((s, i) => [s.conn.key, `S${i + 1}`]));
  const systems: SopSystem[] = sysOrder.map((s) => {
    const m = s.conn.grant
      ? effectiveMatrix(s.conn.matrix ?? undefined, s.conn.grant)
      : { ...(s.conn.matrix ?? {}) };
    const level = (verb: Verb): SopLevel | null => {
      const l = (m as Partial<PermissionMatrix>)[verb];
      if (!s.conn.connected) return null;
      if (l === undefined) return s.verbs.has(verb) ? (verb === "read" ? "auto" : "ask") : null;
      // Writes: what a step set to run on its own would do (the matrix and the grant); approval
      // set on a step stays on its own line.
      if (verb !== "read" && mode !== "act") return l === "off" ? "off" : "ask";
      return levelFromMatrix(l);
    };
    return {
      id: sysIds.get(s.conn.key) as string,
      key: s.conn.key,
      name: s.conn.name,
      account: s.conn.account,
      connected: s.conn.connected,
      connectedBy: s.conn.connectedBy,
      read: level("read"),
      create: level("create"),
      update: level("update"),
      delete: s.conn.connected ? "off" : null,
      steps: s.steps,
    };
  });

  const dataList = [...dataUse.entries()];
  const dataIds = new Map(dataList.map(([k], i) => [k, `D${i + 1}`]));
  const data: SopData[] = dataList.map(([key, d]) => ({
    id: dataIds.get(key) as string,
    key,
    record: d.record,
    livesIn: d.livesIn,
    agentDoes: capital([...d.does].join(" and ")),
    steps: d.steps,
    readByAi: d.ai.length > 0 ? d.ai.join("; ") : null,
    kept: d.kept,
  }));

  // The procedure, with each line's controls by number and systems and data by their ids.
  const procedure: SopProcedureLine[] = lines.map((l) => {
    if ("line" in l || !("step" in l)) return { line: "path", ...(l as Omit<SopPathLine, "line">) };
    const s = stepLines.get(l.step.id) as SopStepLine;
    return {
      ...s,
      controls: [...new Set(s.controls.map((k) => ids.get(k)).filter((x): x is string => !!x))],
      systems: s.systems.map((x) => ({ ...x, id: sysIds.get(x.id) ?? x.id })),
      data: s.data.map((x) => ({ ...x, id: dataIds.get(x.id) ?? x.id })),
    };
  });

  const steps = procedure.filter((l): l is SopStepLine => l.line === "step");
  const count = (m: SopMethod) => steps.filter((s) => s.method === m).length;

  // The shape for the client's view-only chart (§6a): each step's place and kind, nothing else.
  const outline: SopOutlineStep[] = visited.map((v) => ({
    id: v.step.id,
    number: v.number,
    workflow: v.workflow,
    kind: chartKind(v, input),
    container: v.container,
    depth: v.depth,
    paths: v.paths,
  }));

  // Who else takes part, by step: never the agent itself.
  const parties: SopParty[] = [];
  const addParty = (p: SopParty) => {
    if (p.key === self.key) return -1;
    let i = parties.findIndex((x) => x.key === p.key);
    if (i < 0) {
      parties.push(p);
      i = parties.length - 1;
    }
    return i;
  };
  const ownerControl = controls.get("owner");
  const rowsRaw = steps.map((s) => {
    const cells = new Map<
      number,
      { cell: "does" | "approves" | "checks" | "told"; note: string | null }
    >();
    if (s.who) cells.set(addParty(s.who), { cell: "does", note: null });
    for (const a of s.approval?.approvers ?? []) {
      cells.set(addParty(a.party), {
        cell: "approves",
        note: a.condition ? capital(a.condition) : null,
      });
    }
    if (input.owner && ownerControl?.steps.includes(s.number)) {
      const i = addParty(input.owner.party);
      if (!cells.has(i)) cells.set(i, { cell: "checks", note: null });
    }
    for (const t of s.told) {
      const i = addParty(t);
      if (!cells.has(i)) cells.set(i, { cell: "told", note: null });
    }
    cells.delete(-1);
    return { s, cells };
  });
  const rows = rowsRaw
    .filter((r) => r.cells.size > 0)
    .map((r) => ({
      step: r.s.number,
      name: r.s.name,
      cells: parties.map((_, i) => r.cells.get(i)?.cell ?? ("" as const)),
      notes: parties.map((_, i) => r.cells.get(i)?.note ?? null),
    }));

  // Roles: each party once, with what it does here.
  const roles: SopView["roles"] = [
    {
      role: "Does the work",
      party: self,
      words: "Does every step unless a step names a person or another agent.",
    },
  ];
  if (input.owner) {
    const model = input.owner.model ? input.modelName(input.owner.model) : null;
    roles.push({
      role: "Watches each run",
      party: input.owner.party,
      words: `Your ${AREA_WORDS[input.agent.area]} owner, an agent${model ? ` on AI (${model})` : ""}. When a step fails it may try again or correct the input; it never adds, skips or reorders a step, or changes an approval.`,
    });
  }
  for (const p of input.accountable) {
    roles.push({
      role: "Accountable",
      party: p,
      words:
        "Answers for this process, connects your tools and sets what the agent may do in them.",
    });
  }
  const seen = new Set([self.key, input.owner?.party.key, ...input.accountable.map((p) => p.key)]);
  for (const s of steps) {
    for (const a of s.approval?.approvers ?? []) {
      if (seen.has(a.party.key)) continue;
      seen.add(a.party.key);
      roles.push({
        role: "Approves changes",
        party: a.party,
        words: `Approves "${s.name}"${a.condition ? ` ${a.condition}` : ""}.`,
      });
    }
    if (s.who && !seen.has(s.who.key)) {
      seen.add(s.who.key);
      roles.push({
        role: s.who.kind === "agent" ? "Another agent" : "Takes part",
        party: s.who,
        words: `${s.name}.`,
      });
    }
  }
  if (input.lead && !seen.has(input.lead.key)) {
    roles.push({
      role: "Escalations",
      party: input.lead,
      words: "Your Mezonas lead: told when nobody answers in time, and steps in when needed.",
    });
  }
  roles.push({
    role: "Builds and changes it",
    party: MEZONAS,
    words:
      "Changes to the steps are made by us and recorded as a new revision. You can adjust the settings in section 10 yourself.",
  });

  // Triggers, scope, exceptions.
  const agentName = (slug: string) => input.agentParty(slug)?.name ?? null;
  const triggers: string[] = [];
  const triggersSay: (SopSay | null)[] = [];
  let runByHand: string | null = null;
  for (const w of input.bundle.workflows) {
    if (w.enabled === false) continue;
    const wf = w.workflow as {
      schemaVersion: number;
      triggers?: { on: Record<string, unknown> & { type: string } }[];
      trigger?: { on: Record<string, unknown> & { type: string } };
      moreTriggers?: { on: Record<string, unknown> & { type: string } }[];
    };
    const list =
      wf.schemaVersion === 4
        ? (wf.triggers ?? [])
        : [wf.trigger, ...(wf.moreTriggers ?? [])].filter((t) => t !== undefined);
    for (const t of list) {
      const words = sopTriggerWords(t.on, agentName);
      if (!triggers.includes(words)) {
        triggers.push(words);
        triggersSay.push(sopTriggerSay(t.on, agentName));
      }
      if (t.on.type === "manual" && (t.on.client as { canRun?: boolean } | undefined)?.canRun) {
        runByHand = "Your admin and people who sign can start it from this agent's page.";
      }
    }
  }
  const missing = steps.filter(
    (s) => visited.find((v) => v.step.id === s.id)?.step.kind === "missing",
  );
  const notCovered = [
    ...(manual?.knownRisks ?? []).map((r) => `${sentence(r.what)} A person handles it.`),
    ...missing.map((s) => `${sentence(s.name)} A person does this part.`),
  ];
  const exceptions: SopView["exceptions"] = [];
  const ex = (id: string, words: string) => exceptions.push({ id, words });
  ex(
    "fails",
    input.owner
      ? `A step fails: ${input.owner.party.name} may try it again or correct its input, and a corrected change is approved again. Otherwise the run stops and your team is told.`
      : "A step fails: the run stops and your team is told.",
  );
  for (const s of steps) {
    if (s.byWhen)
      ex(
        `late:${s.id}`,
        `Nobody answers step ${s.number} in time: ${s.byWhen.replace(/^[^;]*; /, "")}.`,
      );
    if (s.approval?.ifRejected && s.approval.level === "ask")
      ex(`reject:${s.id}`, `A change at step ${s.number} is rejected: ${s.approval.ifRejected}.`);
  }
  for (const r of manual?.knownRisks ?? [])
    ex(
      `risk:${r.id}`,
      `Known risk: ${sentence(r.what)} Not built in this version: when it happens, a person handles it.`,
    );
  ex(
    "pause",
    "Your admin can pause it at any time from its page; new work waits until it resumes. We may hold it while we fix a problem, and we tell you when we do.",
  );

  // Decisions: what was decided and who set it; never a status that waits on someone.
  const decisions: SopView["decisions"] = (manual?.decisions ?? []).map((d) => ({
    id: d.id,
    what: d.what,
    value: d.value ?? null,
    kind: d.kind,
    step: d.stepId ? (numberOf.get(d.stepId) ?? null) : null,
    setBy:
      d.side === "client" && d.by
        ? `${d.by}${d.at ? `, ${d.at.slice(0, 10)}` : ""}`
        : d.status === "confirmed"
          ? "Confirmed with you"
          : "Us",
  }));
  const setupRaw = (definition as { setup?: unknown }).setup;
  const setup = readSetupAnswered(setupRaw);

  const handsOverTo = [
    ...new Set(
      steps
        .map((s) => (s.who?.kind === "agent" && s.who.key !== self.key ? s.who.name : null))
        .filter((x): x is string => x !== null),
    ),
  ];

  return {
    agent: { id: input.agent.id, name: input.agent.name, key: self.key },
    format: SOP_FORMAT,
    code: input.code,
    client: input.client,
    area: { id: input.agent.area, words: AREA_WORDS[input.agent.area] },
    // DECISION: a pause or a safety hold is a state of the moment, shown on the agent's page, not
    // part of how the process runs: it makes no revision (docs/sop-plan.md §6).
    stage: {
      id: input.agent.stage ?? "bench",
      words: STAGE_WORDS[input.agent.stage ?? "bench"] ?? "Being set up",
    },
    // DECISION (QA W9): a paused agent's SOP and the Procedures list say "Paused" where the stage
    // is, never "Live". Outside the fingerprint (`sopContent`), so pausing and resuming make no
    // revision; a safety hold stays on the agent's page.
    paused: input.agent.runStatus === "paused",
    asOf: input.asOf,
    revision: input.revision,
    previous: input.previous,
    accountable: [...input.accountable],
    owner: input.owner
      ? {
          party: input.owner.party,
          model: input.owner.model ? (input.modelName(input.owner.model) ?? "An AI model") : null,
        }
      : null,
    lead: input.lead,
    purpose: manual?.whatItDoes || input.fallbackPurpose || "",
    scope: { covers: triggers, notCovered, never: [...SOP_NEVER] },
    roles,
    matrix: { parties, rows },
    start: { triggers, triggersSay, hours: input.businessHours, runByHand },
    summary: {
      steps: steps.length,
      rules: count("rules"),
      ai: count("ai"),
      rulesThenAi: count("rules_then_ai"),
      person: count("person"),
      writesByRules: anyWrite && writesByRules,
    },
    procedure,
    outline,
    controls: sopControls,
    systems,
    data,
    learned: input.learned ? [...input.learned] : null,
    exceptions,
    decisions,
    setup,
    settings: [...input.settings],
    measures: [...input.measures],
    references: {
      follows: [
        "How Mezonas agents work",
        "Your charter, once you confirm it",
        ...input.policies.map((p) => `Policy: ${p}`),
      ],
      handsOverTo,
      takesOverFrom: [...input.takesOverFrom],
      knowledge: [...input.knowledge],
    },
    history: [...input.history],
  };
}

/** Steps' own controls first (by the first step they cover), then the owner's, then the platform's. */
function controlRank(key: string): number {
  if (key.startsWith("platform:")) {
    const order = [
      "no_delete",
      "once",
      "signed_stage",
      "data_is_data",
      "own_permissions",
      "logged",
      "hipaa",
    ];
    return 2_000_000 + order.indexOf(key.slice("platform:".length));
  }
  if (key === "owner") return 1_000_000;
  if (key === "deadlines") return 900_000;
  return 0;
}

/** The client's approver rules that could match a step's change (any amount), in order. */
function rulesFor(tools: ToolSpec[], input: SopInput): ApproverRule[] {
  const writes = tools.filter((t) => t.sideEffect === "external");
  return input.approverRules.filter((r) =>
    writes.some(
      (t) =>
        (r.match.connector === undefined || r.match.connector === t.connector) &&
        (r.match.tool === undefined || r.match.tool === t.id) &&
        (r.match.verb === undefined || r.match.verb === t.verb) &&
        (r.match.agentId === undefined || r.match.agentId === input.agent.id),
    ),
  );
}

/**
 * Who approves a step's change, in the order `routeApproval` decides it: the client's rules first
 * (one with an amount is a condition; one without decides everything left), then the step's
 * approvers, the agent's, the client's default, and last the client's admins.
 */
function approversFor(step: AnyStep, v4: boolean, tool: ToolSpec, input: SopInput): SopApprover[] {
  const out: SopApprover[] = [];
  for (const rule of rulesFor([tool], input)) {
    const party = targetParty(rule.approver, input);
    if (rule.match.amountOver) {
      out.push({
        party,
        condition: `over ${moneyWords(rule.match.amountOver.value, rule.match.amountOver.currency)}`,
      });
    } else {
      out.push({ party, condition: null });
      return withOtherwise(out);
    }
  }
  const definition = input.bundle.definition as AgentDefinition;
  const stepApprovers = v4
    ? (
        (step.checks as { approval?: { approvers?: { who?: string }[] } } | undefined)?.approval
          ?.approvers ?? []
      )
        .map((a) => a.who)
        .filter((w): w is string => !!w)
    : [(step.approval as { approver?: string } | undefined)?.approver].filter(
        (w): w is string => !!w,
      );
  const chain = [
    ...stepApprovers,
    definition.permissions.approver,
    input.agent.approver,
    input.clientApprover,
  ].filter((w): w is string => typeof w === "string" && w !== "");
  const first = chain[0] ?? "client_admin";
  if (v4 && stepApprovers.length > 1) {
    for (const w of stepApprovers) out.push({ party: input.party(w), condition: null });
  } else {
    out.push({ party: input.party(first), condition: null });
  }
  return withOtherwise(out);
}

/** The last approver after conditional ones reads "up to …" of the highest condition. */
function withOtherwise(list: SopApprover[]): SopApprover[] {
  const conditional = list.filter((a) => a.condition?.startsWith("over "));
  if (conditional.length === 0) return list;
  const last = list.at(-1);
  if (last && last.condition === null) {
    const lowest = conditional[conditional.length - 1]?.condition?.slice("over ".length);
    return [...list.slice(0, -1), { ...last, condition: lowest ? `up to ${lowest}` : null }];
  }
  return list;
}

/** The setup checklist's answered items, as "What we set up with you". */
function readSetupAnswered(raw: unknown): { label: string; answer: string }[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { items?: unknown }).items)
      ? ((raw as { items: unknown[] }).items as unknown[])
      : [];
  const out: { label: string; answer: string }[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const label = [r.label, r.question, r.title].find(
      (v): v is string => typeof v === "string" && v.trim() !== "",
    );
    const answer = [r.answer, r.value].find(
      (v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean",
    );
    if (label && answer !== undefined && String(answer).trim() !== "")
      out.push({ label: label.trim(), answer: String(answer) });
    if (out.length >= 40) break;
  }
  return out;
}
