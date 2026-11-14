import { z } from "zod";
import { E164 } from "../messaging/rules";
import { defineRoute } from "./contract";

// A second factor by authenticator app, text or WhatsApp (docs/plan.md §1.99). After WorkOS checks
// the password, a session is `pending` until the person passes this step; a pending session reaches
// only these routes (every other session route answers 401 `second_factor_required`). The routes
// are `public` in the contract because the API answers them outside `mount()`: they act for the
// person, never in a client, and a pending session must reach them.

/** The kinds of method (`user_factor.kind`). */
export const SecondFactorKind = z.enum(["totp", "sms", "whatsapp"]);
export type SecondFactorKind = z.infer<typeof SecondFactorKind>;

/** Where a session is with the step. */
export const SecondFactorState = z.enum(["pending", "done", "exempt"]);
export type SecondFactorState = z.infer<typeof SecondFactorState>;

/** Operators reach every client, so they use an authenticator app only. */
export const OPERATOR_SECOND_FACTOR_KINDS: readonly SecondFactorKind[] = ["totp"];
export const CLIENT_SECOND_FACTOR_KINDS: readonly SecondFactorKind[] = ["totp", "sms", "whatsapp"];

/** How long a sign-in may wait on the step before it must start again. */
export const SECOND_FACTOR_PENDING_SEC = 10 * 60;
/** "Remember this browser": how long a browser skips the code after one passed (owner, 2026-11-10). */
export const SECOND_FACTOR_REMEMBER_SEC = 30 * 24 * 60 * 60;
/** Recovery codes made at setup: each finishes one sign-in. */
export const RECOVERY_CODE_COUNT = 10;
/** Wrong codes, and codes sent, per person in the window below before the step refuses. */
export const SECOND_FACTOR_MAX_ATTEMPTS = 5;
export const SECOND_FACTOR_WINDOW_SEC = 15 * 60;

/** A code as typed: digits only (spaces and dashes are dropped by the page). */
export const SecondFactorCode = z.string().regex(/^\d{6,8}$/, "the code from your app or message");
/** A recovery code as shown: 8 letters and digits, an optional dash in the middle. */
export const RecoveryCode = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}$/, "a recovery code, e.g. ABCD-2345");

export const SecondFactorMethodView = z.object({
  kind: SecondFactorKind,
  /** A text or WhatsApp number's last digits ("•••• 4567"); null for an authenticator app. */
  phoneHint: z.string().nullable(),
  verified: z.boolean(),
});
export type SecondFactorMethodView = z.infer<typeof SecondFactorMethodView>;

export const SecondFactorStatus = z.object({
  state: SecondFactorState,
  /** Whether this environment runs the step at all (Twilio Verify set up). */
  enabled: z.boolean(),
  /** The methods this person may set up (operators: an authenticator app only). */
  allowed: z.array(SecondFactorKind),
  /** Their methods: a verified one is used to sign in; an unverified one is a setup in progress. */
  methods: z.array(SecondFactorMethodView),
  /** No verified method yet: this sign-in sets one up. */
  setupNeeded: z.boolean(),
  recoveryCodesLeft: z.int(),
});
export type SecondFactorStatus = z.infer<typeof SecondFactorStatus>;

export const SecondFactorSetupBody = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("totp") }),
  z.strictObject({ kind: z.literal("sms"), phone: E164 }),
  z.strictObject({ kind: z.literal("whatsapp"), phone: E164 }),
]);
export type SecondFactorSetupBody = z.infer<typeof SecondFactorSetupBody>;

export const SecondFactorSetupResponse = z.object({
  kind: SecondFactorKind,
  /**
   * For an authenticator app: the `otpauth://` link the page shows once as a QR code (and as a key
   * to type). Never stored by us; null for text and WhatsApp, which were sent a code instead.
   */
  otpauthUri: z.string().nullable(),
  phoneHint: z.string().nullable(),
});

export const SecondFactorSendBody = z.strictObject({ kind: z.enum(["sms", "whatsapp"]) });

export const SecondFactorVerifyBody = z.strictObject({
  kind: SecondFactorKind,
  code: SecondFactorCode,
  /** Skip the code on this browser for 30 days. */
  remember: z.boolean().default(false),
});

export const SecondFactorRecoveryBody = z.strictObject({
  code: RecoveryCode,
  remember: z.boolean().default(false),
});

export const SecondFactorPassed = z.object({
  ok: z.literal(true),
  /** Shown once, after the first method is set up; never again. */
  recoveryCodes: z.array(z.string()).nullable(),
  recoveryCodesLeft: z.int(),
});

export const SecondFactorResetBody = z.strictObject({
  reason: z.string().trim().min(3).max(500),
});

const OPS = ["operator"] as const;

export const secondFactorRoutes = {
  secondFactorStatus: defineRoute({
    method: "GET",
    path: "/api/auth/second-factor",
    auth: "public",
    roles: [],
    summary: "Where this sign-in is with its second step, and the person's methods",
    response: SecondFactorStatus,
  }),
  secondFactorSetup: defineRoute({
    method: "POST",
    path: "/api/auth/second-factor/setup",
    auth: "public",
    roles: [],
    summary:
      "Start setting up the first method: an authenticator app (its QR link, once) or a number to send codes to",
    body: SecondFactorSetupBody,
    response: SecondFactorSetupResponse,
    // DECISION (docs/plan.md §1.99): the person's own authenticator link, shown to them once at
    // setup; Twilio keeps the secret and we never store it.
    secretShownOnce: ["otpauthUri"],
  }),
  secondFactorSend: defineRoute({
    method: "POST",
    path: "/api/auth/second-factor/send",
    auth: "public",
    roles: [],
    summary: "Send a code by text or WhatsApp to the person's number",
    body: SecondFactorSendBody,
    response: z.object({ ok: z.literal(true), phoneHint: z.string() }),
  }),
  secondFactorVerify: defineRoute({
    method: "POST",
    path: "/api/auth/second-factor/verify",
    auth: "public",
    roles: [],
    summary:
      "Check a code: finishes the sign-in (and a setup, with recovery codes shown once); optionally remembers this browser for 30 days",
    body: SecondFactorVerifyBody,
    response: SecondFactorPassed,
  }),
  secondFactorRecovery: defineRoute({
    method: "POST",
    path: "/api/auth/second-factor/recovery",
    auth: "public",
    roles: [],
    summary: "Finish the sign-in with a one-time recovery code",
    body: SecondFactorRecoveryBody,
    response: SecondFactorPassed,
  }),
  opsSecondFactorReset: defineRoute({
    method: "POST",
    path: "/api/ops/users/:id/second-factor/reset",
    auth: "session",
    roles: OPS,
    summary:
      "Reset a person's sign-in methods and recovery codes (lost phone): they set up again at their next sign-in",
    params: z.object({ id: z.uuid() }),
    body: SecondFactorResetBody,
    response: z.object({ ok: z.literal(true), removed: z.int() }),
  }),
} as const;
