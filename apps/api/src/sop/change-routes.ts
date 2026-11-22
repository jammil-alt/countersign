// The routes that change what an agent's SOP says (docs/sop-plan.md §6), and which agents each
// changes. `mount()` records their revisions after the handler, in the request's transaction, with
// the signed-in person as who made the change (http.ts `withSopRevisions`). Changes made away from a
// session route (a stage moved by the hourly pass, a connection's health) are caught by the read's
// and the hourly check's safety net instead.
//
// DECISION: a declarative list keyed by "METHOD path", as ASSIGNED_USER_ROUTES is, rather than a
// call in each handler: one place says which changes make a revision, the writers need no platform
// registry, and a test checks each entry names a real route. Including too many agents is harmless:
// an agent whose SOP didn't change gets no revision (its fingerprint is the same).

import { agent, areaOwner, type Tx } from "@countersign/db";
import { eq } from "drizzle-orm";
import { agentsUsingConnection, clientAgentIds, type SopRevisionSource } from "./revisions";

export interface SopChangeCtx {
  tx: Tx;
  params: Record<string, string>;
  tenantIds: readonly string[];
}

type Scope = { tenantId: string; agentIds: string[] } | null;

export interface SopChangeRoute {
  source: SopRevisionSource;
  scope: (ctx: SopChangeCtx) => Promise<Scope>;
}

/** A client agent by the `:id` (or named) param: its client and itself. */
const oneAgent =
  (param = "id") =>
  async (ctx: SopChangeCtx): Promise<Scope> => {
    const id = ctx.params[param];
    if (!id) return null;
    const [row] = await ctx.tx
      .select({ id: agent.id, tenantId: agent.tenantId, kind: agent.kind })
      .from(agent)
      .where(eq(agent.id, id));
    if (!row?.tenantId || row.kind !== "client" || !ctx.tenantIds.includes(row.tenantId))
      return null;
    return { tenantId: row.tenantId, agentIds: [row.id] };
  };

/** The portal's one client. */
const portalClient = (ctx: SopChangeCtx) => ctx.tenantIds[0] ?? null;

/** Every agent of the portal's client. */
const portalAll = async (ctx: SopChangeCtx): Promise<Scope> => {
  const tenantId = portalClient(ctx);
  return tenantId ? { tenantId, agentIds: await clientAgentIds(ctx.tx, tenantId) } : null;
};

/** Every agent of the client named by `/api/ops/clients/:id`. */
const opsClientAll = async (ctx: SopChangeCtx): Promise<Scope> => {
  const tenantId = ctx.params.id;
  if (!tenantId || !ctx.tenantIds.includes(tenantId)) return null;
  return { tenantId, agentIds: await clientAgentIds(ctx.tx, tenantId) };
};

/** The agents bound to the connection named by `param`, in the given client. */
const usingConnection =
  (client: (ctx: SopChangeCtx) => string | null | undefined, param: string) =>
  async (ctx: SopChangeCtx): Promise<Scope> => {
    const tenantId = client(ctx);
    const connectionId = ctx.params[param];
    if (!tenantId || !connectionId || !ctx.tenantIds.includes(tenantId)) return null;
    return { tenantId, agentIds: await agentsUsingConnection(ctx.tx, tenantId, connectionId) };
  };

/** An agent of the portal's client by param. */
const portalAgent =
  (param: string) =>
  async (ctx: SopChangeCtx): Promise<Scope> => {
    const tenantId = portalClient(ctx);
    const id = ctx.params[param];
    return tenantId && id ? { tenantId, agentIds: [id] } : null;
  };

export const SOP_CHANGE_ROUTES: Readonly<Record<string, SopChangeRoute>> = {
  // A new version of the agent goes live, or an older one again.
  "POST /api/ops/agents/:id/versions/:vid/publish": { source: "version", scope: oneAgent() },
  "POST /api/ops/agents/:id/rollback": { source: "version", scope: oneAgent() },
  "POST /api/ops/agents/:id/update": { source: "version", scope: oneAgent() },
  "POST /api/ops/agents/:id/turn-on": { source: "version", scope: oneAgent() },
  // The agent's own settings outside its version: bindings, people, approver, area, stage.
  "PATCH /api/ops/agents/:id/operation": { source: "agent", scope: oneAgent() },
  "PATCH /api/ops/agents/:id/area": { source: "agent", scope: oneAgent() },
  "POST /api/ops/agents/:id/stage": { source: "stage", scope: oneAgent() },
  // The agent's access to a connection.
  "PUT /api/ops/agents/:id/grants/:connectionId": { source: "grant", scope: oneAgent() },
  "PUT /api/access/agents/:agentId/connections/:connectionId": {
    source: "grant",
    scope: portalAgent("agentId"),
  },
  // What a connection allows, connecting and disconnecting.
  "PATCH /api/connections/:id/permissions": {
    source: "connection",
    scope: usingConnection(portalClient, "id"),
  },
  "DELETE /api/connections/:id": {
    source: "connection",
    scope: usingConnection(portalClient, "id"),
  },
  "POST /api/portal/connections/:connectionId/allow-for/:agentId": {
    source: "connection",
    scope: usingConnection(portalClient, "connectionId"),
  },
  "PUT /api/portal/connections/:connectionId/access": {
    source: "connection",
    scope: usingConnection(portalClient, "connectionId"),
  },
  "POST /api/portal/connection-requests/:id/approve": { source: "connection", scope: portalAll },
  "POST /api/ops/clients/:id/connections/:connectionId/changes": {
    source: "connection",
    scope: usingConnection((ctx) => ctx.params.id, "connectionId"),
  },
  "DELETE /api/ops/clients/:id/connections/:connectionId": {
    source: "connection",
    scope: usingConnection((ctx) => ctx.params.id, "connectionId"),
  },
  // Client-wide: approval rules, business hours, the area owners.
  "PUT /api/approver-rules": { source: "approver_rules", scope: portalAll },
  "PUT /api/ops/clients/:id/approver-rules": { source: "approver_rules", scope: opsClientAll },
  "PUT /api/settings/business-hours": { source: "business_hours", scope: portalAll },
  "PATCH /api/owners/:id": { source: "owner", scope: portalAll },
  // An owner's id names its client only through the row; the operator's scope lists its clients.
  "PATCH /api/ops/owners/:id": { source: "owner", scope: opsOwnerClient },
  "POST /api/ops/owners/:id/versions": { source: "owner", scope: opsOwnerClient },
  // The client's adjustments and setup answers (each a new version made by code).
  "POST /api/services/:id/adjustable/:settingId": { source: "adjust", scope: portalAgent("id") },
  "POST /api/setup/:id/items/:itemId": { source: "adjust", scope: portalAgent("id") },
  "POST /api/ops/agents/:id/setup/:itemId": { source: "adjust", scope: oneAgent() },
};

/** Every agent of the client whose area owner `:id` is. */
async function opsOwnerClient(ctx: SopChangeCtx): Promise<Scope> {
  const id = ctx.params.id;
  if (!id) return null;
  const [row] = await ctx.tx
    .select({ tenantId: areaOwner.tenantId })
    .from(areaOwner)
    .where(eq(areaOwner.id, id));
  if (!row || !ctx.tenantIds.includes(row.tenantId)) return null;
  return { tenantId: row.tenantId, agentIds: await clientAgentIds(ctx.tx, row.tenantId) };
}
