// The welcome link (docs/cases-plan.md §4.4; docs/plan.md §1.125): `app.mezonas.com/start/<token>`,
// a signed link over the client, the intake, the person and the expiry (core `WelcomeLinkToken`),
// seen without sign-in. Signed like the form link (../forms/link.ts) under its own label
// (`mezonas-welcome-link`), so no other link opens it and it opens nothing else. Never a way in on
// its own: after sign-in the address must be the invited one.

import { WELCOME_LINK_TTL_DAYS, WelcomeLinkToken, welcomePagePath } from "@countersign/core";
import type { Bindings } from "../env";
import { HttpError } from "../http";
import { isProductionEnv } from "../platform";

export type WelcomeLinkEnv = Pick<Bindings, "ENCRYPTION_KEY" | "ENVIRONMENT">;

const encoder = new TextEncoder();
let devKey: Uint8Array | undefined;

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(text: string): Uint8Array {
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

/** Whether this Worker can sign welcome links (production needs ENCRYPTION_KEY). */
export function welcomeLinksAvailable(env: WelcomeLinkEnv): boolean {
  return !!env.ENCRYPTION_KEY?.trim() || !isProductionEnv(env);
}

// DECISION: a key derived from ENCRYPTION_KEY under the label `mezonas-welcome-link` (the form
// link's is `mezonas-form-link`, so neither opens the other); in development without the key, a
// random key per isolate; production without it makes no links (and no invite email is sent).
async function linkKey(env: WelcomeLinkEnv) {
  let raw: Uint8Array;
  if (env.ENCRYPTION_KEY?.trim()) {
    raw = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        encoder.encode(`mezonas-welcome-link:${env.ENCRYPTION_KEY.trim()}`),
      ),
    );
  } else if (!isProductionEnv(env)) {
    devKey ??= crypto.getRandomValues(new Uint8Array(32));
    raw = devKey;
  } else {
    throw new HttpError(409, "not_available", "welcome links need ENCRYPTION_KEY");
  }
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

/** The token for a person's welcome page (`welcomePagePath(token)` in core). */
export async function signWelcomeLink(
  env: WelcomeLinkEnv,
  payload: WelcomeLinkToken,
): Promise<string> {
  const checked = WelcomeLinkToken.parse(payload);
  // Always the same field order, so the same person and expiry make the same link (a retried
  // send renders the same email under the same idempotency key).
  const body = encoder.encode(
    JSON.stringify({ t: checked.t, i: checked.i, p: checked.p, e: checked.e }),
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await linkKey(env), body));
  return `${b64url(body)}.${b64url(sig)}`;
}

/**
 * The link's payload, or null when forged or malformed. An expired link still reads (the page
 * offers "Ask <lead> for a new one"); `expired` says so.
 */
export async function verifyWelcomeLink(
  env: WelcomeLinkEnv,
  token: string,
  now: number = Date.now(),
): Promise<{ payload: WelcomeLinkToken; expired: boolean } | null> {
  const [bodyText, sigText, extra] = token.split(".");
  if (!bodyText || !sigText || extra !== undefined || token.length > 2000) return null;
  try {
    const body = unb64url(bodyText);
    const ok = await crypto.subtle.verify("HMAC", await linkKey(env), unb64url(sigText), body);
    if (!ok) return null;
    const parsed = WelcomeLinkToken.safeParse(JSON.parse(new TextDecoder().decode(body)));
    if (!parsed.success) return null;
    return { payload: parsed.data, expired: parsed.data.e * 1000 <= now };
  } catch (error) {
    // Production without its key is a setup problem, not a bad link.
    if (error instanceof HttpError) throw error;
    return null;
  }
}

/** When a link sent at `sentAt` stops working. */
export function welcomeLinkExpiry(sentAt: Date): Date {
  return new Date(sentAt.getTime() + WELCOME_LINK_TTL_DAYS * 24 * 60 * 60 * 1000);
}

/** The full address of a person's welcome page. */
export async function welcomeLinkUrl(
  links: { origin: string; env: WelcomeLinkEnv },
  ref: { tenantId: string; intakeId: string; personId: string; expiresAt: Date },
): Promise<string> {
  const token = await signWelcomeLink(links.env, {
    t: ref.tenantId,
    i: ref.intakeId,
    p: ref.personId,
    e: Math.floor(ref.expiresAt.getTime() / 1000),
  });
  return `${links.origin}${welcomePagePath(token)}`;
}
