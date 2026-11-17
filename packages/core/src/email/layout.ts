// The branded email layout (docs/cases-plan.md §4.4; docs/plan.md §1.126): one layout for
// everything the client sees from us: the Mezonas logo (a PNG hosted with the app; mail clients
// drop SVG), the design system's colours and type, borders not shadows, a plain-text part,
// readable in light and dark mail clients, six languages. Notification emails move onto it after.
//
// Every word that goes in is escaped here; no caller passes HTML. Links are https only (http only
// on localhost, for development), so a value from a form can't become a `javascript:` link.

import type { Locale } from "../i18n/locale";
import { ONBOARDING_WORDS } from "../i18n/onboarding";

/** One email as sent: the subject, the plain-text part and the HTML part. */
export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

/** A block of the email's body, in order. Text is escaped by the layout; no raw HTML goes in. */
export type BrandedBlock =
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; text: string }
  /** The lead's own note, quoted, with who wrote it. */
  | { kind: "note"; text: string; from: string }
  /** The one button. */
  | { kind: "button"; label: string; href: string }
  /** Small print: the security line, when the link expires. */
  | { kind: "small"; text: string };

export interface BrandedEmailInput {
  locale: Locale;
  subject: string;
  /** The line mail clients show beside the subject. */
  preheader?: string;
  /** Who it's from, shown at the top: the lead's name and photo (an https URL), or Mezonas. */
  from: { name: string; photoUrl: string | null; role?: string };
  blocks: readonly BrandedBlock[];
  /** The app's origin, for the hosted logo. */
  origin: string;
}

/**
 * The design system's colours (packages/design-system/tokens.json, version 4), light and dark,
 * inlined: mail clients read no stylesheet of ours. Checked against tokens.json in the tests.
 */
export const EMAIL_THEME = {
  paper: { light: "#FAFAF9", dark: "#0F1318" },
  surface: { light: "#FFFFFF", dark: "#171C23" },
  line: { light: "#E6E8EA", dark: "#2A313A" },
  ink: { light: "#1A1F26", dark: "#E6E9EC" },
  "ink-muted": { light: "#5B636D", dark: "#9DA5AF" },
  slate: { light: "#23415E", dark: "#8FB0D2" },
  "on-slate": { light: "#FFFFFF", dark: "#0F1318" },
  copper: { light: "#9A4D27", dark: "#D9895E" },
  "copper-ink": { light: "#7A3D1F", dark: "#E3A07C" },
  "copper-tint": { light: "#F8ECE4", dark: "#33231A" },
} as const;

/** The logo, hosted with the app (apps/web/public/email): the design system's app icon PNG. */
export const EMAIL_LOGO_PATH = "/email/mezonas-icon.png";

// DECISION: Geist where the mail client shows web fonts we don't link (none load it from us: no
// remote fonts in email), then the system's own sans.
const FONT =
  "Geist, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export function escapeEmailHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** An https URL (or http on localhost), or an error: nothing else goes in an href or a src. */
// DECISION: read with a pattern, not `URL` (core has no DOM or Workers types): a scheme, a host
// without user info, then a path without spaces or quotes.
export function emailSafeUrl(url: string): string {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#\s@"'<>\\]+)([/?#][^\s"'<>\\]*)?$/i.exec(url.trim());
  if (!m) throw new Error("an email link must be an absolute URL");
  const scheme = (m[1] as string).toLowerCase();
  const host = (m[2] as string).toLowerCase().replace(/:\d+$/, "");
  const local = host === "localhost" || host === "127.0.0.1";
  if (scheme !== "https" && !(scheme === "http" && local)) {
    throw new Error("an email link must be https");
  }
  return url.trim();
}

/** One line of text, without control characters (a subject or a name can't add a header). */
function oneLine(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    out += code < 32 || code === 127 ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

/** Escaped, with its line breaks kept. */
const paragraphs = (s: string) => escapeEmailHtml(s.replace(/\r\n?/g, "\n")).replace(/\n/g, "<br>");

function initials(name: string): string {
  const parts = oneLine(name).split(" ").filter(Boolean);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return `${first}${last}`.toUpperCase() || "M";
}

const L = (k: keyof typeof EMAIL_THEME) => EMAIL_THEME[k].light;
const D = (k: keyof typeof EMAIL_THEME) => EMAIL_THEME[k].dark;

/**
 * Dark mail clients: those that read `prefers-color-scheme` (Apple Mail, iOS, some Outlooks) get
 * the design system's dark theme; Outlook.com marks its dark mode with `[data-ogsc]`. Clients that
 * invert colours themselves (Gmail's apps) start from the light theme, which reads after inverting.
 */
function darkStyles(): string {
  const rules = [
    `.mz-paper{background:${D("paper")}!important}`,
    `.mz-surface{background:${D("surface")}!important;border-color:${D("line")}!important}`,
    `.mz-ink{color:${D("ink")}!important}`,
    `.mz-muted{color:${D("ink-muted")}!important}`,
    `.mz-line{border-color:${D("line")}!important}`,
    `.mz-button{background:${D("slate")}!important;color:${D("on-slate")}!important}`,
    `.mz-button a{color:${D("on-slate")}!important}`,
    `.mz-note{background:${D("copper-tint")}!important;border-color:${D("copper")}!important}`,
    `.mz-copper{color:${D("copper-ink")}!important}`,
    `.mz-avatar{background:${D("copper-tint")}!important;color:${D("copper-ink")}!important}`,
  ];
  return [
    `:root{color-scheme:light dark;supported-color-schemes:light dark}`,
    `@media (prefers-color-scheme: dark){${rules.join("")}}`,
    rules.map((r) => `[data-ogsc] ${r}`).join(""),
  ].join("");
}

function blockHtml(block: BrandedBlock): string {
  const text = (size: number, color: string, cls: string, weight = 400) =>
    `margin:0 0 16px;font-family:${FONT};font-size:${size}px;line-height:1.5;font-weight:${weight};color:${color}" class="${cls}`;
  switch (block.kind) {
    case "heading":
      return `<h1 style="${text(20, L("ink"), "mz-ink", 500)}">${escapeEmailHtml(oneLine(block.text))}</h1>`;
    case "paragraph":
      return `<p style="${text(15, L("ink"), "mz-ink")}">${paragraphs(block.text)}</p>`;
    case "small":
      return `<p style="${text(13, L("ink-muted"), "mz-muted")}">${paragraphs(block.text)}</p>`;
    case "note":
      return [
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;border-collapse:separate">`,
        `<tr><td class="mz-note" style="background:${L("copper-tint")};border-left:3px solid ${L("copper")};border-radius:6px;padding:14px 16px">`,
        `<p style="margin:0 0 8px;font-family:${FONT};font-size:15px;line-height:1.5;color:${L("ink")}" class="mz-ink">${paragraphs(block.text)}</p>`,
        `<p style="margin:0;font-family:${FONT};font-size:13px;line-height:1.4;color:${L("copper-ink")}" class="mz-copper">${escapeEmailHtml(oneLine(block.from))}</p>`,
        `</td></tr></table>`,
      ].join("");
    case "button": {
      const href = escapeEmailHtml(emailSafeUrl(block.href));
      return [
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px">`,
        `<tr><td class="mz-button" style="background:${L("slate")};border-radius:10px">`,
        `<a href="${href}" style="display:inline-block;padding:12px 20px;font-family:${FONT};font-size:15px;font-weight:500;line-height:1;color:${L("on-slate")};text-decoration:none;border-radius:10px">${escapeEmailHtml(oneLine(block.label))}</a>`,
        `</td></tr></table>`,
      ].join("");
    }
  }
}

function blockText(block: BrandedBlock): string {
  switch (block.kind) {
    case "heading":
    case "paragraph":
    case "small":
      return block.text.replace(/\r\n?/g, "\n").trim();
    case "note":
      return [
        ...block.text
          .replace(/\r\n?/g, "\n")
          .trim()
          .split("\n")
          .map((l) => `> ${l}`),
        `> ${oneLine(block.from)}`,
      ].join("\n");
    case "button":
      return `${oneLine(block.label)}: ${emailSafeUrl(block.href)}`;
  }
}

/** Renders the branded layout around `blocks`. */
export function renderBrandedEmail(input: BrandedEmailInput): RenderedEmail {
  const words = ONBOARDING_WORDS[input.locale];
  const subject = oneLine(input.subject).slice(0, 200);
  const origin = emailSafeUrl(input.origin).replace(/\/+$/, "");
  const logo = escapeEmailHtml(`${origin}${EMAIL_LOGO_PATH}`);
  const name = oneLine(input.from.name);
  const role = input.from.role ? oneLine(input.from.role) : null;
  let photo: string | null = null;
  try {
    photo = input.from.photoUrl ? emailSafeUrl(input.from.photoUrl) : null;
    if (photo && !photo.startsWith("https:")) photo = null;
  } catch {
    // A photo that isn't https is left out; the initials show instead.
    photo = null;
  }
  const avatar = photo
    ? `<img src="${escapeEmailHtml(photo)}" width="40" height="40" alt="" style="display:block;width:40px;height:40px;border-radius:20px;border:1px solid ${L("line")}" class="mz-line">`
    : `<div class="mz-avatar" style="width:40px;height:40px;border-radius:20px;background:${L("copper-tint")};color:${L("copper-ink")};font-family:${FONT};font-size:14px;font-weight:500;line-height:40px;text-align:center">${escapeEmailHtml(initials(name))}</div>`;
  const preheader = input.preheader ? oneLine(input.preheader) : "";

  const html = [
    "<!doctype html>",
    `<html lang="${escapeEmailHtml(input.locale)}"><head>`,
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width,initial-scale=1">`,
    `<meta name="color-scheme" content="light dark">`,
    `<meta name="supported-color-schemes" content="light dark">`,
    `<title>${escapeEmailHtml(subject)}</title>`,
    `<style>${darkStyles()}</style>`,
    `</head>`,
    `<body class="mz-paper" style="margin:0;padding:0;background:${L("paper")}">`,
    preheader
      ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${escapeEmailHtml(preheader)}</div>`
      : "",
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="mz-paper" style="background:${L("paper")}"><tr><td align="center" style="padding:32px 16px">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px">`,
    // The logo.
    `<tr><td style="padding:0 0 20px"><img src="${logo}" width="36" height="36" alt="Mezonas" style="display:block;width:36px;height:36px;border:0"></td></tr>`,
    // The card: a border, never a shadow.
    `<tr><td class="mz-surface" style="background:${L("surface")};border:1px solid ${L("line")};border-radius:14px;padding:28px">`,
    // Who it's from.
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px"><tr>`,
    `<td style="padding:0 12px 0 0;vertical-align:middle">${avatar}</td>`,
    `<td style="vertical-align:middle">`,
    `<p style="margin:0;font-family:${FONT};font-size:15px;font-weight:500;line-height:1.3;color:${L("ink")}" class="mz-ink">${escapeEmailHtml(name)}</p>`,
    role
      ? `<p style="margin:0;font-family:${FONT};font-size:13px;line-height:1.3;color:${L("ink-muted")}" class="mz-muted">${escapeEmailHtml(role)}</p>`
      : "",
    `</td></tr></table>`,
    ...input.blocks.map(blockHtml),
    `</td></tr>`,
    // The footer.
    `<tr><td style="padding:20px 4px 0"><p style="margin:0;font-family:${FONT};font-size:12px;line-height:1.5;color:${L("ink-muted")}" class="mz-muted">${escapeEmailHtml(words.footer)}</p></td></tr>`,
    `</table></td></tr></table>`,
    `</body></html>`,
  ].join("");

  const text = [
    ...(role ? [name, role] : [name]),
    "",
    ...input.blocks.map(blockText).flatMap((t) => [t, ""]),
    "--",
    words.footer,
  ].join("\n");

  return { subject, text, html };
}
