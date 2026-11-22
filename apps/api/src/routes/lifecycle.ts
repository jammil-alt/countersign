// Go-live stages, client controls and running a past event live (ARCHITECTURE §10.9, §11.5;
// docs/plan.md §1.36, W1-A). The stage, trial and past-event routes are the operator's (inside
// withOperator, for the clients served); pausing is the client admin's; Run now is for the client
// admin and signing client users (inside withTenant, one client).

import { getAgent } from "@countersign/agents";
import {
  type MissedWhilePaused,
  type PortalSetupAgent,
  routes,
  setupRoutes,
} from "@countersign/core";
import { narrowToTenant } from "@countersign/db";
import type { Hono } from "hono";
import { ensureSeesAgent } from "../assigned";
import { type AppEnv, type HandlerCtx, HttpError, mount, notFound } from "../http";
import {
  controllableAgents,
  pauseAgent,
  pauseAll,
  resumeAgent,
  resumeAll,
  serviceControl,
} from "../lifecycle/pause";
import {
  type MissedEvents,
  missedWhilePaused,
  runForms,
  runMissedEvents,
  runNow,
  runOnEvent,
} from "../lifecycle/runs";
import { goLiveView, moveStage, type StageActor, setTrialMinimums } from "../lifecycle/stages";
import { turnOn, turnOnPreview } from "../lifecycle/turn-on";
import { startAfterCommit } from "../runs/reconcile";
import {
  agentSetupView,
  checklistOf,
  portalSetupAgent,
  portalSetupAgents,
  recordSetupItem,
  shownVersion,
} from "../setup/checklist";
import { receiveUploads } from "./documents";

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

/** The person's name as a checklist shows who did an item (else their email). */
function personName(ctx: Pick<HandlerCtx<never>, "session">): string | null {
  return ctx.session.user.name?.trim() || ctx.session.user.email || null;
}

/**
 * What came in while the agent was paused, as a count and the pause's start and end: never the
 * events or anything they say (invariants 9 and 11).
 */
// DECISION (H7, docs/plan.md §1.195): the portal's resume answer carries the go-live panel's view,
// so the client admin is told the same as the operator; running them stays the operator's.
function missedView(missed: MissedEvents | null): MissedWhilePaused | null {
  if (!missed) return null;
  return {
    count: missed.events.length,
    from: missed.from.toISOString(),
    to: missed.to.toISOString(),
    more: missed.more,
  };
}

/**
 * The checklist as the client sees it: an item we recorded for them reads "by us", never an
 * operator's name or email.
 */
function clientSide(a: PortalSetupAgent): PortalSetupAgent {
  return {
    ...a,
    setup: {
      ...a.setup,
      items: a.setup.items.map((i) => (i.side === "operator" ? { ...i, byName: null } : i)),
    },
  };
}

export function lifecycleRoutes(app: Hono<AppEnv>): void {
  // ── The operator ───────────────────────────────────────────────────────────────────────────────

  // Turn on in one button (docs/builder-plan.md §12.4): one transaction, audited as any route.
  mount(app, routes.opsAgentTurnOnPreview, (ctx) =>
    turnOnPreview(ctx, ctx.params.id, ctx.query.client),
  );

  mount(app, routes.opsAgentTurnOn, (ctx) => turnOn(ctx, ctx.params.id, ctx.body));

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
      for (const r of requests) await startAfterCommit(ctx.services, r);
    });
    return { runs: requests.map((r) => ({ runId: r.runId, workflow: r.workflowSlug })) };
  });

  // Audit 4.2: what came in while the agent was paused (none of it started by itself).
  mount(app, routes.opsMissedEvents, async (ctx) => {
    const row = await clientAgentInScope(ctx, ctx.params.id);
    return { missed: missedView(await missedWhilePaused(ctx.tx, row)) };
  });

  mount(app, routes.opsRunMissedEvents, async (ctx) => {
    const row = await clientAgentInScope(ctx, ctx.params.id);
    const { requests, left } = await runMissedEvents(ctx.tx, {
      tenantId: row.tenantId as string,
      agentId: row.id,
      userId: ctx.session.user.id,
    });
    ctx.afterCommit(async () => {
      for (const r of requests) await startAfterCommit(ctx.services, r);
    });
    return { runs: requests.map((r) => ({ runId: r.runId, workflow: r.workflowSlug })), left };
  });

  // docs/builder-plan.md §6 (B4): the operator records a setup item for the client.
  mount(app, setupRoutes.opsSetupItem, async (ctx) => {
    const row = await clientAgentInScope(ctx, ctx.params.id);
    const updated = await recordSetupItem(ctx.tx, {
      agentId: row.id,
      tenantId: row.tenantId as string,
      itemId: ctx.params.itemId,
      body: ctx.body,
      actor: { userId: ctx.session.user.id, name: personName(ctx), side: "operator" },
      ctx: ctx.services.platform.ctx,
    });
    return { goLive: await goLiveView(ctx.tx, updated, ctx.services.platform.ctx) };
  });

  // G10: the operator sends a file item for the client: the files are stored quietly in the
  // client's documents (as the portal's own setup files are, `for=chat`: no `document.received`,
  // so no agent starts on them, and no CSV import), then recorded on the item as ours.
  // DECISION (G10): the one place the back office uploads into a client that isn't the Sandbox
  // (§1.16 keeps uploads the client's), and only for a file item of that client's own checklist:
  // the client asked us to send it. Who sent it is kept and the portal shows "by us".
  mount(app, setupRoutes.opsSetupItemFiles, async (ctx) => {
    const row = await clientAgentInScope(ctx, ctx.params.id);
    const tenantId = row.tenantId as string;
    const item = checklistOf((await shownVersion(ctx.tx, row))?.bundle).find(
      (i) => i.id === ctx.params.itemId,
    );
    if (!item) throw notFound("setup item");
    if (item.kind !== "file")
      throw new HttpError(422, "not_a_file_item", "This item isn't a file.");
    const { results } = await narrowToTenant(ctx.tx, tenantId, (tx) =>
      receiveUploads({ ...ctx, tx }, tenantId, true),
    );
    const files = results.flatMap((r) => (r.document ? [r.document.id] : []));
    const refused = results.flatMap((r) =>
      r.document ? [] : [{ filename: r.filename, error: r.error ?? "It wasn't kept." }],
    );
    if (files.length === 0) {
      throw new HttpError(422, "no_files", refused[0]?.error ?? "Add the file first.");
    }
    const updated = await recordSetupItem(ctx.tx, {
      agentId: row.id,
      tenantId,
      itemId: item.id,
      body: { files },
      actor: { userId: ctx.session.user.id, name: personName(ctx), side: "operator" },
      ctx: ctx.services.platform.ctx,
    });
    return { goLive: await goLiveView(ctx.tx, updated, ctx.services.platform.ctx), refused };
  });

  // ── The client: Getting started's setup checklists ───────────────────────────────────────────

  mount(app, setupRoutes.portalSetup, async (ctx) => {
    const agents = await portalSetupAgents(
      ctx.tx,
      ctx.tenantIds[0] as string,
      ctx.agents,
      ctx.services.platform.ctx,
    );
    return { agents: agents.map(clientSide) };
  });

  mount(app, setupRoutes.portalSetupItem, async (ctx) => {
    const tenantId = ctx.tenantIds[0] as string;
    ensureSeesAgent(ctx.agents, ctx.params.id);
    const updated = await recordSetupItem(ctx.tx, {
      agentId: ctx.params.id,
      tenantId,
      itemId: ctx.params.itemId,
      body: ctx.body,
      actor: { userId: ctx.session.user.id, name: personName(ctx), side: "client" },
      ctx: ctx.services.platform.ctx,
    });
    const setup = await agentSetupView(ctx.tx, updated, ctx.services.platform.ctx);
    if (!setup) throw notFound("setup checklist");
    return { agent: clientSide(portalSetupAgent(updated, setup)) };
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
    // Audit 4.2: counted, never started: whoever paused it had a reason.
    const missed = await missedWhilePaused(tx, row);
    return {
      service: serviceControl(row),
      missedEvents: missed?.events.length ?? 0,
      missed: missedView(missed),
    };
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
    const tenantId = tenantIds[0] as string;
    const paused = new Set(
      (await controllableAgents(tx, tenantId))
        .filter((a) => a.runStatus === "paused")
        .map((a) => a.id),
    );
    const rows = await resumeAll(tx, { tenantId, by: session.user.id });
    let missedEvents = 0;
    for (const row of rows) {
      if (!paused.has(row.id) || row.runStatus !== "active") continue;
      missedEvents += (await missedWhilePaused(tx, row))?.events.length ?? 0;
    }
    return { services: rows.map(serviceControl), missedEvents };
  });

  // ── Run now ──────────────────────────────────────────────────────────────────────────────────

  mount(app, routes.portalRunForms, async ({ tx, tenantIds, params, agents }) => {
    // §1.122: an agent off a limited client user's list is "not found".
    ensureSeesAgent(agents, params.id);
    return { forms: await runForms(tx, tenantIds[0] as string, params.id) };
  });

  mount(app, routes.portalRunNow, async (ctx) => {
    ensureSeesAgent(ctx.agents, ctx.params.id);
    const request = await runNow(ctx.tx, {
      tenantId: ctx.tenantIds[0] as string,
      agentId: ctx.params.id,
      slug: ctx.params.slug,
      input: ctx.body.input,
      userId: ctx.session.user.id,
      role: ctx.role,
    });
    ctx.afterCommit(() => startAfterCommit(ctx.services, request));
    return { runId: request.runId };
  });
}
