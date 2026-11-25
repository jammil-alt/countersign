// Lockdown routes (docs/plan.md §1.243, docs/lockdown-plan.md §4). The back office locks one client
// or everything and sees what is locked; only the security officer, recently signed in, unlocks. A
// client admin may lock their own account and lift a lock their side made. Each route is audited by
// mount(); each lock and unlock is also in the clients' change logs.

import { type ClientLockRow, LOCK_EVERYTHING_CONFIRM, type Role, routes } from "@countersign/core";
import {
  admitTenant,
  appUser,
  lockClient,
  lockEverything,
  lockState,
  type TenantLock,
  type Tx,
  tenant,
  tenantChange,
  unlockClient,
  unlockEverything,
} from "@countersign/db";
import { eq, inArray, sql } from "drizzle-orm";
import type { Hono } from "hono";
import {
  type AppEnv,
  ensureClient,
  HttpError,
  mount,
  mountLong,
  notFound,
  type Services,
} from "../http";
import {
  checkOperatorUnlock,
  clientAdminEmails,
  endInstances,
  freshProofRefusal,
  isSecurityOfficer,
  securityOfficers,
  sendLockNotices,
  stopClientRuns,
} from "../lockdown/service";
import { mailerFromEnv } from "../notify/mailer";

const mailerOf = (services: Services) =>
  mailerFromEnv(services.env, services.deps.fetch?.(services.env));

async function people(tx: Tx, ids: readonly string[]) {
  if (ids.length === 0)
    return new Map<string, { id: string; name: string | null; email: string }>();
  const rows = await tx
    .select({ id: appUser.id, name: appUser.name, email: appUser.email })
    .from(appUser)
    .where(inArray(appUser.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, r]));
}

async function clientName(tx: Tx, tenantId: string): Promise<string> {
  const [t] = await tx.select({ name: tenant.name }).from(tenant).where(eq(tenant.id, tenantId));
  if (!t) throw notFound("client");
  return t.name;
}

/** Locks one client and stops its runs, in the caller's transaction; notices after the response. */
async function lockOne(
  ctx: {
    tx: Tx;
    services: Services;
    afterCommit(task: () => Promise<unknown>): void;
    defer(task: () => Promise<unknown>): void;
  },
  input: {
    tenantId: string;
    side: TenantLock["side"];
    by: { id: string; email: string };
    reason: string;
  },
) {
  const { tx, services } = ctx;
  const name = await clientName(tx, input.tenantId);
  // Read while the client is still in this transaction's scope: after the lock, nothing else is.
  const admins = await clientAdminEmails(tx, input.tenantId);
  const { changed, lock } = await lockClient(tx, {
    tenantId: input.tenantId,
    side: input.side,
    by: input.by.id,
    reason: input.reason,
  });
  if (!changed) return { changed: false, lockedAt: lock.at, runsStopped: 0 };
  const stopped = await stopClientRuns(tx, input.tenantId, input.by.id);
  ctx.afterCommit(() => endInstances(services.instances, stopped));
  ctx.defer(() =>
    sendLockNotices(mailerOf(services), {
      lockId: `${input.tenantId}:${lock.at}`,
      clientName: name,
      clientAdmins: admins,
      officers: securityOfficers(services.env),
      by: input.by.email,
      reason: input.reason,
    }),
  );
  return { changed: true, lockedAt: lock.at, runsStopped: stopped.length };
}

export function lockdownRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.opsLockdown, async ({ tx, tenantIds, session, services }) => {
    const state = await lockState(tx, tenantIds);
    const by = await people(tx, [
      ...state.clients.map((c) => c.lock.by),
      ...(state.everything ? [state.everything.lockedBy] : []),
    ]);
    const names = state.clients.length
      ? new Map(
          (
            await tx
              .select({ id: tenant.id, name: tenant.name })
              .from(tenant)
              .where(
                inArray(
                  tenant.id,
                  state.clients.map((c) => c.tenantId),
                ),
              )
          ).map((t) => [t.id, t.name]),
        )
      : new Map<string, string>();
    const clients: ClientLockRow[] = state.clients.map((c) => ({
      clientId: c.tenantId,
      clientName: names.get(c.tenantId) ?? "",
      lockedAt: c.lockedAt.toISOString(),
      side: c.lock.side,
      by: by.get(c.lock.by) ?? null,
      reason: c.lock.reason,
      inbound: c.lock.inbound ?? {},
    }));
    return {
      everything: state.everything
        ? {
            lockedAt: state.everything.lockedAt.toISOString(),
            by: by.get(state.everything.lockedBy) ?? null,
            reason: state.everything.reason,
          }
        : null,
      clients,
      canUnlock: isSecurityOfficer(session, services.env),
    };
  });

  mount(app, routes.opsLockClient, async (ctx) => {
    const { tx, params, body, session } = ctx;
    ensureClient(ctx, params.id);
    const name = await clientName(tx, params.id);
    if (body.confirmName.toLowerCase() !== name.trim().toLowerCase()) {
      throw new HttpError(422, "confirm_name", "type the client's name exactly to lock it");
    }
    return lockOne(ctx, {
      tenantId: params.id,
      side: "operator",
      by: session.user,
      reason: body.reason,
    });
  });

  mount(app, routes.opsUnlockClient, async (ctx) => {
    const { tx, params, body, session, services } = ctx;
    checkOperatorUnlock(session, services.env, new Date());
    ensureClient(ctx, params.id);
    const { changed } = await unlockClient(tx, {
      tenantId: params.id,
      by: session.user.id,
      note: body.note,
    });
    return { changed };
  });

  mount(app, routes.opsLockEverything, async (ctx) => {
    const { tx, body, session, services } = ctx;
    if (body.confirm.toLowerCase() !== LOCK_EVERYTHING_CONFIRM) {
      throw new HttpError(422, "confirm", `type "${LOCK_EVERYTHING_CONFIRM}" to lock every client`);
    }
    const { changed, lock } = await lockEverything(tx, {
      by: session.user.id,
      reason: body.reason,
    });
    if (!changed) return { changed: false, lockedAt: lock.lockedAt.toISOString(), runsStopped: 0 };
    // The clients this transaction could see when it began (those served and not locked on their
    // own): each one's history says so, and its runs stop now rather than at their next step.
    const stopped: string[] = [];
    for (const id of await scopeIds(tx)) {
      await tx.insert(tenantChange).values({
        tenantId: id,
        actorId: session.user.id,
        change: { lockEverything: { from: false, to: true } },
        reason: body.reason,
      });
      stopped.push(...(await stopClientRuns(tx, id, session.user.id)));
    }
    ctx.afterCommit(() => endInstances(services.instances, stopped));
    // DECISION: only the security officer is emailed; telling every client's admins at once is
    // an outward step the person locking decides on, not a side effect.
    ctx.defer(() =>
      sendLockNotices(mailerOf(services), {
        lockId: `everything:${lock.lockedAt.toISOString()}`,
        clientName: null,
        clientAdmins: [],
        officers: securityOfficers(services.env),
        by: session.user.email,
        reason: body.reason,
      }),
    );
    return {
      changed: true,
      lockedAt: lock.lockedAt.toISOString(),
      runsStopped: stopped.length,
    };
  });

  mount(app, routes.opsUnlockEverything, async (ctx) => {
    const { tx, body, session, services, tenantIds } = ctx;
    checkOperatorUnlock(session, services.env, new Date());
    const { changed } = await unlockEverything(tx);
    if (changed) {
      // The clients served come back into this transaction (unless locked on their own), so each
      // one's history says so, with the note.
      for (const id of tenantIds) {
        if (!(await admitTenant(tx, id))) continue;
        await tx.insert(tenantChange).values({
          tenantId: id,
          actorId: session.user.id,
          change: { lockEverything: { from: true, to: false } },
          reason: body.note,
        });
      }
    }
    return { changed };
  });

  // The locked page's state: answered while the account is locked (whileLocked).
  mountLong(
    app,
    routes.accountLock,
    async ({ inTx, tenantIds, role }) => {
      const tenantId = tenantIds[0] as string;
      const state = await inTx(({ tx }) => lockState(tx, [tenantId]));
      const own = state.clients[0] ?? null;
      const locked = !!own || !!state.everything;
      return {
        locked,
        lockedAt: own?.lockedAt.toISOString() ?? state.everything?.lockedAt.toISOString() ?? null,
        side: own ? own.lock.side : state.everything ? ("operator" as const) : null,
        // Our reason is ours: a client sees only a reason its own side gave.
        reason: own?.lock.side === "client" ? own.lock.reason : null,
        canUnlock: clientMayUnlock(role, own, !!state.everything),
      };
    },
    { whileLocked: true },
  );

  mount(app, routes.accountLockSet, async (ctx) =>
    lockOne(ctx, {
      tenantId: ctx.tenantIds[0] as string,
      side: "client",
      by: ctx.session.user,
      reason: ctx.body.reason,
    }),
  );

  mountLong(
    app,
    routes.accountUnlock,
    async ({ inTx, tenantIds, role, session, body }) => {
      const stale = freshProofRefusal(session, new Date());
      if (stale) throw stale;
      const tenantId = tenantIds[0] as string;
      return inTx(async ({ tx }) => {
        const state = await lockState(tx, [tenantId]);
        const own = state.clients[0] ?? null;
        if (!own) return { changed: false };
        if (!clientMayUnlock(role, own, !!state.everything)) {
          throw new HttpError(
            403,
            "locked_by_us",
            "we locked this account: we'll unlock it once we've finished looking into it",
          );
        }
        const { changed } = await unlockClient(tx, {
          tenantId,
          by: session.user.id,
          note: body.note,
        });
        return { changed };
      });
    },
    { whileLocked: true },
  );
}

/** A client admin may lift a lock their own side made, while everything isn't locked. */
function clientMayUnlock(
  role: Role,
  own: { lock: TenantLock } | null,
  everything: boolean,
): boolean {
  return role === "client_admin" && own?.lock.side === "client" && !everything;
}

/** The clients in this transaction's scope. */
async function scopeIds(tx: Tx): Promise<string[]> {
  const rows = await tx.execute<{ ids: string | null }>(
    sql`select current_setting('app.tenant_ids', true) as ids`,
  );
  return ([...rows][0]?.ids ?? "")
    .replace(/^\{|\}$/g, "")
    .split(",")
    .filter(Boolean);
}
