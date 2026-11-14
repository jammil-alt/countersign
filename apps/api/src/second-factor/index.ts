// A second factor by authenticator app, text or WhatsApp (docs/plan.md §1.99), after WorkOS checks
// the password. This file is the step's configuration, its storage (the person's methods and
// recovery codes, read as that person: `withUser`), its limits, and the "remember this browser"
// check the WorkOS adapter asks at sign-in. The routes are in ../routes/second-factor.ts.
//
// Off until TWILIO_VERIFY_SERVICE_SID is set: then every password sign-in is `pending` until the
// person passes the step. Set up wrongly (the service set, a key missing), it fails closed.

import {
  DEVICE_COOKIE,
  type DevicePayload,
  openDevice,
  requestCookie,
  type SecondFactorPolicy,
  workosStateOf,
} from "@countersign/auth";
import {
  type CodeVerifier,
  type FetchLike,
  globalFetch,
  twilioCodeVerifier,
} from "@countersign/connectors";
import {
  CLIENT_SECOND_FACTOR_KINDS,
  isOperatorRole,
  OPERATOR_SECOND_FACTOR_KINDS,
  RECOVERY_CODE_COUNT,
  SECOND_FACTOR_MAX_ATTEMPTS,
  SECOND_FACTOR_WINDOW_SEC,
  type SecondFactorKind,
} from "@countersign/core";
import {
  auditEvent,
  type Db,
  userFactor,
  userMemberships,
  userRecoveryCode,
  withOperator,
  withUser,
} from "@countersign/db";
import { and, count, eq, gte, inArray, isNotNull, isNull } from "drizzle-orm";
import type { Bindings } from "../env";
import { reportProblem } from "../observability/report";

/** What the step is built from; tests pass a code service in memory (AppDeps.codeVerifier). */
export interface SecondFactorConfig {
  verifier: CodeVerifier;
  /** Recovery codes are kept as HMACs under this key (from ENCRYPTION_KEY), and the previous one. */
  recoveryKeys: readonly string[];
  /** The WorkOS cookie password: it seals the remembered-browser cookie too (own purpose). */
  cookiePassword: string;
}

export type SecondFactorSetup =
  | { readonly state: "off" }
  | { readonly state: "misconfigured"; readonly problems: readonly string[] }
  | { readonly state: "on"; readonly config: SecondFactorConfig };

const read = (v: string | undefined) => (typeof v === "string" ? v.trim() : "");

// DECISION (docs/plan.md §1.99): on where TWILIO_VERIFY_SERVICE_SID is set (a Worker variable);
// it needs Twilio's keys, ENCRYPTION_KEY (recovery codes) and the WorkOS sign-in. Missing one of
// them is `misconfigured`: sign-ins stay pending and the routes answer 503, never "off".
export function secondFactorSetupOf(
  env: Bindings,
  inject?: { verifier?: (env: Bindings) => CodeVerifier; fetch?: FetchLike },
): SecondFactorSetup {
  const serviceSid = read(env.TWILIO_VERIFY_SERVICE_SID);
  if (!serviceSid) return { state: "off" };
  const problems: string[] = [];
  const accountSid = read(env.TWILIO_ACCOUNT_SID);
  const authToken = read(env.TWILIO_AUTH_TOKEN);
  if (!inject?.verifier && (!accountSid || !authToken)) {
    problems.push("TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are needed for Twilio Verify");
  }
  const key = read(env.ENCRYPTION_KEY);
  if (!key) problems.push("ENCRYPTION_KEY is needed for recovery codes");
  const workos = workosStateOf(env);
  if (workos.state !== "on") problems.push("the second step needs the WorkOS sign-in on");
  if (problems.length > 0 || workos.state !== "on") return { state: "misconfigured", problems };
  const verifier =
    inject?.verifier?.(env) ??
    twilioCodeVerifier({
      accountSid,
      authToken,
      serviceSid,
      fetch: inject?.fetch ?? globalFetch(),
    });
  const previous = read(env.ENCRYPTION_KEY_PREVIOUS);
  return {
    state: "on",
    config: {
      verifier,
      recoveryKeys: previous ? [key, previous] : [key],
      cookiePassword: workos.config.cookiePassword,
    },
  };
}

/** The methods a person may use: operators reach every client, so an authenticator app only. */
export async function allowedKinds(db: Db, userId: string): Promise<readonly SecondFactorKind[]> {
  const memberships = await userMemberships(db, userId);
  return memberships.some((m) => isOperatorRole(m.role))
    ? OPERATOR_SECOND_FACTOR_KINDS
    : CLIENT_SECOND_FACTOR_KINDS;
}

export type FactorRow = typeof userFactor.$inferSelect;

export function factorsOf(db: Db, userId: string): Promise<FactorRow[]> {
  return withUser(db, userId, (tx) =>
    tx.select().from(userFactor).where(eq(userFactor.userId, userId)),
  );
}

export async function recoveryCodesLeft(db: Db, userId: string): Promise<number> {
  const [row] = await withUser(db, userId, (tx) =>
    tx
      .select({ n: count() })
      .from(userRecoveryCode)
      .where(and(eq(userRecoveryCode.userId, userId), isNull(userRecoveryCode.usedAt))),
  );
  return row?.n ?? 0;
}

/** "•••• 4567" */
export const phoneHint = (phone: string | null): string | null =>
  phone ? `•••• ${phone.slice(-4)}` : null;

// ── Recovery codes ───────────────────────────────────────────────────────────────────────────────

/** No 0/O, 1/I/L: read aloud or typed from paper without guessing. */
const RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** The largest multiple of the alphabet's length that fits in a byte: bytes at or above it are dropped. */
const RECOVERY_BYTE_LIMIT = 256 - (256 % RECOVERY_ALPHABET.length);

function recoveryCode(): string {
  // Rejection sampling, so every character is equally likely (a plain `byte % 31` is biased).
  let chars = "";
  while (chars.length < 8) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      if (b < RECOVERY_BYTE_LIMIT && chars.length < 8) {
        chars += RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length];
      }
    }
  }
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

/** A recovery code as stored: HMAC-SHA256 of the person and the code, under one key. */
async function recoveryHash(key: string, userId: string, code: string): Promise<string> {
  const normalized = code.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const k = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`mezonas-recovery-code:${key}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    k,
    new TextEncoder().encode(`${userId}:${normalized}`),
  );
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Replaces the person's recovery codes with 10 new ones, and returns them (shown once). */
export async function newRecoveryCodes(
  db: Db,
  config: SecondFactorConfig,
  userId: string,
): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, recoveryCode);
  const [key] = config.recoveryKeys;
  if (!key) throw new Error("no recovery key");
  const hashes = await Promise.all(codes.map((c) => recoveryHash(key, userId, c)));
  await withUser(db, userId, async (tx) => {
    await tx.delete(userRecoveryCode).where(eq(userRecoveryCode.userId, userId));
    await tx.insert(userRecoveryCode).values(hashes.map((codeHash) => ({ userId, codeHash })));
  });
  return codes;
}

/** Uses one recovery code: true when it was the person's and unused (it is then used up). */
export async function useRecoveryCode(
  db: Db,
  config: SecondFactorConfig,
  userId: string,
  code: string,
  now: Date,
): Promise<boolean> {
  const hashes = await Promise.all(config.recoveryKeys.map((k) => recoveryHash(k, userId, code)));
  const used = await withUser(db, userId, (tx) =>
    tx
      .update(userRecoveryCode)
      .set({ usedAt: now })
      .where(
        and(
          eq(userRecoveryCode.userId, userId),
          inArray(userRecoveryCode.codeHash, hashes),
          isNull(userRecoveryCode.usedAt),
        ),
      )
      .returning({ id: userRecoveryCode.id }),
  );
  return used.length > 0;
}

// ── Limits ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Wrong codes (`session.second_factor` refused) or sends (`session.second_factor_send`) by this
 * person in the last 15 minutes, from the audit log.
 */
// DECISION: counted from audit rows as §1.99 says. Those rows have no client, which only an
// operator scope reads, so this one count runs in an operator scope over no clients: it sees
// client-less rows only, filtered to this person's own actions.
export async function recentCount(
  db: Db,
  userId: string,
  what: "wrong_code" | "send",
  now: Date,
): Promise<number> {
  const since = new Date(now.getTime() - SECOND_FACTOR_WINDOW_SEC * 1000);
  const [row] = await withOperator(db, [], (tx) =>
    tx
      .select({ n: count() })
      .from(auditEvent)
      .where(
        and(
          eq(auditEvent.actorUserId, userId),
          gte(auditEvent.createdAt, since),
          what === "send"
            ? eq(auditEvent.action, "session.second_factor_send")
            : and(
                eq(auditEvent.action, "session.second_factor"),
                eq(auditEvent.outcome, "refused"),
              ),
        ),
      ),
  );
  return row?.n ?? 0;
}

export const overLimit = (n: number) => n >= SECOND_FACTOR_MAX_ATTEMPTS;

// ── Remember this browser ────────────────────────────────────────────────────────────────────────

/**
 * Whether this browser passed the step for this person in the last 30 days, with a method they
 * still have (a reset removes their methods, so it forgets every browser) and may still use.
 */
export async function rememberedBrowser(
  db: Db,
  config: SecondFactorConfig,
  request: Request,
  userId: string,
  now: Date,
): Promise<boolean> {
  const raw = requestCookie(request, DEVICE_COOKIE);
  if (!raw) return false;
  const device: DevicePayload | null = await openDevice(
    raw,
    config.cookiePassword,
    Math.floor(now.getTime() / 1000),
  );
  if (!device || device.uid !== userId) return false;
  const [factor] = await withUser(db, userId, (tx) =>
    tx
      .select({ kind: userFactor.kind })
      .from(userFactor)
      .where(
        and(
          eq(userFactor.id, device.fid),
          eq(userFactor.userId, userId),
          isNotNull(userFactor.verifiedAt),
        ),
      ),
  );
  if (!factor) return false;
  return (await allowedKinds(db, userId)).includes(factor.kind);
}

/** What the WorkOS adapter is given: whether the step is on, and the remembered-browser check. */
export function secondFactorPolicy(setup: SecondFactorSetup, db: Db): SecondFactorPolicy {
  if (setup.state === "off") return { on: false };
  if (setup.state === "misconfigured") {
    reportProblem("second factor misconfigured", {
      kind: "second_factor",
      problems: setup.problems.join("; ").slice(0, 200),
    });
    return { on: true };
  }
  const { config } = setup;
  return {
    on: true,
    remembered: ({ request, userId, now }) => rememberedBrowser(db, config, request, userId, now),
  };
}
