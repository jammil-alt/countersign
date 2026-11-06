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

/** An agent's initials tile: "PI" for Pia. Its name, not a colour, tells agents apart. */
export function AgentBadge({
  name,
  size = "md",
  testId,
}: {
  name: string;
  size?: "sm" | "md" | "lg";
  testId?: string;
}) {
  return (
    <span
      aria-hidden
      data-testid={testId}
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
