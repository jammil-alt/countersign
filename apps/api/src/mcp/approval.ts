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
import { type Db, mcpSessionApproval, withUser } from "@countersign/db";
import { and, eq, inArray } from "drizzle-orm";
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
  now: Date;
}): Promise<ClaudeConnectionGate> {
  const { db, userId, sessionId, now } = input;
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
    await tx
      .insert(mcpSessionApproval)
      .values({ userId, workosSessionId: sessionId, codeHash, expiresAt })
      .onConflictDoUpdate({
        target: [mcpSessionApproval.workosSessionId, mcpSessionApproval.userId],
        set: { codeHash, expiresAt, approvedAt: null },
      });
    const confirm = await connectionConfirmCode(key, code);
    return {
      ok: false,
      code: "approval_needed",
      message: `approve this Claude connection first: open ${input.approvePage(code)} in the browser where you're signed in to Mezonas and type the code ${confirm} there (the link works for ${CLAUDE_LINK_MIN} minutes), then ask again. Show the person the link and the code`,
    } as const;
  });
}
