// The Claude connector's approval link (docs/plan.md §1.100, §1.120). The MCP server signs people in
// through AuthKit directly, not through our cookie, so it never passes our second step: once WorkOS's
// own multi-factor is off, a password alone would reach it. So while the step is on, a Claude
// connection is tied to its AuthKit session (the token's `sid`): its first tool call is answered
// with a link, and the person approves it from a browser that is signed in past the step. The
// approval lasts until that AuthKit session ends (12 hours at most).
//
// The link's code is kept only as an HMAC under ENCRYPTION_KEY (as recovery codes are), in
// `mcp_session_approval` (migration 0042), read and written as the person (withUser).

import {
  CLAUDE_CONFIRM_DIGITS,
  CLAUDE_LINK_MIN,
  type ClaudeConnection,
  SESSION_MAX_AGE_SEC,
} from "@countersign/core";
import {
  auditEvent,
  type Db,
  mcpSessionApproval,
  type Tx,
  withOperator,
  withUser,
} from "@countersign/db";
import { and, count, eq, inArray, sql } from "drizzle-orm";
import type { Bindings } from "../env";
import type { AppDeps } from "../http";
import { secondFactorSetupOf } from "../second-factor";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** 32 random base32 letters and digits: 160 bits (256 is a multiple of 32, so no bias). */
export function connectionCode(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))].map((b) => BASE32[b % 32]).join("");
}

/** A link's code as stored: HMAC-SHA256 under one key, for this purpose only. */
export async function connectionCodeHash(key: string, code: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`mezonas-claude-connection:${key}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(code));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Audit 5.3: the short code Claude shows beside a link, which the person types on the approval
 * page: CLAUDE_CONFIRM_DIGITS digits from an HMAC of the link's code under the same key, with its
 * own label. Nothing more is stored: the link's code gives it back, and only Claude's answer and
 * the person's typing ever show it.
 */
// DECISION: derived, not stored, so mcp_session_approval needs no new column (no migration); the
// page never returns it, so approving takes reading it from the Claude that asked.
export async function connectionConfirmCode(key: string, code: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`mezonas-claude-confirm:${key}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(code)));
  const n = new DataView(sig.buffer).getUint32(0) % 10 ** CLAUDE_CONFIRM_DIGITS;
  return String(n).padStart(CLAUDE_CONFIRM_DIGITS, "0");
}

type ApprovalRow = typeof mcpSessionApproval.$inferSelect;

/** Wrong codes a link takes before it stops working (a new one comes with Claude's next call). */
export const CLAUDE_CONFIRM_MAX_TRIES = 5;

/**
 * Checks the code typed for a link (audit 5.3) under a per-link advisory lock, so codes sent at
 * once are taken one at a time: `ok`; `wrong` (its refused row written by `wrongRow` in the same
 * step); `spent`, the wrong code that used the link's last try; or `ended`, a link already past
 * its tries. The caller ends the link on `spent` (`endLink`). Refused `mcp.approve` rows are the
 * count, read in an operator scope over no clients as they have none (as `claimAttempt`).
 */
export async function checkConfirm(input: {
  db: Db;
  row: ApprovalRow;
  keys: readonly string[];
  code: string;
  typed: string;
  wrongRow: (tx: Tx) => Promise<void>;
}): Promise<"ok" | "wrong" | "spent" | "ended"> {
  const { row } = input;
  return withOperator(input.db, [], async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`claude-confirm:${row.id}`}, 0))`,
    );
    const [tried] = await tx
      .select({ n: count() })
      .from(auditEvent)
      .where(
        and(
          eq(auditEvent.actorUserId, row.userId),
          eq(auditEvent.action, "mcp.approve"),
          eq(auditEvent.outcome, "refused"),
          sql`${auditEvent.target} ->> 'connection' = ${row.id}`,
          sql`${auditEvent.createdAt} >= ${row.expiresAt}::timestamptz - ${`${CLAUDE_LINK_MIN} minutes`}::interval`,
        ),
      );
    const n = tried?.n ?? 0;
    if (n >= CLAUDE_CONFIRM_MAX_TRIES) return "ended";
    const expected = await Promise.all(input.keys.map((k) => connectionConfirmCode(k, input.code)));
    if (expected.some((e) => sameText(e, input.typed))) return "ok";
    await input.wrongRow(tx);
    return n + 1 >= CLAUDE_CONFIRM_MAX_TRIES ? "spent" : "wrong";
  });
}

/** A link past its tries matches nothing from now on: Claude's next call gives a new one. */
export async function endLink(db: Db, row: ApprovalRow): Promise<void> {
  await withUser(db, row.userId, (tx) =>
    tx
      .update(mcpSessionApproval)
      .set({ codeHash: `ended:${crypto.randomUUID()}` })
      .where(and(eq(mcpSessionApproval.id, row.id), eq(mcpSessionApproval.userId, row.userId))),
  );
}

/** Equal strings, compared in time that doesn't depend on where they differ. */
function sameText(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0;
}

/** The longest client name the page shows. */
const CLIENT_MAX = 40;

/**
 * Who is asking (H6), from the asking request's user agent: "Claude Code" or "Claude" for
 * Anthropic's clients, otherwise the agent's first product name ("python-httpx"), so a token used
 * from something else says so. Never the user agent itself; null without one.
 */
// DECISION (docs/plan.md §1.201): the name is what the request says it is, not proof: it is shown
// beside the place and the confirm code, which stays the check. Letters, digits and `._-` only,
// at most CLIENT_MAX characters, so nothing a request sends reaches the page as it was sent.
export function claudeClientInWords(userAgent: string | null | undefined): string | null {
  const ua = (userAgent ?? "").trim();
  if (!ua) return null;
  if (/claude[-_ ]?code/i.test(ua)) return "Claude Code";
  if (/claude|anthropic/i.test(ua)) return "Claude";
  const first = /^[A-Za-z0-9._-]+/.exec(ua)?.[0] ?? "";
  return first ? first.slice(0, CLIENT_MAX) : null;
}

/** What the approval page shows for a row. */
export function connectionView(row: ApprovalRow, now: Date): ClaudeConnection {
  const live = row.expiresAt > now;
  return {
    status: row.approvedAt && live ? "approved" : live ? "waiting" : "expired",
    startedAt: row.createdAt.toISOString(),
    // Each refused call gives a new link that works CLAUDE_LINK_MIN minutes from then.
    requestedAt: row.approvedAt
      ? null
      : new Date(row.expiresAt.getTime() - CLAUDE_LINK_MIN * 60_000).toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    client: row.client,
    place: row.place,
  };
}

/** The person's own connection whose link carries `code` (any of the keys), or null. */
export async function findConnection(
  db: Db,
  keys: readonly string[],
  userId: string,
  code: string,
): Promise<ApprovalRow | null> {
  const hashes = await Promise.all(keys.map((k) => connectionCodeHash(k, code)));
  const [row] = await withUser(db, userId, (tx) =>
    tx
      .select()
      .from(mcpSessionApproval)
      .where(
        and(eq(mcpSessionApproval.userId, userId), inArray(mcpSessionApproval.codeHash, hashes)),
      ),
  );
  return row ?? null;
}

/**
 * Approves a waiting connection: it then lasts until its AuthKit session must have ended, 12 hours
 * after Claude first asked in it at the latest. An approved one is answered as it is.
 */
export async function approveConnection(
  db: Db,
  row: ApprovalRow,
  now: Date,
): Promise<{ row: ApprovalRow; approvedNow: boolean }> {
  if (row.approvedAt) return { row, approvedNow: false };
  // DECISION (docs/plan.md §1.120): the approval ends 12 hours after the row was made (the first
  // refused call of this AuthKit session), not 12 hours after approving: the session began before
  // that call and AuthKit ends it 12 hours after it began, so this is never longer than the session.
  const end = new Date(row.createdAt.getTime() + SESSION_MAX_AGE_SEC * 1000);
  const [approved] = await withUser(db, row.userId, (tx) =>
    tx
      .update(mcpSessionApproval)
      .set({ approvedAt: now, expiresAt: end })
      .where(and(eq(mcpSessionApproval.id, row.id), eq(mcpSessionApproval.userId, row.userId)))
      .returning(),
  );
  return { row: approved ?? row, approvedNow: true };
}

export type ClaudeConnectionGate =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Whether this Claude connection may call a tool. With the step off, always. With it on: only once
 * the person approved this AuthKit session's connection; otherwise a new link, valid 30 minutes,
 * replaces the last one and is given in the refusal.
 */
export async function claudeConnectionGate(input: {
  db: Db;
  env: Bindings;
  deps: Pick<AppDeps, "codeVerifier">;
  userId: string;
  /** The access token's `sid`: AuthKit's session for this connection. */
  sessionId: string | null;
  /** Where the person approves: the back office for an operator, the portal for a client. */
  approvePage: (code: string) => string;
  /** Who is asking (H6): the Claude client in words and where the request came from. */
  asking: { client: string | null; place: string | null };
  now: Date;
}): Promise<ClaudeConnectionGate> {
  const { db, userId, sessionId, now } = input;
  const asking = { client: input.asking.client, place: input.asking.place };
  const setup = secondFactorSetupOf(input.env, {
    ...(input.deps.codeVerifier ? { verifier: input.deps.codeVerifier } : {}),
  });
  if (setup.state === "off") return { ok: true };
  // Set up wrongly, the step fails closed here as it does for a browser sign-in.
  if (setup.state === "misconfigured") {
    return {
      ok: false,
      code: "second_factor_unavailable",
      message: "sign-in codes can't be checked right now; try again later",
    };
  }
  // DECISION (docs/plan.md §1.120): a token without `sid` can't be tied to a sign-in, so it is
  // refused rather than approved for every session of the person.
  if (!sessionId) {
    return {
      ok: false,
      code: "approval_needed",
      message: "this sign-in can't be approved; disconnect Mezonas in Claude and connect again",
    };
  }
  const [key] = setup.config.recoveryKeys;
  if (!key) throw new Error("no ENCRYPTION_KEY for the approval link");
  return withUser(db, userId, async (tx) => {
    const [row] = await tx
      .select()
      .from(mcpSessionApproval)
      .where(
        and(
          eq(mcpSessionApproval.workosSessionId, sessionId),
          eq(mcpSessionApproval.userId, userId),
        ),
      );
    if (row?.approvedAt && row.expiresAt > now) return { ok: true } as const;
    const code = connectionCode();
    const codeHash = await connectionCodeHash(key, code);
    const expiresAt = new Date(now.getTime() + CLAUDE_LINK_MIN * 60_000);
    // DECISION (docs/plan.md §1.120, 2026-11-20): an AuthKit session can outlive 12 hours (a
    // Claude connection on staging kept its `sid` for two days), so an approval window that would
    // end before this link does starts again from now. Kept, every link of that session expired
    // the moment it was approved, and the only way out was to reconnect Claude.
    const restart =
      !row || row.createdAt.getTime() + SESSION_MAX_AGE_SEC * 1000 <= expiresAt.getTime();
    await tx
      .insert(mcpSessionApproval)
      .values({
        userId,
        workosSessionId: sessionId,
        codeHash,
        expiresAt,
        createdAt: now,
        ...asking,
      })
      .onConflictDoUpdate({
        target: [mcpSessionApproval.workosSessionId, mcpSessionApproval.userId],
        // The page describes the request that got this link, so each link takes its own asker.
        set: {
          codeHash,
          expiresAt,
          approvedAt: null,
          ...asking,
          ...(restart ? { createdAt: now } : {}),
        },
      });
    const confirm = await connectionConfirmCode(key, code);
    return {
      ok: false,
      code: "approval_needed",
      message: `approve this Claude connection first: open ${input.approvePage(code)} in the browser where you're signed in to Mezonas and type the code ${confirm} there (the link works for ${CLAUDE_LINK_MIN} minutes), then ask again. Show the person the link and the code`,
    } as const;
  });
}
