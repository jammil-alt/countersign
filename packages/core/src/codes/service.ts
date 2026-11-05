import { z } from "zod";

// The code service's RPC (ARCHITECTURE §6.9, docs/plan.md §1.26 "The code service (phase 2)").
// `apps/mfa` (Worker `mezonas-codes`) implements it as a WorkerEntrypoint; `apps/api` reaches it
// only through its `CODES` service binding and types that binding with `CodesService` below. Every
// call names the client (`tenantId`) and is refused for an identity of another client. Codes and
// authenticator secrets cross this boundary in one direction only: a secret goes in
// (`setAuthenticator`) and is never returned; a code comes out once, from `claim`.

/** A client id (uuid), as everywhere in the platform. */
const TenantId = z.uuid();

// DECISION: an identity id is 12 lowercase base32 characters (60 random bits). It is also the
// identity's Durable Object name and the local part of its address (`agent-<id>@<domain>`), so
// inbound mail finds its identity without a lookup table. It is not a secret.
export const CodesIdentityId = z.string().regex(/^[a-z2-7]{12}$/, "a code service identity id");

/** The site a code is for: a browser site's slug (phase 3) or another stable key. */
export const CodesSiteKey = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/, "lowercase letters, digits, dots and dashes");

export const CODES_LABEL_MAX = 120;
export const CODES_TTL_MAX_SECONDS = 300;
export const CODES_TTL_MIN_SECONDS = 30;
export const CODES_PATTERN_MAX = 200;
/** The longest code a pattern may yield. */
export const CODES_CODE_MAX = 32;
/** Messages are deleted when claimed or this long after they arrive. */
export const CODES_MESSAGE_TTL_SECONDS = 600;
/** Default daily cap on code requests per identity (`MFA_DAILY_CAP` overrides it). */
export const CODES_DAILY_CAP_DEFAULT = 20;

export const CodesChannel = z.enum(["sms", "email", "totp"]);
export type CodesChannel = z.infer<typeof CodesChannel>;

/** A regular expression source; the first capture group (or the whole match) is the code. */
export const CodesPattern = z
  .string()
  .min(1)
  .max(CODES_PATTERN_MAX)
  .refine((p) => {
    try {
      new RegExp(p);
      return true;
    } catch {
      return false;
    }
  }, "not a valid regular expression");

/**
 * Who sends the code: for `sms`, the sender's number or short code as Twilio reports it
 * (`+15551234567`, `22395`); for `email`, an address (`no-reply@site.com`) or a whole domain
 * (`@site.com`).
 */
export const CodesSender = z.string().trim().min(1).max(254);

const Owned = { tenantId: TenantId, identityId: CodesIdentityId };

export const CreateIdentityInput = z.strictObject({
  tenantId: TenantId,
  label: z.string().trim().min(1).max(CODES_LABEL_MAX),
});
export const IdentityInput = z.strictObject(Owned);
export const DeleteIdentityInput = z.strictObject(Owned);
export const AddPhoneInput = z.strictObject({
  ...Owned,
  /** A US area code to search in; any number when absent. */
  areaCode: z
    .string()
    .regex(/^[2-9]\d{2}$/, "a three-digit area code")
    .optional(),
});
export const SetAuthenticatorInput = z.strictObject({
  ...Owned,
  siteKey: CodesSiteKey,
  /** `otpauth://totp/...?secret=...`, as the site shows it in its QR code. */
  otpauthUri: z.string().trim().min(1).max(2048),
});

const WaitBase = {
  ...Owned,
  siteKey: CodesSiteKey,
  ttlSeconds: z
    .number()
    .int()
    .min(CODES_TTL_MIN_SECONDS)
    .max(CODES_TTL_MAX_SECONDS)
    .default(CODES_TTL_MAX_SECONDS),
};
export const OpenWaitInput = z.discriminatedUnion("channel", [
  z.strictObject({
    ...WaitBase,
    channel: z.literal("sms"),
    sender: CodesSender,
    pattern: CodesPattern,
  }),
  z.strictObject({
    ...WaitBase,
    channel: z.literal("email"),
    sender: CodesSender,
    pattern: CodesPattern,
  }),
  // An authenticator code is computed from the stored secret: no sender, no pattern.
  z.strictObject({ ...WaitBase, channel: z.literal("totp") }),
]);
export const ClaimInput = z.strictObject({ ...Owned, waitId: z.uuid() });
export const AlertsInput = z.strictObject({
  tenantId: TenantId,
  /** Alerts created at or after this time. */
  since: z.iso.datetime({ offset: true }),
  limit: z.number().int().min(1).max(500).default(100),
});

export const TotpAlgorithm = z.enum(["SHA1", "SHA256", "SHA512"]);
export const AuthenticatorView = z.object({
  siteKey: CodesSiteKey,
  algorithm: TotpAlgorithm,
  digits: z.number().int(),
  period: z.number().int(),
  updatedAt: z.iso.datetime({ offset: true }),
});

/** What anyone may know about an identity: never a secret or a code. */
export const IdentityView = z.object({
  id: CodesIdentityId,
  tenantId: TenantId,
  label: z.string(),
  email: z.string(),
  phone: z.string().nullable(),
  authenticators: z.array(AuthenticatorView),
  createdAt: z.iso.datetime({ offset: true }),
});

export const OpenWaitResult = z.object({
  waitId: z.uuid(),
  expiresAt: z.iso.datetime({ offset: true }),
});

export const ClaimResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("code"), code: z.string().min(1).max(CODES_CODE_MAX) }),
  z.object({ status: z.literal("pending"), expiresAt: z.iso.datetime({ offset: true }) }),
  z.object({ status: z.literal("expired") }),
]);

/**
 * `unsolicited_code`: a code-like message with no open wait (someone else may be signing in);
 * `reset_attempt`: a password-reset-looking message; `unexpected_message`: anything else that
 * arrived with no wait for it.
 */
export const CodeAlertKind = z.enum(["unsolicited_code", "reset_attempt", "unexpected_message"]);
export type CodeAlertKind = z.infer<typeof CodeAlertKind>;

/** Metadata only: never the message's text or a code. */
export const CodeAlert = z.object({
  id: z.uuid(),
  tenantId: TenantId,
  identityId: CodesIdentityId,
  identityLabel: z.string(),
  kind: CodeAlertKind,
  channel: z.enum(["sms", "email"]),
  /** The sender's number, or the email's From address. */
  sender: z.string().nullable(),
  receivedAt: z.iso.datetime({ offset: true }),
  createdAt: z.iso.datetime({ offset: true }),
});
export const AlertsResult = z.object({ alerts: z.array(CodeAlert) });

export const DeleteIdentityResult = z.object({
  deleted: z.literal(true),
  /** Whether a phone number was released back to Twilio. */
  phoneReleased: z.boolean(),
});

export const CodesErrorCode = z.enum([
  /** The input failed validation. */
  "invalid",
  /** No such identity for this client (also: it belongs to another client). */
  "not_found",
  /** The identity reached its daily cap on code requests. */
  "daily_cap",
  /** The change conflicts with what is there (e.g. a phone number already set). */
  "conflict",
  /** A setting the call needs is missing (e.g. the codes Twilio subaccount). */
  "not_configured",
  /** An upstream service (Twilio) failed. */
  "unavailable",
]);
export type CodesErrorCode = z.infer<typeof CodesErrorCode>;
export const CodesFailure = z.object({
  ok: z.literal(false),
  error: z.object({ code: CodesErrorCode, message: z.string() }),
});

// DECISION: RPC methods answer `{ok: true, value} | {ok: false, error: {code, message}}` rather than
// throwing: Workers RPC keeps only an Error's message across the binding, and callers branch on the
// code (`daily_cap`, `not_found`).
export type CodesResponse<T> = { ok: true; value: T } | z.infer<typeof CodesFailure>;

export function codesResponse<T extends z.ZodType>(value: T) {
  return z.union([z.object({ ok: z.literal(true), value }), CodesFailure]);
}

export type CreateIdentityInput = z.input<typeof CreateIdentityInput>;
export type IdentityInput = z.input<typeof IdentityInput>;
export type DeleteIdentityInput = z.input<typeof DeleteIdentityInput>;
export type AddPhoneInput = z.input<typeof AddPhoneInput>;
export type SetAuthenticatorInput = z.input<typeof SetAuthenticatorInput>;
export type OpenWaitInput = z.input<typeof OpenWaitInput>;
export type ClaimInput = z.input<typeof ClaimInput>;
export type AlertsInput = z.input<typeof AlertsInput>;
export type AuthenticatorView = z.infer<typeof AuthenticatorView>;
export type IdentityView = z.infer<typeof IdentityView>;
export type OpenWaitResult = z.infer<typeof OpenWaitResult>;
export type ClaimResult = z.infer<typeof ClaimResult>;
export type CodeAlert = z.infer<typeof CodeAlert>;
export type AlertsResult = z.infer<typeof AlertsResult>;
export type DeleteIdentityResult = z.infer<typeof DeleteIdentityResult>;

/** The code service as `apps/api` sees it through the `CODES` service binding. */
export interface CodesService {
  createIdentity(input: CreateIdentityInput): Promise<CodesResponse<IdentityView>>;
  identity(input: IdentityInput): Promise<CodesResponse<IdentityView>>;
  addPhone(input: AddPhoneInput): Promise<CodesResponse<IdentityView>>;
  setAuthenticator(input: SetAuthenticatorInput): Promise<CodesResponse<AuthenticatorView>>;
  openWait(input: OpenWaitInput): Promise<CodesResponse<OpenWaitResult>>;
  claim(input: ClaimInput): Promise<CodesResponse<ClaimResult>>;
  alerts(input: AlertsInput): Promise<CodesResponse<AlertsResult>>;
  deleteIdentity(input: DeleteIdentityInput): Promise<CodesResponse<DeleteIdentityResult>>;
}

/** Response schemas per method, for callers that check what came back (invariant 5). */
export const CodesResponses = {
  createIdentity: codesResponse(IdentityView),
  identity: codesResponse(IdentityView),
  addPhone: codesResponse(IdentityView),
  setAuthenticator: codesResponse(AuthenticatorView),
  openWait: codesResponse(OpenWaitResult),
  claim: codesResponse(ClaimResult),
  alerts: codesResponse(AlertsResult),
  deleteIdentity: codesResponse(DeleteIdentityResult),
} satisfies Record<keyof CodesService, z.ZodType>;

/** Input schemas per method; the code service parses every call with these. */
export const CodesInputs = {
  createIdentity: CreateIdentityInput,
  identity: IdentityInput,
  addPhone: AddPhoneInput,
  setAuthenticator: SetAuthenticatorInput,
  openWait: OpenWaitInput,
  claim: ClaimInput,
  alerts: AlertsInput,
  deleteIdentity: DeleteIdentityInput,
} satisfies Record<keyof CodesService, z.ZodType>;
