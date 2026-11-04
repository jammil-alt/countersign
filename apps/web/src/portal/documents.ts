// Words and figures for documents in the portal, in the reader's language: statuses as plain words
// with their tone; money and figures through Intl from the decimal string (never a float).
import type { PlainKey } from "../i18n/catalog";
import { EN, type I18n } from "../i18n/i18n";
import type { Tone } from "../ui/primitives";

export function money(
  amount: string | null | undefined,
  currency = "USD",
  { fmt }: Pick<I18n, "fmt"> = EN,
): string {
  return fmt.money(amount, currency);
}

/** A quantity or unit price as printed: trailing zeros past 2 places trimmed. */
export function figure(value: string, { fmt }: Pick<I18n, "fmt"> = EN): string {
  return fmt.figure(value);
}

const DOCUMENT_STATUS: Record<string, { label: PlainKey; tone: Tone }> = {
  stored: { label: "document.status.stored", tone: "neutral" },
  extracting: { label: "document.status.extracting", tone: "accent" },
  extracted: { label: "document.status.extracted", tone: "positive" },
  needs_review: { label: "document.status.needs_review", tone: "warning" },
  failed: { label: "document.status.failed", tone: "risk" },
};

export function documentStatus(
  status: string,
  { t }: Pick<I18n, "t"> = EN,
): { label: string; tone: Tone } {
  const s = DOCUMENT_STATUS[status];
  return s ? { label: t(s.label), tone: s.tone } : { label: status, tone: "neutral" };
}

const SOURCE_LABEL: Record<string, PlainKey> = {
  upload: "document.source.upload",
  email: "document.source.email",
  connector: "document.source.connector",
  request: "document.source.request",
};

export function sourceLabel(source: string, { t }: Pick<I18n, "t"> = EN): string {
  const key = SOURCE_LABEL[source];
  return key ? t(key) : source;
}

export function bytes(n: number, { fmt }: Pick<I18n, "fmt"> = EN): string {
  return fmt.bytes(n);
}

const DROP_REASON: Record<string, PlainKey> = {
  sender_not_allowed: "forwarding.drop.sender_not_allowed",
  unknown_address: "forwarding.drop.unknown_address",
  too_large: "forwarding.drop.too_large",
  unreadable: "forwarding.drop.unreadable",
};

export function dropReason(reason: string, { t }: Pick<I18n, "t"> = EN): string {
  const key = DROP_REASON[reason];
  return key ? t(key) : reason;
}
