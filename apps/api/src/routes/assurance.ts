// Agent assurance (docs/agent-assurance-plan.md §5): the SOP's section 14 in the portal (the client's
// admins, and the team members who work with the agent: ASSIGNED_USER_ROUTES), and the back
// office's Security tab with "Run the checks now". Both are core's `assuranceView`; the portal's
// leaves out the evidence and the issue (invariant 11).

import { getAgent } from "@countersign/agents";
import type { ObjectStore } from "@countersign/connectors";
import { assuranceRoutes } from "@countersign/core";
import { agent, type Tx } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { ensureSeesAgent } from "../assigned";
import type { AssuranceEnv } from "../assurance/inputs";
import { readAssurance, runAgentChecks } from "../assurance/run";
import type { Bindings } from "../env";
import { type AppEnv, mount, notFound } from "../http";
import { secondFactorSetupOf } from "../second-factor";
import { vaultFor } from "../secrets";

/**
 * The checks' settings. With `objects`, the checks that read stored secrets and model requests run
 * too (§1.231.2); a view never needs them.
 */
export function assuranceEnv(env: Bindings, objects?: ObjectStore | null): AssuranceEnv {
  return {
    covered: env.BAA_PROCESSORS,
    secondFactorOn: secondFactorSetupOf(env).state === "on",
    ...(objects !== undefined
      ? {
          scan: {
            vault: env.ENCRYPTION_KEY ? (tx: Tx) => vaultFor(tx, env) : null,
            bodies: objects,
          },
        }
      : {}),
  };
}

async function opsAgent(tx: Tx, id: string, served: readonly string[]) {
  const row = await getAgent(tx, id);
  if (row.kind !== "client" || row.tenantId === null || !served.includes(row.tenantId)) {
    throw notFound("agent");
  }
  const [a] = await tx.select().from(agent).where(eq(agent.id, row.id));
  if (!a) throw notFound("agent");
  return a;
}

export function assuranceRouteHandlers(app: Hono<AppEnv>): void {
  mount(app, assuranceRoutes.portalAgentAssurance, async (ctx) => {
    const tenantId = ctx.tenantIds[0] as string;
    ensureSeesAgent(ctx.agents, ctx.params.id);
    const [a] = await ctx.tx
      .select()
      .from(agent)
      .where(
        and(eq(agent.id, ctx.params.id), eq(agent.tenantId, tenantId), eq(agent.kind, "client")),
      );
    if (!a || a.testCopy) throw notFound("service");
    const view = await readAssurance(
      ctx.tx,
      ctx.services.platform,
      assuranceEnv(ctx.services.env),
      a,
      "client",
    );
    if (!view) throw notFound("service");
    return view;
  });

  mount(app, assuranceRoutes.opsAgentAssurance, async (ctx) => {
    const a = await opsAgent(ctx.tx, ctx.params.id, ctx.tenantIds);
    const view = await readAssurance(
      ctx.tx,
      ctx.services.platform,
      assuranceEnv(ctx.services.env),
      a,
      "ops",
    );
    if (!view) throw notFound("agent");
    return view;
  });

  mount(app, assuranceRoutes.opsAgentAssuranceRun, async (ctx) => {
    const a = await opsAgent(ctx.tx, ctx.params.id, ctx.tenantIds);
    const env = assuranceEnv(ctx.services.env, ctx.services.deps.objects(ctx.services.env));
    const now = new Date();
    const ran = await runAgentChecks(ctx.tx, ctx.services.platform, env, a, "person", now);
    if (!ran) throw notFound("agent");
    const view = await readAssurance(ctx.tx, ctx.services.platform, env, a, "ops", now);
    if (!view) throw notFound("agent");
    return view;
  });
}
