// The design's square connector mark ("QB", "GM"): initials in a bordered tile.
import type { PlainKey } from "../i18n/catalog";
import { EN, type I18n } from "../i18n/i18n";
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

const ACCESS_WORDS: Record<string, PlainKey> = {
  runs: "access.runs",
  asks_first: "access.asks_first",
  steps_may_skip_approval: "access.steps_may_skip_approval",
  not_allowed: "access.not_allowed",
};

/** A tool's access on a connection, in plain words (from the API's `access`). */
export function accessLabel(access: string, { t }: Pick<I18n, "t"> = EN): string {
  const key = ACCESS_WORDS[access];
  return key ? t(key) : access;
}

const STATUS_WORDS: Record<string, PlainKey> = {
  connected: "connection.status.connected",
  pending: "connection.status.pending",
  disconnected: "connection.status.disconnected",
  error: "connection.status.error",
};

export function connectionStatusLabel(status: string, { t }: Pick<I18n, "t"> = EN): string {
  const key = STATUS_WORDS[status];
  return key ? t(key) : status;
}
