// The second step of signing in (docs/plan.md §1.99): where a sign-in is with it, setting up the
// first method, sending a code, checking it (and remembering the browser for 30 days), recovery
// codes, and an operator's reset. The step's routes run outside mount(): they act for the person,
// never in a client, and a `pending` session must reach them (getSession's
// `allowPendingSecondFactor`); every other route refuses it.

import { deviceCookie, getSession, type Session, type WorkOSAdapter } from "@countersign/auth";
import { routes, type SecondFactorKind } from "@countersign/core";
import { membership, userFactor, userRecoveryCode, withUser } from "@countersign/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Hono } from "hono";
import { type AuditEntry, auditAlone, auditInTx } from "../audit";
import { authDirectory } from "../auth";
import { type AppContext, type AppEnv, HttpError, mount, mountPublic, notFound } from "../http";
import {
  allowedKinds,
  factorsOf,
  newRecoveryCodes,
  overLimit,
  phoneHint,
  recentCount,
  recoveryCodesLeft,
  type SecondFactorConfig,
  secondFactorSetupOf,
  useRecoveryCode,
} from "../second-factor";

function sendCookies(c: AppContext, cookies: readonly string[]) {
  for (const cookie of cookies) c.header("Set-Cookie", cookie, { append: true });
}

interface StepCtx {
  session: Session;
  workos: WorkOSAdapter | null;
  config: SecondFactorConfig | null;
}

/** The signed-in person, pending or not, and the step's configuration. */
async function stepContext(c: AppContext): Promise<StepCtx> {
  const services = c.get("req").services();
  const choice = services.auth();
  if (!choice.ok)
    throw new HttpError(choice.refusal.status, choice.refusal.code, choice.refusal.message);
  const result = await getSession(c.req.raw, {
    adapter: choice.adapter,
    directory: authDirectory(services.db),
    allowPendingSecondFactor: true,
  });
  if (!result.ok) {
    sendCookies(c, result.setCookies);
    throw new HttpError(result.status, result.code, result.message);
  }
  sendCookies(c, result.setCookies);
  const setup = secondFactorSetupOf(services.env, {
    ...(services.deps.codeVerifier ? { verifier: services.deps.codeVerifier } : {}),
  });
  return {
    session: result.session,
    workos: choice.workos,
    config: setup.state === "on" ? setup.config : null,
  };
}

/** A pending sign-in, with the step set up: what every action below needs. */
async function pending(c: AppContext) {
  const ctx = await stepContext(c);
  if (ctx.session.secondFactor !== "pending" || !ctx.workos) {
    throw new HttpError(409, "not_pending", "this sign-in is not waiting on a second step");
  }
  if (!ctx.config) {
    throw new HttpError(503, "second_factor_unavailable", "codes can't be checked right now");
  }
  return { ...ctx, workos: ctx.workos, config: ctx.config };
}

function entry(
  session: Session,
  action: string,
  outcome: AuditEntry["outcome"],
  httpStatus: number,
  target: Record<string, string> = {},
): AuditEntry {
  return {
    tenantId: null,
    actorKind: "user",
    actorUserId: session.user.id,
    actorEmail: session.user.email,
    action,
    outcome,
    httpStatus,
    target,
  };
}

/** Twilio refused or could not be reached: said plainly, logged without the provider's text. */
function providerFailed(): HttpError {
  return new HttpError(502, "code_service_failed", "we couldn't send or check the code; try again");
}

export function secondFactorRoutes(app: Hono<AppEnv>): void {
  mountPublic(app, routes.secondFactorStatus, async ({ c, services }) => {
    const { session, config } = await stepContext(c);
    const userId = session.user.id;
    const enabled = config !== null;
    const factors = enabled ? await factorsOf(services.db, userId) : [];
    const allowed = enabled ? await allowedKinds(services.db, userId) : [];
    const usable = factors.filter((f) => f.verifiedAt && allowed.includes(f.kind));
    return {
      state: session.secondFactor ?? "exempt",
      enabled,
      allowed: [...allowed],
      methods: factors
        .filter((f) => allowed.includes(f.kind))
        .map((f) => ({ kind: f.kind, phoneHint: phoneHint(f.phone), verified: !!f.verifiedAt })),
      setupNeeded: enabled && usable.length === 0,
      recoveryCodesLeft: enabled ? await recoveryCodesLeft(services.db, userId) : 0,
    };
  });

  mountPublic(app, routes.secondFactorSetup, async ({ c, body, services }) => {
    const { session, config } = await pending(c);
    const userId = session.user.id;
    const db = services.db;
    const allowed = await allowedKinds(db, userId);
    if (!allowed.includes(body.kind)) {
      throw new HttpError(403, "method_not_allowed", "operators use an authenticator app");
    }
    const factors = await factorsOf(db, userId);
    // DECISION (docs/plan.md §1.99): setup only while a person has no usable method; changing
    // one is an operator's reset, so a stolen password can't swap in the thief's phone.
    if (factors.some((f) => f.verifiedAt && allowed.includes(f.kind))) {
      throw new HttpError(409, "already_set_up", "you already have a method; use it to sign in");
    }
    const now = new Date();
    try {
      if (body.kind === "totp") {
        const old = factors.find((f) => f.kind === "totp");
        if (old?.twilioFactorSid) await config.verifier.deleteTotp(userId, old.twilioFactorSid);
        const made = await config.verifier.createTotp(userId, session.user.email);
        await saveFactor(c, userId, { kind: "totp", phone: null, twilioFactorSid: made.factorSid });
        await auditAlone(
          db,
          c,
          entry(session, "session.second_factor_setup", "ok", 200, { kind: "totp" }),
        );
        return { kind: "totp" as const, otpauthUri: made.uri, phoneHint: null };
      }
      if (overLimit(await recentCount(db, userId, "send", now))) throw tooMany();
      await saveFactor(c, userId, { kind: body.kind, phone: body.phone, twilioFactorSid: null });
      await config.verifier.sendCode(body.phone, body.kind);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw providerFailed();
    }
    await auditAlone(
      db,
      c,
      entry(session, "session.second_factor_setup", "ok", 200, { kind: body.kind }),
    );
    await auditAlone(
      db,
      c,
      entry(session, "session.second_factor_send", "ok", 200, { kind: body.kind }),
    );
    return { kind: body.kind, otpauthUri: null, phoneHint: phoneHint(body.phone) };
  });

  mountPublic(app, routes.secondFactorSend, async ({ c, body, services }) => {
    const { session, config } = await pending(c);
    const userId = session.user.id;
    const db = services.db;
    const allowed = await allowedKinds(db, userId);
    const factor = (await factorsOf(db, userId)).find((f) => f.kind === body.kind);
    if (!factor?.phone || !allowed.includes(body.kind)) throw notFound("that method");
    if (overLimit(await recentCount(db, userId, "send", new Date()))) throw tooMany();
    try {
      await config.verifier.sendCode(factor.phone, body.kind);
    } catch {
      throw providerFailed();
    }
    await auditAlone(
      db,
      c,
      entry(session, "session.second_factor_send", "ok", 200, { kind: body.kind }),
    );
    return { ok: true as const, phoneHint: phoneHint(factor.phone) ?? "" };
  });

  mountPublic(app, routes.secondFactorVerify, async ({ c, body, services }) => {
    const { session, config, workos } = await pending(c);
    const userId = session.user.id;
    const db = services.db;
    const now = new Date();
    if (overLimit(await recentCount(db, userId, "wrong_code", now))) throw tooMany();
    const allowed = await allowedKinds(db, userId);
    const factor = (await factorsOf(db, userId)).find((f) => f.kind === body.kind);
    if (!factor || !allowed.includes(body.kind)) throw notFound("that method");

    let right: boolean;
    try {
      if (factor.kind === "totp") {
        const sid = factor.twilioFactorSid ?? "";
        right = factor.verifiedAt
          ? await config.verifier.checkTotp(userId, sid, body.code)
          : await config.verifier.verifyTotp(userId, sid, body.code);
      } else {
        right = await config.verifier.checkCode(factor.phone ?? "", body.code);
      }
    } catch {
      throw providerFailed();
    }
    if (!right) {
      await auditAlone(
        db,
        c,
        entry(session, "session.second_factor", "refused", 422, { method: body.kind }),
      );
      throw new HttpError(422, "wrong_code", "that code is not right, or has expired");
    }

    const firstSetup = !factor.verifiedAt;
    await markUsed(c, userId, factor.id, now, firstSetup);
    const recoveryCodes = firstSetup ? await newRecoveryCodes(db, config, userId) : null;
    if (recoveryCodes) {
      await auditAlone(db, c, entry(session, "session.recovery_codes", "ok", 200));
    }
    await pass(c, workos, session, config, factor.id, body.remember, now, body.kind);
    return {
      ok: true as const,
      recoveryCodes,
      recoveryCodesLeft: await recoveryCodesLeft(db, userId),
    };
  });

  mountPublic(app, routes.secondFactorRecovery, async ({ c, body, services }) => {
    const { session, config, workos } = await pending(c);
    const userId = session.user.id;
    const db = services.db;
    const now = new Date();
    if (overLimit(await recentCount(db, userId, "wrong_code", now))) throw tooMany();
    const allowed = await allowedKinds(db, userId);
    const usable = (await factorsOf(db, userId)).find(
      (f) => f.verifiedAt && allowed.includes(f.kind),
    );
    if (!usable || !(await useRecoveryCode(db, config, userId, body.code, now))) {
      await auditAlone(
        db,
        c,
        entry(session, "session.second_factor", "refused", 422, { method: "recovery" }),
      );
      throw new HttpError(422, "wrong_code", "that recovery code is not right, or was used");
    }
    await pass(c, workos, session, config, usable.id, body.remember, now, "recovery");
    return {
      ok: true as const,
      recoveryCodes: null,
      recoveryCodesLeft: await recoveryCodesLeft(db, userId),
    };
  });

  // An operator resets a person's methods (a lost phone): they set up again at their next sign-in.
  mount(
    app,
    routes.opsSecondFactorReset,
    async ({ c, params, body, tx, tenantIds, session, services }) => {
      // Only someone in a client this operator serves (an operator's own team included).
      const [member] = await tx
        .select({ userId: membership.userId })
        .from(membership)
        .where(and(eq(membership.userId, params.id), inArray(membership.tenantId, [...tenantIds])))
        .limit(1);
      if (!member) throw notFound("person");
      const factors = await tx.select().from(userFactor).where(eq(userFactor.userId, params.id));
      const setup = secondFactorSetupOf(services.env, {
        ...(services.deps.codeVerifier ? { verifier: services.deps.codeVerifier } : {}),
      });
      if (setup.state === "on") {
        for (const f of factors) {
          if (f.twilioFactorSid) {
            await setup.config.verifier
              .deleteTotp(params.id, f.twilioFactorSid)
              .catch(() => undefined);
          }
        }
      }
      await tx.delete(userFactor).where(eq(userFactor.userId, params.id));
      await tx
        .delete(userRecoveryCode)
        .where(and(eq(userRecoveryCode.userId, params.id), isNull(userRecoveryCode.usedAt)));
      await auditInTx(tx, c, {
        tenantId: null,
        actorKind: "user",
        actorUserId: session.user.id,
        actorEmail: session.user.email,
        actorRole: "operator",
        action: "session.second_factor_reset",
        outcome: "ok",
        httpStatus: 200,
        target: { user: params.id, reason: body.reason.slice(0, 200) },
      });
      return { ok: true as const, removed: factors.length };
    },
  );
}

const tooMany = () =>
  new HttpError(429, "too_many_attempts", "too many tries; wait 15 minutes and try again");

/** Inserts or replaces the person's unverified method of one kind. */
async function saveFactor(
  c: AppContext,
  userId: string,
  f: { kind: SecondFactorKind; phone: string | null; twilioFactorSid: string | null },
) {
  const { db } = c.get("req").services();
  await withUser(db, userId, (tx) =>
    tx
      .insert(userFactor)
      .values({ userId, ...f, verifiedAt: null })
      .onConflictDoUpdate({
        target: [userFactor.userId, userFactor.kind],
        set: { phone: f.phone, twilioFactorSid: f.twilioFactorSid, verifiedAt: null },
      }),
  );
}

async function markUsed(
  c: AppContext,
  userId: string,
  factorId: string,
  now: Date,
  verify: boolean,
) {
  const { db } = c.get("req").services();
  await withUser(db, userId, (tx) =>
    tx
      .update(userFactor)
      .set({ lastUsedAt: now, ...(verify ? { verifiedAt: now } : {}) })
      .where(and(eq(userFactor.id, factorId), eq(userFactor.userId, userId))),
  );
}

/** The step is passed: the session becomes `done`, the browser is remembered if asked, audited. */
async function pass(
  c: AppContext,
  workos: WorkOSAdapter,
  session: Session,
  config: SecondFactorConfig,
  factorId: string,
  remember: boolean,
  now: Date,
  method: string,
) {
  const passed = await workos.passSecondFactor(c.req.raw, session.user.id, now);
  if (!passed.ok) throw new HttpError(passed.status, passed.code, passed.message);
  sendCookies(c, passed.setCookies);
  if (remember) {
    sendCookies(c, [
      await deviceCookie(
        { userId: session.user.id, factorId },
        config.cookiePassword,
        Math.floor(now.getTime() / 1000),
      ),
    ]);
  }
  const { db } = c.get("req").services();
  await auditAlone(
    db,
    c,
    entry(session, "session.second_factor", "ok", 200, {
      method,
      ...(remember ? { remembered: "30d" } : {}),
    }),
  );
}
