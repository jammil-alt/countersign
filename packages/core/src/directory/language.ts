// The language an agent writes to a person in (owner, 2026-11-05; docs/plan.md §1.27): the person's
// own, else their organization's, else the client's default (`tenant.settings.language`, as the
// portal uses it), else English. One helper for every path where an agent writes to someone: reach
// out, fixed message templates, composed messages, calls and human-release codes.

import { z } from "zod";
import { LOCALES, Locale, matchLocale } from "../i18n/locale";

export const LanguageSource = z.enum(["person", "organization", "client", "default"]);
export type LanguageSource = z.infer<typeof LanguageSource>;

/** The language to use and where it came from ("Uses: Spanish (from Acme Corp)"). */
export const LanguageUsed = z.object({
  language: Locale,
  from: LanguageSource,
  /** The organization it came from, when it did. */
  organization: z.string().nullable().optional(),
});
export type LanguageUsed = z.infer<typeof LanguageUsed>;

/**
 * A stored language as one of the six, or null. Contacts before the directory accepted any
 * `xx` or `xx-YY` tag, so a regional tag reads as its language (`es-MX` → `es`, `pt` → `pt-BR`)
 * and anything else (`ja`) counts as not given.
 */
// DECISION: unsupported stored values are skipped, not errors: the next level decides, so a
// contact saved with `ja` before the directory gets the organization's or the client's language.
export function supportedLanguage(value: string | null | undefined): Locale | null {
  if (!value) return null;
  if ((LOCALES as readonly string[]).includes(value)) return value as Locale;
  return matchLocale(value);
}

export interface LanguageInputs {
  /** The person's own (a contact's `language`, or a user's own choice). */
  person?: string | null | undefined;
  /** Their organization's `language`, with its name for "from …". */
  organization?: { language: string | null | undefined; name?: string | null | undefined } | null;
  /** The client's default (`tenant.settings.language`). */
  client?: string | null | undefined;
}

/** The language to write to a person in: theirs, else their organization's, else the client's, else English. */
export function languageFor(input: LanguageInputs): LanguageUsed {
  const own = supportedLanguage(input.person);
  if (own) return { language: own, from: "person" };
  const org = supportedLanguage(input.organization?.language);
  if (org) {
    return { language: org, from: "organization", organization: input.organization?.name ?? null };
  }
  const client = supportedLanguage(input.client);
  if (client) return { language: client, from: "client" };
  return { language: "en", from: "default" };
}
