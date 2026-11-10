import { z } from "zod";
import { isUuid } from "../ids";
import { E164 } from "../messaging/rules";
import { defineRoute } from "./contract";

// The second step of signing in (docs/plan.md §1.83): a code by text, WhatsApp or authenticator
// app, after WorkOS has checked the password. The `/api/auth/second-factor` routes are `public` in
// the contract because they serve a session that has not passed the step yet; each one checks the
// sealed cookie itself and acts only for that person.

export const SECOND_FACTOR_METHODS = ["totp", "sms", "whatsapp"] as const;
export type SecondFactorMethod = (typeof SECOND_FACTOR_METHODS)[number];

/** Operators reach every client: the authenticator app only. */
export const OPERATOR_SECOND_FACTOR_METHODS: readonly SecondFactorMethod[] = ["totp"];

export const RECOVERY_CODE_COUNT = 10;
/** Wrong codes, and codes sent, allowed per person in SECOND_FACTOR_WINDOW_MIN. */
export const SECOND_FACTOR_MAX_TRIES = 5;
export const SECOND_FACTOR_MAX_SENDS = 5;
export const SECOND_FACTOR_WINDOW_MIN = 15;
/** How long a sign-in may wait at the second step. */
export const SECOND_FACTOR_PENDING_SEC = 10 * 60;

/** Recovery codes: 8 letters and digits, shown as `abcd-efgh`; dashes and case don't matter. */
export const RecoveryCodeInput = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, "").toLowerCase())
  .pipe(z.string().regex(/^[a-z2-7]{8}$/, "a recovery code"));

const Code = z
  .string()
  .trim()
  .regex(/^\d{4,10}$/, "the code from the message or app");

export const SecondFactorStatus = z.enum(["pending", "done", "exempt"]);

export const SecondFactorState = z.object({
  status: SecondFactorStatus,
  /** Operators may use the authenticator app only. */
  operator: z.boolean(),
  /** The methods this person may use: OPERATOR_SECOND_FACTOR_METHODS for operators. */
  allowed: z.array(z.enum(SECOND_FACTOR_METHODS)),
  /** Whether this deployment can send texts and WhatsApp messages (Twilio Verify's set-up). */
  available: z.object({ totp: z.boolean(), sms: z.boolean(), whatsapp: z.boolean() }),
  /** Methods already set up (`verified`) or started. */
  methods: z.array(
    z.object({
      method: z.enum(SECOND_FACTOR_METHODS),
      verified: z.boolean(),
      /** The phone's last digits, e.g. `•••• 4242`, for texts and WhatsApp. */
      phoneHint: z.string().nullable(),
    }),
  ),
  recoveryCodesLeft: z.number().int().min(0),
  /** Seconds left to finish the step, while pending. */
  secondsLeft: z.number().int().min(0).nullable(),
});
export type SecondFactorState = z.infer<typeof SecondFactorState>;

export const SecondFactorVerified = z.object({
  ok: z.literal(true),
  /** Set only when this sign-in finished setting up a method: shown once, never again. */
  recoveryCodes: z.array(z.string()).nullable(),
});

const IdParams = z.object({ id: z.string().refine((v) => isUuid(v), "not an id") });
const ConnectionCode = z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/) });

export const ClaudeConnection = z.object({
  status: z.enum(["waiting", "approved", "expired"]),
  startedAt: z.string(),
  expiresAt: z.string(),
  /** Whether the person looking at it is the one whose connection it is. */
  yours: z.boolean(),
});
export type ClaudeConnection = z.infer<typeof ClaudeConnection>;

export const secondFactorRoutes = {
  secondFactorState: defineRoute({
    method: "GET",
    path: "/api/auth/second-factor",
    auth: "public",
    roles: [],
    summary: "Where the signed-in person is with the second step, and which methods they may use",
    response: SecondFactorState,
  }),
  secondFactorTotpStart: defineRoute({
    method: "POST",
    path: "/api/auth/second-factor/totp",
    auth: "public",
    roles: [],
    summary: "Start setting up an authenticator app: the otpauth link for the QR code, shown once",
    response: z.object({ uri: z.string(), secret: z.string() }),
  }),
  secondFactorPhoneStart: defineRoute({
    method: "POST",
    path: "/api/auth/second-factor/phone",
    auth: "public",
    roles: [],
    summary: "Start setting up texts or WhatsApp: saves the number and sends the first code",
    body: z.strictObject({ method: z.enum(["sms", "whatsapp"]), phone: E164 }),
    response: z.object({ sent: z.literal(true), phoneHint: z.string() }),
  }),
  secondFactorSend: defineRoute({
    method: "POST",
    path: "/api/auth/second-factor/send",
    auth: "public",
    roles: [],
    summary: "Send a sign-in code by text or WhatsApp to the number already set up",
    body: z.strictObject({ method: z.enum(["sms", "whatsapp"]) }),
    response: z.object({ sent: z.literal(true), phoneHint: z.string() }),
  }),
  secondFactorVerify: defineRoute({
    method: "POST",
    path: "/api/auth/second-factor/verify",
    auth: "public",
    roles: [],
    summary: "Check a code (or a recovery code) and finish signing in",
    body: z.discriminatedUnion("method", [
      z.strictObject({ method: z.enum(SECOND_FACTOR_METHODS), code: Code }),
      z.strictObject({ method: z.literal("recovery"), code: RecoveryCodeInput }),
    ]),
    response: SecondFactorVerified,
  }),
  opsUserSecondFactorReset: defineRoute({
    method: "POST",
    path: "/api/ops/users/:id/second-factor/reset",
    auth: "session",
    roles: ["operator"],
    summary:
      "Remove a person's sign-in methods and recovery codes (a lost phone); they set up again",
    params: IdParams,
    body: z.strictObject({ reason: z.string().trim().min(1).max(500) }),
    response: z.object({ reset: z.literal(true), methodsRemoved: z.number().int().min(0) }),
  }),
  opsClaudeConnection: defineRoute({
    method: "GET",
    path: "/api/ops/claude-connections/:code",
    auth: "session",
    roles: ["operator"],
    summary: "A Claude connection to the back office waiting for approval",
    params: ConnectionCode,
    response: ClaudeConnection,
  }),
  opsClaudeConnectionApprove: defineRoute({
    method: "POST",
    path: "/api/ops/claude-connections/:code/approve",
    auth: "session",
    roles: ["operator"],
    summary: "Approve your Claude connection to the back office until its sign-in ends",
    params: ConnectionCode,
    response: ClaudeConnection,
  }),
} as const;
