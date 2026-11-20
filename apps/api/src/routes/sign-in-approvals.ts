// The phone's side of approving a sign-in (docs/plan.md §1.154): the person's sign-ins waiting on
// their phone, and the phone's answer. No session: an app signed out after 30 idle minutes still
// approves. Each call is signed by the person's own phone, with its key behind Face ID or a
// fingerprint; one that doesn't verify changes nothing.

import {
  routes,
  type SignInApprovalDecideBody,
  signInApprovalText,
  signInListText,
} from "@countersign/core";
import type { Hono } from "hono";
import { type AuditEntry, auditAlone, auditInTx } from "../audit";
import { type AppContext, type AppEnv, HttpError, mountPublic } from "../http";
import { ATTEMPT_ACTION, claimAttempt } from "../second-factor";
import { decideApproval, verifyPhone, waitingApprovals } from "../second-factor/phone";

function entry(
  userId: string,
  outcome: AuditEntry["outcome"],
  httpStatus: number,
  target: Record<string, string>,
): AuditEntry {
  return {
    tenantId: null,
    actorKind: "user",
    actorUserId: userId,
    action: "session.phone_approval",
    outcome,
    httpStatus,
    target,
  };
}

/** The key the numbers on offer are derived from; without it no request can be answered. */
function choicesKey(c: AppContext): string {
  const key = c.get("req").services().env.ENCRYPTION_KEY?.trim();
  if (!key) {
    throw new HttpError(503, "second_factor_unavailable", "sign-ins can't be approved right now");
  }
  return key;
}

export function signInApprovalRoutes(app: Hono<AppEnv>): void {
  mountPublic(app, routes.mobileSignInApprovals, async ({ c, body, services }) => {
    const key = choicesKey(c);
    const now = new Date();
    await verifyPhone(services.db, {
      userId: body.userId,
      deviceId: body.deviceId,
      at: body.at,
      signature: body.signature,
      text: signInListText(body),
      now,
    });
    return {
      approvals: await waitingApprovals(services.db, { userId: body.userId, choicesKey: key, now }),
    };
  });

  mountPublic(app, routes.mobileSignInApprovalDecide, async ({ c, body, services }) => {
    choicesKey(c);
    const id = c.req.param("id") ?? "";
    const b = body as SignInApprovalDecideBody;
    const db = services.db;
    const now = new Date();
    const phone = await verifyPhone(db, {
      userId: b.userId,
      deviceId: b.deviceId,
      at: b.at,
      signature: b.signature,
      text: signInApprovalText({
        approvalId: id,
        userId: b.userId,
        deviceId: b.deviceId,
        decision: b.decision,
        number: b.number,
        at: b.at,
      }),
      now,
    });
    // An answer is one try of the person's limit (5 in 15 minutes), as a code is.
    const claimed = await claimAttempt(db, b.userId, (tx) =>
      auditInTx(tx, c, {
        tenantId: null,
        actorKind: "user",
        actorUserId: b.userId,
        action: ATTEMPT_ACTION,
        outcome: "ok",
        httpStatus: 200,
        target: { method: "phone" },
      }),
    );
    if (!claimed) {
      throw new HttpError(
        429,
        "too_many_attempts",
        "too many tries; wait 15 minutes and try again",
      );
    }
    const outcome = await decideApproval(db, {
      userId: b.userId,
      id,
      deviceId: phone.id,
      decision: b.decision,
      number: b.number,
      now,
    });
    await auditAlone(
      db,
      c,
      entry(b.userId, outcome === "approved" ? "ok" : "refused", 200, {
        approval: id,
        device: phone.id,
        step: outcome,
      }),
    );
    return { status: outcome === "approved" ? ("approved" as const) : ("denied" as const) };
  });
}
