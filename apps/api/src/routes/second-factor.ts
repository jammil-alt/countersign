// The second step of signing in (docs/plan.md §1.100): where a sign-in is with it, setting up the
// first method, sending a code, checking it (and remembering the browser for 30 days), recovery
// codes, an operator's reset, and approving a Claude connection (§1.120). The step's routes run
// outside mount(): they act for the person, never in a client, and a `pending` session must reach
// them (getSession's `allowPendingSecondFactor`); every other route refuses it. The Claude
// connection routes run outside mount() for the same reason, but refuse a pending session.

import {
  deviceCookie,
  getSession,
  mobileSessionFromSetCookies,
  type Session,
  type WorkOSAdapter,
} from "@countersign/auth";
import { routes, type SecondFactorKind } from "@countersign/core";
import { membership, userFactor, userRecoveryCode, withUser } from "@countersign/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Hono } from "hono";
import { type AuditEntry, auditAlone, auditInTx } from "../audit";
import { authDirectory } from "../auth";
import { type AppContext, type AppEnv, HttpError, mount, mountPublic, notFound } from "../http";
import {
  approveConnection,
  checkConfirm,
  connectionView,
  endLink,
  findConnection,
} from "../mcp/approval";
import { PHONE_ENDED_MESSAGE, phoneEndedForPerson } from "../mobile/phone-session";
import {
  ATTEMPT_ACTION,
  allowedKinds,
  claimAttempt,
  claimSend,
  factorsOf,
  newRecoveryCodes,
  phoneHint,
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
  /** The session cookie's value as this request's identify left it (refreshed), or null. */
  current: string | null;
}

/**
 * The signed-in person and the step's configuration; pending or not, unless `passed` (then a
 * pending sign-in is refused with 401 second_factor_required, as on every session route).
 */
async function stepContext(c: AppContext, passed = false): Promise<StepCtx> {
  const services = c.get("req").services();
  const choice = services.auth();
  if (!choice.ok)
    throw new HttpError(choice.refusal.status, choice.refusal.code, choice.refusal.message);
  const result = await getSession(c.req.raw, {
    adapter: choice.adapter,
    directory: authDirectory(services.db),
    allowPendingSecondFactor: !passed,
  });
  if (!result.ok) {
    sendCookies(c, result.setCookies);
    throw new HttpError(result.status, result.code, result.message);
  }
  // Audit 5.2: these routes run outside mount(), so they ask for themselves whether a phone
  // session was ended by a removed phone (approving a Claude connection included).
  if (await phoneEndedForPerson(services.db, result.session)) {
    throw new HttpError(401, "session_invalid", PHONE_ENDED_MESSAGE);
  }
  sendCookies(c, result.setCookies);
  const setup = secondFactorSetupOf(services.env, {
    ...(services.deps.codeVerifier ? { verifier: services.deps.codeVerifier } : {}),
  });
  return {
    session: result.session,
    workos: choice.workos,
    config: setup.state === "on" ? setup.config : null,
    // A WorkOS refresh during this request rotated the session: passing the step reseals that one.
    current: mobileSessionFromSetCookies(result.setCookies) || null,
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
    // DECISION (docs/plan.md §1.100): setup only while a person has no usable method; changing
    // one is an operator's reset, so a stolen password can't swap in the thief's phone.
    if (factors.some((f) => f.verifiedAt && allowed.includes(f.kind))) {
      throw new HttpError(409, "already_set_up", "you already have a method; use it to sign in");
    }
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
      await sendOnce(c, session, body.kind);
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
    return { kind: body.kind, otpauthUri: null, phoneHint: phoneHint(body.phone) };
  });

  mountPublic(app, routes.secondFactorSend, async ({ c, body, services }) => {
    const { session, config } = await pending(c);
    const userId = session.user.id;
    const db = services.db;
    const allowed = await allowedKinds(db, userId);
    const factor = (await factorsOf(db, userId)).find((f) => f.kind === body.kind);
    if (!factor?.phone || !allowed.includes(body.kind)) throw notFound("that method");
    await sendOnce(c, session, body.kind);
    try {
      await config.verifier.sendCode(factor.phone, body.kind);
    } catch {
      throw providerFailed();
    }
    return { ok: true as const, phoneHint: phoneHint(factor.phone) ?? "" };
  });

  mountPublic(app, routes.secondFactorVerify, async ({ c, body, services }) => {
    const { session, config, workos, current } = await pending(c);
    const userId = session.user.id;
    const db = services.db;
    const now = new Date();
    const allowed = await allowedKinds(db, userId);
    const factor = (await factorsOf(db, userId)).find((f) => f.kind === body.kind);
    if (!factor || !allowed.includes(body.kind)) throw notFound("that method");
    await tryOnce(c, session, body.kind);

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
    await pass(c, workos, current, session, config, factor.id, body.remember, now, body.kind);
    return {
      ok: true as const,
      recoveryCodes,
      recoveryCodesLeft: await recoveryCodesLeft(db, userId),
    };
  });

  mountPublic(app, routes.secondFactorRecovery, async ({ c, body, services }) => {
    const { session, config, workos, current } = await pending(c);
    const userId = session.user.id;
    const db = services.db;
    const now = new Date();
    await tryOnce(c, session, "recovery");
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
    await pass(c, workos, current, session, config, usable.id, body.remember, now, "recovery");
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

// ── The Claude connector's approval link (docs/plan.md §1.120) ─────────────────────────────────

/** The signed-in person (past the step) and their own connection behind `code`. */
async function connectionFor(c: AppContext, code: string) {
  const { session, config } = await stepContext(c, true);
  // Links are only given while the step is on; without its key no code can be matched.
  if (!config) {
    throw new HttpError(503, "second_factor_unavailable", "codes can't be checked right now");
  }
  const { db } = c.get("req").services();
  const row = await findConnection(db, config.recoveryKeys, session.user.id, code);
  // Another person's link answers as one that matches nothing: it says nothing about theirs.
  if (!row) throw notFound("Claude connection");
  return { session, row, keys: config.recoveryKeys };
}

export function claudeConnectionRoutes(app: Hono<AppEnv>): void {
  mountPublic(app, routes.claudeConnection, async ({ c }) => {
    const { row } = await connectionFor(c, c.req.param("code") ?? "");
    return connectionView(row, new Date());
  });

  mountPublic(app, routes.claudeConnectionApprove, async ({ c, body, services }) => {
    const code = c.req.param("code") ?? "";
    const { session, row, keys } = await connectionFor(c, code);
    const now = new Date();
    const view = connectionView(row, now);
    if (view.status === "approved") return view;
    if (view.status === "expired") {
      throw new HttpError(409, "expired", "this link has expired; ask Claude again for a new one");
    }
    // Audit 5.3: the code Claude showed beside the link, typed here (any key's, as the link's),
    // at most CLAUDE_CONFIRM_MAX_TRIES wrong ones per link.
    const checked = await checkConfirm({
      db: services.db,
      row,
      keys,
      code,
      typed: body.confirm,
      wrongRow: (tx) =>
        auditInTx(
          tx,
          c,
          entry(session, "mcp.approve", "refused", 422, {
            connection: row.id,
            reason: "wrong_code",
          }),
        ),
    });
    if (checked === "ended") throw notFound("Claude connection");
    if (checked === "spent") {
      await endLink(services.db, row);
      throw new HttpError(
        429,
        "too_many_attempts",
        "too many wrong codes for this link; ask Claude again for a new one",
      );
    }
    if (checked === "wrong") {
      throw new HttpError(
        422,
        "wrong_code",
        "that isn't the code Claude showed with this link; check it and try again",
      );
    }
    const approved = await approveConnection(services.db, row, now);
    if (approved.approvedNow) {
      await auditAlone(
        services.db,
        c,
        entry(session, "mcp.approve", "ok", 200, { connection: row.id }),
      );
    }
    const after = connectionView(approved.row, now);
    if (after.status !== "approved") {
      throw new HttpError(409, "expired", "this sign-in has ended; connect Claude again");
    }
    return after;
  });
}

const tooMany = () =>
  new HttpError(429, "too_many_attempts", "too many tries; wait 15 minutes and try again");

/**
 * Audit 5.4: one try of a code, claimed (and its row written) before the code is checked; past
 * the limit, 429 and the code is never checked. A failure to claim fails the request.
 */
/**
 * Audit 5.4: one code send, claimed (its `session.second_factor_send` row written) before the
 * message goes out; past the limit, 429 and nothing is sent.
 */
async function sendOnce(c: AppContext, session: Session, kind: string): Promise<void> {
  const { db } = c.get("req").services();
  const claimed = await claimSend(db, session.user.id, (tx) =>
    auditInTx(tx, c, entry(session, "session.second_factor_send", "ok", 200, { kind })),
  );
  if (!claimed) throw tooMany();
}

async function tryOnce(c: AppContext, session: Session, method: string): Promise<void> {
  const { db } = c.get("req").services();
  const claimed = await claimAttempt(db, session.user.id, (tx) =>
    auditInTx(tx, c, entry(session, ATTEMPT_ACTION, "ok", 200, { method })),
  );
  if (!claimed) throw tooMany();
}

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
  /** The session as this request's identify left it (`StepCtx.current`). */
  current: string | null,
  session: Session,
  config: SecondFactorConfig,
  factorId: string,
  remember: boolean,
  now: Date,
  method: string,
) {
  const passed = await workos.passSecondFactor(c.req.raw, session.user.id, now, current);
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
