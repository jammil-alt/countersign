// Approving a sign-in on the phone app (docs/plan.md §1.154): the person's phones that can approve,
// the request a pending sign-in makes, the browser's check, and the phone's signed list and
// decision. The routes are in ../routes/second-factor.ts (the browser's) and
// ../routes/sign-in-approvals.ts (the phone's).

import {
  complianceOf,
  DEVICE_SIGNATURE_SKEW_SEC,
  type DevicePublicKey,
  isOperatorRole,
  PHONE_APPROVAL_CHOICES,
  PHONE_APPROVAL_SEC,
  type WaitingSignIn,
} from "@countersign/core";
import {
  type Db,
  personDevice,
  signInApproval,
  tenant,
  userMemberships,
  withTenants,
  withUser,
} from "@countersign/db";
import { and, asc, eq, gt, inArray, isNotNull, isNull } from "drizzle-orm";
import { HttpError, notFound } from "../http";
import { sha256Hex, signatureRequired, verifySigned } from "../mobile/devices";
import type { Pusher } from "../notify/push";
import { reportProblem } from "../observability/report";

/** A phone that can approve a sign-in: the person's own, set up to sign, not removed. */
export interface SigningPhone {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly pushToken: string | null;
  readonly publicKey: DevicePublicKey;
  /** Its client is in HIPAA mode: no push through Expo until Expo's BAA is recorded. */
  readonly hipaa: boolean;
}

/**
 * The person's phones that can approve, across the clients they belong to. None for anyone who is
 * an operator anywhere: operators use an authenticator app only (§1.100).
 */
export async function signingPhones(
  db: Db,
  userId: string,
  only?: { deviceId: string },
): Promise<SigningPhone[]> {
  const memberships = await userMemberships(db, userId);
  if (memberships.length === 0 || memberships.some((m) => isOperatorRole(m.role))) return [];
  const tenantIds = memberships.map((m) => m.tenantId);
  const rows = await withTenants(db, tenantIds, (tx) =>
    tx
      .select({
        id: personDevice.id,
        tenantId: personDevice.tenantId,
        name: personDevice.name,
        pushToken: personDevice.pushToken,
        publicKey: personDevice.publicKey,
        settings: tenant.settings,
      })
      .from(personDevice)
      .innerJoin(tenant, eq(tenant.id, personDevice.tenantId))
      .where(
        and(
          inArray(personDevice.tenantId, tenantIds),
          eq(personDevice.userId, userId),
          isNull(personDevice.revokedAt),
          isNotNull(personDevice.publicKey),
          ...(only ? [eq(personDevice.id, only.deviceId)] : []),
        ),
      )
      .orderBy(asc(personDevice.createdAt)),
  );
  return rows.flatMap((r) =>
    r.publicKey
      ? [
          {
            id: r.id,
            tenantId: r.tenantId,
            name: r.name,
            pushToken: r.pushToken,
            publicKey: r.publicKey as DevicePublicKey,
            hipaa: complianceOf(r.settings as Record<string, unknown>).hipaa,
          },
        ]
      : [],
  );
}

// ── What the phone shows of the browser ────────────────────────────────────────────────────────

/** "Chrome on macOS", from a user agent; never the user agent itself. */
export function browserInWords(userAgent: string | null | undefined): string {
  const ua = userAgent ?? "";
  const browser = /Edg(e|A|iOS)?\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /Firefox\/|FxiOS\//.test(ua)
        ? "Firefox"
        : /Chrome\/|CriOS\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "A browser";
  const system = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /CrOS/.test(ua)
          ? "ChromeOS"
          : /Mac OS X|Macintosh/.test(ua)
            ? "macOS"
            : /Windows/.test(ua)
              ? "Windows"
              : /Linux/.test(ua)
                ? "Linux"
                : null;
  return system ? `${browser} on ${system}` : browser;
}

/** "Austin, US": the city and country Cloudflare puts the address in; null when it doesn't. */
export function placeOf(request: Request): string | null {
  const cf = (request as Request & { cf?: Record<string, unknown> }).cf;
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 60) : null);
  const city = text(cf?.city);
  const country = text(cf?.country);
  if (city && country) return `${city}, ${country}`;
  return country ?? city;
}

// ── Numbers and keys ────────────────────────────────────────────────────────────────────────────

const base64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** A number from 10 to 99, every one equally likely. */
function twoDigits(): number {
  for (;;) {
    for (const b of crypto.getRandomValues(new Uint8Array(8))) {
      // 90 numbers; bytes from 180 up are dropped so none is likelier than another.
      if (b < 180) return 10 + (b % 90);
    }
  }
}

/**
 * The numbers the phone offers, the browser's among them, in an order fixed per request: derived
 * from its id under `key`, so asking twice shows the same three, and nobody without the key can
 * tell from the id which one it is.
 */
export async function choicesFor(key: string, id: string, number: number): Promise<number[]> {
  const k = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`mezonas-sign-in-choices:${key}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(
    await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`${id}:${number}`)),
  );
  const out = [number];
  for (const b of bytes) {
    if (out.length >= PHONE_APPROVAL_CHOICES) break;
    const n = 10 + (b % 90);
    if (!out.includes(n)) out.push(n);
  }
  // 32 bytes always give two more distinct numbers in practice; this keeps it total.
  for (let n = 10; out.length < PHONE_APPROVAL_CHOICES; n++) if (!out.includes(n)) out.push(n);
  const at = (bytes[31] ?? 0) % PHONE_APPROVAL_CHOICES;
  const decoys = out.slice(1);
  return [...decoys.slice(0, at), number, ...decoys.slice(at)];
}

// ── The browser asks, and checks ───────────────────────────────────────────────────────────────

export type ApprovalRow = typeof signInApproval.$inferSelect;

/**
 * A pending sign-in asks the person's phones. Any earlier request still waiting ends: only the
 * newest is answered. Answers the row and the key the page keeps (only its hash is stored).
 */
export async function startApproval(
  db: Db,
  input: { userId: string; browser: string; place: string | null; now: Date },
): Promise<{ row: ApprovalRow; key: string }> {
  const key = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const browserKeyHash = await sha256Hex(key);
  const { userId, now } = input;
  const row = await withUser(db, userId, async (tx) => {
    await tx
      .update(signInApproval)
      .set({ expiresAt: now })
      .where(
        and(
          eq(signInApproval.userId, userId),
          eq(signInApproval.status, "pending"),
          gt(signInApproval.expiresAt, now),
        ),
      );
    const [made] = await tx
      .insert(signInApproval)
      .values({
        userId,
        browserKeyHash,
        number: twoDigits(),
        browser: input.browser,
        place: input.place,
        expiresAt: new Date(now.getTime() + PHONE_APPROVAL_SEC * 1000),
        createdAt: now,
      })
      .returning();
    return made;
  });
  if (!row) throw new Error("sign-in approval not made");
  return { row, key };
}

/** How long after the phone approves the asking page may still pass with it. */
export const APPROVED_USE_SEC = 60;

export type CheckResult =
  | { readonly status: "pending" | "denied" | "expired" }
  | { readonly status: "approved"; readonly deviceId: string };

/**
 * Where the browser's request is. Approved, it is used up here, once: the caller passes the step.
 * Only the asking page (its key) of the same person finds it; anything else is not found.
 */
export async function checkApproval(
  db: Db,
  input: { userId: string; id: string; key: string; now: Date },
): Promise<CheckResult> {
  const { userId, id, now } = input;
  const keyHash = await sha256Hex(input.key);
  return withUser(db, userId, async (tx) => {
    const [row] = await tx
      .select()
      .from(signInApproval)
      .where(and(eq(signInApproval.id, id), eq(signInApproval.userId, userId)));
    if (!row || row.browserKeyHash !== keyHash) throw notFound("sign-in request");
    if (row.status === "denied") return { status: "denied" as const };
    if (row.status === "pending") {
      return { status: row.expiresAt > now ? ("pending" as const) : ("expired" as const) };
    }
    const decided = row.decidedAt?.getTime() ?? 0;
    if (row.usedAt || !row.deviceId || now.getTime() - decided > APPROVED_USE_SEC * 1000) {
      return { status: "expired" as const };
    }
    const [used] = await tx
      .update(signInApproval)
      .set({ usedAt: now })
      .where(and(eq(signInApproval.id, id), isNull(signInApproval.usedAt)))
      .returning({ id: signInApproval.id });
    if (!used) return { status: "expired" as const };
    return { status: "approved" as const, deviceId: row.deviceId };
  });
}

// ── The phone ───────────────────────────────────────────────────────────────────────────────────

/**
 * A call signed by one of the person's phones: theirs, in a client they belong to, set up to sign,
 * the time within DEVICE_SIGNATURE_SKEW_SEC, the signature over `text`. Anything else changes
 * nothing: 403 `signature_required` (401 `signature_stale` for an old time).
 */
export async function verifyPhone(
  db: Db,
  input: {
    userId: string;
    deviceId: string;
    at: string;
    signature: string;
    text: string;
    now: Date;
  },
): Promise<SigningPhone> {
  const [phone] = await signingPhones(db, input.userId, { deviceId: input.deviceId });
  if (!phone) throw signatureRequired("this phone can't approve: set it up again in the app");
  const at = Date.parse(input.at);
  if (
    !Number.isFinite(at) ||
    Math.abs(input.now.getTime() - at) > DEVICE_SIGNATURE_SKEW_SEC * 1000
  ) {
    throw new HttpError(401, "signature_stale", "the signature is too old: try again");
  }
  if (!(await verifySigned(phone.publicKey, input.text, input.signature))) {
    throw signatureRequired("the signature doesn't match: try again");
  }
  await withTenants(db, [phone.tenantId], (tx) =>
    tx
      .update(personDevice)
      .set({ lastSeenAt: input.now })
      .where(and(eq(personDevice.tenantId, phone.tenantId), eq(personDevice.id, phone.id))),
  );
  return phone;
}

/** The person's requests still waiting, newest first, with the numbers to offer. */
export async function waitingApprovals(
  db: Db,
  input: { userId: string; choicesKey: string; now: Date },
): Promise<WaitingSignIn[]> {
  const rows = await withUser(db, input.userId, (tx) =>
    tx
      .select()
      .from(signInApproval)
      .where(
        and(
          eq(signInApproval.userId, input.userId),
          eq(signInApproval.status, "pending"),
          gt(signInApproval.expiresAt, input.now),
        ),
      )
      .orderBy(asc(signInApproval.createdAt)),
  );
  return Promise.all(
    rows.reverse().map(async (r) => ({
      id: r.id,
      browser: r.browser,
      place: r.place,
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      choices: await choicesFor(input.choicesKey, r.id, r.number),
    })),
  );
}

export type Decision = "approved" | "denied" | "wrong_number";

/**
 * The phone's answer to one waiting request: approved with the browser's number, denied otherwise
 * ("It wasn't me", or a wrong number). A request no longer waiting answers 409 `not_waiting`.
 */
export async function decideApproval(
  db: Db,
  input: {
    userId: string;
    id: string;
    deviceId: string;
    decision: "approve" | "deny";
    number: number | null;
    now: Date;
  },
): Promise<Decision> {
  const { userId, id, now } = input;
  return withUser(db, userId, async (tx) => {
    const [row] = await tx
      .select()
      .from(signInApproval)
      .where(
        and(
          eq(signInApproval.id, id),
          eq(signInApproval.userId, userId),
          eq(signInApproval.status, "pending"),
          gt(signInApproval.expiresAt, now),
        ),
      )
      .for("update");
    if (!row) {
      throw new HttpError(409, "not_waiting", "this sign-in isn't waiting any more");
    }
    const outcome: Decision =
      input.decision === "deny"
        ? "denied"
        : input.number === row.number
          ? "approved"
          : "wrong_number";
    await tx
      .update(signInApproval)
      .set({
        status: outcome === "approved" ? "approved" : "denied",
        deviceId: input.deviceId,
        decidedAt: now,
      })
      .where(eq(signInApproval.id, id));
    return outcome;
  });
}

// ── Push ────────────────────────────────────────────────────────────────────────────────────────

export const SIGN_IN_PUSH_PATH = "/sign-in-approval";

/**
 * Tells the person's phones a sign-in waits, at once, best effort: a failure is reported and the
 * request still waits (the app lists it when opened). No client, browser or place in it. A phone
 * in a HIPAA client gets none until Expo's BAA is recorded (`covered`).
 */
export async function pushApproval(
  pusher: Pusher,
  phones: readonly SigningPhone[],
  input: { approvalId: string; covered: ReadonlySet<string> },
): Promise<number> {
  if (!pusher.isConfigured) return 0;
  const tokens = [
    ...new Set(
      phones
        .filter((p) => p.pushToken && (!p.hipaa || input.covered.has("expo_push")))
        .map((p) => p.pushToken as string),
    ),
  ];
  if (tokens.length === 0) return 0;
  try {
    const tickets = await pusher.send(
      tokens.map((to) => ({
        to,
        title: "Mezonas",
        body: "Approve your sign-in: open Mezonas and pick the number on your screen.",
        data: { path: `${SIGN_IN_PUSH_PATH}?id=${input.approvalId}`, kind: "sign_in_approval" },
      })),
    );
    return tickets.filter((t) => t.ok).length;
  } catch (error) {
    reportProblem("sign-in push failed", {
      kind: "sign_in_push",
      error: error instanceof Error ? error.message.slice(0, 120) : "error",
    });
    return 0;
  }
}
