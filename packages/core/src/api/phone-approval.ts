// Approving a sign-in on the phone app (docs/plan.md §1.154): a fourth way through the second step
// (§1.100) for client users with a phone set up to sign (§1.116). The browser asks and shows a
// two-digit number; the phone lists what is waiting, picks the number and signs with its key
// behind Face ID or a fingerprint. The browser's routes act for a pending sign-in, outside
// `mount()`, like the step's own; the phone's carry no session at all: each call is signed.

import { z } from "zod";
import { isUuid } from "../ids";
import { defineRoute } from "./contract";
import { SecondFactorPassed } from "./second-factor";

const Id = z.string().refine((v) => isUuid(v), "not an id");

/** How long a request waits on the phone. */
export const PHONE_APPROVAL_SEC = 2 * 60;
/** How often the step page asks whether the phone has answered. */
export const PHONE_APPROVAL_POLL_MS = 2000;
/** How many numbers the phone offers: the browser's and the rest decoys. */
export const PHONE_APPROVAL_CHOICES = 3;

/** The number the browser shows and the phone picks. */
export const PhoneApprovalNumber = z.int().min(10).max(99);

/** The key only the asking page holds: 32 random bytes, base64url. */
export const BrowserKey = z.string().regex(/^[A-Za-z0-9\-_]{43}$/, "not a browser key");

/** ECDSA P-256 over SHA-256, r‖s (64 bytes), base64url, as a Desk item's (`DeviceSignature`). */
const Signature = z.string().regex(/^[A-Za-z0-9\-_]{86}$/);

// ── The browser ─────────────────────────────────────────────────────────────────────────────────

export const PhoneApprovalStarted = z.object({
  id: Id,
  /** Sent back with each check; never stored here (only its hash). */
  key: BrowserKey,
  number: PhoneApprovalNumber,
  expiresAt: z.string(),
  /** How many phones were asked (sent a notification or not). */
  phones: z.int(),
});
export type PhoneApprovalStarted = z.infer<typeof PhoneApprovalStarted>;

export const PhoneApprovalCheckBody = z.strictObject({
  id: Id,
  key: BrowserKey,
  /** Skip the code on this browser for 30 days, as with a code. */
  remember: z.boolean().default(false),
});
export type PhoneApprovalCheckBody = z.infer<typeof PhoneApprovalCheckBody>;

export const PhoneApprovalCheck = z.object({
  status: z.enum(["pending", "approved", "denied", "expired"]),
  /** Set when approved: the step is passed, as a code passes it. */
  passed: SecondFactorPassed.nullable(),
});
export type PhoneApprovalCheck = z.infer<typeof PhoneApprovalCheck>;

// ── The phone ───────────────────────────────────────────────────────────────────────────────────

/** Who is asking and with which phone, signed with that phone's key. */
const PhoneProof = {
  userId: Id,
  deviceId: Id,
  /** When the phone signed (ISO 8601), part of what is signed. */
  at: z.string().datetime(),
  signature: Signature,
};

export const SignInApprovalsBody = z.strictObject(PhoneProof);
export type SignInApprovalsBody = z.infer<typeof SignInApprovalsBody>;

export const WaitingSignIn = z.object({
  id: Id,
  /** "Chrome on macOS". */
  browser: z.string(),
  /** "Austin, US"; null when Cloudflare didn't place the address. */
  place: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
  /** The numbers to pick from, in the order to show them; one is on the browser's screen. */
  choices: z.array(PhoneApprovalNumber).length(PHONE_APPROVAL_CHOICES),
});
export type WaitingSignIn = z.infer<typeof WaitingSignIn>;

export const SignInApprovalDecideBody = z
  .strictObject({
    ...PhoneProof,
    decision: z.enum(["approve", "deny"]),
    /** The number picked; null with `deny`. */
    number: PhoneApprovalNumber.nullable(),
  })
  .refine((b) => (b.decision === "approve") === (b.number !== null), {
    message: "approve with the number picked; deny without one",
    path: ["number"],
  });
export type SignInApprovalDecideBody = z.infer<typeof SignInApprovalDecideBody>;

/**
 * What a phone signs to list the requests waiting on it. Its first line differs from every other
 * signed text, so no signature can be replayed as another kind.
 */
export function signInListText(input: { userId: string; deviceId: string; at: string }): string {
  return ["mezonas-sign-in-list:v1", input.userId, input.deviceId, input.at].join("\n");
}

/** What a phone signs to approve a request with a number, or to deny it. */
export function signInApprovalText(input: {
  approvalId: string;
  userId: string;
  deviceId: string;
  decision: "approve" | "deny";
  number: number | null;
  at: string;
}): string {
  return [
    "mezonas-sign-in:v1",
    input.approvalId,
    input.userId,
    input.deviceId,
    input.decision,
    input.number === null ? "-" : String(input.number),
    input.at,
  ].join("\n");
}

export const phoneApprovalRoutes = {
  // DECISION (docs/plan.md §1.154): `public` in the contract, as the step's own routes: the API
  // answers them outside mount() for a pending sign-in, never in a client.
  secondFactorPhone: defineRoute({
    method: "POST",
    path: "/api/auth/second-factor/phone",
    auth: "public",
    roles: [],
    summary:
      "Ask the person's phone to approve this sign-in: answers the number to show and a key for checking",
    body: z.strictObject({}),
    response: PhoneApprovalStarted,
  }),
  secondFactorPhoneCheck: defineRoute({
    method: "POST",
    path: "/api/auth/second-factor/phone/check",
    auth: "public",
    roles: [],
    summary:
      "Whether the phone has answered; approved, it finishes the sign-in (optionally remembering this browser)",
    body: PhoneApprovalCheckBody,
    response: PhoneApprovalCheck,
  }),
  // DECISION (docs/plan.md §1.154): no session: a phone signed out after 30 idle minutes still
  // approves. Each call is signed by the person's own phone (`signInListText`,
  // `signInApprovalText`); one that doesn't verify answers 403 `signature_required`.
  mobileSignInApprovals: defineRoute({
    method: "POST",
    path: "/api/mobile/sign-in-approvals",
    auth: "public",
    roles: [],
    summary: "The person's sign-ins waiting on their phone, signed for by that phone",
    body: SignInApprovalsBody,
    response: z.object({ approvals: z.array(WaitingSignIn) }),
  }),
  mobileSignInApprovalDecide: defineRoute({
    method: "POST",
    path: "/api/mobile/sign-in-approvals/:id/decide",
    auth: "public",
    roles: [],
    summary:
      "Approve a waiting sign-in with the number on its screen, or deny it, signed by the phone",
    params: z.object({ id: Id }),
    body: SignInApprovalDecideBody,
    response: z.object({ status: z.enum(["approved", "denied"]) }),
  }),
} as const;
