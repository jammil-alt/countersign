// The second step of signing in (docs/plan.md §1.83): after WorkOS checks the password, a code by
// authenticator app, text or WhatsApp (Twilio Verify), or a one-time recovery code. The four
// `/api/auth/second-factor*` routes serve a session whose step is still pending, so they check the
// cookie themselves (getSession with allowPendingSecondFactor) and act only for that person, inside
// withUser (row-level security on app.user_id). Operators reset a person's methods; a Claude
// connection to the Ops MCP server is approved here by the operator whose connection it is.

import { getSession, type Session } from "@countersign/auth";
import { type VerifyClient, verifyLocale } from "@countersign/connectors";
import {
  OPERATOR_SECOND_FACTOR_METHODS,
  RECOVERY_CODE_COUNT,
  routes,
  SECOND_FACTOR_MAX_SENDS,
  SECOND_FACTOR_MAX_TRIES,
  SECOND_FACTOR_METHODS,
  SECOND_FACTOR_WINDOW_MIN,
  SESSION_MAX_AGE_SEC,
  type SecondFactorMethod,
} from "@countersign/core";
import {
  auditEvent,
  type Db,
  mcpSessionApproval,
  membership,
  type Tx,
  userFactor,
  userRecoveryCode,
  withOperator,
  withUser,
} from "@countersign/db";
import { and, count, eq, gt, inArray, isNull } from "drizzle-orm";
import type { Hono } from "hono";
import { auditAlone, auditInTx } from "../audit";
import { authDirectory } from "../auth";
import {
  type AppContext,
  type AppEnv,
  HttpError,
  mount,
  mountPublic,
  type Services,
} from "../http";
import {
  codeHash,
  phoneHint,
  randomCode,
  showRecoveryCode,
  verifyFor,
  whatsappOn,
} from "../second-factor/config";
import { sessionLanguage } from "./language";

type FactorRow = typeof userFactor.$inferSelect;

interface StepCtx {
  c: AppContext;
  services: Services;
  session: Session;
  userId: string;
  status: "pending" | "done" | "exempt";
  secondsLeft: number | null;
  verify: VerifyClient | null;
}

/** The person at the second step: their session (pending allowed) and Twilio Verify. */
async function step(c: AppContext, services: Services): Promise<StepCtx> {
  const choice = services.auth();
  if (!choice.ok) throw new HttpError(503, choice.refusal.code, choice.refusal.message);
  const result = await getSession(c.req.raw, {
    adapter: choice.adapter,
    directory: authDirectory(services.db),
    allowPendingSecondFactor: true,
  });
  if (!result.ok) {
    for (const cookie of result.setCookies) c.header("Set-Cookie", cookie, { append: true });
    throw new HttpError(result.status === 503 ? 503 : 401, result.code, result.message);
  }
  for (const cookie of result.setCookies) c.header("Set-Cookie", cookie, { append: true });
  return {
    c,
    services,
    session: result.session,
    userId: result.session.user.id,
    status: result.secondFactor,
    secondsLeft: result.secondFactorSecondsLeft,
    verify: verifyFor(services.deps, services.env),
  };
}

function allowedFor(s: StepCtx): SecondFactorMethod[] {
  return s.session.isOperator ? [...OPERATOR_SECOND_FACTOR_METHODS] : [...SECOND_FACTOR_METHODS];
}

function available(s: StepCtx) {
  const on = s.verify !== null;
  return { totp: on, sms: on, whatsapp: on && whatsappOn(s.services.env) };
}

/** The methods a pending step may still change: refuses a done or exempt session. */
function mustBePending(s: StepCtx) {
  if (s.status !== "pending") {
    throw new HttpError(409, "not_pending", "you are already signed in");
  }
  if (!s.verify) throw new HttpError(409, "not_available", "sign-in codes aren't set up here");
  return s.verify;
}

const factors = (db: Db, userId: string) =>
  withUser(db, userId, (tx) => tx.select().from(userFactor).where(eq(userFactor.userId, userId)));

async function recoveryCodesLeft(db: Db, userId: string): Promise<number> {
  const [row] = await withUser(db, userId, (tx) =>
    tx
      .select({ n: count() })
      .from(userRecoveryCode)
      .where(and(eq(userRecoveryCode.userId, userId), isNull(userRecoveryCode.usedAt))),
  );
  return Number(row?.n ?? 0);
}

/**
 * Audit rows of this person in the last window: wrong codes, or codes sent. Rows with no client are
 * read in an operator scope with no clients, which sees nothing else.
 */
async function recent(db: Db, userId: string, action: string, outcome: "ok" | "refused") {
  const since = new Date(Date.now() - SECOND_FACTOR_WINDOW_MIN * 60_000);
  const [row] = await withOperator(db, [], (tx) =>
    tx
      .select({ n: count() })
      .from(auditEvent)
      .where(
        and(
          isNull(auditEvent.tenantId),
          eq(auditEvent.actorUserId, userId),
          eq(auditEvent.action, action),
          eq(auditEvent.outcome, outcome),
          gt(auditEvent.createdAt, since),
        ),
      ),
  );
  return Number(row?.n ?? 0);
}

const tooMany = () =>
  new HttpError(
    429,
    "too_many_attempts",
    `too many tries; wait ${SECOND_FACTOR_WINDOW_MIN} minutes and try again`,
  );

function audit(
  s: StepCtx,
  action: string,
  outcome: "ok" | "refused" | "error",
  httpStatus: number,
  target: Record<string, string> = {},
) {
  return auditAlone(s.services.db, s.c, {
    tenantId: null,
    actorKind: "user",
    actorUserId: s.userId,
    actorEmail: s.session.user.email,
    actorRole: s.session.isOperator ? "operator" : (s.session.activeRole ?? null),
    action,
    outcome,
    httpStatus,
    target,
  });
}

async function sendCode(s: StepCtx, verify: VerifyClient, factor: FactorRow) {
  if (!factor.phone) throw new HttpError(409, "not_a_phone", "that method has no phone number");
  if (
    (await recent(s.services.db, s.userId, "session.second_factor_send", "ok")) >=
    SECOND_FACTOR_MAX_SENDS
  ) {
    throw tooMany();
  }
  const language = await sessionLanguage(
    s.services.db,
    s.session,
    s.c.req.header("accept-language"),
  );
  await verify.send(
    factor.phone,
    factor.kind === "whatsapp" ? "whatsapp" : "sms",
    verifyLocale(language.effective),
  );
  await audit(s, "session.second_factor_send", "ok", 200, { method: factor.kind });
  return { sent: true as const, phoneHint: phoneHint(factor.phone) };
}

/** New recovery codes, replacing any unused ones: returned once, kept as HMACs. */
async function newRecoveryCodes(s: StepCtx, tx: Tx): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => randomCode(8));
  await tx
    .delete(userRecoveryCode)
    .where(and(eq(userRecoveryCode.userId, s.userId), isNull(userRecoveryCode.usedAt)));
  await tx.insert(userRecoveryCode).values(
    await Promise.all(
      codes.map(async (code) => ({
        userId: s.userId,
        codeHash: await codeHash(s.services.env, "recovery-code", code),
      })),
    ),
  );
  return codes.map(showRecoveryCode);
}

export function secondFactorRoutes(app: Hono<AppEnv>): void {
  mountPublic(app, routes.secondFactorState, async ({ c, services }) => {
    const s = await step(c, services);
    const rows = await factors(services.db, s.userId);
    return {
      status: s.status,
      operator: s.session.isOperator,
      allowed: allowedFor(s),
      available: available(s),
      methods: rows.map((f) => ({
        method: f.kind,
        verified: f.verifiedAt !== null,
        phoneHint: f.phone ? phoneHint(f.phone) : null,
      })),
      recoveryCodesLeft: await recoveryCodesLeft(services.db, s.userId),
      secondsLeft: s.secondsLeft,
    };
  });

  mountPublic(app, routes.secondFactorTotpStart, async ({ c, services }) => {
    const s = await step(c, services);
    const verify = mustBePending(s);
    const rows = await factors(services.db, s.userId);
    const existing = rows.find((f) => f.kind === "totp");
    if (existing?.verifiedAt) {
      throw new HttpError(409, "already_set_up", "your authenticator app is already set up");
    }
    // A setup started before and never proven is replaced, at Twilio too.
    if (existing?.twilioFactorSid) {
      await verify.deleteTotp(s.userId, existing.twilioFactorSid);
    }
    const enrollment = await verify.startTotp(s.userId, s.session.user.email);
    await withUser(services.db, s.userId, async (tx) => {
      if (existing) await tx.delete(userFactor).where(eq(userFactor.id, existing.id));
      await tx.insert(userFactor).values({
        userId: s.userId,
        kind: "totp",
        twilioFactorSid: enrollment.factorSid,
      });
    });
    await audit(s, "session.second_factor_setup", "ok", 200, { method: "totp", step: "started" });
    return { uri: enrollment.uri, secret: enrollment.secret };
  });

  mountPublic(app, routes.secondFactorPhoneStart, async ({ c, services, body }) => {
    const s = await step(c, services);
    const verify = mustBePending(s);
    if (!allowedFor(s).includes(body.method)) {
      throw new HttpError(
        403,
        "operator_needs_authenticator",
        "operators sign in with an authenticator app",
      );
    }
    if (!available(s)[body.method]) {
      throw new HttpError(409, "not_available", `${body.method} codes aren't set up here`);
    }
    const rows = await factors(services.db, s.userId);
    if (rows.find((f) => f.kind === body.method)?.verifiedAt) {
      throw new HttpError(409, "already_set_up", "that method is already set up");
    }
    const [factor] = await withUser(services.db, s.userId, async (tx) => {
      await tx
        .delete(userFactor)
        .where(and(eq(userFactor.userId, s.userId), eq(userFactor.kind, body.method)));
      return tx
        .insert(userFactor)
        .values({ userId: s.userId, kind: body.method, phone: body.phone })
        .returning();
    });
    if (!factor) throw new Error("factor insert returned nothing");
    await audit(s, "session.second_factor_setup", "ok", 200, {
      method: body.method,
      step: "started",
    });
    return sendCode(s, verify, factor);
  });

  mountPublic(app, routes.secondFactorSend, async ({ c, services, body }) => {
    const s = await step(c, services);
    const verify = mustBePending(s);
    if (!allowedFor(s).includes(body.method)) {
      throw new HttpError(
        403,
        "operator_needs_authenticator",
        "operators sign in with an authenticator app",
      );
    }
    const factor = (await factors(services.db, s.userId)).find((f) => f.kind === body.method);
    if (!factor) throw new HttpError(409, "not_set_up", "that method isn't set up");
    return sendCode(s, verify, factor);
  });

  mountPublic(app, routes.secondFactorVerify, async ({ c, services, body }) => {
    const s = await step(c, services);
    const verify = mustBePending(s);
    const { db } = services;
    if (
      (await recent(db, s.userId, "session.second_factor", "refused")) >= SECOND_FACTOR_MAX_TRIES
    ) {
      throw tooMany();
    }
    const refused = async (message: string) => {
      await audit(s, "session.second_factor", "refused", 422, { method: body.method });
      return new HttpError(422, "wrong_code", message);
    };

    let firstSetup = false;
    if (body.method === "recovery") {
      const hash = await codeHash(services.env, "recovery-code", body.code);
      const used = await withUser(db, s.userId, (tx) =>
        tx
          .update(userRecoveryCode)
          .set({ usedAt: new Date() })
          .where(
            and(
              eq(userRecoveryCode.userId, s.userId),
              eq(userRecoveryCode.codeHash, hash),
              isNull(userRecoveryCode.usedAt),
            ),
          )
          .returning({ id: userRecoveryCode.id }),
      );
      if (used.length === 0) throw await refused("that recovery code isn't right, or was used");
    } else {
      if (!allowedFor(s).includes(body.method)) {
        throw new HttpError(
          403,
          "operator_needs_authenticator",
          "operators sign in with an authenticator app",
        );
      }
      const factor = (await factors(db, s.userId)).find((f) => f.kind === body.method);
      if (!factor) throw new HttpError(409, "not_set_up", "that method isn't set up");
      let ok: boolean;
      if (factor.kind === "totp") {
        const sid = factor.twilioFactorSid ?? "";
        ok = factor.verifiedAt
          ? await verify.checkTotp(s.userId, sid, body.code)
          : await verify.confirmTotp(s.userId, sid, body.code);
      } else {
        ok = await verify.check(factor.phone ?? "", body.code);
      }
      if (!ok) throw await refused("that code isn't right, or has expired");
      firstSetup = factor.verifiedAt === null;
      await withUser(db, s.userId, (tx) =>
        tx
          .update(userFactor)
          .set({ lastUsedAt: new Date(), ...(firstSetup ? { verifiedAt: new Date() } : {}) })
          .where(eq(userFactor.id, factor.id)),
      );
    }

    // The first method a person proves gets them their recovery codes; so does proving one when
    // none are left.
    const left = await recoveryCodesLeft(db, s.userId);
    const recoveryCodes =
      firstSetup || left === 0
        ? await withUser(db, s.userId, (tx) => newRecoveryCodes(s, tx))
        : null;
    const choice = services.auth();
    if (!choice.ok || !choice.workos) {
      throw new HttpError(409, "not_pending", "there is no sign-in code waiting to be checked");
    }
    const done = await choice.workos.completeSecondFactor(c.req.raw, new Date());
    if (!done.ok) throw new HttpError(409, "not_pending", done.message);
    for (const cookie of done.setCookies) c.header("Set-Cookie", cookie, { append: true });
    await audit(s, "session.second_factor", "ok", 200, {
      method: body.method,
      ...(firstSetup ? { setup: "done" } : {}),
    });
    if (recoveryCodes)
      await audit(s, "session.recovery_codes", "ok", 200, { count: String(RECOVERY_CODE_COUNT) });
    return { ok: true as const, recoveryCodes };
  });

  // ── Operators: a lost phone ────────────────────────────────────────────────────────────────────

  mount(
    app,
    routes.opsUserSecondFactorReset,
    async ({ c, tx, params, body, tenantIds, services }) => {
      // Only someone in a client this operator serves.
      const [member] = await tx
        .select({ userId: membership.userId })
        .from(membership)
        .where(and(eq(membership.userId, params.id), inArray(membership.tenantId, [...tenantIds])))
        .limit(1);
      if (!member) throw new HttpError(404, "not_found", "no such person in your clients");
      const rows = await tx.select().from(userFactor).where(eq(userFactor.userId, params.id));
      const verify = verifyFor(services.deps, services.env);
      for (const f of rows) {
        if (f.kind === "totp" && f.twilioFactorSid && verify) {
          await verify.deleteTotp(params.id, f.twilioFactorSid);
        }
      }
      await tx.delete(userFactor).where(eq(userFactor.userId, params.id));
      await tx.delete(userRecoveryCode).where(eq(userRecoveryCode.userId, params.id));
      await auditInTx(tx, c, {
        tenantId: null,
        actorKind: "system",
        action: "session.second_factor_reset",
        outcome: "ok",
        httpStatus: 200,
        target: {
          user: params.id,
          methods: String(rows.length),
          reason: body.reason.slice(0, 200),
        },
      });
      return { reset: true as const, methodsRemoved: rows.length };
    },
  );

  // ── Claude connections to the Ops MCP server ───────────────────────────────────────────────────

  async function connection(tx: Tx, services: Services, code: string) {
    const hash = await codeHash(services.env, "claude-connection", code);
    const [row] = await tx
      .select()
      .from(mcpSessionApproval)
      .where(eq(mcpSessionApproval.codeHash, hash));
    if (!row) throw new HttpError(404, "not_found", "no such Claude connection; ask Claude again");
    return row;
  }

  const view = (row: typeof mcpSessionApproval.$inferSelect, userId: string) => ({
    status:
      row.approvedAt && row.expiresAt > new Date()
        ? ("approved" as const)
        : row.expiresAt <= new Date()
          ? ("expired" as const)
          : ("waiting" as const),
    startedAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    yours: row.userId === userId,
  });

  mount(app, routes.opsClaudeConnection, async ({ tx, params, services, session }) =>
    view(await connection(tx, services, params.code), session.user.id),
  );

  mount(app, routes.opsClaudeConnectionApprove, async ({ c, tx, params, services, session }) => {
    const row = await connection(tx, services, params.code);
    const now = new Date();
    if (row.userId !== session.user.id) {
      throw new HttpError(403, "not_yours", "only the person who connected Claude can approve it");
    }
    if (row.expiresAt <= now)
      throw new HttpError(409, "expired", "this link has expired; ask Claude again");
    if (row.approvedAt) return view(row, session.user.id);
    const [approved] = await tx
      .update(mcpSessionApproval)
      .set({ approvedAt: now, expiresAt: new Date(now.getTime() + SESSION_MAX_AGE_SEC * 1000) })
      .where(eq(mcpSessionApproval.id, row.id))
      .returning();
    await auditInTx(tx, c, {
      tenantId: null,
      actorKind: "user",
      actorUserId: session.user.id,
      actorEmail: session.user.email,
      actorRole: "operator",
      action: "mcp.approve",
      outcome: "ok",
      httpStatus: 200,
      target: { connection: row.id },
    });
    return view(approved ?? row, session.user.id);
  });
}
