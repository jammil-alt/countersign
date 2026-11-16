// Forms (docs/plan.md §1.115): the signed link a contact opens a form with. It carries the client,
// the request and an expiry, nothing else; the request's own row says whether it still takes
// answers. Signed like the texting sign-up link, under its own label, so no other link opens it.

import { FormLinkToken, formPagePath } from "@countersign/core";
import type { Bindings } from "../env";
import { HttpError } from "../http";
import { isProductionEnv } from "../platform";

export type FormLinkEnv = Pick<Bindings, "ENCRYPTION_KEY" | "ENVIRONMENT">;

/** Where links point and what signs them: the app's origin and the Worker's key. */
export interface FormLinks {
  origin: string;
  env: FormLinkEnv;
}

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

// DECISION: a key derived from ENCRYPTION_KEY under the label `mezonas-form-link`; in development
// without the key, a random key per isolate; production without it makes no links (and no form
// request is sent).
async function linkKey(env: FormLinkEnv) {
  let raw: Uint8Array;
  if (env.ENCRYPTION_KEY?.trim()) {
    raw = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        encoder.encode(`mezonas-form-link:${env.ENCRYPTION_KEY.trim()}`),
      ),
    );
  } else if (!isProductionEnv(env)) {
    devKey ??= crypto.getRandomValues(new Uint8Array(32));
    raw = devKey;
  } else {
    throw new HttpError(409, "not_available", "form links need ENCRYPTION_KEY");
  }
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export async function signFormLink(env: FormLinkEnv, payload: FormLinkToken): Promise<string> {
  const body = encoder.encode(JSON.stringify(payload));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await linkKey(env), body));
  return `${b64url(body)}.${b64url(sig)}`;
}

/** The link's payload, or null: forged, malformed or past its expiry. */
export async function verifyFormLink(
  env: FormLinkEnv,
  token: string,
  now: number = Date.now(),
): Promise<FormLinkToken | null> {
  const [bodyText, sigText, extra] = token.split(".");
  if (!bodyText || !sigText || extra !== undefined || token.length > 2000) return null;
  try {
    const body = unb64url(bodyText);
    const ok = await crypto.subtle.verify("HMAC", await linkKey(env), unb64url(sigText), body);
    if (!ok) return null;
    const parsed = FormLinkToken.safeParse(JSON.parse(new TextDecoder().decode(body)));
    if (!parsed.success) return null;
    if (parsed.data.e * 1000 < now) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

/** The full address of a request's page. */
export async function formLinkUrl(
  links: FormLinks,
  ref: { tenantId: string; formRequestId: string; expiresAt: Date },
): Promise<string> {
  const token = await signFormLink(links.env, {
    t: ref.tenantId,
    r: ref.formRequestId,
    e: Math.floor(ref.expiresAt.getTime() / 1000),
  });
  return `${links.origin}${formPagePath(token)}`;
}
