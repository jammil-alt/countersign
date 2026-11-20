// The emailed setup link (owner, 2026-11-19; docs/plan.md §1.100): a first sign-in with a password
// and no method yet asks for a link by email, and the first method is set up from that link's page,
// so whoever set it up had the password and the inbox. The token is signed like the welcome link
// (../onboarding/link.ts) under its own label (`mezonas-second-factor-link`), so no other link
// opens it and it opens nothing else. It carries the person, their sign-in address and the expiry;
// a change of address makes it useless.

import { SETUP_LINK_MIN } from "@countersign/core";
import { z } from "zod";
import type { Bindings } from "../env";

const encoder = new TextEncoder();

/** What a setup link carries: the person, their sign-in address (lower case), the expiry (ms). */
const Payload = z.strictObject({ u: z.uuid(), m: z.string().min(3).max(320), e: z.int() });
export type SetupLinkPayload = z.infer<typeof Payload>;

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(text: string): Uint8Array {
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

/** Null without ENCRYPTION_KEY: then no link can be made or opened. */
async function linkKey(env: Pick<Bindings, "ENCRYPTION_KEY">): Promise<CryptoKey | null> {
  const secret = env.ENCRYPTION_KEY?.trim();
  if (!secret) return null;
  const raw = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`mezonas-second-factor-link:${secret}`),
  );
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

/** A setup link's token for this person, good for SETUP_LINK_MIN minutes. */
export async function signSetupLink(
  env: Pick<Bindings, "ENCRYPTION_KEY">,
  input: { userId: string; email: string; now: Date },
): Promise<string> {
  const key = await linkKey(env);
  if (!key) throw new Error("setup links need ENCRYPTION_KEY");
  const payload: SetupLinkPayload = {
    u: input.userId,
    m: input.email.toLowerCase(),
    e: input.now.getTime() + SETUP_LINK_MIN * 60_000,
  };
  const body = encoder.encode(JSON.stringify({ u: payload.u, m: payload.m, e: payload.e }));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
  return `${b64url(body)}.${b64url(sig)}`;
}

/** The link's payload while it works; null when forged, malformed or expired. */
export async function openSetupLink(
  env: Pick<Bindings, "ENCRYPTION_KEY">,
  token: string,
  now: Date,
): Promise<SetupLinkPayload | null> {
  const key = await linkKey(env);
  const [body, sig] = token.split(".");
  if (!key || !body || !sig) return null;
  try {
    const bodyBytes = unb64url(body);
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      unb64url(sig) as Uint8Array<ArrayBuffer>,
      bodyBytes as Uint8Array<ArrayBuffer>,
    );
    if (!ok) return null;
    const parsed = Payload.safeParse(JSON.parse(new TextDecoder().decode(bodyBytes)));
    if (!parsed.success || parsed.data.e <= now.getTime()) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

/** "d•••@acme.com" */
export function emailHint(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 1)}•••@${domain}`;
}
