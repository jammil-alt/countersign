// Go-live stages, client controls and running a past event live (ARCHITECTURE §10.9, §11.5;
// docs/plan.md §1.36, W1-A). The stage, trial and past-event routes are the operator's (inside
// withOperator, for the clients served); pausing is the client admin's; Run now is for the client
// admin and signing client users (inside withTenant, one client).

import { getAgent } from "@countersign/agents";
import { routes } from "@countersign/core";
import type { Hono } from "hono";
import { type AppEnv, type HandlerCtx, HttpError, mount, notFound } from "../http";
import {
  controllableAgents,
  pauseAgent,
  pauseAll,
  resumeAgent,
  resumeAll,
  serviceControl,
} from "../lifecycle/pause";
import { runForms, runNow, runOnEvent } from "../lifecycle/runs";
import { goLiveView, moveStage, type StageActor, setTrialMinimums } from "../lifecycle/stages";

/** A client agent of a client this operator serves. */
async function clientAgentInScope(ctx: Pick<HandlerCtx<never>, "tx" | "tenantIds">, id: string) {
  const row = await getAgent(ctx.tx, id);
  if (row.tenantId === null || !ctx.tenantIds.includes(row.tenantId)) throw notFound("agent");
  if (row.kind !== "client") throw new HttpError(422, "not_a_client_agent", "not a client agent");
  return row;
}

function actorOf(ctx: Pick<HandlerCtx<never>, "session" | "role">): StageActor {
  return {
    actorKind: "user",
    actorUserId: ctx.session.user.id,
    actorEmail: ctx.session.user.email,
    actorRole: ctx.role,
  };
}

export function lifecycleRoutes(app: Hono<AppEnv>): void {
  // ── The operator ───────────────────────────────────────────────────────────────────────────────

  mount(app, routes.opsAgentGoLive, async (ctx) => {
    const row = await clientAgentInScope(ctx, ctx.params.id);
    return { goLive: await goLiveView(ctx.tx, row, ctx.services.platform.ctx) };
  });

  mount(app, routes.opsAgentStage, async (ctx) => {
    const row = await clientAgentInScope(ctx, ctx.params.id);
    const updated = await moveStage(ctx.tx, {
      agentId: row.id,
      to: ctx.body.to,
      reason: ctx.body.reason ?? null,
      actorId: ctx.session.user.id,
      actor: actorOf(ctx),
      ctx: ctx.services.platform.ctx,
    });
    return { goLive: await goLiveView(ctx.tx, updated, ctx.services.platform.ctx) };
  });

  mount(app, routes.opsAgentTrial, async (ctx) => {
    const row = await clientAgentInScope(ctx, ctx.params.id);
    const updated = await setTrialMinimums(ctx.tx, {
      agentId: row.id,
      minDays: ctx.body.minDays,
      minRuns: ctx.body.minRuns,
      actorId: ctx.session.user.id,
      actor: actorOf(ctx),
    });
    return { goLive: await goLiveView(ctx.tx, updated, ctx.services.platform.ctx) };
  });

  mount(app, routes.opsRunOnEvent, async (ctx) => {
    const row = await clientAgentInScope(ctx, ctx.params.id);
    const requests = await runOnEvent(ctx.tx, {
      tenantId: row.tenantId as string,
      agentId: row.id,
      eventId: ctx.body.eventId,
      userId: ctx.session.user.id,
    });
    ctx.afterCommit(async () => {
      for (const r of requests) await ctx.services.instances.start(r);
    });
    return { runs: requests.map((r) => ({ runId: r.runId, workflow: r.workflowSlug })) };
  });

  // ── The client admin: pause and resume ───────────────────────────────────────────────────────

  mount(app, routes.portalServiceControls, async ({ tx, tenantIds }) => {
    const tenantId = tenantIds[0] as string;
    return { services: (await controllableAgents(tx, tenantId)).map(serviceControl) };
  });

  mount(app, routes.portalPauseService, async ({ tx, tenantIds, params, body, session }) => {
    const row = await pauseAgent(tx, {
      tenantId: tenantIds[0] as string,
      agentId: params.id,
      side: "client",
      by: session.user.id,
      reason: body.reason,
      until: body.until,
    });
    return { service: serviceControl(row) };
  });

  mount(app, routes.portalResumeService, async ({ tx, tenantIds, params, session }) => {
    const row = await resumeAgent(tx, {
      tenantId: tenantIds[0] as string,
      agentId: params.id,
      side: "client",
      by: session.user.id,
    });
    return { service: serviceControl(row) };
  });

  mount(app, routes.portalPauseAll, async ({ tx, tenantIds, body, session }) => {
    const rows = await pauseAll(tx, {
      tenantId: tenantIds[0] as string,
      by: session.user.id,
      reason: body.reason,
      until: body.until,
    });
    return { services: rows.map(serviceControl) };
  });

  mount(app, routes.portalResumeAll, async ({ tx, tenantIds, session }) => {
    const rows = await resumeAll(tx, { tenantId: tenantIds[0] as string, by: session.user.id });
    return { services: rows.map(serviceControl) };
  });

  // ── Run now ──────────────────────────────────────────────────────────────────────────────────

  mount(app, routes.portalRunForms, async ({ tx, tenantIds, params }) => ({
    forms: await runForms(tx, tenantIds[0] as string, params.id),
  }));

  mount(app, routes.portalRunNow, async (ctx) => {
    const request = await runNow(ctx.tx, {
      tenantId: ctx.tenantIds[0] as string,
      agentId: ctx.params.id,
      slug: ctx.params.slug,
      input: ctx.body.input,
      userId: ctx.session.user.id,
    });
    ctx.afterCommit(() => ctx.services.instances.start(request));
    return { runId: request.runId };
  });
}
