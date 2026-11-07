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
import { eventLabel } from "../../runs/labels";

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
      // The event in plain words ("When an invoice has been read"), never its id.
      return `When ${eventLabel(on.event)}`;
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
      return on.filter && on.filter.rules.length > 0 ? `if ${rulesText(on.filter)}` : "Event";
    case "schedule":
      return [on.cron, on.tz, on.skipHolidays ? "skips holidays" : null]
        .filter(Boolean)
        .join(" · ");
    case "manual":
      return "Manual";
    case "command":
      return "Thread command";
    // v0.12 W2-E
    case "webhook":
      return [
        on.filter && on.filter.rules.length > 0 ? `if ${rulesText(on.filter)}` : "Webhook",
        on.rateLimit ? `at most ${on.rateLimit.max} a ${on.rateLimit.per}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
    case "message":
      return on.channels.join(", ");
    case "handoff":
      return on.filter && on.filter.rules.length > 0 ? `if ${rulesText(on.filter)}` : "Handoff";
  }
}

/** The second line under a step's name. */
export function stepDetail(step: Step): string | null {
  switch (step.kind) {
    case "skill":
      return step.agent ? `${step.skill} · by ${step.agent}` : step.skill;
    case "action":
      return `${step.tool} · ${
        step.approval.required === "required" ? "needs approval" : "no approval"
      }`;
    case "person":
      return `${step.mode === "approve" ? "Approve" : "Ask"} · ${step.assignee} · ${step.timeout}`;
    case "fork":
      return `${step.paths.length} ${step.paths.length === 1 ? "path" : "paths"}`;
    case "for_each":
      return `over ${step.over}`;
    case "wait":
      return `for ${step.for}`;
    case "notify":
      return step.to ? `${step.channel} · ${step.to}` : step.channel;
    case "stop":
      return step.status;
    // v0.12 W2-B: the pinned version, e.g. polite-follow-up@2.
    case "use_automation":
      return step.automation;
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
