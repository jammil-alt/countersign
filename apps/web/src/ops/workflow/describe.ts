// Plain labels for workflow parts, shared by the step list and the agent overview's chips.
import {
  type AgentBundle,
  allSteps,
  type Rule,
  type Rules,
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
  /** What a step's skill, tool or automation does, in its own words (the canvas's tooltip). */
  description?(step: Step): string | undefined;
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

/** "6 steps, 2 forks": counted across nested paths and loops. */
export function workflowStats(bundle: AgentBundle): { steps: number; forks: number } {
  let steps = 0;
  let forks = 0;
  for (const w of bundle.workflows) {
    for (const { step } of allSteps(w.workflow)) {
      steps += 1;
      if (step.kind === "fork") forks += 1;
    }
  }
  return { steps, forks };
}
