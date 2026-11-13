// A notification as sent (ARCHITECTURE §11.3): the kind's fixed sentence in the person's language,
// its counts and one link. Email gets plain text and a small HTML part in the design system's
// colours (no images, no tracking); a text is one line and the link. Nothing else goes in: the
// inputs are the kind, whole numbers, a week's date and the link.

import type { Locale } from "../i18n/locale";
import { NOTIFY_WORDS, type NotifyNumbers } from "../i18n/notify";
import {
  CREDITS_BLOCK,
  type NotificationChannel,
  type NotificationCounts,
  type NotificationKind,
} from "./notify";

export interface RenderInput {
  kind: NotificationKind;
  channel: NotificationChannel;
  counts: NotificationCounts;
  /** APP_ORIGIN + the page. */
  link: string;
  locale: Locale;
  /** lead_message: true when it goes to the lead (a client wrote), false when to the client. */
  toLead?: boolean;
  /** weekly_table: the week's Monday, which its sentence names. */
  weekStart?: string;
}

export interface RenderedNotification {
  subject: string;
  text: string;
  /** Email only. */
  html?: string;
}

// The design system's light colours (packages/design-system/tokens.css), inlined: mail clients
// read no stylesheet.
const INK = "#1A1F26";
const MUTED = "#5B636D";
const SLATE = "#23415E";
const PAPER = "#FAFAF9";
const LINE = "#E6E8EA";

/** The brand's colours for Mezonas' own email (mail clients don't read the design system's CSS). */
export const EMAIL_COLORS = {
  ink: INK,
  muted: MUTED,
  slate: SLATE,
  paper: PAPER,
  line: LINE,
} as const;

function numbers(counts: NotificationCounts, locale: Locale, weekStart?: string): NotifyNumbers {
  const fmt = new Intl.NumberFormat(locale);
  const week = weekStart
    ? new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(
        new Date(`${weekStart}T00:00:00Z`),
      )
    : "";
  return {
    n: fmt.format(counts.items ?? counts.messages ?? 0),
    runs: fmt.format(counts.runs ?? 0),
    changes: fmt.format(counts.changes ?? 0),
    // v0.12 W2-G: the count the billing pass gives, else the block × 2,500.
    credits: fmt.format(counts.credits ?? (counts.block ?? 0) * CREDITS_BLOCK),
    week,
  };
}

/** The headline, an optional second sentence and the action's words. */
function sentences(input: RenderInput): { headline: string; line: string | null; action: string } {
  const w = NOTIFY_WORDS[input.locale];
  const x = numbers(input.counts, input.locale, input.weekStart);
  switch (input.kind) {
    case "items_waiting":
      return {
        headline: w.itemsWaiting.subject(input.counts.items ?? 0, x),
        line: null,
        action: w.itemsWaiting.action,
      };
    case "weekly_table":
      return {
        headline: w.weeklyTable.subject(x),
        line: w.weeklyTable.line(x),
        action: w.weeklyTable.action,
      };
    case "reconnect":
      return { headline: w.reconnect.subject, line: w.reconnect.line, action: w.reconnect.action };
    case "credits":
      return {
        headline: w.credits.subject(input.counts.block ?? 0, x),
        line: w.credits.line,
        action: w.credits.action,
      };
    case "lead_message": {
      const c = input.counts.messages ?? 1;
      return {
        headline: input.toLead ? w.leadMessage.toLead(c, x) : w.leadMessage.toClient(c, x),
        line: null,
        action: w.leadMessage.action,
      };
    }
    case "signoff":
      return { headline: w.signoff.subject, line: w.signoff.line, action: w.signoff.action };
  }
}

const escapeHtml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

export function renderNotification(input: RenderInput): RenderedNotification {
  const { headline, line, action } = sentences(input);
  // A phone notification's lock-screen words are `renderPush`'s; this one line is its record.
  if (input.channel === "sms" || input.channel === "push") {
    return { subject: headline, text: `Mezonas: ${headline}. ${input.link}` };
  }
  const footer = NOTIFY_WORDS[input.locale].footer;
  const text = [
    `${headline}.`,
    ...(line ? [line] : []),
    "",
    `${action}: ${input.link}`,
    "",
    footer,
  ].join("\n");
  const p = (s: string, color = INK) =>
    `<p style="margin:0 0 12px;color:${color};font:15px/1.5 Helvetica,Arial,sans-serif">${escapeHtml(s)}</p>`;
  const html = [
    `<div style="background:${PAPER};padding:24px">`,
    `<div style="max-width:520px;margin:0 auto;background:#FFFFFF;border:1px solid ${LINE};border-radius:8px;padding:24px">`,
    p(`${headline}.`),
    ...(line ? [p(line)] : []),
    `<p style="margin:16px 0"><a href="${escapeHtml(input.link)}" style="display:inline-block;background:${SLATE};color:${PAPER};text-decoration:none;padding:10px 16px;border-radius:6px;font:600 14px Helvetica,Arial,sans-serif">${escapeHtml(action)}</a></p>`,
    p(footer, MUTED),
    "</div></div>",
  ].join("");
  return { subject: headline, text, html };
}

/** A phone notification (§1.97): a title and one sentence, the count and nothing else. */
export interface RenderedPush {
  title: string;
  body: string;
}

/**
 * The lock screen's words: "Mezonas" and the kind's sentence, or the business's name in its place
 * when the person chose that. No amounts, vendors, customers or links: the app opens the page.
 */
export function renderPush(
  input: Omit<RenderInput, "channel" | "link"> & { clientName?: string | null },
): RenderedPush {
  const { headline } = sentences({ ...input, channel: "push", link: "" });
  const name = input.clientName?.trim();
  return { title: name ? name : "Mezonas", body: `${headline}.` };
}
