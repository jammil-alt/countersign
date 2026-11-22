// Getting started's chapters and the back office's Setup tab (docs/setup-plan.md; docs/plan.md
// §1.185). Portal routes answer the client's own words and people only (invariant 11); the back
// office's are the operator's. Every route goes through `mount()`, which writes the audit row.
import { gettingStartedRoutes as routes } from "@countersign/core";
import { membership, type Tx, tenant } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { ensureSeesAgent } from "../assigned";
import { type AppEnv, type HandlerCtx, HttpError, mount } from "../http";
import { notifyDepsFromEnv, sendNow } from "../notify/tick";
import { startAfterCommit } from "../runs/reconcile";
import { callAnswers, nudge, setupBoard } from "../setup/board";
import { gettingStarted } from "../setup/overview";
import {
  confirmPeople,
  fillSeat,
  peopleChapter,
  tellLeadSeatChanged,
} from "../setup/people-chapter";
import { scopeView, signScope } from "../setup/scope";
import { askToolOf, confirmTool, toolsChapter } from "../setup/tools-chapter";
import { startTry, tryVerdict, tryView } from "../setup/try";
import { markStep, walkthrough } from "../setup/walkthrough";

// biome-ignore lint/suspicious/noExplicitAny: any route's context, for the helpers below.
type Ctx = HandlerCtx<any>;

function nameOf(ctx: Pick<Ctx, "session">): string | null {
  return ctx.session.user.name?.trim() || ctx.session.user.email || null;
}

/** Whether the person may sign in this client: an admin always; a client user unless a viewer. */
async function canSignHere(ctx: Pick<Ctx, "tx" | "role" | "session">, tenantId: string) {
  if (ctx.role === "client_admin") return true;
  const [m] = await ctx.tx
    .select({ canSign: membership.canSign })
    .from(membership)
    .where(and(eq(membership.tenantId, tenantId), eq(membership.userId, ctx.session.user.id)));
  return m?.canSign ?? false;
}

async function clientName(tx: Tx, tenantId: string): Promise<string> {
  const [t] = await tx.select({ name: tenant.name }).from(tenant).where(eq(tenant.id, tenantId));
  return t?.name ?? "A client";
}

export function gettingStartedRoutes(app: Hono<AppEnv>): void {
  // ── Overview ───────────────────────────────────────────────────────────────────────────────

  mount(app, routes.portalGettingStarted, async (ctx) =>
    gettingStarted(ctx.tx, {
      tenantId: ctx.tenantIds[0] as string,
      userId: ctx.session.user.id,
      sees: ctx.agents,
      ctx: ctx.services.platform.ctx,
      now: new Date(),
    }),
  );

  // ── Your people (SU2) ──────────────────────────────────────────────────────────────────────

  const people = (ctx: Ctx) =>
    peopleChapter(ctx.tx, {
      tenantId: ctx.tenantIds[0] as string,
      userId: ctx.session.user.id,
      canEdit: ctx.role === "client_admin",
    });

  mount(app, routes.portalSetupPeople, async (ctx) => ({ people: await people(ctx) }));

  mount(app, routes.portalSetupSeat, async (ctx) => {
    const tenantId = ctx.tenantIds[0] as string;
    const changed = await fillSeat(ctx.tx, {
      tenantId,
      role: ctx.params.role,
      body: ctx.body,
      actorId: ctx.session.user.id,
    });
    if (changed.changedLive.length) {
      const name = await clientName(ctx.tx, tenantId);
      ctx.afterCommit(() =>
        tellLeadSeatChanged(ctx.services.db, {
          tenantId,
          clientName: name,
          label: changed.label,
          byName: nameOf(ctx) ?? "Your client",
          agents: changed.changedLive,
        }),
      );
    }
    return { people: await people(ctx) };
  });

  mount(app, routes.portalSetupPeopleConfirm, async (ctx) => {
    await confirmPeople(ctx.tx, {
      tenantId: ctx.tenantIds[0] as string,
      userId: ctx.session.user.id,
      name: nameOf(ctx),
    });
    return { people: await people(ctx) };
  });

  // ── Your tools (SU3) ───────────────────────────────────────────────────────────────────────

  const toolsInput = (ctx: Ctx) => ({
    tenantId: ctx.tenantIds[0] as string,
    userId: ctx.session.user.id,
    agents: ctx.agents,
    canEdit: ctx.role === "client_admin",
    registry: ctx.services.platform.ctx,
  });

  mount(app, routes.portalSetupTools, async (ctx) => toolsChapter(ctx.tx, toolsInput(ctx)));

  mount(app, routes.portalSetupToolConfirm, async (ctx) => {
    await confirmTool(ctx.tx, {
      ...toolsInput(ctx),
      connector: ctx.params.connector,
      body: ctx.body,
      name: nameOf(ctx),
    });
    return toolsChapter(ctx.tx, toolsInput(ctx));
  });

  mount(app, routes.portalSetupToolAsk, async (ctx) => {
    await askToolOf(ctx.tx, {
      ...toolsInput(ctx),
      connector: ctx.params.connector,
      askUserId: ctx.body.userId,
      name: nameOf(ctx),
    });
    return toolsChapter(ctx.tx, toolsInput(ctx));
  });

  // ── See it work (SU4, SU5) ─────────────────────────────────────────────────────────────────

  const seeInput = async (ctx: Ctx, agentId: string) => {
    const tenantId = ctx.tenantIds[0] as string;
    ensureSeesAgent(ctx.agents, agentId);
    return {
      tenantId,
      agentId,
      userId: ctx.session.user.id,
      name: nameOf(ctx),
      canSign: await canSignHere(ctx, tenantId),
      sees: ctx.agents,
    };
  };

  mount(app, routes.portalSetupWalkthrough, async (ctx) =>
    walkthrough(ctx.tx, await seeInput(ctx, ctx.params.id)),
  );

  mount(app, routes.portalSetupWalkMark, async (ctx) => {
    const input = await seeInput(ctx, ctx.params.id);
    await markStep(ctx.tx, { ...input, stepId: ctx.params.stepId, body: ctx.body });
    return walkthrough(ctx.tx, input);
  });

  mount(app, routes.portalSetupTry, async (ctx) => {
    const input = await seeInput(ctx, ctx.params.id);
    if (!input.canSign) {
      throw new HttpError(403, "cannot_sign", "Only someone who can sign may try an agent.");
    }
    const started = await startTry(ctx.tx, {
      ...input,
      documentId: ctx.body.documentId,
      ctx: ctx.services.platform.ctx,
    });
    // The run's instance starts once its row has committed, as the back office's Test run does.
    ctx.afterCommit(() => startAfterCommit(ctx.services, started.request));
    return { try: started.view };
  });

  mount(app, routes.portalSetupTryView, async (ctx) => ({
    try: await tryView(ctx.tx, {
      ...(await seeInput(ctx, ctx.params.id)),
      runId: ctx.params.runId,
    }),
  }));

  mount(app, routes.portalSetupTryVerdict, async (ctx) => ({
    try: await tryVerdict(ctx.tx, {
      ...(await seeInput(ctx, ctx.params.id)),
      runId: ctx.params.runId,
      stepId: ctx.params.stepId,
      body: ctx.body,
    }),
  }));

  // ── Go live ────────────────────────────────────────────────────────────────────────────────

  const scopeInput = (ctx: Ctx) => {
    ensureSeesAgent(ctx.agents, ctx.params.id);
    return {
      tenantId: ctx.tenantIds[0] as string,
      agentId: ctx.params.id as string,
      userId: ctx.session.user.id,
      name: nameOf(ctx),
      isAdmin: ctx.role === "client_admin",
      platform: ctx.services.platform,
    };
  };

  mount(app, routes.portalSetupScope, async (ctx) => ({
    scope: await scopeView(ctx.tx, scopeInput(ctx)),
  }));

  mount(app, routes.portalSetupScopeSign, async (ctx) => {
    await signScope(ctx.tx, scopeInput(ctx));
    return { scope: await scopeView(ctx.tx, scopeInput(ctx)) };
  });

  // ── The back office's Setup tab (SU6) ──────────────────────────────────────────────────────

  const served = (ctx: Ctx, clientId: string) => {
    if (!ctx.tenantIds.includes(clientId)) {
      throw new HttpError(404, "not_found", "client not found");
    }
    return clientId;
  };

  mount(app, routes.opsSetupBoard, async (ctx) =>
    setupBoard(ctx.tx, {
      tenantId: served(ctx, ctx.params.id),
      now: new Date(),
      ctx: ctx.services.platform.ctx,
    }),
  );

  mount(app, routes.opsSetupNudge, async (ctx) => {
    const tenantId = served(ctx, ctx.params.id);
    const out = await nudge(ctx.tx, {
      tenantId,
      userId: ctx.body.userId,
      by: ctx.session.user.id,
      now: new Date(),
      env: ctx.services.env,
      ctx: ctx.services.platform.ctx,
    });
    // The outbox's row goes at once after the commit, as the onboarding emails do.
    if (out.sent) {
      ctx.afterCommit(() =>
        sendNow(
          ctx.services.db,
          notifyDepsFromEnv(ctx.services.env, ctx.services.deps.fetch?.(ctx.services.env)),
          tenantId,
          new Date(),
        ),
      );
    }
    return out;
  });

  mount(app, routes.opsSetupCallAnswers, async (ctx) => ({
    saved: await callAnswers(ctx.tx, {
      tenantIds: ctx.tenantIds,
      intakeId: ctx.params.id,
      body: ctx.body,
      by: ctx.session.user.id,
    }),
  }));
}
