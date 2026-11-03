import { z } from "zod";
import { ROLES, Role } from "../roles";
import { defineRoute } from "./contract";

export const HealthResponse = z.object({ ok: z.literal(true) });

export const SessionResponse = z.object({
  user: z.object({ id: z.string(), email: z.string(), name: z.string().nullable() }),
  /** True when the user is an operator (back office). */
  operator: z.boolean(),
  /** The clients this session may act in, with the user's role in each. */
  tenants: z.array(z.object({ id: z.string(), name: z.string(), role: Role })),
  /** The client selected now: a portal session's one client, or the operator's switcher choice. */
  activeTenantId: z.string().nullable(),
});
export type SessionResponse = z.infer<typeof SessionResponse>;

/** Routes so far; later milestones add theirs here (ARCHITECTURE §14). */
export const routes = {
  health: defineRoute({
    method: "GET",
    path: "/api/health",
    auth: "public",
    roles: [],
    summary: "Liveness",
    response: HealthResponse,
  }),
  session: defineRoute({
    method: "GET",
    path: "/api/session",
    auth: "session",
    roles: ROLES,
    summary: "The signed-in user, their clients and the active one",
    response: SessionResponse,
  }),
} as const;
export type Routes = typeof routes;
