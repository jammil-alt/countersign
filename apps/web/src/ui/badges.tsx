// Who did it, at a glance (docs/design/prototype.html `.av`, `.pp`): an agent is an initials tile
// (slate-tint, square corners), a person a round badge. People of Mezonas (the lead, an operator)
// and people signing are copper; the client's own people can be plain.
import type { ReactNode } from "react";
import { cx } from "./cx";
import { agentInitials } from "./primitives";

/** "Ana Ruiz" → "AR"; one word gives its first two letters. */
export function personInitials(name: string): string {
  return agentInitials(name);
}

/** How many colours an agent's tile cycles through: the five steps of `data-seq-*`. */
export const AGENT_HUES = 5;

// UI cleanup (design pass): each agent gets a colour of its own again, as the owner's v1 screens
// had, so a card, a row and a sidebar entry read as the same agent at a glance.
// DECISION: the colours are the slate ramp `data-seq-1`…`-5` (each with the text token that
// meets 4.5:1 on it in both themes, page.css), never a state colour: copper is people, gold
// waits on you, risk is errors and positive is done. The agent's id picks it (FNV-1a), so the
// same agent has the same colour on both sides; without an id, its name does.
/** 1…AGENT_HUES for a seed: the same seed always gives the same colour. */
export function agentHue(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) % AGENT_HUES) + 1;
}

/**
 * An agent's initials tile: "PI" for Pia, in the agent's own colour (`seed`, its id; else its
 * name). The words beside it still name the agent; the colour only helps the eye.
 */
export function AgentBadge({
  name,
  seed,
  size = "md",
  testId,
}: {
  name: string;
  /** The agent's id: picks its colour. */
  seed?: string | null | undefined;
  size?: "sm" | "md" | "lg";
  testId?: string;
}) {
  return (
    <span
      aria-hidden
      data-testid={testId}
      data-hue={agentHue(seed || name)}
      className={cx("ui-agentbadge", size !== "md" && `ui-agentbadge--${size}`)}
    >
      {agentInitials(name)}
    </span>
  );
}

/**
 * A person: a round initials badge, copper (a person's touch: the lead, a sign-off) unless
 * `plain`. With `line` it shows the name and the line beside it ("Your Mezonas lead").
 */
export function PersonBadge({
  name,
  line,
  plain,
  size = "md",
  testId,
}: {
  name: string;
  line?: ReactNode;
  plain?: boolean;
  size?: "sm" | "md" | "lg";
  testId?: string;
}) {
  const badge = (
    <span
      aria-hidden={line !== undefined}
      className={cx(
        "ds-avatar",
        size === "sm" && "ds-avatar--sm",
        size === "lg" && "ds-avatar--lg",
        plain ? "ui-personbadge--plain" : "mz-lead",
      )}
    >
      {personInitials(name)}
    </span>
  );
  if (line === undefined) {
    return (
      <span data-testid={testId} role="img" aria-label={name} className="inline-flex">
        {badge}
      </span>
    );
  }
  return (
    <span data-testid={testId} className={cx("mz-person", !plain && "mz-person--lead")}>
      {badge}
      <span className="min-w-0">
        <span className="block truncate">{name}</span>
        <small className="truncate">{line}</small>
      </span>
    </span>
  );
}
