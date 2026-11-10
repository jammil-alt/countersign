// Twilio Verify, for the second step of signing in (docs/plan.md §1.83): codes by text and WhatsApp
// (Verifications, VerificationCheck), and authenticator apps (TOTP Factors and Challenges, under one
// Entity per person). Twilio holds every code and authenticator secret; we keep only the kind, the
// phone number and the factor's id. Mezonas' own Twilio account, not a client's. Details not checked
// against Twilio's docs: VERIFY_NOTES.md.

import { z } from "zod";
import type { FetchLike } from "../http";
import { type TwilioAuth, TwilioError, twilioRequest } from "./api";

export const TWILIO_VERIFY_API = "https://verify.twilio.com/v2";

export const VerifyServiceSid = z.string().regex(/^VA[0-9a-f]{32}$/);

export type VerifyChannel = "sms" | "whatsapp";

export interface VerifyConfig extends TwilioAuth {
  serviceSid: string;
}

export interface TotpEnrollment {
  /** Twilio's factor id (`YF…`). */
  factorSid: string;
  /** `otpauth://totp/…`, for the QR code. Shown once, never stored. */
  uri: string;
  /** The base32 secret, for typing into an app by hand. Shown once, never stored. */
  secret: string;
}

/** What the second step needs from Twilio Verify; tests pass `fakeVerify`. */
export interface VerifyClient {
  /** Sends a code to `to` (E.164) by text or WhatsApp, in `locale` (e.g. `en`, `pt-br`). */
  send(to: string, channel: VerifyChannel, locale: string | null): Promise<void>;
  /** Whether `code` is the code last sent to `to`. Any status but `approved` is a no. */
  check(to: string, code: string): Promise<boolean>;
  /** A new, unverified authenticator for the person (`identity`: their app_user id). */
  startTotp(identity: string, label: string): Promise<TotpEnrollment>;
  /** Proves a new authenticator with its first code; true when the factor is now verified. */
  confirmTotp(identity: string, factorSid: string, code: string): Promise<boolean>;
  /** Checks a sign-in code from a verified authenticator. */
  checkTotp(identity: string, factorSid: string, code: string): Promise<boolean>;
  /** Removes an authenticator (a reset, or one replaced before it was proven). */
  deleteTotp(identity: string, factorSid: string): Promise<void>;
}

const Status = z.object({ status: z.string() });
const NewFactor = z.object({
  sid: z.string(),
  binding: z.object({ secret: z.string(), uri: z.string() }),
});

/** Twilio's "not found" for a check: no pending verification (expired, used, too many tries). */
const isGone = (error: unknown) => error instanceof TwilioError && error.status === 404;

export function createVerifyClient(config: VerifyConfig, fetch: FetchLike): VerifyClient {
  const service = `${TWILIO_VERIFY_API}/Services/${encodeURIComponent(config.serviceSid)}`;
  const entity = (identity: string) => `${service}/Entities/${encodeURIComponent(identity)}`;
  const call = (url: string, form?: Record<string, string>, method: "POST" | "DELETE" = "POST") =>
    twilioRequest(fetch, config, method, url, form ? { form } : {});

  return {
    async send(to, channel, locale) {
      await call(`${service}/Verifications`, {
        To: to,
        Channel: channel,
        ...(locale ? { Locale: locale } : {}),
      });
    },
    async check(to, code) {
      try {
        const res = Status.parse(
          await call(`${service}/VerificationCheck`, { To: to, Code: code }),
        );
        return res.status === "approved";
      } catch (error) {
        if (isGone(error)) return false;
        throw error;
      }
    },
    async startTotp(identity, label) {
      const res = NewFactor.parse(
        await call(`${entity(identity)}/Factors`, { FactorType: "totp", FriendlyName: label }),
      );
      return { factorSid: res.sid, uri: res.binding.uri, secret: res.binding.secret };
    },
    async confirmTotp(identity, factorSid, code) {
      try {
        const res = Status.parse(
          await call(`${entity(identity)}/Factors/${encodeURIComponent(factorSid)}`, {
            AuthPayload: code,
          }),
        );
        return res.status === "verified";
      } catch (error) {
        if (isGone(error)) return false;
        throw error;
      }
    },
    async checkTotp(identity, factorSid, code) {
      try {
        const res = Status.parse(
          await call(`${entity(identity)}/Challenges`, { FactorSid: factorSid, AuthPayload: code }),
        );
        return res.status === "approved";
      } catch (error) {
        if (isGone(error)) return false;
        throw error;
      }
    },
    async deleteTotp(identity, factorSid) {
      try {
        await call(
          `${entity(identity)}/Factors/${encodeURIComponent(factorSid)}`,
          undefined,
          "DELETE",
        );
      } catch (error) {
        if (!isGone(error)) throw error;
      }
    },
  };
}

/** Twilio Verify's locales are lowercase (`pt-br`); ours are `pt-BR`. */
export const verifyLocale = (locale: string | null | undefined): string | null =>
  locale ? locale.toLowerCase() : null;
