// Whether WorkOS sign-in is on, and with what. Three states, because "configured" is not a
// boolean (ported from Plenary Labs' apps/api/src/identity/config.ts):
//   - off: WORKOS_CLIENT_ID is empty.
//   - misconfigured: the client id is set but a secret is missing or the cookie password is too
//     short to be a key. No session is ever accepted; it never degrades into "off".
//   - on: everything needed to sign somebody in.

import { MIN_COOKIE_PASSWORD_LENGTH } from "../seal";

export interface WorkOSConfig {
  readonly clientId: string;
  readonly apiKey: string;
  readonly cookiePassword: string;
  /** `https://<domain>` (or `http://localhost:8787`): where the callback lives. */
  readonly appOrigin: string;
  /** Path of the callback route on `appOrigin`. */
  readonly callbackPath: string;
}

export type WorkOSState =
  | { readonly state: "off" }
  | { readonly state: "misconfigured"; readonly problems: readonly string[] }
  | { readonly state: "on"; readonly config: WorkOSConfig };

export interface WorkOSEnv {
  readonly WORKOS_CLIENT_ID?: string | undefined;
  readonly WORKOS_API_KEY?: string | undefined;
  readonly WORKOS_COOKIE_PASSWORD?: string | undefined;
  readonly APP_ORIGIN?: string | undefined;
}

// DECISION: the callback is `/api/auth/callback` on APP_ORIGIN (a var next to the WORKOS_* ones
// in ARCHITECTURE §17), registered as the redirect URI in each WorkOS environment.
export const DEFAULT_CALLBACK_PATH = "/api/auth/callback";

/** An http(s) origin and nothing more, or null. */
export function originOf(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function workosStateOf(env: WorkOSEnv): WorkOSState {
  const read = (v: string | undefined) => (typeof v === "string" ? v.trim() : "");
  const clientId = read(env.WORKOS_CLIENT_ID);
  if (!clientId) return { state: "off" };

  const problems: string[] = [];
  const apiKey = read(env.WORKOS_API_KEY);
  if (!apiKey) problems.push("WORKOS_API_KEY is not set");
  const cookiePassword = read(env.WORKOS_COOKIE_PASSWORD);
  if (cookiePassword.length < MIN_COOKIE_PASSWORD_LENGTH) {
    problems.push(
      `WORKOS_COOKIE_PASSWORD must be at least ${MIN_COOKIE_PASSWORD_LENGTH} characters`,
    );
  }
  const appOrigin = originOf(read(env.APP_ORIGIN));
  if (!appOrigin) problems.push("APP_ORIGIN is not an http(s) origin");
  if (problems.length > 0 || !appOrigin) return { state: "misconfigured", problems };

  return {
    state: "on",
    config: { clientId, apiKey, cookiePassword, appOrigin, callbackPath: DEFAULT_CALLBACK_PATH },
  };
}
