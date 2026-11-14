// Signing in from the app (docs/plan.md §1.99): the system browser runs the usual WorkOS sign-in,
// started at /api/mobile/sign-in with this phone's PKCE challenge; it ends at mezonas://signed-in
// with a handoff code, which only this phone's verifier trades for the session.
import { MOBILE_SIGNED_IN_URL, routes } from "@countersign/core";
import * as Crypto from "expo-crypto";
import * as WebBrowser from "expo-web-browser";
import type { ApiClient } from "../api/client";
import { handoffCode, handoffError, pkceChallenge, pkceVerifier } from "./pkce";

export type SignInResult =
  | { ok: true; session: string }
  | { ok: false; reason: "cancelled" | "refused" | "failed"; code?: string };

export async function signInWithBrowser(api: ApiClient, origin: string): Promise<SignInResult> {
  const verifier = pkceVerifier((n) => Crypto.getRandomBytes(n));
  const url = `${origin.replace(/\/+$/, "")}/api/mobile/sign-in?challenge=${pkceChallenge(verifier)}`;
  const result = await WebBrowser.openAuthSessionAsync(url, MOBILE_SIGNED_IN_URL, {
    preferEphemeralSession: false,
  });
  if (result.type !== "success") return { ok: false, reason: "cancelled" };
  const code = handoffCode(result.url);
  if (!code) {
    const error = handoffError(result.url);
    return { ok: false, reason: "refused", ...(error ? { code: error } : {}) };
  }
  try {
    const out = await api.call(routes.mobileSession, { body: { code, verifier }, byPerson: true });
    return { ok: true, session: out.session };
  } catch {
    return { ok: false, reason: "failed" };
  }
}
