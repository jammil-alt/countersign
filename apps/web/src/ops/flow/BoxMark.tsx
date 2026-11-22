// What a step is, at a glance, on its box in the chart (owner, 2026-11-21: "visually add the logo
// on the step so that we know what it is … in each of the steps let's add visual cues to what they
// are: some are AI, skills, connectors"). A small tile at the box's left:
//
// - a step on a connector's tool shows the connector's own mark (the provider's logo, or the mark
//   the connections screens give it): ../../connections/ConnectorMark;
//   a connector with no logo of its own (one of ours, an area's tools, a provider we have no file
//   for) has an avatar instead: its icon, or its initials on the plain tile;
// - a hand-off shows the other agent's own avatar, its initials in its colour;
// - a skill a model does says "AI"; one that runs by rules shows the gear; a step on a connector
//   whose tool calls a model inside carries a small "AI" on its logo;
// - every other kind has its icon from the design system's set (a person, a message, a notice…).
//
// A decision is its diamond and a Stop its pill: their shapes already say what they are.
// No colours of its own: ink for the agent's work, copper for a person's (brand book).
//
// Owner, 2026-11-21 (docs/plan.md §1.178, "let's go with D2"): the mark moved from a tile at the
// box's left into a badge on its top-left corner, with the kind in words; the model that does the
// step and what it works through (a connector's logo, a channel) sit at the box's right; and the
// box's top edge takes the colour of whose work it is (`boxFamily`).
import { ConnectorMark } from "../../connections/ConnectorMark";
import { AgentBadge } from "../../ui/badges";
import { Icon, type IconName } from "../../ui/icons";
import { cx } from "../../ui/primitives";
import type { Step } from "./types";

/** What a box's mark shows, and the words for it (its tooltip, and the details on hover). */
export type BoxMarkSpec =
  | { type: "connector"; id: string; name: string; words: string; ai?: boolean }
  /** Another agent (a hand-off): its initials in its own colour, as agents are drawn everywhere. */
  | { type: "agent"; name: string; words: string }
  | { type: "ai"; words: string }
  | { type: "icon"; icon: IconName; person: boolean; words: string };

// DECISION: the design system's icons only, each the nearest in its set of 37: no icon is drawn
// for this. Search reads, the table is our own records, the gear is rules with no model.
const KIND_ICON: Partial<Record<Step["kind"], { icon: IconName; words: string; person?: true }>> = {
  read: { icon: "search", words: "Reads" },
  write: { icon: "table", words: "Saves to our records" },
  person: { icon: "lead", words: "A person does this", person: true },
  conversation: { icon: "message", words: "A conversation with a person", person: true },
  notify: { icon: "notifications", words: "Tells someone" },
  wait: { icon: "calendar", words: "Waits" },
  for_each: { icon: "copy", words: "Repeats for each item" },
  repeat: { icon: "copy", words: "Repeats until it is done" },
  process: { icon: "worksheet", words: "An automation: saved steps" },
  handoff: { icon: "arrow", words: "Hands off to another agent" },
  missing: { icon: "alert", words: "Not built yet" },
};

/**
 * The mark for a step: its connector's when it is on one, "AI" or the gear for a skill, else its
 * kind's icon. Null for a decision and a Stop.
 */
export function boxMark(
  step: Step,
  known: {
    /** "AI" or "Deterministic", as the label says it. */
    skillKind?: string | undefined;
    connector?: { id: string; name: string } | undefined;
    /** The agent a hand-off goes to, by its name. */
    agent?: { name: string } | undefined;
  } = {},
): BoxMarkSpec | null {
  if (step.kind === "if" || step.kind === "stop") return null;
  if (known.connector && (step.kind === "read" || step.kind === "write")) {
    const verb = step.kind === "read" ? "Reads from" : "Changes";
    const ai = known.skillKind === "AI";
    return {
      type: "connector",
      ...known.connector,
      words: `${verb} ${known.connector.name}${ai ? ", with a model" : ""}`,
      ...(ai ? { ai } : {}),
    };
  }
  if (step.kind === "handoff" && known.agent) {
    return { type: "agent", name: known.agent.name, words: `Hands off to ${known.agent.name}` };
  }
  if (step.kind === "skill") {
    return known.skillKind === "AI"
      ? { type: "ai", words: "A skill a model does" }
      : { type: "icon", icon: "settings", person: false, words: "A skill that runs by rules" };
  }
  // A read or a write whose tool calls a model inside says so too.
  if (known.skillKind === "AI" && (step.kind === "read" || step.kind === "write")) {
    return { type: "ai", words: "A model does this" };
  }
  const k = KIND_ICON[step.kind];
  return k ? { type: "icon", icon: k.icon, person: k.person === true, words: k.words } : null;
}

/**
 * Whose work a step is, for the colour of its box's top edge (docs/plan.md §1.178): the agent's
 * own (a skill a model does), rules and code, a client's tool read or changed, people, or the
 * flow's own plumbing (waits, loops, automations, hand-offs).
 */
export type BoxFamily = "agent" | "rules" | "read" | "write" | "people" | "flow";

export function boxFamily(step: Step, known: { skillKind?: string | undefined } = {}): BoxFamily {
  switch (step.kind) {
    case "skill":
      return known.skillKind === "AI" ? "agent" : "rules";
    case "read":
      return "read";
    case "write":
      return "write";
    case "person":
    case "conversation":
    case "notify":
      return "people";
    default:
      return "flow";
  }
}

/** A model's name short enough for its chip: "Sonnet" for claude-sonnet-5-5, else as it is. */
export function modelShort(name: string): string {
  const family = /(fable|opus|sonnet|haiku)/i.exec(name)?.[1];
  if (family) return family.charAt(0).toUpperCase() + family.slice(1).toLowerCase();
  return /^(openai:)?gpt/i.test(name) ? "GPT" : name;
}

/**
 * Who does a step, for the chip at the box's right: the model it runs on, "code" for a step no
 * model does, "person" for a person's. Null where nobody does anything (a wait, a loop).
 */
export function boxDoer(
  step: Step,
  known: { model?: string | undefined; skillKind?: string | undefined } = {},
): { word: string; title: string; model: boolean } | null {
  if (known.model) {
    return { word: modelShort(known.model), title: `Runs on ${known.model}`, model: true };
  }
  if (step.kind === "person") return { word: "person", title: "A person does this", model: false };
  if (step.kind === "skill" || step.kind === "read" || step.kind === "write") {
    return known.skillKind === "AI"
      ? null
      : { word: "code", title: "Runs as code, no model", model: false };
  }
  return null;
}

/** One of the things a step works through, as a small mark: a connector, or a channel. */
export interface BoxTool {
  key: string;
  name: string;
  /** A connector's id, drawn with its own mark; else one of our icons. */
  connector?: string;
  icon?: IconName;
}

const CHANNEL_TOOL: Record<string, BoxTool> = {
  inbox: { key: "inbox", name: "The inbox", icon: "desk" },
  email: { key: "email", name: "Email", icon: "email" },
  sms: { key: "sms", name: "Text message", icon: "message" },
  whatsapp: { key: "whatsapp", name: "WhatsApp", connector: "whatsapp_meta" },
  call: { key: "call", name: "Phone call", icon: "phone" },
};

/**
 * What a step works through, for the small marks at the box's right: the connector a read or a
 * write is on, the channel a conversation or a person's step uses.
 */
export function boxTools(
  step: Step,
  known: { connector?: { id: string; name: string } | undefined } = {},
): BoxTool[] {
  if ((step.kind === "read" || step.kind === "write") && known.connector) {
    return [{ key: known.connector.id, name: known.connector.name, connector: known.connector.id }];
  }
  if (step.kind === "conversation" || step.kind === "person") {
    const tool = CHANNEL_TOOL[step.channel];
    return tool ? [tool] : [];
  }
  return [];
}

/**
 * A step's kind in the word or two its badge has room for: the badge never passes the middle of
 * the box, where the arrow arrives. A write says only "Change" or "Save" (where it writes is the
 * logo at the right and the line under the name); a skill says who does it.
 */
export function badgeWord(
  step: Step,
  known: { kind: string; skillKind?: string | undefined },
): string {
  if (step.kind === "write") return known.kind.split(" ")[0] ?? known.kind;
  if (step.kind === "skill") return known.skillKind === "AI" ? "AI skill" : "Rules skill";
  return known.kind;
}

/** A step's kind as a small icon for its badge, where its mark is a connector's logo. */
export function kindIcon(step: Step): IconName | null {
  return KIND_ICON[step.kind]?.icon ?? null;
}

export function BoxMark({
  mark,
  testId,
  size = "tile",
}: {
  mark: BoxMarkSpec;
  testId?: string | undefined;
  /** `tile`: the key's 24px tile. `badge`: in a box's corner badge. `tool`: at a box's right. */
  size?: "tile" | "badge" | "tool";
}) {
  const sized = size === "tile" ? null : `flow-box__mark--${size}`;
  if (mark.type === "connector") {
    return (
      <span
        className={cx("flow-box__mark flow-box__mark--logo", sized)}
        title={mark.words}
        data-testid={testId}
        data-mark="connector"
        data-connector={mark.id}
      >
        <ConnectorMark name={mark.name} connector={mark.id} size="xs" />
        {mark.ai ? <i className="flow-box__mark-ai">AI</i> : null}
      </span>
    );
  }
  if (mark.type === "agent") {
    return (
      <span
        className={cx("flow-box__mark flow-box__mark--logo", sized)}
        title={mark.words}
        data-testid={testId}
        data-mark="agent"
      >
        <AgentBadge name={mark.name} size="sm" />
      </span>
    );
  }
  return (
    <span
      className={cx(
        "flow-box__mark",
        mark.type === "ai" && "flow-box__mark--ai",
        mark.type === "icon" && mark.person && "flow-box__mark--person",
        sized,
      )}
      title={mark.words}
      data-testid={testId}
      data-mark={mark.type === "ai" ? "ai" : mark.icon}
    >
      {mark.type === "ai" ? "AI" : <Icon name={mark.icon} size={14} />}
    </span>
  );
}

/** One line of the chart's key: a mark and what it means. */
export interface KeyLine {
  key: string;
  mark: BoxMarkSpec;
  words: string;
}

/**
 * The key for a chart: one line per kind of mark on it, in the order they first appear. Every
 * connector's logo is one line ("A connected tool"), shown with the first one's mark.
 */
export function chartKey(marks: readonly BoxMarkSpec[]): KeyLine[] {
  const lines = new Map<string, KeyLine>();
  for (const m of marks) {
    const key =
      m.type === "connector" || m.type === "agent" ? m.type : m.type === "ai" ? "ai" : m.icon;
    if (lines.has(key)) continue;
    lines.set(key, {
      key,
      mark: m,
      words:
        m.type === "connector"
          ? "Reads from or changes a connected tool"
          : m.type === "agent"
            ? "Hands off to another agent"
            : m.type === "ai"
              ? "A model does it"
              : m.icon === "settings"
                ? "Runs by rules, no model"
                : m.words,
    });
  }
  return [...lines.values()];
}
