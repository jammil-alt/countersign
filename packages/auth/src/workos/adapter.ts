// The WorkOS adapter: identify a request from the sealed session cookie (refreshing it when due),
// start sign-in, finish it on the callback, and sign out. Provisioning (find or create the
// app_user, refuse the uninvited) is the directory's job, done by the API with packages/db.

import { SESSION_ACTIVITY_HEADER } from "@countersign/core";
import { compactAccount, cookieFits, expandAccount } from "../account";
import { requestCookie } from "../cookies";
import { randomToken, timingSafeEqual } from "../seal";
import {
  type AuthAdapter,
  type AuthRefusal,
  type ProvisioningDirectory,
  type ProvisionRefusalReason,
  refuse,
} from "../types";
import { createWorkOS, type WorkOSAuthentication, type WorkOSClient, WorkOSError } from "./client";
import type { WorkOSConfig } from "./config";
import {
  clearSessionCookie,
  clearStateCookie,
  epochSec,
  isRestartState,
  newSession,
  openSession,
  openState,
  resolveSession,
  restartNonce,
  SESSION_COOKIE,
  STATE_COOKIE,
  STATE_MAX_AGE_SEC,
  safeReturnTo,
  sealSession,
  sealState,
  sessionCookie,
  stateCookie,
} from "./session";

export interface Redirect {
  readonly ok: true;
  readonly redirectTo: string;
  readonly setCookies: readonly string[];
  /** A completed sign-in: who, and how (for the audit log, docs/plan.md §1.35). */
  readonly signedIn?: { readonly userId: string; readonly method: string | null };
}

/** Why a callback did not finish: the audit row's `target.reason` (plan §1.35). */
export type CallbackFailureReason =
  /** No `code` or no `state` on the URL: WorkOS sent an error, or the URL was opened by hand. */
  | "callback_incomplete"
  /** No state cookie, or one that does not open (cleared by a finished sign-in, or never set). */
  | "state_missing"
  /** The state is older than STATE_MAX_AGE_SEC. */
  | "state_expired"
  /** The state cookie belongs to another sign-in (another tab started one since). */
  | "state_mismatch"
  /** WorkOS refused the code: already used (Back, reload, a restored tab) or expired. */
  | "code_rejected"
  /** WorkOS could not be reached, or answered 5xx. */
  | "workos_unavailable";

export interface CallbackFailure {
  readonly reason: CallbackFailureReason;
  /** Where the sign-in meant to land, when the state cookie opened. */
  readonly returnTo: string | null;
  /** Sign-in may start again by itself: this callback is not from a restarted sign-in. */
  readonly restart: boolean;
}

/** A refused callback. Every refusal of the state or the code says why in `failure`. */
export type CallbackRefusal = AuthRefusal & { readonly failure?: CallbackFailure };

export interface WorkOSAdapter extends AuthAdapter {
  readonly kind: "workos";
  /**
   * Where to send the browser to sign in, with the state cookie that proves it came from us.
   * `restart`: the callback started this sign-in again after a failure, so it won't again.
   */
  signIn(
    input: { returnTo?: string | null; restart?: boolean },
    now: Date,
  ): Promise<Redirect | AuthRefusal>;
  /** Finish sign-in on the callback request (`?code=&state=`). */
  callback(request: Request, now: Date): Promise<Redirect | CallbackRefusal>;
  signOut(request: Request): Promise<Redirect>;
}

const PROVISION_MESSAGES: Record<ProvisionRefusalReason, string> = {
  email_not_verified: "verify your email address with the sign-in provider, then sign in again",
  not_invited: "this account has not been invited; ask your operator for an invitation",
  email_taken: "this email address belongs to a different sign-in",
};

function displayName(auth: WorkOSAuthentication): string | null {
  const name = [auth.user.firstName, auth.user.lastName].filter(Boolean).join(" ").trim();
  return name || null;
}

export function createWorkOSAdapter(options: {
  readonly config: WorkOSConfig;
  readonly directory: ProvisioningDirectory;
  /** Injected in tests; otherwise built over `fetch`. */
  readonly workos?: WorkOSClient;
  readonly fetch?: typeof fetch;
}): WorkOSAdapter {
  const { config, directory } = options;
  const workos =
    options.workos ??
    createWorkOS({
      clientId: config.clientId,
      apiKey: config.apiKey,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  const password = config.cookiePassword;
  const redirectUri = `${config.appOrigin}${config.callbackPath}`;

  return {
    kind: "workos",

    async identify(request, nowDate) {
      const raw = requestCookie(request, SESSION_COOKIE);
      if (!raw) return refuse("unauthenticated", "not signed in");
      const opened = await openSession(raw, password);
      if (!opened) {
        return refuse("session_invalid", "the session cookie is not valid", [clearSessionCookie()]);
      }
      const now = epochSec(nowDate);
      const active = request.headers.get(SESSION_ACTIVITY_HEADER) === "1";
      const resolved = await resolveSession(opened, now, workos, active);
      if (resolved.status === "invalid") {
        // End WorkOS's own session too, or the next sign-in would pass without a password: an
        // idle or expired session must be signed in to again (docs/plan.md §1.35).
        if (opened.sid) await workos.revokeSession(opened.sid).catch(() => undefined);
        return refuse("session_invalid", resolved.reason, [clearSessionCookie()]);
      }
      const session = resolved.session;
      const setCookies = resolved.rotated
        ? [sessionCookie(await sealSession(session, password), session, now)]
        : [];
      return {
        ok: true,
        userId: session.uid,
        setCookies,
        account: expandAccount(session.acct, session.uid),
        // The same session, sealed again with the account just read (or without one).
        async carry(account) {
          const { acct: _old, ...rest } = session;
          if (account) {
            const next = { ...rest, acct: compactAccount(account) };
            const cookie = sessionCookie(await sealSession(next, password), next, now);
            // DECISION: an account too big for a cookie (an operator with very many clients) is
            // not carried; that person's requests read it each time, as before (§1.93).
            if (cookieFits(cookie)) return [cookie];
          }
          if (session.acct === undefined) return setCookies;
          return [sessionCookie(await sealSession(rest, password), rest, now)];
        },
      };
    },

    async signIn({ returnTo, restart }, nowDate) {
      const path = safeReturnTo(returnTo, config.appOrigin);
      if (path === null) return refuse("forbidden", "return_to must be a path on this site");
      const nonce = restart ? restartNonce(randomToken()) : randomToken();
      const sealed = await sealState(
        { n: nonce, r: path, exp: epochSec(nowDate) + STATE_MAX_AGE_SEC },
        password,
      );
      return {
        ok: true,
        redirectTo: workos.authorizationUrl({ redirectUri, state: nonce }),
        setCookies: [stateCookie(sealed)],
      };
    },

    async callback(request, nowDate) {
      const url = new URL(request.url);
      const code = url.searchParams.get("code");
      const stateParam = url.searchParams.get("state");
      const rawState = requestCookie(request, STATE_COOKIE);
      const state = rawState ? await openState(rawState, password) : null;
      const clear = [clearStateCookie()];
      // Every failure below is the same refusal; only `failure` tells them apart (audit, restart).
      // Nothing here relaxes the check: a sign-in finishes only with a matching, unexpired state.
      const failed = (reason: CallbackFailureReason, message: string): CallbackRefusal => ({
        ...refuse("unauthenticated", message, clear),
        failure: {
          reason,
          returnTo: state?.r ?? null,
          // A callback without `state` can't show it isn't from a restart, so it never restarts.
          restart: !!code && !!stateParam && !isRestartState(stateParam),
        },
      });
      const unverified = "the sign-in could not be verified; start again";
      if (!code || !stateParam) return failed("callback_incomplete", unverified);
      if (!state) return failed("state_missing", unverified);
      if (epochSec(nowDate) >= state.exp) return failed("state_expired", unverified);
      if (!timingSafeEqual(state.n, stateParam)) return failed("state_mismatch", unverified);

      let auth: WorkOSAuthentication;
      try {
        auth = await workos.authenticateWithCode(code);
      } catch (error) {
        // A used or expired code, or WorkOS down: either way the person starts again.
        const refused = error instanceof WorkOSError && error.status !== null && error.status < 500;
        return failed(
          refused ? "code_rejected" : "workos_unavailable",
          "the sign-in could not be completed; start again",
        );
      }
      const organizationName = auth.organizationId
        ? await workos.organizationName(auth.organizationId).catch(() => null)
        : null;
      const outcome = await directory.provision({
        workosUserId: auth.user.id,
        email: auth.user.email.trim().toLowerCase(),
        name: displayName(auth),
        emailVerified: auth.user.emailVerified,
        workosOrganizationId: auth.organizationId,
        organizationName,
      });
      if (!outcome.ok) {
        // The browser never gets a session of ours, so end the WorkOS one here.
        if (auth.sessionId) await workos.revokeSession(auth.sessionId).catch(() => undefined);
        return {
          ...refuse("no_access", PROVISION_MESSAGES[outcome.reason], clear),
          reason: outcome.reason,
        };
      }

      const now = epochSec(nowDate);
      const session = newSession(
        {
          userId: outcome.userId,
          workosUserId: auth.user.id,
          email: auth.user.email,
          workosOrganizationId: auth.organizationId,
          sessionId: auth.sessionId,
          refreshToken: auth.refreshToken,
        },
        now,
      );
      return {
        ok: true,
        redirectTo: state.r,
        setCookies: [...clear, sessionCookie(await sealSession(session, password), session, now)],
        signedIn: { userId: outcome.userId, method: auth.authenticationMethod ?? null },
      };
    },

    async invite(email) {
      try {
        const { id } = await workos.sendInvitation(email.trim().toLowerCase());
        return { status: "sent", invitationId: id } as const;
      } catch (error) {
        // Only the code travels on (WorkOS messages can echo the address back).
        const reason =
          error instanceof WorkOSError
            ? (error.code ?? (error.status === null ? "unreachable" : `http_${error.status}`))
            : "unknown";
        return { status: "failed", reason } as const;
      }
    },

    async signOut(request) {
      const raw = requestCookie(request, SESSION_COOKIE);
      const opened = raw ? await openSession(raw, password) : null;
      const home = `${config.appOrigin}/`;
      return {
        ok: true,
        redirectTo: opened?.sid ? workos.logoutUrl(opened.sid, home) : home,
        setCookies: [clearSessionCookie()],
      };
    },
  };
}
