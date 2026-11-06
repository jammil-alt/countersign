// Triggers in plain words (prototype `#O7-Triggers`): each trigger of a bundle as a row of the
// triggers table, its guards read out ("once per {{trigger.id}}", "skips holidays"), who may start a
// message trigger, and the bundle with a trigger added or removed. Pure.
import {
  type AgentBundle,
  allTriggers,
  type LocalizedText,
  type PeopleFilter,
  type Trigger,
  type TriggerOn,
} from "@countersign/core";
import { rulesText } from "../workflow/describe";

export interface TriggerRow {
  workflow: string;
  workflowName: string;
  enabled: boolean;
  trigger: Trigger;
  /** The workflow's first trigger (else one of `moreTriggers`, which can be removed here). */
  first: boolean;
}

export function triggerRows(bundle: AgentBundle): TriggerRow[] {
  return bundle.workflows.flatMap((w) =>
    allTriggers(w.workflow).map((trigger, i) => ({
      workflow: w.slug,
      workflowName: w.name,
      enabled: w.enabled,
      trigger,
      first: i === 0,
    })),
  );
}

const ROLE_WORDS: Record<string, string> = {
  client_admin: "the client's admins",
  client_user: "the client's team",
};

const CHANNEL_WORDS: Record<string, string> = {
  email: "Email",
  sms: "Text",
  whatsapp: "WhatsApp",
  command: "/command in a thread",
  sloan: "Requests passed by Sloan",
};

export function channelWords(channel: string): string {
  return CHANNEL_WORDS[channel] ?? channel;
}

/** "Contacts tagged cardholder, and the client's admins": who may start a message trigger. */
export function peopleWords(filter: PeopleFilter): string {
  const parts: string[] = [];
  if (filter.tags?.length) parts.push(`contacts tagged ${filter.tags.join(" or ")}`);
  if (filter.relationships?.length) parts.push(`${filter.relationships.join(" or ")} contacts`);
  if (filter.contactIds?.length) {
    parts.push(
      `${filter.contactIds.length} named ${filter.contactIds.length === 1 ? "contact" : "contacts"}`,
    );
  }
  for (const r of filter.clientRoles ?? []) parts.push(ROLE_WORDS[r] ?? r);
  if (parts.length === 0) return "Nobody yet: name who may start it";
  const text = parts.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function localized(text: LocalizedText): string {
  return typeof text === "string" ? text : text.en;
}

/** The trigger's guards, each in a few words; empty when it has none. */
export function guardWords(on: TriggerOn): string[] {
  const out: string[] = [];
  switch (on.type) {
    case "event":
    case "handoff":
      if (on.filter?.rules.length) out.push(`only if ${rulesText(on.filter)}`);
      break;
    case "schedule":
      out.push(on.tz ? `in ${on.tz}` : "in the client's time zone");
      if (on.skipHolidays) out.push("skips holidays");
      break;
    case "manual":
      if (on.client?.canRun)
        out.push(`the client may run it${on.client.label ? ` (${on.client.label})` : ""}`);
      break;
    case "webhook":
      if (on.filter?.rules.length) out.push(`only if ${rulesText(on.filter)}`);
      if (on.dedupeKey) out.push(`once per ${on.dedupeKey}`);
      if (on.rateLimit) out.push(`at most ${on.rateLimit.max} a ${on.rateLimit.per}`);
      break;
    case "message":
      out.push(`from ${peopleWords(on.from).toLowerCase()}`);
      if (on.reply) out.push("confirms to the sender");
      break;
    case "command":
      break;
  }
  return out;
}

/** "Weekdays at 8:00" stays the cron as written; the table shows what the trigger listens to. */
export function whenWords(on: TriggerOn): string {
  switch (on.type) {
    case "event":
      return `When ${on.event}`;
    case "schedule":
      return `On ${on.cron}`;
    case "manual":
      return "Started by hand";
    case "command":
      return `/${on.command.replace(/^\//, "")} in a thread`;
    case "webhook":
      return "A delivery to the client's hook";
    case "message":
      return on.channels.map(channelWords).join(", ");
    case "handoff":
      return `When ${on.from.agent}${on.from.workflow ? ` (${on.from.workflow})` : ""} finishes a live run`;
  }
}

/** Most `moreTriggers` a workflow takes (core's schema). */
export const MAX_MORE_TRIGGERS = 9;

export function addTrigger(bundle: AgentBundle, workflow: string, trigger: Trigger): AgentBundle {
  return {
    ...bundle,
    workflows: bundle.workflows.map((w) =>
      w.slug === workflow
        ? {
            ...w,
            workflow: {
              ...w.workflow,
              moreTriggers: [...(w.workflow.moreTriggers ?? []), trigger],
            },
          }
        : w,
    ),
  };
}

/** Removes one of a workflow's `moreTriggers`; its first trigger stays (every workflow has one). */
export function removeTrigger(bundle: AgentBundle, workflow: string, id: string): AgentBundle {
  return {
    ...bundle,
    workflows: bundle.workflows.map((w) => {
      if (w.slug !== workflow) return w;
      const more = (w.workflow.moreTriggers ?? []).filter((t) => t.id !== id);
      const { moreTriggers: _more, ...rest } = w.workflow;
      return { ...w, workflow: more.length > 0 ? { ...rest, moreTriggers: more } : rest };
    }),
  };
}
