// P-7: message translation's settings, limits and what screens show (docs/plan.md §1.69).
//
// A client keeps its work in one working language (`tenant.settings.translation.working`). Absent,
// or null, translation is off and nothing changes. A contact's own switch (`contact.translation`)
// wins over the client's for that person.

import { z } from "zod";
import { LOCALES, Locale } from "../i18n/locale";

export const TRANSLATE_SKILL = "comms.translate";

/** Model translations per client per UTC day, by default (docs/plan.md §1.69). */
export const DEFAULT_TRANSLATION_DAILY_LIMIT = 200;
export const MAX_TRANSLATION_DAILY_LIMIT = 5000;
/** The most characters of one original that are translated; the rest is cut and marked. */
export const MAX_TRANSLATE_CHARS = 6000;
/** How far back the catch-up looks for originals with no translation row. */
export const TRANSLATION_CATCH_UP_HOURS = 24;
/** Originals one pass of the job looks at, per client. */
export const TRANSLATION_BATCH = 25;

/** What a client stores. Every field is optional so a partial save keeps the rest. */
export const TranslationSettingsStored = z.object({
  working: Locale.nullable().optional(),
  incoming: z.boolean().optional(),
  outgoing: z.boolean().optional(),
  threads: z.boolean().optional(),
  model: z.string().min(1).max(100).optional(),
  dailyLimit: z.number().int().min(1).max(MAX_TRANSLATION_DAILY_LIMIT).optional(),
  enabledAt: z.string().optional(),
});
export type TranslationSettingsStored = z.infer<typeof TranslationSettingsStored>;

/** The settings as they apply: defaults filled in. */
export interface TranslationSettings {
  /** null: translation is off for the client. */
  working: Locale | null;
  incoming: boolean;
  outgoing: boolean;
  threads: boolean;
  /** null: the classification model. */
  model: string | null;
  dailyLimit: number;
  enabledAt: string | null;
}

export const TRANSLATION_OFF: TranslationSettings = {
  working: null,
  incoming: false,
  outgoing: false,
  threads: false,
  model: null,
  dailyLimit: DEFAULT_TRANSLATION_DAILY_LIMIT,
  enabledAt: null,
};

/**
 * The client's translation settings from `tenant.settings`, parsed, never trusted (invariant 5).
 * Anything unreadable is off.
 */
export function translationOf(
  settings: Record<string, unknown> | null | undefined,
): TranslationSettings {
  const parsed = TranslationSettingsStored.safeParse(settings?.translation);
  if (!parsed.success || !parsed.data.working) return TRANSLATION_OFF;
  const s = parsed.data;
  return {
    working: s.working ?? null,
    incoming: s.incoming ?? true,
    outgoing: s.outgoing ?? true,
    threads: s.threads ?? true,
    model: s.model ?? null,
    dailyLimit: s.dailyLimit ?? DEFAULT_TRANSLATION_DAILY_LIMIT,
    enabledAt: s.enabledAt ?? null,
  };
}

/** A contact's switch: `true` or `false` wins over the client's; absent follows it. */
export const ContactTranslation = z.strictObject({
  incoming: z.boolean().optional(),
  outgoing: z.boolean().optional(),
});
export type ContactTranslation = z.infer<typeof ContactTranslation>;

/** Whether to translate this way for this person: theirs, else the client's. */
export function translationWanted(
  client: TranslationSettings,
  person: unknown,
  direction: "incoming" | "outgoing",
): boolean {
  if (!client.working) return false;
  const own = ContactTranslation.safeParse(person ?? {});
  const mine = own.success ? own.data[direction] : undefined;
  return mine ?? client[direction];
}

/**
 * The first MAX_TRANSLATE_CHARS of a text, cut at the last paragraph end, else sentence end, else
 * space, in its last quarter; else at the limit. Code points are never split.
 */
export function clipForTranslation(
  text: string,
  max = MAX_TRANSLATE_CHARS,
): { text: string; truncated: boolean } {
  const chars = [...text];
  if (chars.length <= max) return { text, truncated: false };
  const head = chars.slice(0, max).join("");
  const floor = Math.floor(head.length * 0.75);
  const paragraph = head.lastIndexOf("\n\n");
  if (paragraph >= floor) return { text: head.slice(0, paragraph).trimEnd(), truncated: true };
  let sentence = -1;
  for (const end of [". ", "! ", "? ", ".\n", "!\n", "?\n"]) {
    sentence = Math.max(sentence, head.lastIndexOf(end));
  }
  if (sentence >= floor) return { text: head.slice(0, sentence + 1), truncated: true };
  const space = head.lastIndexOf(" ");
  if (space >= floor) return { text: head.slice(0, space), truncated: true };
  return { text: head, truncated: true };
}

/** A language as stored: one of the six, or `unknown`. */
export const TranslationLanguage = z.enum([...LOCALES, "unknown"]);
export type TranslationLanguage = z.infer<typeof TranslationLanguage>;

export const TranslationStatus = z.enum(["translated", "skipped", "capped", "refused", "failed"]);
export type TranslationStatus = z.infer<typeof TranslationStatus>;

/**
 * What the portal shows beside an original: the latest outcome for it. Never a model, a cost or a
 * prompt (invariant 11).
 */
export const TranslationView = z.object({
  id: z.string(),
  status: TranslationStatus,
  /** Why it wasn't translated, as a code (`same_language`, `daily_limit`, `not_covered`…). */
  reason: z.string().nullable(),
  from: TranslationLanguage,
  to: Locale,
  /** The translation: the sender's words in another language. Data, never instructions. */
  text: z.string().nullable(),
  truncated: z.boolean(),
  at: z.string(),
});
export type TranslationView = z.infer<typeof TranslationView>;

/** What the back office shows: the portal's view with the model and its cost. */
export const OpsTranslationView = TranslationView.extend({
  model: z.string().nullable(),
  costUsd: z.string(),
});
export type OpsTranslationView = z.infer<typeof OpsTranslationView>;

/** The settings as both surfaces read them. */
export const TranslationSettingsView = z.object({
  working: Locale.nullable(),
  incoming: z.boolean(),
  outgoing: z.boolean(),
  threads: z.boolean(),
  dailyLimit: z.number().int(),
  enabledAt: z.string().nullable(),
});
export type TranslationSettingsView = z.infer<typeof TranslationSettingsView>;

export const OpsTranslationSettingsView = TranslationSettingsView.extend({
  /** null: the classification model. */
  model: z.string().nullable(),
  /** Model translations today (UTC), against the limit. */
  today: z.number().int(),
});
export type OpsTranslationSettingsView = z.infer<typeof OpsTranslationSettingsView>;

/** The client admin's save: the language and the three switches. */
export const PortalTranslationBody = z.strictObject({
  working: Locale.nullable(),
  incoming: z.boolean().optional(),
  outgoing: z.boolean().optional(),
  threads: z.boolean().optional(),
});
export type PortalTranslationBody = z.infer<typeof PortalTranslationBody>;

/** The operator's save: everything, with a reason. */
export const OpsTranslationBody = PortalTranslationBody.extend({
  model: z.string().min(1).max(100).nullable().optional(),
  dailyLimit: z.number().int().min(1).max(MAX_TRANSLATION_DAILY_LIMIT).optional(),
  reason: z.string().trim().min(1).max(500),
});
export type OpsTranslationBody = z.infer<typeof OpsTranslationBody>;

/** A contact's switch, saved whole: a direction left out follows the client again. */
export const ContactTranslationBody = z.strictObject({ translation: ContactTranslation });
export type ContactTranslationBody = z.infer<typeof ContactTranslationBody>;

/**
 * A dotted path into a raw record's payload (`text`, `body.comment`): at most 5 names of letters,
 * digits, `_` and `-`, checked by a plain loop.
 */
export function isPayloadPath(path: string): boolean {
  if (path.length === 0 || path.length > 200) return false;
  const parts = path.split(".");
  if (parts.length > 5) return false;
  for (const part of parts) {
    if (part.length === 0 || part.length > 40) return false;
    for (const ch of part) {
      const ok =
        (ch >= "a" && ch <= "z") ||
        (ch >= "A" && ch <= "Z") ||
        (ch >= "0" && ch <= "9") ||
        ch === "_" ||
        ch === "-";
      if (!ok) return false;
    }
  }
  return !parts.some((p) => p === "__proto__" || p === "constructor" || p === "prototype");
}

/** The string at `path` in `payload`, or null. */
export function payloadText(payload: unknown, path: string): string | null {
  if (!isPayloadPath(path)) return null;
  let at: unknown = payload;
  for (const part of path.split(".")) {
    if (!at || typeof at !== "object" || Array.isArray(at)) return null;
    if (!Object.hasOwn(at, part)) return null;
    at = (at as Record<string, unknown>)[part];
  }
  return typeof at === "string" ? at : null;
}
