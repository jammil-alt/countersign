// The design's square connector mark ("QB", "GM"): initials in a bordered tile.
import { agentInitials } from "../ui/primitives";

export function ConnectorMark({ name }: { name: string }) {
  return (
    <span
      aria-hidden
      className="inline-flex size-10 shrink-0 items-center justify-center rounded-sm border border-line bg-surface-subtle text-sm font-medium text-ink"
    >
      {agentInitials(name)}
    </span>
  );
}

const ACCESS_WORDS: Record<string, string> = {
  runs: "Runs",
  asks_first: "Asks first",
  steps_may_skip_approval: "May run without asking",
  not_allowed: "Not allowed",
};

/** A tool's access on a connection, in plain words (from the API's `access`). */
export function accessLabel(access: string): string {
  return ACCESS_WORDS[access] ?? access;
}

const STATUS_WORDS: Record<string, string> = {
  connected: "Connected",
  pending: "Not connected",
  disconnected: "Disconnected",
  error: "Needs reconnecting",
};

export function connectionStatusLabel(status: string): string {
  return STATUS_WORDS[status] ?? status;
}
