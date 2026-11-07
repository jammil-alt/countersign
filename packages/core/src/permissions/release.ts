// Human release (ARCHITECTURE §6.9, docs/plan.md §1.26 "Human release", phase 4): a vault item (a
// connection) may require a named person of the client to release it before an agent uses it. The
// setting lives in `connection.config.release`; each request is an `access_release` row holding
// only the code's HMAC. The rules here are pure: what the setting may be, whether a release covers
// a call, and what a try or the clock does to a request. The code itself is made, hashed and
// compared in packages/connectors (`release-codes.ts`); it never reaches this module.

import { z } from "zod";
import { languageFor } from "../directory/language";
import type { Locale } from "../i18n/locale";
import { RELEASE_WORDS } from "../i18n/release";
import { isUuid } from "../ids";

/** A code lasts this long. */
export const RELEASE_CODE_TTL_MS = 10 * 60_000;
/** Wrong codes allowed on one request before it fails. */
export const RELEASE_MAX_TRIES = 5;
/** New codes a person may ask for while the step waits. */
export const RELEASE_MAX_RESENDS = 3;
/** The longest `hours` window. */
export const RELEASE_MAX_HOURS = 24;
/** A code: six digits. */
export const RELEASE_CODE_PATTERN = /^\d{6}$/;

export const RELEASE_STATUSES = [
  "pending",
  "released",
  "expired",
  "failed",
  "revoked",
  "void",
] as const;
export type ReleaseStatus = (typeof RELEASE_STATUSES)[number];

export const ReleaseChannel = z.enum(["sms", "email"]);
export type ReleaseChannel = z.infer<typeof ReleaseChannel>;

/** One run, or a number of hours for that connection and agent. */
export const ReleaseWindow = z.union([
  z.literal("run"),
  z.strictObject({ hours: z.number().int().min(1).max(RELEASE_MAX_HOURS) }),
]);
export type ReleaseWindow = z.infer<typeof ReleaseWindow>;

const PersonId = z.string().refine((v) => isUuid(v), "not an id");
/** E.164. */
const Phone = z.string().regex(/^\+[1-9]\d{6,14}$/);

/**
 * `connection.config.release`. `phone` is pinned by the server when a text channel is saved (the
 * person's number as it was then); it is never taken from a request body.
 */
export const ReleaseSetting = z
  .object({
    mode: z.enum(["off", "code"]),
    personId: PersonId.nullable().default(null),
    channel: ReleaseChannel.default("email"),
    window: ReleaseWindow.default("run"),
    phone: Phone.nullable().default(null),
    updatedAt: z.string().nullable().default(null),
  })
  .meta({ id: "ReleaseSetting" });
export type ReleaseSetting = z.infer<typeof ReleaseSetting>;

export const RELEASE_OFF: ReleaseSetting = {
  mode: "off",
  personId: null,
  channel: "email",
  window: "run",
  phone: null,
  updatedAt: null,
};

/**
 * The release setting of a connection's config. None: off. One that no longer parses is read as
 * on with nobody to release it, so every call through the connection is refused (fails closed),
 * like a grant that no longer parses.
 */
// DECISION: a malformed setting fails closed (on, nobody named), never open.
export function releaseOf(config: unknown): ReleaseSetting {
  const raw = (config as { release?: unknown } | null | undefined)?.release;
  if (raw === undefined || raw === null) return RELEASE_OFF;
  const parsed = ReleaseSetting.safeParse(raw);
  if (!parsed.success) return { ...RELEASE_OFF, mode: "code" };
  return parsed.data;
}

/** What a setting must have before it can be on: a person. */
export function releaseSettingProblem(setting: ReleaseSetting): string | null {
  if (setting.mode === "off") return null;
  if (!setting.personId) return "human release is on, but nobody is named to release it";
  if (setting.channel === "sms" && !setting.phone) {
    return "human release by text needs the person's phone";
  }
  return null;
}

/** The window's length in ms, or null for `run`. */
export function windowMs(window: ReleaseWindow): number | null {
  return window === "run" ? null : window.hours * 3_600_000;
}

/** When a release given at `releasedAt` stops counting: null for `run` (that run only). */
export function validUntilFor(window: ReleaseWindow, releasedAt: Date): Date | null {
  const ms = windowMs(window);
  return ms === null ? null : new Date(releasedAt.getTime() + ms);
}

/** The fields of an `access_release` row the rules read. */
export interface ReleaseRecord {
  status: ReleaseStatus;
  connectionId: string;
  agentId: string;
  runId: string;
  personId: string;
  expiresAt: Date;
  tries: number;
  releasedAt: Date | null;
  validUntil: Date | null;
}

export interface ReleaseAsk {
  connectionId: string;
  agentId: string;
  /** Null outside a run (an inbound call): only an hours release can cover it. */
  runId: string | null;
  now: Date;
}

/**
 * Whether a release lets this call through, under the connection's setting as it is now: released,
 * for this connection and agent, by the person the setting names now; `run`: given in this run;
 * hours: still inside its window, and no longer than the setting's window allows today; and given
 * after the setting was last saved (so a client that shortens the window, names someone else or
 * turns it off and on again tightens at once).
 */
export function releaseCovers(
  row: ReleaseRecord,
  setting: ReleaseSetting,
  ask: ReleaseAsk,
): boolean {
  if (setting.mode !== "code" || !setting.personId) return false;
  if (row.status !== "released" || !row.releasedAt) return false;
  if (row.connectionId !== ask.connectionId || row.agentId !== ask.agentId) return false;
  if (row.personId !== setting.personId) return false;
  // Saving the setting again (off and on, another channel) starts afresh: earlier releases lapse.
  if (setting.updatedAt && row.releasedAt.getTime() < Date.parse(setting.updatedAt)) return false;
  const ms = windowMs(setting.window);
  if (ms === null) return row.validUntil === null && ask.runId !== null && row.runId === ask.runId;
  if (!row.validUntil || row.validUntil.getTime() <= ask.now.getTime()) return false;
  return row.validUntil.getTime() - row.releasedAt.getTime() <= ms;
}

/** A pending request whose code still counts: not expired, tries left. */
export function codeOpen(row: Pick<ReleaseRecord, "status" | "expiresAt" | "tries">, now: Date) {
  return (
    row.status === "pending" &&
    row.expiresAt.getTime() > now.getTime() &&
    row.tries < RELEASE_MAX_TRIES
  );
}

/** What a try does to a request. `matched` = the code entered is the request's. */
export type TryOutcome =
  | { kind: "released"; status: "released"; tries: number }
  | { kind: "wrong"; status: "pending" | "failed"; tries: number; triesLeft: number }
  | { kind: "expired"; status: "expired"; tries: number }
  | { kind: "closed"; status: ReleaseStatus; tries: number };

export function tryCode(
  row: Pick<ReleaseRecord, "status" | "expiresAt" | "tries">,
  matched: boolean,
  now: Date,
): TryOutcome {
  if (row.status !== "pending") return { kind: "closed", status: row.status, tries: row.tries };
  if (row.expiresAt.getTime() <= now.getTime()) {
    return { kind: "expired", status: "expired", tries: row.tries };
  }
  if (row.tries >= RELEASE_MAX_TRIES) return { kind: "closed", status: "failed", tries: row.tries };
  if (matched) return { kind: "released", status: "released", tries: row.tries };
  const tries = row.tries + 1;
  const left = RELEASE_MAX_TRIES - tries;
  return { kind: "wrong", status: left > 0 ? "pending" : "failed", tries, triesLeft: left };
}

/** A code as a person typed or texted it: digits only, or null when it isn't six of them. */
export function normalizeCode(input: string): string | null {
  const digits = input.replace(/[\s-]/g, "");
  return RELEASE_CODE_PATTERN.test(digits) ? digits : null;
}

/** "for this run", "for the next 4 hours": what the message and the inbox item say. */
export function windowWords(window: ReleaseWindow, test: boolean, locale: Locale = "en"): string {
  const w = RELEASE_WORDS[locale];
  if (window === "run") return test ? w.testRun : w.run;
  return w.hours(window.hours);
}

/**
 * The text and email that carry a code, in the person's language. Short, no link (a link in a
 * code message is what phishing looks like), and the code first so a phone shows it in the
 * notification.
 */
export function releaseMessage(input: {
  code: string;
  agent: string;
  tool: string;
  window: ReleaseWindow;
  test: boolean;
  locale?: Locale | undefined;
}): string {
  const locale = input.locale ?? "en";
  const w = RELEASE_WORDS[locale];
  return `${w.prefix} ${input.code}. ${w.body(input.agent, input.tool, windowWords(input.window, input.test, locale))}`;
}

/** The person's language for a code: their own choice, else the client's default, else English. */
export function releaseLocale(user: Locale | null, client: Locale | null): Locale {
  return languageFor({ person: user, client }).language;
}

/** A phone number with all but its last 4 digits hidden. */
export function maskPhone(phone: string): string {
  return phone.length <= 4 ? phone : `•••${phone.slice(-4)}`;
}

/** An address with its local part shortened to its first letter. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "•••";
  return `${email[0]}•••${email.slice(at)}`;
}
