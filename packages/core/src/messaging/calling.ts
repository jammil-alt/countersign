// §1.160: calls that carry the client's name (SHAKEN/STIR and CNAM, Twilio's Trust Hub). What is
// stored on the client's `twilio` connection, what the back office sees, and the caller name's
// rules. The Twilio calls are in `@countersign/connectors` (twilio/calling.ts).

import { z } from "zod";

/**
 * A caller name Twilio accepts: starts with a letter, then letters, digits, periods, commas and
 * spaces, 15 characters at most (Twilio, "Branded calls using CNAM").
 */
export const CNAM_NAME_RE = /^[A-Za-z][A-Za-z0-9., ]{0,14}$/;

/** A name made to fit: the business's name cut to what Twilio accepts, or null if nothing fits. */
export function cnamNameFrom(name: string): string | null {
  const cleaned = name
    .replace(/[^A-Za-z0-9., ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[^A-Za-z]+/, "");
  const cut = cleaned.slice(0, 15).trim();
  return CNAM_NAME_RE.test(cut) ? cut : null;
}

const Sid = (prefix: string) => z.string().regex(new RegExp(`^${prefix}[0-9a-fA-F]{32}$`));

/** One trust product's review: `draft`, `pending-review`, `in-review`, `twilio-approved`, `twilio-rejected`. */
const Product = z.object({
  sid: Sid("BU").nullable().default(null),
  status: z.string().nullable().default(null),
  /** Twilio's reasons, when rejected. */
  issues: z.array(z.string()).default([]),
});

/** `connection.config.calling` on the client's `twilio` connection. */
export const CallingRegistration = z.looseObject({
  /** The name calls show (CNAM). */
  displayName: z.string().regex(CNAM_NAME_RE).nullable().default(null),
  shakenStir: Product.default({ sid: null, status: null, issues: [] }),
  cnam: Product.default({ sid: null, status: null, issues: [] }),
  cnamEndUserSid: Sid("IT").nullable().default(null),
  /**
   * Numbers on the profile and the products: `<bundle sid>:<number sid>` → the assignment (RA…),
   * so a retry skips what is done and a released number is taken off first.
   */
  assignments: z.record(z.string(), z.string()).default({}),
  /** What Twilio refused last (a call that failed), cleared by the next try that works. */
  error: z.string().nullable().default(null),
  submittedAt: z.string().nullable().default(null),
  checkedAt: z.string().nullable().default(null),
});
export type CallingRegistration = z.infer<typeof CallingRegistration>;

export function readCallingRegistration(value: unknown): CallingRegistration | null {
  if (value === undefined || value === null) return null;
  const r = CallingRegistration.safeParse(value);
  return r.success ? r.data : null;
}

export const CallingStatus = z.enum(["not_started", "pending", "approved", "rejected"]);
export type CallingStatus = z.infer<typeof CallingStatus>;

/** A trust product's status, in our four words. */
export function callingStatusOf(status: string | null): CallingStatus {
  if (!status) return "not_started";
  if (status === "twilio-approved") return "approved";
  if (status === "twilio-rejected") return "rejected";
  return "pending";
}

/** What the back office sees on Messaging. */
export const CallingView = z.object({
  /** Whether the texting registration's business profile is approved (the products need it). */
  profileReady: z.boolean(),
  displayName: z.string().nullable(),
  /** The name to offer when none is set: the business's, made to fit. */
  suggestedName: z.string().nullable(),
  shakenStir: z.object({ status: CallingStatus, issues: z.array(z.string()) }),
  cnam: z.object({ status: CallingStatus, issues: z.array(z.string()) }),
  /** Numbers (PN…) carried by both products. */
  numbersCovered: z.array(z.string()),
  error: z.string().nullable(),
  submittedAt: z.string().nullable(),
  checkedAt: z.string().nullable(),
});
export type CallingView = z.infer<typeof CallingView>;

export const CallingSubmit = z.strictObject({
  displayName: z.string().trim().regex(CNAM_NAME_RE, {
    message: "up to 15 letters, digits, periods, commas and spaces, starting with a letter",
  }),
});
export type CallingSubmit = z.infer<typeof CallingSubmit>;
