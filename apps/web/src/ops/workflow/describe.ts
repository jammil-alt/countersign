// Plain labels for workflow parts, shared by the step list and the agent overview's chips.
import {
  type AnyAgentBundle,
  allSteps,
  processes,
  type Rule,
  type Rules,
  SKILL_KIND_LABEL,
  type SkillKind,
  type Step,
  type StepKind,
  type Trigger,
  type Workflow,
} from "@countersign/core";
import { cronText, roleLabel, toolLabel, whenEvent } from "./labels";

export const KIND_LABEL: Record<StepKind | "trigger", string> = {
  trigger: "Trigger",
  skill: "Skill",
  action: "Action",
  person: "Person",
  fork: "Fork",
  for_each: "For each",
  wait: "Wait",
  notify: "Notify",
  stop: "Stop",
  // v0.12 W2-B
  use_automation: "Automation",
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
  }
}

export function triggerDetail(trigger: Trigger): string | null {
  const on = trigger.on;
  switch (on.type) {
    case "event":
      return on.filter && on.filter.rules.length > 0 ? `if ${rulesText(on.filter)}` : null;
    case "schedule":
      return [cronText(on.cron), on.tz, on.skipHolidays ? "skips holidays" : null]
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
  person?(id: string): string | undefined;
  /**
   * Whether a tool changes a client's tool (an external side effect); undefined when unknown.
   * A v4 write with no approval check reads "needs approval" unless this says false.
   */
  changesClientTool?(toolId: string): boolean | undefined;
  /** Skill model (2026-11-10): a skill's kind by its reference; undefined when unknown. */
  skillKind?(ref: string): SkillKind | undefined;
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
  if (step.kind === "write") return labels.writeLabel?.(step.tool) ?? PROCESS_KIND_LABEL.write;
  return PROCESS_KIND_LABEL[step.kind];
}

/** "Deterministic" or "AI" for a skill step whose skill the labels know; null otherwise. */
export function stepSkillKindLabel(step: processes.Step, labels: StepLabels = {}): string | null {
  if (step.kind !== "skill") return null;
  const kind = labels.skillKind?.(step.skill);
  return kind ? SKILL_KIND_LABEL[kind] : null;
}

/** The second line under a step's name: what it does in words, never its ids. */
export function stepDetail(step: Step, labels: StepLabels = {}): string | null {
  switch (step.kind) {
    case "skill": {
      const name = labels.skill?.(step.skill);
      const what = name && name !== step.name ? name : null;
      return [what, step.agent ? `by ${step.agent}` : null].filter(Boolean).join(" · ") || null;
    }
    case "action":
      return [
        labels.connector?.(step.tool),
        toolLabel(step.tool),
        step.approval.required === "required" ? "needs approval" : "on its own",
      ]
        .filter(Boolean)
        .join(" · ");
    case "person":
      return `${step.mode === "approve" ? "Approve" : "Ask"} · ${
        labels.person?.(step.assignee) ?? roleLabel(step.assignee)
      } · ${step.timeout}`;
    case "fork":
      return `${step.paths.length} ${step.paths.length === 1 ? "path" : "paths"}`;
    case "for_each":
      return `over ${fieldText(step.over)}`;
    case "wait":
      return `for ${step.for}`;
    case "notify":
      return [CHANNEL_LABEL[step.channel] ?? step.channel, step.to ? fieldText(step.to) : null]
        .filter(Boolean)
        .join(" · ");
    case "stop":
      return STOP_LABEL[step.status] ?? step.status;
    // v0.12 W2-B: the pinned automation by name and version, e.g. "Polite follow-up · v2".
    case "use_automation": {
      const [slug = step.automation, v] = step.automation.split("@");
      const name = labels.automation?.(step.automation) ?? slug.replace(/[-_]+/g, " ");
      return v ? `${name} · v${v}` : name;
    }
  }
}

/** Step names by id, so a rule reads "Review the record · needsFix" rather than `steps.<uuid>…`. */
export type StepNames = ReadonlyMap<string, string>;

export function stepNames(workflow: Workflow): StepNames {
  const names = new Map<string, string>();
  for (const { step } of allSteps(workflow)) names.set(step.id, step.name || KIND_LABEL[step.kind]);
  return names;
}

/** A rule's field as people read it: the step's name and the output field, or the trigger's. */
export function fieldText(field: string, names?: StepNames): string {
  const path = field.replace(/^\{\{\s*|\s*\}\}$/g, "");
  const step = /^steps\.([^.]+)\.output(?:\.(.+))?$/.exec(path);
  if (step && names) {
    const name = names.get(step[1] as string);
    if (name) return step[2] ? `${name} · ${step[2]}` : `${name} output`;
  }
  const trigger = /^trigger\.(.+)$/.exec(path);
  if (trigger) return `trigger · ${trigger[1]}`;
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
  wait: "Wait",
  stop: "Stop",
  process: "Process",
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
      const waits = approval
        ? approval.required === "required"
        : labels.changesClientTool?.(step.tool) !== false;
      const words = waits ? "needs approval" : approval ? "on its own" : null;
      return [labels.connector?.(step.tool), toolLabel(step.tool), words]
        .filter(Boolean)
        .join(" · ");
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
      return `${step.paths.length} ${step.paths.length === 1 ? "path" : "paths"}`;
    case "for_each":
      return `over ${fieldText(step.over)}`;
    case "wait":
      return `for ${step.for}`;
    case "stop":
      return STOP_LABEL[step.status] ?? step.status;
    case "process": {
      const [slug = step.process, v] = step.process.split("@");
      const name = labels.automation?.(step.process) ?? slug.replace(/[-_]+/g, " ");
      return v ? `${name} · v${v}` : name;
    }
  }
}

/** Step names by id for a v4 process. */
export function processStepNames(process: Pick<processes.Process, "steps">): StepNames {
  const names = new Map<string, string>();
  for (const { step } of processes.allSteps(process)) {
    names.set(step.id, step.name || PROCESS_KIND_LABEL[step.kind]);
  }
  return names;
}

/**
 * "6 steps, 2 forks": counted across nested paths and loops. A v4 process's `if` counts as a
 * fork (it is laid out as one).
 */
export function workflowStats(bundle: Pick<AnyAgentBundle, "workflows">): {
  steps: number;
  forks: number;
} {
  let steps = 0;
  let forks = 0;
  for (const w of bundle.workflows) {
    const kinds =
      w.workflow.schemaVersion === 4
        ? processes.allSteps(w.workflow).map((l) => l.step.kind as string)
        : allSteps(w.workflow).map((l) => l.step.kind as string);
    for (const kind of kinds) {
      steps += 1;
      if (kind === "fork" || kind === "if") forks += 1;
    }
  }
  return { steps, forks };
}
