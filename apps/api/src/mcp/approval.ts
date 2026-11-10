// Claude connections need approving when the second step of signing in runs here (docs/plan.md
// §1.83). The Ops MCP server signs people in through AuthKit directly, not through our cookie, so
// with WorkOS's own MFA off a password alone would reach it. Each connection is tied to its AuthKit
// session (`sid`): the first call of a new session is refused with a link, and the operator approves
// it in a browser that has passed the step. The approval lasts until that session ends (12 hours).

import { type Db, mcpSessionApproval, withOperator } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import type { Bindings } from "../env";
import type { AppDeps } from "../http";
import { codeHash, randomCode, secondFactorOn } from "../second-factor/config";

/** How long an approval link works. */
export const CLAUDE_LINK_MIN = 30;

export type ClaudeConnectionGate =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export async function claudeConnectionGate(input: {
  db: Db;
  env: Bindings;
  deps: Pick<AppDeps, "verify">;
  userId: string;
  sessionId: string | null;
  appOrigin: string;
  now: Date;
}): Promise<ClaudeConnectionGate> {
  const { db, env, userId, sessionId, now } = input;
  if (!secondFactorOn(input.deps, env)) return { ok: true };
  if (!sessionId) {
    return { ok: false, message: "this sign-in has no session to approve; connect Claude again" };
  }
  // DECISION: approvals are read and written in an operator scope with no clients (their policy
  // admits operators); the person is matched on user_id in the query.
  return withOperator(db, [], async (tx) => {
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
    const code = randomCode(32);
    const hash = await codeHash(env, "claude-connection", code);
    const expiresAt = new Date(now.getTime() + CLAUDE_LINK_MIN * 60_000);
    if (row) {
      await tx
        .update(mcpSessionApproval)
        .set({ codeHash: hash, expiresAt, approvedAt: null })
        .where(eq(mcpSessionApproval.id, row.id));
    } else {
      await tx
        .insert(mcpSessionApproval)
        .values({ userId, workosSessionId: sessionId, codeHash: hash, expiresAt });
    }
    const link = `${input.appOrigin}/ops/connect-claude/${code}`;
    return {
      ok: false,
      message: `approve this Claude connection first: open ${link} in the browser where you're signed in to Mezonas (the link works for ${CLAUDE_LINK_MIN} minutes), then try again`,
    } as const;
  });
}
