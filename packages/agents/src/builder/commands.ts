// v0.12 W3-A: `/skill`, `/automation` and `/trigger` in a Builder conversation (ARCHITECTURE §9.6;
// docs/plan.md §1.51). The message is read by the threads parser (`parseCommand`, W1-C, in core so
// every surface reads a message the same way); this module turns the command into a structured
// instruction for the turn and says which changes the turn may make.
//
// - `/skill <id> <instruction>`: that skill's steps and this agent's settings for it. The skill's
//   own definition and defaults never change from here (they are the skill's versions).
// - `/automation <slug>[@version] [where]`: place an automation as a process step (wave 3b: v4).
// - `/trigger <kind> <details>`: add or change a trigger.

import {
  type AnyAgentBundle,
  flattenBundle,
  parseCommand,
  parseSkillRef,
  resolveSkillCommand,
  TriggerOn,
} from "@countersign/core";
import type { BuilderAutomationRef } from "./context";

export type TurnCommand =
  | { name: "skill"; skill: string; args: string; instruction: string }
  | { name: "automation"; ref: string; args: string; instruction: string }
  | { name: "trigger"; trigger: string; args: string; instruction: string };

export type ReadCommand =
  | { ok: true; command: TurnCommand | null }
  | { ok: false; code: "unknown_command" | "invalid_command"; message: string };

/** The trigger kinds `/trigger` takes: every kind the workflow schema knows. */
export const TRIGGER_KINDS: readonly string[] = TriggerOn.options.map(
  (o) => o.shape.type.value as string,
);

/** The first word and the rest, split at the first whitespace (an index loop, no regex). */
export function firstWord(text: string): { word: string; rest: string } {
  const s = text.trim();
  let i = 0;
  while (i < s.length && !isSpace(s.charCodeAt(i))) i++;
  return { word: s.slice(0, i), rest: s.slice(i).trim() };
}

function isSpace(code: number): boolean {
  return code === 32 || (code >= 9 && code <= 13) || code === 160;
}

/** The skill ids an agent draft uses (listed or run by a step). */
export function draftSkillIds(bundle: AnyAgentBundle): string[] {
  const ids = new Set(bundle.definition.skills.map((s) => parseSkillRef(s.skill).id));
  for (const e of flattenBundle(bundle).entities.values()) {
    if (e.kind === "step" && e.content.kind === "skill" && typeof e.content.skill === "string") {
      ids.add(parseSkillRef(e.content.skill).id);
    }
  }
  return [...ids].sort();
}

/**
 * Reads a turn's text. Plain text is no command; `/skill`, `/automation` and `/trigger` become a
 * structured instruction; any other `/word` is refused (the Builder knows only these three).
 */
export function readCommand(
  text: string,
  input: { bundle: AnyAgentBundle; automations: readonly BuilderAutomationRef[] },
): ReadCommand {
  const parsed = parseCommand(text);
  if (!parsed) return { ok: true, command: null };
  const { word, rest } = firstWord(parsed.args);
  if (parsed.name === "skill") {
    const skill = word ? resolveSkillCommand(word, draftSkillIds(input.bundle)) : null;
    if (!skill) {
      return {
        ok: false,
        code: "invalid_command",
        message: word
          ? `this agent has no skill "${word}"`
          : "say which skill: /skill <id> <what to change>",
      };
    }
    if (!rest) {
      return { ok: false, code: "invalid_command", message: `say what to change for ${skill}` };
    }
    return {
      ok: true,
      command: {
        name: "skill",
        skill,
        args: parsed.args,
        instruction: `Change only the skill ${skill} in this agent: the steps that run it and this agent's settings for it (definition.skills[].settings, by the skill's setting keys). Never change the skill's own definition or defaults, and change nothing else in the bundle.`,
      },
    };
  }
  if (parsed.name === "automation") {
    const at = word.lastIndexOf("@");
    const slug = at === -1 ? word : word.slice(0, at);
    const found = input.automations.find((a) => a.ref === word || (at === -1 && a.slug === slug));
    if (!found) {
      return {
        ok: false,
        code: "invalid_command",
        message: word
          ? `there is no automation "${word}" this agent may use`
          : "say which automation: /automation <slug>",
      };
    }
    return {
      ok: true,
      command: {
        name: "automation",
        ref: found.ref,
        args: parsed.args,
        instruction: `Place the automation ${found.ref} ("${found.name}") as one process step (kind "process", process "${found.ref}", an input that matches its input schema) where it fits${rest ? `, as the operator says below` : ""}. Change nothing else.`,
      },
    };
  }
  if (parsed.name === "trigger") {
    if (!TRIGGER_KINDS.includes(word)) {
      return {
        ok: false,
        code: "invalid_command",
        message: `say which kind of trigger: /trigger <${TRIGGER_KINDS.join("|")}> <details>`,
      };
    }
    return {
      ok: true,
      command: {
        name: "trigger",
        trigger: word,
        args: parsed.args,
        instruction: `Add or change a trigger of kind "${word}" (one of a process's triggers) as the operator says below. Change only triggers.`,
      },
    };
  }
  return {
    ok: false,
    code: "unknown_command",
    message: `the Builder knows /skill, /automation and /trigger, not /${parsed.name}`,
  };
}

/**
 * Which of a turn's changes (selectable change ids) a command allows; null: any. `/skill` allows
 * that skill's entry and the steps that run it; `/trigger` allows workflows (a trigger lives in
 * its workflow's own fields), not their steps.
 */
export function commandScope(
  command: TurnCommand | null,
  before: AnyAgentBundle,
  after: AnyAgentBundle,
): ((changeId: string) => boolean) | null {
  if (!command || command.name === "automation") return null;
  if (command.name === "trigger") {
    return (id) => id.startsWith("workflow:") && !id.includes(">") && !id.includes("#");
  }
  const skillId = command.skill;
  const steps = new Set<string>();
  for (const b of [before, after]) {
    for (const e of flattenBundle(b).entities.values()) {
      if (
        e.kind === "step" &&
        e.content.kind === "skill" &&
        typeof e.content.skill === "string" &&
        parseSkillRef(e.content.skill).id === skillId
      ) {
        steps.add(e.key);
      }
    }
  }
  return (id) => id === `skill:${skillId}` || steps.has(id);
}
