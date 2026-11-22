import { z } from "zod";
import { isUuid } from "../ids";
import { ManualView } from "../manual/manual";
import { defineRoute } from "./contract";

// The agent manual (docs/builder-plan.md §5, B3). Both surfaces read the same view, made by code
// from the agent's version and its notes for the client: never the bundle, instructions, prompts
// or cost (invariant 11; the portal's is checked by the contract test like every portal route).

const Id = z.string().refine((v) => isUuid(v), "not an id");
const IdParams = z.object({ id: Id });
const OPS = ["operator"] as const;
const CLIENT = ["client_admin", "client_user"] as const;

export const manualRoutes = {
  portalAgentManual: defineRoute({
    method: "GET",
    path: "/api/services/:id/manual",
    auth: "session",
    roles: CLIENT,
    summary:
      "An agent's manual as the client reads it: what it does, how it works, its decisions, decision points, known risks, what we set up and what it learned",
    params: IdParams,
    response: ManualView,
  }),
  opsAgentManual: defineRoute({
    method: "GET",
    path: "/api/ops/agents/:id/manual",
    auth: "session",
    roles: OPS,
    summary:
      "An agent's manual: its latest version's (or `version`'s), with a client agent's notes for its client",
    params: IdParams,
    query: z.object({ version: z.coerce.number().int().positive().optional() }),
    response: ManualView,
  }),
  opsAgentForgetNote: defineRoute({
    method: "DELETE",
    path: "/api/ops/agents/:id/memory/:noteId",
    auth: "session",
    roles: OPS,
    summary:
      "Delete one of a client agent's notes for its client (the manual's What it learned); not a new version",
    params: z.object({ id: Id, noteId: Id }),
    response: z.object({ ok: z.literal(true) }),
  }),
};
