// Twilio Verify on Mezonas' own account, for people's sign-in codes (docs/plan.md §1.83): text and
// WhatsApp codes (`Verifications`, `VerificationCheck`) and authenticator apps (TOTP `Factors` and
// `Challenges`). Twilio holds every code and authenticator secret; we keep only a factor's SID.
// What is not checked against Twilio's docs is in VERIFY_NOTES.md.

import type { FetchLike } from "../http";
import { type TwilioAuth, TwilioError, twilioRequest } from "./api";

export const TWILIO_VERIFY_API = "https://verify.twilio.com/v2";

export type CodeChannel = "sms" | "whatsapp";

/** What the sign-in step needs from a code service. Tests use `memoryCodeVerifier`. */
export interface CodeVerifier {
  /** Send a code to a number in E.164 form. */
  sendCode(to: string, channel: CodeChannel): Promise<void>;
  /** Whether `code` is the one last sent to `to` (and unexpired). */
  checkCode(to: string, code: string): Promise<boolean>;
  /**
   * A new authenticator app for `identity` (our user id): its SID and the `otpauth://` link to show
   * once as a QR code. Unverified until `verifyTotp` passes.
   */
  createTotp(identity: string, label: string): Promise<{ factorSid: string; uri: string }>;
  /** The first code from a new authenticator app: verifies the factor. */
  verifyTotp(identity: string, factorSid: string, code: string): Promise<boolean>;
  /** A code from a verified authenticator app, at sign-in. */
  checkTotp(identity: string, factorSid: string, code: string): Promise<boolean>;
  /** Remove an authenticator app (a reset). A factor already gone is not an error. */
  deleteTotp(identity: string, factorSid: string): Promise<void>;
}

export interface TwilioVerifyConfig extends TwilioAuth {
  serviceSid: string;
  fetch: FetchLike;
}

const statusOf = (body: unknown): string | null => {
  const s = (body as { status?: unknown } | null)?.status;
  return typeof s === "string" ? s : null;
};

/** A missing verification or factor (expired, already used, deleted) reads as a wrong code. */
const notFound = (error: unknown) => error instanceof TwilioError && error.status === 404;

export function twilioCodeVerifier(config: TwilioVerifyConfig): CodeVerifier {
  const base = `${TWILIO_VERIFY_API}/Services/${encodeURIComponent(config.serviceSid)}`;
  const entity = (identity: string) => `${base}/Entities/${encodeURIComponent(identity)}`;
  const post = (url: string, form: Record<string, string>) =>
    twilioRequest(config.fetch, config, "POST", url, { form });

  return {
    async sendCode(to, channel) {
      await post(`${base}/Verifications`, { To: to, Channel: channel });
    },

    async checkCode(to, code) {
      try {
        return (
          statusOf(await post(`${base}/VerificationCheck`, { To: to, Code: code })) === "approved"
        );
      } catch (error) {
        if (notFound(error)) return false;
        throw error;
      }
    },

    async createTotp(identity, label) {
      const body = (await post(`${entity(identity)}/Factors`, {
        FriendlyName: label,
        FactorType: "totp",
      })) as { sid?: unknown; binding?: { uri?: unknown } } | null;
      const sid = body?.sid;
      const uri = body?.binding?.uri;
      if (typeof sid !== "string" || typeof uri !== "string") {
        throw new TwilioError(null, null, "Twilio answered a new factor without its SID or link");
      }
      return { factorSid: sid, uri };
    },

    async verifyTotp(identity, factorSid, code) {
      try {
        const body = await post(`${entity(identity)}/Factors/${encodeURIComponent(factorSid)}`, {
          AuthPayload: code,
        });
        return statusOf(body) === "verified";
      } catch (error) {
        if (notFound(error)) return false;
        throw error;
      }
    },

    async checkTotp(identity, factorSid, code) {
      try {
        const body = await post(`${entity(identity)}/Challenges`, {
          FactorSid: factorSid,
          AuthPayload: code,
        });
        return statusOf(body) === "approved";
      } catch (error) {
        if (notFound(error)) return false;
        throw error;
      }
    },

    async deleteTotp(identity, factorSid) {
      try {
        await twilioRequest(
          config.fetch,
          config,
          "DELETE",
          `${entity(identity)}/Factors/${encodeURIComponent(factorSid)}`,
        );
      } catch (error) {
        if (!notFound(error)) throw error;
      }
    },
  };
}

/**
 * A code service in memory, for tests and local runs: every code is `123456` unless a test sets
 * another; it records what was sent.
 */
export function memoryCodeVerifier(code = "123456") {
  const sent: { to: string; channel: CodeChannel }[] = [];
  const factors = new Map<string, { identity: string; verified: boolean }>();
  let next = 1;
  const verifier: CodeVerifier & {
    sent: typeof sent;
    factors: typeof factors;
    code: string;
  } = {
    sent,
    factors,
    code,
    async sendCode(to, channel) {
      sent.push({ to, channel });
    },
    async checkCode(to, given) {
      return sent.some((s) => s.to === to) && given === verifier.code;
    },
    async createTotp(identity, label) {
      const factorSid = `YF${String(next++).padStart(32, "0")}`;
      factors.set(factorSid, { identity, verified: false });
      return {
        factorSid,
        uri: `otpauth://totp/${encodeURIComponent(label)}?secret=FAKESECRET&issuer=Mezonas`,
      };
    },
    async verifyTotp(identity, factorSid, given) {
      const f = factors.get(factorSid);
      if (!f || f.identity !== identity || given !== verifier.code) return false;
      f.verified = true;
      return true;
    },
    async checkTotp(identity, factorSid, given) {
      const f = factors.get(factorSid);
      return !!f && f.identity === identity && f.verified && given === verifier.code;
    },
    async deleteTotp(_identity, factorSid) {
      factors.delete(factorSid);
    },
  };
  return verifier;
}
