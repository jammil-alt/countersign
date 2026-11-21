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

export function BoxMark({ mark, testId }: { mark: BoxMarkSpec; testId?: string | undefined }) {
  if (mark.type === "connector") {
    return (
      <span
        className="flow-box__mark flow-box__mark--logo"
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
        className="flow-box__mark flow-box__mark--logo"
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
