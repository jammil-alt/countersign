// Words and figures for documents in the portal: statuses as plain words with their tone, money
// with thousands separators from the decimal string (never a float).
import { formatAmount } from "@countersign/core";
import type { Tone } from "../ui/primitives";

export function money(amount: string | null | undefined, currency = "USD"): string {
  if (amount === null || amount === undefined || amount === "") return "–";
  let fixed: string;
  try {
    fixed = formatAmount(amount, 2);
  } catch {
    return amount;
  }
  const negative = fixed.startsWith("-");
  const [whole = "0", frac = "00"] = (negative ? fixed.slice(1) : fixed).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+$)/g, ",");
  const symbol = currency === "USD" ? "$" : `${currency} `;
  return `${negative ? "−" : ""}${symbol}${grouped}.${frac}`;
}

/** A quantity or unit price as printed: trailing zeros past 2 places trimmed. */
export function figure(value: string): string {
  if (!/^-?\d+(\.\d+)?$/.test(value)) return value;
  const [w, f = ""] = value.split(".");
  const trimmed = f.replace(/0+$/, "");
  return trimmed.length === 0
    ? (w as string)
    : `${w}.${trimmed.length < 2 ? trimmed.padEnd(2, "0") : trimmed}`;
}

export const DOCUMENT_STATUS: Record<string, { label: string; tone: Tone }> = {
  stored: { label: "Received", tone: "neutral" },
  extracting: { label: "Reading", tone: "accent" },
  extracted: { label: "Read", tone: "positive" },
  needs_review: { label: "Needs review", tone: "warning" },
  failed: { label: "Couldn't read", tone: "risk" },
};

export function documentStatus(status: string): { label: string; tone: Tone } {
  return DOCUMENT_STATUS[status] ?? { label: status, tone: "neutral" };
}

export const SOURCE_LABEL: Record<string, string> = {
  upload: "Uploaded",
  email: "Forwarded",
  connector: "From a connected tool",
  request: "Requested",
};

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export const DROP_REASON: Record<string, string> = {
  sender_not_allowed: "the sender isn't on your list",
  unknown_address: "it was sent to an old or wrong address",
  too_large: "it was over 25 MB",
  unreadable: "the message couldn't be read",
};
