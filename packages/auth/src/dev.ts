// The dev adapter (plan §1.1 "Auth provider"): local work and e2e tests sign in as a seeded user
// by email, with no WorkOS. It must never run in production, so it refuses to be created there
// and refuses every request if it somehow is.

import { clearCookie, requestCookie, serializeCookie } from "./cookies";
import { type AuthAdapter, type DevDirectory, refuse } from "./types";

export const DEV_USER_COOKIE = "cs_dev_user";
export const DEV_USER_HEADER = "x-countersign-dev-user";
const DEV_COOKIE_MAX_AGE_SEC = 30 * 24 * 60 * 60;

export interface RuntimeEnv {
  readonly NODE_ENV?: string | undefined;
  readonly ENVIRONMENT?: string | undefined;
}

// DECISION: a Worker has no NODE_ENV of its own, so `ENVIRONMENT` (a wrangler var:
// development | staging | production) is the flag; either one saying production is enough.
export function isProduction(env: RuntimeEnv): boolean {
  const said = (v: string | undefined) => v?.trim().toLowerCase() === "production";
  return said(env.NODE_ENV) || said(env.ENVIRONMENT);
}

export class DevAdapterRefusedError extends Error {
  override name = "DevAdapterRefusedError";
  constructor() {
    super("the dev auth adapter cannot be used in production");
  }
}

export interface DevAdapter extends AuthAdapter {
  readonly kind: "dev";
  /** The cookie that signs this browser in as the seeded user with this email. */
  signIn(email: string): string;
  signOut(): string;
}

export function createDevAdapter(options: {
  readonly directory: DevDirectory;
  readonly env: RuntimeEnv;
}): DevAdapter {
  const { directory, env } = options;
  if (isProduction(env)) throw new DevAdapterRefusedError();

  return {
    kind: "dev",
    async identify(request) {
      if (isProduction(env)) {
        return refuse("adapter_disabled", "the dev auth adapter cannot be used in production");
      }
      const raw = request.headers.get(DEV_USER_HEADER) ?? requestCookie(request, DEV_USER_COOKIE);
      const email = raw ? safeDecode(raw).trim().toLowerCase() : "";
      if (!email) return refuse("unauthenticated", "not signed in");
      const user = await directory.userByEmail(email);
      if (!user) {
        return refuse("session_invalid", `no seeded user ${email}`, [
          clearCookie(DEV_USER_COOKIE, { secure: false }),
        ]);
      }
      return { ok: true, userId: user.id, setCookies: [] };
    },
    signIn(email) {
      // Plain http on localhost, so not Secure. The value is an email, not a credential: this
      // adapter exists only where anyone at the keyboard may be anyone.
      return serializeCookie(DEV_USER_COOKIE, encodeURIComponent(email.trim().toLowerCase()), {
        maxAgeSec: DEV_COOKIE_MAX_AGE_SEC,
        secure: false,
      });
    },
    signOut() {
      return clearCookie(DEV_USER_COOKIE, { secure: false });
    },
  };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}
