// Approver rules (docs/plan.md §1.17, §1.20): who approves a client's changes. The operator sets a
// client's ordered rules from the back office; the client admin can only make them stricter from
// the portal (core's clientTighteningProblems, enforced here). Rules live in
// `tenant.settings.approver_rules` with a revision; every save is a tenant_change row with who,
// which side and why, and the rules before and after. No migration.
//
// Rules decide WHO approves, never WHETHER: approval-on defaults, the connection matrix and the
// agent's mode are untouched (invariant 8). packages/agents reads the rules at each proposal.

import {
  type ApproverConnectorOption,
  type ApproverPerson,
  type ApproverRule,
  type ApproverRuleChange,
  type ApproverRuleInput,
  clientTighteningProblems,
  deepEqual,
  readApproverRuleSet,
  routes,
  type SaveApproverRules,
  uuidv7,
} from "@countersign/core";
import {
  agent,
  agentVersion,
  appUser,
  membership,
  type Tx,
  tenant,
  tenantChange,
} from "@countersign/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Hono } from "hono";
import { type AppEnv, ensureClient, HttpError, mount, notFound } from "../http";
import type { Platform } from "../platform";
import { offeredConnectors } from "./ops-clients";

const SETTING = "approver_rules";

async function lockTenant(tx: Tx, tenantId: string) {
  const [t] = await tx.select().from(tenant).where(eq(tenant.id, tenantId)).for("update");
  if (!t) throw notFound("client");
  return t;
}

async function people(tx: Tx, tenantId: string): Promise<ApproverPerson[]> {
  const rows = await tx
    .select({
      id: appUser.id,
      name: appUser.name,
      email: appUser.email,
      role: membership.role,
    })
    .from(membership)
    .innerJoin(appUser, eq(appUser.id, membership.userId))
    .where(
      and(
        eq(membership.tenantId, tenantId),
        inArray(membership.role, ["client_admin", "client_user"]),
      ),
    )
    .orderBy(appUser.email);
  return rows.map((r) => ({ ...r, role: r.role as ApproverPerson["role"] }));
}

/** The client's own agents (no templates' test copies, nothing retired). */
async function clientAgents(tx: Tx, tenantId: string) {
  const rows = await tx
    .select({ a: agent, bundle: agentVersion.bundle })
    .from(agent)
    .leftJoin(agentVersion, eq(agentVersion.id, agent.liveVersionId))
    .where(
      and(
        eq(agent.tenantId, tenantId),
        eq(agent.kind, "client"),
        eq(agent.status, "active"),
        eq(agent.testCopy, false),
      ),
    )
    .orderBy(agent.slug);
  return rows
    .filter(({ a }) => a.runStatus !== "retired")
    .map(({ a, bundle }) => ({
      id: a.id,
      name: a.serviceName ?? a.name,
      approver: bundle?.definition.permissions.approver ?? a.approver ?? null,
    }));
}

/** Write tools rules can name, per connector (all registered, or those the client is offered). */
function connectorOptions(
  platform: Platform,
  only?: ReadonlySet<string>,
): ApproverConnectorOption[] {
  return platform.connectors
    .list()
    .filter((c) => !only || only.has(c.manifest.id))
    .map((c) => ({
      id: c.manifest.id,
      name: c.manifest.name,
      tools: c.manifest.tools
        .filter((t) => t.sideEffect === "external")
        .map((t) => ({
          id: t.id,
          description: t.description,
          verb: t.verb,
          amount: t.amount !== undefined,
        })),
    }))
    .filter((c) => c.tools.length > 0);
}

async function changes(tx: Tx, tenantId: string, nameOperators: boolean) {
  const rows = await tx
    .select({
      id: tenantChange.id,
      change: tenantChange.change,
      reason: tenantChange.reason,
      name: appUser.name,
      email: appUser.email,
      createdAt: tenantChange.createdAt,
    })
    .from(tenantChange)
    .leftJoin(appUser, eq(appUser.id, tenantChange.actorId))
    .where(eq(tenantChange.tenantId, tenantId))
    .orderBy(desc(tenantChange.createdAt), desc(tenantChange.id))
    .limit(200);
  return rows
    .filter((r) => r.change.setting === SETTING)
    .map((r): ApproverRuleChange => {
      const side = r.change.side === "client" ? "client" : "operator";
      const to = r.change.to as { revision?: unknown } | undefined;
      return {
        id: r.id,
        side,
        // DECISION: the portal names the client's own people and calls the operator's side "we".
        by: side === "operator" && !nameOperators ? null : (r.name ?? r.email ?? null),
        reason: r.reason,
        revision: typeof to?.revision === "number" ? to.revision : 0,
        createdAt: r.createdAt.toISOString(),
      };
    });
}

/**
 * Checks what a saved rule refers to: a client user of this client, one of its agents, a
 * registered connector and write tool that agree, and an amount only where the tool carries one.
 */
function referenceProblems(
  rules: readonly ApproverRuleInput[],
  ctx: {
    platform: Platform;
    people: readonly ApproverPerson[];
    agentIds: ReadonlySet<string>;
  },
): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  rules.forEach((r, i) => {
    const at = `rule ${i + 1}`;
    if (r.id) {
      if (ids.has(r.id)) problems.push(`${at}: the same rule twice`);
      ids.add(r.id);
    }
    if (r.approver.kind === "user") {
      const userId = r.approver.userId;
      if (!ctx.people.some((p) => p.id === userId)) {
        problems.push(`${at}: the approver is not one of this client's people`);
      }
    }
    const m = r.match;
    if (m.agentId && !ctx.agentIds.has(m.agentId)) {
      problems.push(`${at}: that agent is not one of this client's`);
    }
    if (m.connector && !ctx.platform.connectors.has(m.connector)) {
      problems.push(`${at}: no connector ${m.connector}`);
    }
    if (m.tool) {
      const hit = ctx.platform.connectors.findTool(m.tool);
      if (hit?.spec.sideEffect !== "external") {
        problems.push(`${at}: no change tool ${m.tool}`);
      } else {
        if (m.connector && hit.connector.manifest.id !== m.connector) {
          problems.push(`${at}: ${m.tool} is not a ${m.connector} tool`);
        }
        if (m.verb && hit.spec.verb !== m.verb) {
          problems.push(`${at}: ${m.tool} never does ${m.verb}`);
        }
        if (m.amountOver && !hit.spec.amount) {
          problems.push(`${at}: ${m.tool} carries no amount`);
        }
      }
    }
  });
  return problems;
}

export async function save(
  tx: Tx,
  input: {
    tenantId: string;
    body: SaveApproverRules;
    side: "operator" | "client";
    actorId: string;
    platform: Platform;
  },
): Promise<void> {
  const t = await lockTenant(tx, input.tenantId);
  const current = readApproverRuleSet(t.settings);
  if (input.body.revision !== current.revision) {
    throw new HttpError(409, "stale", "someone changed these rules since you opened them; reload");
  }
  const byId = new Map(current.rules.map((r) => [r.id, r]));
  if (input.side === "client") {
    const problems = clientTighteningProblems(current.rules, input.body.rules);
    if (problems.length > 0) {
      throw new HttpError(403, "loosening", "you can only make approvals stricter", problems);
    }
  }
  // v0.12 W1-D: a viewer is never an approver (ARCHITECTURE §4).
  const named = input.body.rules.flatMap((r) =>
    r.approver.kind === "user" ? [r.approver.userId] : [],
  );
  if (named.length > 0) {
    const viewers = await tx
      .select({ userId: membership.userId })
      .from(membership)
      .where(
        and(
          eq(membership.tenantId, input.tenantId),
          inArray(membership.userId, named),
          eq(membership.canSign, false),
        ),
      );
    if (viewers.length > 0) {
      throw new HttpError(
        422,
        "not_a_signer",
        "a rule names someone who doesn't approve (a viewer)",
      );
    }
  }
  const [who, agents] = await Promise.all([
    people(tx, input.tenantId),
    clientAgents(tx, input.tenantId),
  ]);
  const problems = referenceProblems(input.body.rules, {
    platform: input.platform,
    people: who,
    agentIds: new Set(agents.map((a) => a.id)),
  });
  if (problems.length > 0) {
    throw new HttpError(422, "invalid_rule", problems.join("; "), problems);
  }
  // DECISION: the server keeps who added each rule (a rule the client adds is "client", one the
  // operator adds "operator", whatever the body says) and makes ids for new rules.
  const rules: ApproverRule[] = input.body.rules.map((r) => {
    const old = r.id ? byId.get(r.id) : undefined;
    const note = r.note?.trim();
    return {
      id: old?.id ?? r.id ?? uuidv7(),
      match: r.match,
      approver: r.approver,
      setBy: old?.setBy ?? input.side,
      ...(note ? { note } : {}),
    };
  });
  if (deepEqual(rules, current.rules)) throw new HttpError(409, "no_op", "nothing changed");
  const next = { revision: current.revision + 1, rules };
  await tx
    .update(tenant)
    .set({ settings: { ...t.settings, [SETTING]: next } })
    .where(eq(tenant.id, t.id));
  await tx.insert(tenantChange).values({
    tenantId: t.id,
    actorId: input.actorId,
    change: { setting: SETTING, side: input.side, from: current, to: next },
    reason: input.body.reason,
  });
}

async function opsView(tx: Tx, tenantId: string, platform: Platform) {
  const [t] = await tx.select().from(tenant).where(eq(tenant.id, tenantId));
  if (!t) throw notFound("client");
  const set = readApproverRuleSet(t.settings);
  const approvals = t.settings.approvals as { external_actions?: unknown } | undefined;
  const fallback = approvals?.external_actions ?? t.settings["approvals.external_actions"];
  return {
    ...set,
    people: await people(tx, tenantId),
    connectors: connectorOptions(platform),
    changes: await changes(tx, tenantId, true),
    agents: await clientAgents(tx, tenantId),
    clientDefault: typeof fallback === "string" ? fallback : null,
  };
}

async function portalView(tx: Tx, tenantId: string, platform: Platform, canTighten: boolean) {
  const [t] = await tx.select().from(tenant).where(eq(tenant.id, tenantId));
  if (!t) throw notFound("client");
  const set = readApproverRuleSet(t.settings);
  // The client sees the tools it is offered, and any a rule already names.
  const shown = new Set([
    ...offeredConnectors(t.settings),
    ...set.rules.flatMap((r) => (r.match.connector ? [r.match.connector] : [])),
    ...set.rules.flatMap((r) => {
      const hit = r.match.tool ? platform.connectors.findTool(r.match.tool) : undefined;
      return hit ? [hit.connector.manifest.id] : [];
    }),
  ]);
  const agents = await clientAgents(tx, tenantId);
  return {
    ...set,
    people: await people(tx, tenantId),
    connectors: connectorOptions(platform, shown),
    changes: await changes(tx, tenantId, false),
    agents: agents.map((a) => ({ id: a.id, name: a.name })),
    canTighten,
  };
}

export function approverRuleRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.opsApproverRules, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    return opsView(ctx.tx, ctx.params.id, ctx.services.platform);
  });

  mount(app, routes.opsSaveApproverRules, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    await save(ctx.tx, {
      tenantId: ctx.params.id,
      body: ctx.body,
      side: "operator",
      actorId: ctx.session.user.id,
      platform: ctx.services.platform,
    });
    return opsView(ctx.tx, ctx.params.id, ctx.services.platform);
  });

  mount(app, routes.portalApproverRules, async ({ tx, tenantIds, role, services }) =>
    portalView(tx, tenantIds[0] as string, services.platform, role === "client_admin"),
  );

  mount(app, routes.portalSaveApproverRules, async ({ tx, tenantIds, session, body, services }) => {
    const tenantId = tenantIds[0] as string;
    await save(tx, {
      tenantId,
      body,
      side: "client",
      actorId: session.user.id,
      platform: services.platform,
    });
    return portalView(tx, tenantId, services.platform, true);
  });
}
