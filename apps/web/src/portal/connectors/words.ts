// Connectors C5: the words the connector screens share: a level as the page says it, how a tool
// connects, its description in the reader's language, and a connection's state.
import type { ConnectorAuth, PermissionLevel, Verb } from "@countersign/core";
import type { PlainKey } from "../../i18n/catalog";
import type { I18n } from "../../i18n/i18n";
import type { ChipState } from "../../ui/status";

/** Reads are On or Off; writes Ask me first, On its own or Off (docs/connectors-plan.md §3.2). */
export function levelKey(verb: Verb, level: PermissionLevel): PlainKey {
  if (level === "off") return "connectors.level.off";
  if (verb === "read") return "connectors.level.on";
  return level === "auto" ? "connectors.level.alone" : "connectors.level.ask";
}

/** Connectors whose description we show in the reader's language (else the API's English). */
const DESCRIPTIONS: Record<string, PlainKey> = {
  gmail: "connections.gmail.description",
  gsheets: "connections.gsheets.description",
  slack: "connections.slack.description",
  bankfeed: "connections.bankfeed.description",
  whatsapp_meta: "connections.whatsappMeta.description",
  excel: "connections.excel.description",
  onedrive: "connections.onedrive.description",
  teams: "connections.teams.description",
};

export function descriptionOf(
  item: { connector: string; description: string },
  { t }: Pick<I18n, "t">,
): string {
  const key = DESCRIPTIONS[item.connector];
  return key ? t(key) : item.description;
}

/** The connect button's words, where "Connect" alone says too little. */
export const CONNECT_LABELS: Record<string, PlainKey> = {
  bankfeed: "connections.bankfeed.connect",
  whatsapp_meta: "connections.whatsappMeta.connect",
};

/** How a tool connects, in a few words: "You sign in", "You enter a key", "Nothing to sign in to". */
export const HOW_KEY: Record<ConnectorAuth, PlainKey> = {
  oauth2: "connectors.how.signIn",
  api_key: "connectors.how.key",
  none: "connectors.how.none",
};

/** A connection's status as a chip: connected is done, a broken one is blocked, the rest idle. */
export const STATUS_CHIP: Record<string, ChipState> = {
  connected: "done",
  error: "blocked",
  disconnected: "idle",
  pending: "setup",
};

export function isBroken(status: string | undefined): boolean {
  return status === "error" || status === "disconnected";
}

/**
 * The provider's id for the account, where a person knows it by that (a mailbox's address); null
 * for a company or realm id, which never shows (Review 2, decision 3).
 */
// DECISION: an id that is an email address is the account as people know it; any other id is the
// provider's own and stays out of sight.
export function accountAddress(id: string | null | undefined): string | null {
  return id && /^[^\s@]+@[^\s@]+$/.test(id) ? id : null;
}

/** "Reads 9 · changes 3, asking you first": a connection's access in one line. */
export function accessSummary(
  access: { reads: number; changesAsk: number; changesAuto: number },
  { t }: Pick<I18n, "t">,
): string {
  const parts: string[] = [];
  if (access.reads > 0) parts.push(t("connectors.summary.reads", { count: access.reads }));
  if (access.changesAsk > 0) parts.push(t("connectors.summary.ask", { count: access.changesAsk }));
  if (access.changesAuto > 0) {
    parts.push(t("connectors.summary.alone", { count: access.changesAuto }));
  }
  if (parts.length === 0) return t("connectors.summary.nothing");
  if (access.changesAsk === 0 && access.changesAuto === 0) {
    return t("connectors.summary.readsOnly", { count: access.reads });
  }
  return parts.join(" · ");
}
