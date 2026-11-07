// Who did it, at a glance (docs/design/prototype.html `.av`, `.pp`): an agent is an initials tile
// (slate-tint, square corners), a person a round badge. People of Mezonas (the lead, an operator)
// and people signing are copper; the client's own people can be plain.
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { cx } from "./cx";
import { agentInitials } from "./primitives";

/** "Ana Ruiz" → "AR"; one word gives its first two letters. */
export function personInitials(name: string): string {
  return agentInitials(name);
}

/** How many colours an agent's tile can take. */
export const AGENT_HUES = 5;

// Each agent has a colour of its own, as on the owner's v1 screens (`docs/design/screens/1-home.png`:
// solid initials blocks in copper, slate, green and mustard), so a card, a row and a header read as
// the same agent at a glance.
// DECISION (owner, design pass 2): the blocks are solid fills of existing tokens (slate, copper,
// positive, signal-ink and the steel step of the slate ramp) with `surface` initials, which meet
// 4.5:1 in both themes. Status keeps its tinted pills and the gold, red and green accents, so a
// solid block reads as "which agent" and never as a state.
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
 * Colours for a set of agents (one client's): each agent starts from its own `agentHue` and, in
 * id order, steps to the next free colour when an earlier one has it, so a client's first five
 * agents never share a colour. Agents with a `group` (a client id) are spread within their group.
 */
export function agentHues(
  agents: readonly { id: string; group?: string | null | undefined }[],
): Map<string, number> {
  const out = new Map<string, number>();
  const used = new Map<string, Set<number>>();
  for (const a of [...agents].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))) {
    if (out.has(a.id)) continue;
    const key = a.group ?? "";
    const taken = used.get(key) ?? new Set<number>();
    let hue = agentHue(a.id);
    for (let i = 0; i < AGENT_HUES && taken.has(hue); i++) hue = (hue % AGENT_HUES) + 1;
    taken.add(hue);
    used.set(key, taken);
    out.set(a.id, hue);
  }
  return out;
}

const AgentHueContext = createContext<ReadonlyMap<string, number>>(new Map());

/**
 * Gives the badges below it their client's colours (`agentHues`), on top of any from a provider
 * above. Where no provider knows an agent, its badge falls back to `agentHue` of its id.
 */
export function AgentHuesProvider({
  agents,
  children,
}: {
  agents: readonly { id: string; group?: string | null | undefined }[];
  children: ReactNode;
}) {
  const parent = useContext(AgentHueContext);
  const key = agents.map((a) => `${a.group ?? ""}:${a.id}`).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `agents`.
  const value = useMemo(() => {
    const mine = agentHues(agents);
    return mine.size === 0 ? parent : new Map([...parent, ...mine]);
  }, [key, parent]);
  return <AgentHueContext.Provider value={value}>{children}</AgentHueContext.Provider>;
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
  const hues = useContext(AgentHueContext);
  const hue = (seed ? hues.get(seed) : undefined) ?? agentHue(seed || name);
  return (
    <span
      aria-hidden
      data-testid={testId}
      data-hue={hue}
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
