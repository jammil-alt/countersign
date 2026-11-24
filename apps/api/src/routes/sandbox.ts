// A client's sandbox (docs/plan.md §1.243): the portal's routes (a client person runs an agent on
// their own data and sees what it would do) and the back office's (the same runs, read by the
// operator; a run is started there with a test run marked `sandbox`). Every route goes through
// `mount()`, which writes the audit row.
import { sandboxRoutes as routes } from "@countersign/core";
import { membership } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { type AppEnv, ensureClient, type HandlerCtx, mount } from "../http";
import { texterFromEnv } from "../notify/mailer";
import { startAfterCommit } from "../runs/reconcile";
import {
  isSandboxClient,
  portalSandbox,
  type SandboxDeps,
  type SandboxReader,
  sandboxRuns,
  sandboxRunView,
  sandboxUse,
  sendToMe,
  startPortalSandboxRun,
} from "../sandbox/sandbox";

// biome-ignore lint/suspicious/noExplicitAny: any route's context, for the helpers below.
type Ctx = HandlerCtx<any>;

/** Whether the person may sign in this client: an admin always; a client user unless a viewer. */
async function canSignHere(ctx: Ctx, tenantId: string): Promise<boolean> {
  if (ctx.role === "client_admin") return true;
  const [m] = await ctx.tx
    .select({ canSign: membership.canSign })
    .from(membership)
    .where(and(eq(membership.tenantId, tenantId), eq(membership.userId, ctx.session.user.id)));
  return m?.canSign ?? false;
}

function deps(ctx: Ctx): SandboxDeps {
  const { services } = ctx;
  return {
    platform: services.platform,
    texter: texterFromEnv(services.env, services.deps.fetch?.(services.env)),
    env: services.env,
  };
}

async function portalReader(ctx: Ctx): Promise<SandboxReader> {
  const tenantId = ctx.tenantIds[0] as string;
  return {
    tenantId,
    userId: ctx.session.user.id,
    email: ctx.session.user.email,
    side: "portal",
    sees: ctx.agents,
    cannotSend: (await canSignHere(ctx, tenantId))
      ? null
      : "Only someone who can sign can have a preview sent.",
  };
}

async function opsReader(ctx: Ctx, tenantId: string): Promise<SandboxReader> {
  ensureClient(ctx, tenantId);
  return {
    tenantId,
    userId: ctx.session.user.id,
    email: ctx.session.user.email,
    side: "ops",
    sees: null,
    // In a real client only the client's own people send from its tools (invariant 8).
    cannotSend: (await isSandboxClient(ctx.tx, tenantId))
      ? null
      : "Only the client's own people can send from their tools. They can press Send to me in their sandbox.",
  };
}

export function sandboxRoutesFor(app: Hono<AppEnv>): void {
  // ── Portal ─────────────────────────────────────────────────────────────────────────────────

  mount(app, routes.portalSandbox, async (ctx) => {
    const tenantId = ctx.tenantIds[0] as string;
    return portalSandbox(ctx.tx, {
      tenantId,
      userId: ctx.session.user.id,
      name: ctx.session.user.name ?? null,
      canSign: await canSignHere(ctx, tenantId),
      sees: ctx.agents,
      platform: ctx.services.platform,
    });
  });

  mount(app, routes.portalSandboxStart, async (ctx) => {
    const tenantId = ctx.tenantIds[0] as string;
    const request = await startPortalSandboxRun(ctx.tx, {
      tenantId,
      userId: ctx.session.user.id,
      name: ctx.session.user.name ?? null,
      canSign: await canSignHere(ctx, tenantId),
      sees: ctx.agents,
      body: ctx.body,
      ctx: ctx.services.platform.ctx,
    });
    // The run's instance starts once its row has committed, as the back office's Test run does.
    ctx.afterCommit(() => startAfterCommit(ctx.services, request));
    return { run: await sandboxRunView(ctx.tx, await portalReader(ctx), deps(ctx), request.runId) };
  });

  mount(app, routes.portalSandboxRun, async (ctx) => ({
    run: await sandboxRunView(ctx.tx, await portalReader(ctx), deps(ctx), ctx.params.runId),
  }));

  mount(app, routes.portalSandboxSend, async (ctx) => ({
    run: await sendToMe(ctx.tx, await portalReader(ctx), deps(ctx), ctx.params),
  }));

  // ── Back office ────────────────────────────────────────────────────────────────────────────

  mount(app, routes.opsSandbox, async (ctx) => {
    const reader = await opsReader(ctx, ctx.params.id);
    return {
      runs: await sandboxRuns(ctx.tx, {
        tenantId: reader.tenantId,
        sees: null,
        side: "ops",
        platform: ctx.services.platform,
      }),
      use: await sandboxUse(ctx.tx, reader.tenantId),
      canSend: reader.cannotSend === null,
    };
  });

  mount(app, routes.opsSandboxRun, async (ctx) => ({
    run: await sandboxRunView(
      ctx.tx,
      await opsReader(ctx, ctx.params.id),
      deps(ctx),
      ctx.params.runId,
    ),
  }));

  mount(app, routes.opsSandboxSend, async (ctx) => ({
    run: await sendToMe(ctx.tx, await opsReader(ctx, ctx.params.id), deps(ctx), {
      runId: ctx.params.runId,
      changeId: ctx.params.changeId,
    }),
  }));
}
