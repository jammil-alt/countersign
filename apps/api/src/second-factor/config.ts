// Whether the second step of signing in runs here (docs/plan.md §1.83), and its parts: Twilio
// Verify on Mezonas' own account, and the key for recovery codes and Claude connection codes.

import {
  createVerifyClient,
  globalFetch,
  type VerifyClient,
  VerifyServiceSid,
} from "@countersign/connectors";
import type { Bindings } from "../env";
import type { AppDeps } from "../http";

/** Twilio Verify from the env, or null where any of its settings is missing. */
export function verifyFromEnv(env: Bindings): VerifyClient | null {
  const accountSid = env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = env.TWILIO_AUTH_TOKEN?.trim();
  const serviceSid = env.TWILIO_VERIFY_SERVICE_SID?.trim();
  if (!accountSid || !authToken || !serviceSid) return null;
  if (!VerifyServiceSid.safeParse(serviceSid).success) return null;
  return createVerifyClient({ accountSid, authToken, serviceSid }, globalFetch());
}

export function verifyFor(deps: Pick<AppDeps, "verify">, env: Bindings): VerifyClient | null {
  return deps.verify ? deps.verify(env) : verifyFromEnv(env);
}

// DECISION: the step needs ENCRYPTION_KEY too (the recovery codes' HMAC key comes from it); without
// it, or without Twilio Verify, it is off and WorkOS's own MFA does the asking.
export function secondFactorOn(deps: Pick<AppDeps, "verify">, env: Bindings): boolean {
  return Boolean(env.ENCRYPTION_KEY?.trim()) && verifyFor(deps, env) !== null;
}

export const whatsappOn = (env: Bindings) =>
  env.TWILIO_VERIFY_WHATSAPP?.trim().toLowerCase() === "on";

const keys = new Map<string, Promise<CryptoKey>>();

/**
 * HMAC-SHA256 under a key derived from ENCRYPTION_KEY for one purpose (HKDF, `info`), hex: how
 * recovery codes and Claude connection codes are kept. Never the code itself.
 */
export async function codeHash(
  env: Pick<Bindings, "ENCRYPTION_KEY">,
  purpose: "recovery-code" | "claude-connection",
  code: string,
): Promise<string> {
  const master = env.ENCRYPTION_KEY?.trim();
  if (!master) throw new Error("ENCRYPTION_KEY is not set");
  const id = `${purpose}:${master}`;
  let key = keys.get(id);
  if (!key) {
    key = (async () => {
      const raw = Uint8Array.from(atob(master), (ch) => ch.charCodeAt(0));
      const base = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey"]);
      return crypto.subtle.deriveKey(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: new Uint8Array(32),
          info: new TextEncoder().encode(`mezonas:${purpose}:v1`),
        },
        base,
        { name: "HMAC", hash: "SHA-256", length: 256 },
        false,
        ["sign"],
      );
    })();
    keys.set(id, key);
  }
  const mac = await crypto.subtle.sign("HMAC", await key, new TextEncoder().encode(code));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** `n` random base32 letters and digits (5 bits each). */
export function randomCode(n: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return [...bytes].map((b) => BASE32[b % 32]).join("");
}

/** A recovery code as shown: `abcd-efgh`. */
export const showRecoveryCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

/** `•••• 4242`: a phone's last four digits. */
export const phoneHint = (phone: string) => `•••• ${phone.slice(-4)}`;
