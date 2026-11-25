// Plain labels for workflow parts, shared by the step list and the agent overview's chips.
import {
  type AgentBundle,
  processes,
  type Rule,
  type Rules,
  type SkillKind,
  scheduleText,
  steps as stepModel,
  type Trigger,
} from "@countersign/core";
import { roleLabel, toolLabel, whenEvent } from "./labels";

/** A step-model step's kind in a word, and the trigger's. */
export const KIND_LABEL: Record<stepModel.StepKind | "trigger", string> = {
  trigger: "Trigger",
  do: "Do",
  loop: "Loop",
  fork: "Fork",
  for_each: "For each",
  repeat: "Repeat",
  wait: "Wait",
  handoff: "Hand off",
  end: "End",
};

/** A trigger's kind in a word, as the triggers list and the plan show it (prototype `#O7-Triggers`). */
export const TRIGGER_KIND_LABEL: Record<Trigger["on"]["type"], string> = {
  event: "Event",
  schedule: "Schedule",
  manual: "Manual",
  command: "Command",
  webhook: "Webhook",
  message: "Message",
  handoff: "Another agent",
  report: "Report",
};

/**
 * An event type made readable when no catalog label is at hand: `document.extracted` →
 * "Document extracted" (raw ids never show to people).
 */
export function readableEvent(type: string): string {
  const words = type.replace(/[._-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function triggerTitle(trigger: Trigger): string {
  const on = trigger.on;
  switch (on.type) {
    case "event":
      return whenEvent(on.event);
    case "schedule":
      return "On a schedule";
    case "manual":
      return "Started by hand";
    case "command":
      return `Command /${on.command.replace(/^\//, "")}`;
    // v0.12 W2-E
    case "webhook":
      return "When a webhook arrives";
    case "message":
      return "When someone sends a message";
    case "handoff":
      return `When ${on.from.agent} finishes`;
    // Collect reports (owner, 2026-11-24)
    case "report":
      return "When a report arrives";
  }
}

export function triggerDetail(trigger: Trigger): string | null {
  const on = trigger.on;
  switch (on.type) {
    case "event":
      return on.filter && on.filter.rules.length > 0 ? `if ${rulesText(on.filter)}` : null;
    case "schedule":
      return [scheduleText(on), on.skipHolidays ? "skips holidays" : null]
        .filter(Boolean)
        .join(" · ");
    case "manual":
      return null;
    case "command":
      return "Typed in a thread";
    // v0.12 W2-E
    case "webhook":
      return (
        [
          on.filter && on.filter.rules.length > 0 ? `if ${rulesText(on.filter)}` : null,
          on.rateLimit ? `at most ${on.rateLimit.max} a ${on.rateLimit.per}` : null,
        ]
          .filter(Boolean)
          .join(" · ") || null
      );
    case "message":
      return on.channels.map((c) => CHANNEL_LABEL[c] ?? c).join(", ");
    case "handoff":
      return on.filter && on.filter.rules.length > 0 ? `if ${rulesText(on.filter)}` : null;
    case "report":
      return `by email to step ${on.step}`;
  }
}

const CHANNEL_LABEL: Record<string, string> = {
  sms: "Text",
  whatsapp: "WhatsApp",
  email: "Email",
  call: "Call",
  voice: "Call",
  thread: "The run's thread",
  digest: "The daily digest",
};

const STOP_LABEL: Record<string, string> = {
  succeeded: "Ends the run as done",
  failed: "Ends the run as failed",
  cancelled: "Ends the run as stopped",
};

/**
 * Names a step's second line can use instead of ids, from the builder's catalog: a skill's name by
 * its reference, an automation's, the connector a tool acts through, a person's name by user id.
 */
export interface StepLabels {
  skill?(ref: string): string | undefined;
  automation?(ref: string): string | undefined;
  connector?(toolId: string): string | undefined;
  /**
   * The connector a read or a write step is on, with its name, for the chart's mark on the box
   * (its logo). Undefined for a step on no connector, or one the catalog doesn't know.
   */
  connectorOf?(step: processes.Step): { id: string; name: string } | undefined;
  person?(id: string): string | undefined;
  /** Hand off (2026-11-11): the target agent's name and its step's "5 · Itemize the invoice". */
  // Ways in, ways out (2026-11-23): `to.workflow` with `agent: "@self"` names this agent's workflow.
  handoff?(to: {
    agent: string;
    step: string;
    workflow?: string | undefined;
  }): { name: string; at: string } | undefined;
  /** What a step's skill, tool or automation does, in its own words (the canvas's tooltip). */
  description?(step: processes.Step): string | undefined;
  /**
   * Whether a tool changes a client's tool (an external side effect); undefined when unknown.
   * A v4 write with no approval check reads "needs approval" unless this says false.
   */
  changesClientTool?(toolId: string): boolean | undefined;
  /** Skill model (2026-11-10): a skill's kind by its reference; undefined when unknown. */
  skillKind?(ref: string): SkillKind | undefined;
  /**
   * Skill model (2026-11-10, review): whether a tool calls a model inside it (`usesModel`), so a
   * read or a write step on it reads AI; undefined when unknown.
   */
  toolUsesModel?(toolId: string): boolean | undefined;
  /**
   * Skill model (2026-11-10): how a write step reads, by its tool ("Save to records", "Change in
   * QuickBooks Online"); undefined when unknown (the step then reads "Write").
   */
  writeLabel?(toolId: string): string | undefined;
  /**
   * Skill model (2026-11-10): the model a skill step runs on, in a word ("claude-sonnet-5-5"), as
   * core's `effectiveModel` resolves it; undefined for a step that runs none.
   */
  stepModel?(step: processes.Step): string | undefined;
}

/**
 * A v4 step's kind in words, as the step list, the canvas and the inspector show it: a write by
 * where it writes ("Save to records", "Change in QuickBooks Online"), else its kind's word.
 */
export function processKindLabel(step: processes.Step, labels: StepLabels = {}): string {
  if (step.kind === "write") {
    if (step.action !== undefined)
      return actionKindLabel(step.action, step.via ? labels.connector?.(step.via) : undefined);
    return labels.writeLabel?.(step.tool as string) ?? PROCESS_KIND_LABEL.write;
  }
  return PROCESS_KIND_LABEL[step.kind];
}

/** Where an action write step with no `via` changes things, until the agent's bindings say. */
const ACTION_SYSTEM_WORD: Record<processes.WriteAction, string> = {
  send_email: "the agent's email",
  send_text: "the agent's texts",
  create_bill: "the agent's accounting",
  create_vendor: "the agent's accounting",
};

/**
 * Skill model (2026-11-10): an action write step always changes a client's tool, so it reads
 * "Change in <system>": the system its `via` names, else the kind the agent's bindings resolve.
 */
// DECISION: an action step's kind label names its `via` connector when it has one, else "the
// agent's accounting" / "email" / "texts"; the system itself is resolved per agent (the inspector's
// "Uses" row shows which).
export function actionKindLabel(action: processes.WriteAction, viaName?: string | null): string {
  return `Change in ${viaName ?? ACTION_SYSTEM_WORD[action]}`;
}

/** Step names by id, so a rule reads "Review the record · needsFix" rather than `steps.<uuid>…`. */
export type StepNames = ReadonlyMap<string, string>;

/** "totalsValid" → "totals valid", "line_count" → "line count": a field path's words. */
function pathWords(path: string): string {
  return path
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase();
}

/** A rule's field as people read it: the step's name and the output field, or the trigger's. */
export function fieldText(field: string, names?: StepNames): string {
  const path = field.replace(/^\{\{\s*|\s*\}\}$/g, "");
  const step = /^steps\.([^.]+)\.output(?:\.(.+))?$/.exec(path);
  if (step && names) {
    const name = names.get(step[1] as string);
    if (name) return step[2] ? `${name} · ${pathWords(step[2])}` : `${name} output`;
  }
  const trigger = /^trigger\.(.+)$/.exec(path);
  if (trigger) return `trigger · ${pathWords(trigger[1] ?? "")}`;
  return path;
}

export function ruleText(rule: Rule, names?: StepNames): string {
  const field = fieldText(rule.field, names);
  if (rule.op === "exists") return `${field} exists`;
  return `${field} ${rule.op} ${valueText(rule.value)}`;
}

export function rulesText(rules: Rules, names?: StepNames): string {
  if (rules.rules.length === 0) return "always";
  return rules.rules.map((r) => ruleText(r, names)).join(rules.match === "any" ? " or " : " and ");
}

function valueText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === undefined) return "";
  return JSON.stringify(v);
}

// ── R8: v4 processes (ARCHITECTURE §10.14) ──────────────────────────────────────────────────────

type ProcessStep = processes.Step;

/** A v4 step's kind in a word: the builder's words (an `if`, not a fork). */
export const PROCESS_KIND_LABEL: Record<ProcessStep["kind"] | "trigger", string> = {
  trigger: "Trigger",
  read: "Read",
  skill: "Skill",
  write: "Write",
  person: "Person",
  conversation: "Conversation",
  notify: "Notify",
  if: "If",
  for_each: "For each",
  repeat: "Repeat",
  wait: "Wait",
  stop: "Stop",
  process: "Automation",
  handoff: "Hand off",
  // v0.18: a piece the Builder couldn't build, held where it belongs.
  missing: "Missing",
  // Collect reports (owner, 2026-11-24)
  collect: "Collect reports",
};

const NOTIFY_CHANNEL: Record<string, string> = {
  inbox: "Inbox",
  email: "Email",
  sms: "Text",
};

/** "client admin" for a role, a person's name for a user or contact id, else the text. */
function whoText(who: string, labels: StepLabels): string {
  return labels.person?.(who) ?? (who.includes("{{") ? fieldText(who) : roleLabel(who));
}

/** How long a deadline waits, in words: "2 days", "30 minutes in business hours". */
export function deadlineText(d: Pick<processes.Deadline, "after" | "hours">): string {
  return d.hours === "business" ? `${d.after} in business hours` : d.after;
}

/** The second line under a v4 step's name: what it does in words, never its ids. */
export function processStepDetail(step: ProcessStep, labels: StepLabels = {}): string | null {
  switch (step.kind) {
    case "skill": {
      const name = labels.skill?.(step.skill);
      const what = name && name !== step.name ? name : null;
      // Skill model (2026-11-10): the model it runs on, wherever the step is shown.
      const model = labels.stepModel?.(step);
      return (
        [what, step.agent ? `by ${step.agent}` : null, model ? `runs on ${model}` : null]
          .filter(Boolean)
          .join(" · ") || null
      );
    }
    case "read":
      return [labels.connector?.(step.tool), toolLabel(step.tool)].filter(Boolean).join(" · ");
    case "write": {
      const approval = step.checks?.approval;
      // A write with no approval check waits for the default approver (invariant 8; the gate
      // asks for writes to a client's tool), so it reads "needs approval" unless the labels know
      // the tool only writes our own records.
      // DECISION (web, wave 3b): without a tool registry at hand (the read-only step lists), an
      // unchecked write reads "needs approval": the safe side, as core counts an unknown tool as
      // an external write.
      // Skill model: an action write step names what it does; its system is the agent's.
      if (step.action !== undefined) {
        const waits = approval ? approval.required === "required" : true;
        return [
          processes.ACTION_SPECS[step.action].label,
          step.via ? labels.connector?.(step.via) : null,
          waits ? "needs approval" : "on its own",
        ]
          .filter(Boolean)
          .join(" · ");
      }
      const tool = step.tool as string;
      const waits = approval
        ? approval.required === "required"
        : labels.changesClientTool?.(tool) !== false;
      const words = waits ? "needs approval" : approval ? "on its own" : null;
      return [labels.connector?.(tool), toolLabel(tool), words].filter(Boolean).join(" · ");
    }
    case "person":
      return `${step.mode === "approve" ? "Approve" : "Ask"} · ${whoText(step.assignee, labels)} · ${deadlineText(step.deadline)}`;
    case "conversation":
      return [
        CHANNEL_LABEL[step.channel] ?? step.channel,
        step.with ? whoText(step.with, labels) : null,
      ]
        .filter(Boolean)
        .join(" · ");
    case "notify":
      return [
        NOTIFY_CHANNEL[step.notify.channel] ?? step.notify.channel,
        step.notify.to.map((w) => whoText(w, labels)).join(", "),
        step.notify.urgent ? "urgent" : null,
      ]
        .filter(Boolean)
        .join(" · ");
    case "if":
      return `${step.paths.length} ${step.paths.length === 1 ? "path" : "paths"}${step.decide === "agent" ? " · the agent chooses" : ""}`;
    case "for_each":
      return `over ${fieldText(step.over)}`;
    case "repeat":
      return `until ${"rules" in step.until ? "its rule holds" : "the agent says it's done"} · up to ${step.maxTimes} ${step.maxTimes === 1 ? "time" : "times"}`;
    case "wait":
      return `for ${step.for}`;
    case "stop":
      return STOP_LABEL[step.status] ?? step.status;
    case "process": {
      const [slug = step.process, v] = step.process.split("@");
      const name = labels.automation?.(step.process) ?? slug.replace(/[-_]+/g, " ");
      return v ? `${name} · v${v}` : name;
    }
    // Hand off: "Hand off to Price checker at 5 · Itemize the invoice".
    case "handoff": {
      if (!step.to.agent) return "Choose the agent to hand off to";
      const named = labels.handoff?.(step.to);
      const self = processes.isSelfHandoff(step);
      if (self && !step.to.workflow) return "Choose the workflow to hand off to";
      const name = named?.name ?? (self ? (step.to.workflow ?? "") : step.to.agent);
      const at = named?.at ?? step.to.step;
      return at ? `Hand off to ${name} at ${at}` : `Hand off to ${name}`;
    }
    // v0.18: what is missing, in the Builder's sentence.
    case "missing":
      return step.need;
    // Collect reports: "3 reports · escalates to client admin after 5 days".
    case "collect":
      return [
        `${step.items.length} ${step.items.length === 1 ? "report" : "reports"}`,
        step.escalate
          ? `escalates to ${whoText(step.escalate.to, labels)} ${deadlineText(step.escalate)} late`
          : null,
      ]
        .filter(Boolean)
        .join(" · ");
  }
}

/** Step names by id for a step-model workflow: its triggers and every step, nested ones too. */
export function workflowStepNames(
  workflow: Pick<stepModel.Workflow, "triggers" | "steps">,
): StepNames {
  const names = new Map<string, string>();
  for (const t of workflow.triggers) names.set(t.id, KIND_LABEL.trigger);
  stepModel.eachStep(workflow.steps, ({ step }) =>
    names.set(step.id, step.name || KIND_LABEL[step.kind]),
  );
  return names;
}

/** "6 steps, 2 forks": counted across nested paths and loops. */
export function workflowStats(bundle: Pick<AgentBundle, "workflows">): {
  steps: number;
  forks: number;
  /** S4.9: how many workflows `steps` adds up. */
  workflows: number;
} {
  let steps = 0;
  let forks = 0;
  for (const w of bundle.workflows) {
    const kinds: string[] = [];
    stepModel.eachStep(w.workflow.steps, ({ step }) => kinds.push(step.kind));
    for (const kind of kinds) {
      steps += 1;
      if (kind === "fork") forks += 1;
    }
  }
  return { steps, forks, workflows: bundle.workflows.length };
}

/**
 * S4.9 (QA TP1): an agent's step count, labelled by what it adds up: "18 steps in 3 workflows"
 * beside a workflow's own "14 steps", so the two never read as one number that disagrees. A step
 * is every step of a workflow, nested ones included, the trigger not (as the workflow builder and
 * its step table count them).
 */
export function stepCountWords(stats: { steps: number; workflows: number }): string {
  const steps = `${stats.steps} ${stats.steps === 1 ? "step" : "steps"}`;
  return stats.workflows > 1 ? `${steps} in ${stats.workflows} workflows` : steps;
}
