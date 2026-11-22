import { z } from "zod";
import { E164 } from "../messaging/rules";
import { defineRoute } from "./contract";

// A second factor by authenticator app, text or WhatsApp (docs/plan.md §1.100). After WorkOS checks
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

/**
 * Operators: an authenticator app or a text message (owner, 2026-11-19, which loosened "an
 * authenticator app only" of 2026-11-09). No WhatsApp: operators reach every client.
 */
export const OPERATOR_SECOND_FACTOR_KINDS: readonly SecondFactorKind[] = ["totp", "sms"];
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
  /** The methods this person may set up (operators: an authenticator app or a text; WhatsApp only once its sender is set up). */
  allowed: z.array(SecondFactorKind),
  /** Their methods: a verified one is used to sign in; an unverified one is a setup in progress. */
  methods: z.array(SecondFactorMethodView),
  /** No verified method yet: this sign-in sets one up. */
  setupNeeded: z.boolean(),
  recoveryCodesLeft: z.int(),
  /**
   * The first method is set up from a link emailed to the person (owner, 2026-11-19), never on
   * this page: whoever has the password must also have the inbox. False only where Mezonas can't
   * send email (then the first method is set up here, as before).
   */
  setupByEmail: z.boolean(),
  /**
   * How many of the person's phones can approve this sign-in (docs/plan.md §1.154): set up to
   * sign, in a client they belong to. Zero for operators and while the step is off.
   */
  phones: z.int(),
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

// ── The setup link (owner, 2026-11-19) ─────────────────────────────────────────────────────────
// A first sign-in with a password, and no method yet, asks for a link by email; the link opens a
// page with no session where the person sets up a text number and/or an authenticator app, then
// goes back to sign in. So the first method needs the password and the inbox.

/** How long a setup link works. */
export const SETUP_LINK_MIN = 30;

/** The link's token: a signed payload and its signature, base64url, dot-separated. */
export const SetupLinkToken = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{10,400}\.[A-Za-z0-9_-]{43}$/),
});

/** The setup page at `/sign-in/setup/<token>`. */
export const setupLinkPagePath = (token: string) => `/sign-in/setup/${token}`;

export const SetupLinkSent = z.object({
  ok: z.literal(true),
  /** "d•••@acme.com" */
  emailHint: z.string(),
});

export const SetupLinkStatus = z.object({
  emailHint: z.string(),
  /** The methods this person may set up here. */
  allowed: z.array(SecondFactorKind),
  methods: z.array(SecondFactorMethodView),
  expiresAt: z.string(),
});
export type SetupLinkStatus = z.infer<typeof SetupLinkStatus>;

export const SetupLinkVerifyBody = z.strictObject({
  kind: SecondFactorKind,
  code: SecondFactorCode,
});

export const SetupLinkVerified = z.object({
  ok: z.literal(true),
  /** Shown once, with the person's first method; null for a second one. */
  recoveryCodes: z.array(z.string()).nullable(),
});

const OPS = ["operator"] as const;

// The Claude connector's approval link (docs/plan.md §1.100, §1.120). The MCP server (§1.34, §1.89)
// signs people in through AuthKit, never through our cookie, so it has no second step of its own.
// While the step is on, a Claude connection is tied to its AuthKit session and its tool calls are
// refused with a link until the person, signed in past the step in a browser, approves it here.

/** How long an approval link works after Claude was given it. */
export const CLAUDE_LINK_MIN = 30;

/** The approval link's code: 32 random base32 letters and digits (160 bits). */
export const ClaudeConnectionCode = z.object({ code: z.string().regex(/^[a-z2-7]{32}$/) });

/**
 * Audit 5.3: the short code Claude shows beside the link, typed on the approval page, so a
 * connection is approved only by someone looking at that Claude.
 */
export const CLAUDE_CONFIRM_DIGITS = 6;
export const ClaudeConnectionApproveBody = z.strictObject({
  confirm: z
    .string()
    .trim()
    .regex(new RegExp(`^[0-9]{${CLAUDE_CONFIRM_DIGITS}}$`)),
});
export type ClaudeConnectionApproveBody = z.infer<typeof ClaudeConnectionApproveBody>;

export const ClaudeConnection = z.object({
  /** waiting: the link works; approved: Claude may use Mezonas as you; expired: ask Claude again. */
  status: z.enum(["waiting", "approved", "expired"]),
  /** When Claude first asked in this sign-in. */
  startedAt: z.string(),
  /** When Claude asked with this link (the newest refused call); null once approved. */
  requestedAt: z.string().nullable(),
  /** Waiting: when the link stops working. Approved: when the approval ends, at the latest. */
  expiresAt: z.string(),
  /**
   * Who is asking (H6): the Claude client as the newest asking request names itself, in words
   * ("Claude", "Claude Code"); null when it named nothing we read or the link predates it.
   */
  client: z.string().nullable(),
  /** Where the newest asking request came from, as Cloudflare places it: "Ashburn, US". */
  place: z.string().nullable(),
});
export type ClaudeConnection = z.infer<typeof ClaudeConnection>;

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
    // DECISION (docs/plan.md §1.100): the person's own authenticator link, shown to them once at
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
  secondFactorSetupLink: defineRoute({
    method: "POST",
    path: "/api/auth/second-factor/setup-link",
    auth: "public",
    roles: [],
    summary:
      "Email the person signing in a link to set up their first method (text and/or authenticator app)",
    body: z.strictObject({}),
    response: SetupLinkSent,
  }),
  // DECISION (owner, 2026-11-19): the link's page has no session: the link is the proof of the
  // inbox, and it was only sent after the password was checked. It sets up methods only (never
  // signs anyone in) and only for a person with no verified method, or the second kind of a
  // person whose first was set up from this link's page.
  setupLinkStatus: defineRoute({
    method: "GET",
    path: "/api/auth/setup-link/:token",
    auth: "public",
    roles: [],
    summary: "The setup link's page: who it is for, and what may be set up",
    params: SetupLinkToken,
    response: SetupLinkStatus,
  }),
  setupLinkSetup: defineRoute({
    method: "POST",
    path: "/api/auth/setup-link/:token/setup",
    auth: "public",
    roles: [],
    summary: "Start setting up a method from the setup link: an authenticator app or a number",
    params: SetupLinkToken,
    body: SecondFactorSetupBody,
    response: SecondFactorSetupResponse,
    secretShownOnce: ["otpauthUri"],
  }),
  setupLinkVerify: defineRoute({
    method: "POST",
    path: "/api/auth/setup-link/:token/verify",
    auth: "public",
    roles: [],
    summary: "Prove a method set up from the setup link with one code (recovery codes, once)",
    params: SetupLinkToken,
    body: SetupLinkVerifyBody,
    response: SetupLinkVerified,
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
  // DECISION (docs/plan.md §1.120): `public` in the contract, as the step's own routes: the API
  // answers them outside mount() for the signed-in person (operator or client), never in a
  // client. A pending session is refused (401 second_factor_required): only a browser past the
  // step approves. Each finds only the person's own connection (withUser), so another person's
  // link answers 404.
  claudeConnection: defineRoute({
    method: "GET",
    path: "/api/auth/claude-connections/:code",
    auth: "public",
    roles: [],
    summary: "Your Claude connection waiting for approval, from the link Claude gave you",
    params: ClaudeConnectionCode,
    response: ClaudeConnection,
  }),
  claudeConnectionApprove: defineRoute({
    method: "POST",
    path: "/api/auth/claude-connections/:code/approve",
    auth: "public",
    roles: [],
    summary:
      "Approve your Claude connection until its sign-in ends (12 hours at most), with the code Claude showed",
    params: ClaudeConnectionCode,
    body: ClaudeConnectionApproveBody,
    response: ClaudeConnection,
  }),
} as const;
