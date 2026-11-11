// The dev adapter (plan §1.1 "Auth provider"): local work and e2e tests sign in as a seeded user
// by email, with no WorkOS. It must never run in production, so it refuses to be created there
// and refuses every request if it somehow is.

import { compactAccount, cookieFits, expandAccount } from "./account";
import { clearCookie, requestCookie, serializeCookie } from "./cookies";
import { randomToken, seal, unseal } from "./seal";
import { type AuthAdapter, type DevDirectory, refuse } from "./types";

export const DEV_USER_COOKIE = "cs_dev_user";
/** The dev sign-in's carried account (docs/plan.md §1.91): its own sealed cookie, as it has no session cookie. */
export const DEV_ACCOUNT_COOKIE = "cs_dev_account";
export const DEV_USER_HEADER = "x-countersign-dev-user";
const DEV_COOKIE_MAX_AGE_SEC = 30 * 24 * 60 * 60;
// DECISION: the dev sign-in has no cookie password, so its carried account is sealed under a key
// made at random for this isolate. A restart makes old cookies unopenable, which only means one
// read and a fresh cookie. The dev adapter never runs in production. Made on first use: a Worker
// may not make random values at load.
let accountKey: string | undefined;
const ACCOUNT_KEY = () => {
  accountKey ??= randomToken(32);
  return accountKey;
};

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
  /** The cookies that sign this browser in as the seeded user with this email. */
  signIn(email: string): readonly string[];
  /** The cookies that sign this browser out. */
  signOut(): readonly string[];
}

export function createDevAdapter(options: {
  readonly directory: DevDirectory;
  readonly env: RuntimeEnv;
}): DevAdapter {
  const { directory, env } = options;
  if (isProduction(env)) throw new DevAdapterRefusedError();
  const clearAccount = () => clearCookie(DEV_ACCOUNT_COOKIE, { secure: false });

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
          clearAccount(),
        ]);
      }
      const sealed = requestCookie(request, DEV_ACCOUNT_COOKIE);
      // Bound to the user the email names now: another user's carried account is never used.
      const account = sealed
        ? expandAccount(await unseal(sealed, ACCOUNT_KEY(), "account"), user.id)
        : null;
      return {
        ok: true,
        userId: user.id,
        setCookies: [],
        account,
        async carry(next) {
          if (next) {
            const value = await seal(compactAccount(next), ACCOUNT_KEY(), "account");
            const cookie = serializeCookie(DEV_ACCOUNT_COOKIE, value, {
              maxAgeSec: DEV_COOKIE_MAX_AGE_SEC,
              secure: false,
            });
            if (cookieFits(cookie)) return [cookie];
          }
          return sealed ? [clearAccount()] : [];
        },
      };
    },
    // DECISION: the dev sign-in sends no email; an invited user is in its list at once.
    async invite() {
      return { status: "not_sent", reason: "dev_sign_in" } as const;
    },
    signIn(email) {
      // Plain http on localhost, so not Secure. The value is an email, not a credential: this
      // adapter exists only where anyone at the keyboard may be anyone.
      return [
        serializeCookie(DEV_USER_COOKIE, encodeURIComponent(email.trim().toLowerCase()), {
          maxAgeSec: DEV_COOKIE_MAX_AGE_SEC,
          secure: false,
        }),
        // A sign-in starts without a carried account, whoever was signed in before.
        clearAccount(),
      ];
    },
    signOut() {
      return [clearCookie(DEV_USER_COOKIE, { secure: false }), clearAccount()];
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
