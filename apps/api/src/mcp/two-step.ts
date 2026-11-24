// The two-step confirm for the MCP server's writes (docs/plan.md §1.34): a first call previews and
// hands back a token bound to the operator, the tool and its arguments; the second, with the same
// arguments and that token, does it once. Shared by the build and agent tools; feedback_resolve and
// the Dev queue keep their own copies of the same steps.

import { HttpError } from "../http";
import { CONFIRM_TTL_SEC, checkConfirmToken, claimNonce, issueConfirmToken } from "./confirm";
import type { OpsToolCtx } from "./ops-tools";

/** A token for `tool` with these arguments, for this operator, and the words that offer it. */
export async function issueFor(
  ctx: OpsToolCtx,
  tool: string,
  bound: Record<string, unknown>,
): Promise<{ token: string; expiresAt: Date; offer: string }> {
  const issued = await issueConfirmToken({
    password: ctx.config.sealPassword,
    userId: ctx.session.user.id,
    tool,
    args: bound,
    now: ctx.now(),
  });
  ctx.audit.outcome = "preview";
  return {
    ...issued,
    offer: `To do it, call ${tool} again with the same arguments and confirm_token "${issued.token}" (it expires at ${issued.expiresAt.toISOString()}, ${CONFIRM_TTL_SEC / 60} minutes).`,
  };
}

/** Checks a token for `tool` with these arguments and uses it up; throws a tool error if it can't. */
export async function useToken(
  ctx: OpsToolCtx,
  tool: string,
  bound: Record<string, unknown>,
  token: string,
): Promise<void> {
  const checked = await checkConfirmToken({
    token,
    password: ctx.config.sealPassword,
    userId: ctx.session.user.id,
    tool,
    args: bound,
    now: ctx.now(),
  });
  if (!checked.ok) {
    const why = {
      invalid: "that confirm token is not valid",
      expired: "that confirm token has expired; preview again for a new one",
      mismatch:
        "that confirm token was for different arguments (or another user, or a newer draft); preview again with these",
      used: "that confirm token was already used",
    }[checked.reason];
    throw new HttpError(422, `confirm_${checked.reason}`, why);
  }
  if (!(await claimNonce(ctx.objects, checked.nonce, ctx.now()))) {
    throw new HttpError(422, "confirm_used", "that confirm token was already used");
  }
}
