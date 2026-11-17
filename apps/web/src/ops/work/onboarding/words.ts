// The onboarding screens' words (docs/plan.md §1.149; docs/cases-plan.md §4). The back office stays
// in English (§1.18); what the client sees (the emails, the welcome page) is rendered by the API in
// their language and only shown here as a preview.
import {
  type Covers,
  coversAnything,
  type FactAudience,
  type FactSourceKind,
  type FactSureness,
  type GuideFieldKind,
  type GuideFieldState,
  type GuideTotals,
  type IntakeArea,
  type IntakeEventKind,
  type IntakeStatus,
  type StartMode,
} from "@countersign/core";

export const AREA_WORDS: Record<IntakeArea, string> = {
  purchasing: "Purchasing",
  sales: "Sales",
  receivables: "Receivables",
  bookkeeping: "Bookkeeping",
  marketing: "Marketing",
};

export const SOURCE_WORDS: Record<FactSourceKind, string> = {
  call: "Call",
  note: "Our note",
  email: "Email",
  document: "Document",
  website: "Their website",
  intake: "Intake",
  tool: "Connected tool",
  run: "A run",
  other: "Other",
};

export const SURENESS_WORDS: Record<FactSureness, string> = {
  heard: "Heard",
  seen: "Seen",
  confirmed: "Confirmed",
};

export const SURENESS_HELP: Record<FactSureness, string> = {
  heard: "Someone told us",
  seen: "In a document or a tool",
  confirmed: "They confirmed it",
};

export const AUDIENCE_WORDS: Record<FactAudience, string> = {
  ours: "Only us",
  theirs: "Theirs",
};

export const AUDIENCE_HELP: Record<FactAudience, string> = {
  ours: "Our notes. Never shown to the client, Sloan or their agents.",
  theirs: "About their business. They confirm it in the intake.",
};

export const FIELD_STATE_WORDS: Record<GuideFieldState, string> = {
  known: "Known",
  to_confirm: "To confirm",
  to_ask: "To ask",
  later: "Ask later",
};

export const FIELD_KIND_WORDS: Record<GuideFieldKind, string> = {
  text: "Short answer",
  long_text: "Long answer",
  number: "Number",
  money: "Amount",
  date: "Date",
  choice: "One choice",
  choices: "Several choices",
  yes_no: "Yes or no",
  files: "Files",
  tool: "A tool to connect",
};

export const START_MODE_WORDS: Record<StartMode, string> = {
  point: "Get to the point",
  talk: "Talk it through with Sloan",
};

export const START_MODE_HELP: Record<StartMode, string> = {
  point: "One page of cards: confirm what we think, answer the rest.",
  talk: "The same questions as a conversation with Sloan.",
};

export const INTAKE_STATUS_WORDS: Record<IntakeStatus, string> = {
  sent: "Sent",
  open: "Open",
  scope_ready: "Scope ready",
  signed: "Signed",
  done: "Done",
  cancelled: "Cancelled",
};

export const INVITE_STEPS = [
  "Who",
  "What it covers",
  "The questions",
  "The email",
  "Send",
] as const;

/** "General, Purchasing and 1 agent", or "Just the account". */
export function coversLine(covers: Covers): string {
  if (!coversAnything(covers)) return "Just the account";
  const parts = [
    ...(covers.general ? ["General"] : []),
    ...covers.areas.map((a) => AREA_WORDS[a]),
    ...(covers.templateIds.length > 0 ? [plural(covers.templateIds.length, "agent")] : []),
  ];
  return listWords(parts);
}

/** "6 to confirm, 8 questions, 1 tool, about 15 minutes". */
export function totalsLine(t: GuideTotals): string {
  const parts = [
    ...(t.toConfirm > 0 ? [`${t.toConfirm} to confirm`] : []),
    ...(t.toAsk > 0 ? [plural(t.toAsk, "question")] : []),
    ...(t.tools > 0 ? [plural(t.tools, "tool")] : []),
    ...(t.later > 0 ? [`${t.later} for later`] : []),
    `about ${plural(t.minutes, "minute")}`,
  ];
  return parts.join(", ");
}

/** "a, b and c". */
export function listWords(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** An intake event on the deal's timeline, in words: "Invite sent to Dana Ruiz". */
export function intakeEventWords(
  kind: IntakeEventKind,
  person: string | null,
  section: string | null,
): string {
  const who = person ?? "Someone";
  const to = person ? ` to ${person}` : "";
  const part = section ?? "a part";
  switch (kind) {
    case "sent":
      return `Invite sent${to}.`;
    case "scheduled":
      return `Invite scheduled${to}.`;
    case "delivered":
      return `Invite delivered${to}.`;
    case "bounced":
      return `The invite${to} bounced.`;
    case "opened":
      return `${who} opened the welcome page.`;
    case "signed_in":
      return `${who} signed in.`;
    case "wrong_account":
      return `Someone signed in with another address on ${person ? `${person}'s` : "a"} link.`;
    case "answered":
      return `${who} answered questions.`;
    case "asked":
      return `${who} asked a colleague.`;
    case "colleague_invited":
      return `${who} invited a colleague to help.`;
    case "different_process":
      return `${who} described a different process.`;
    case "section_started":
      return `${who} said start with ${part}.`;
    case "section_not_now":
      return `${who} said not now to ${part}.`;
    case "cards_added":
      return "More questions added to the intake.";
    case "reminded":
      return `Reminder sent${to}.`;
    case "scope_ready":
      return "The scope is ready to sign.";
    case "signed":
      return `${who} signed the scope.`;
    case "done":
      return "The intake is done.";
    case "cancelled":
      return "The intake was cancelled.";
  }
}
