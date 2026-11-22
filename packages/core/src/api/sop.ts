import { z } from "zod";
import { isUuid } from "../ids";
import { SopList } from "../sop/list";
import { SopView } from "../sop/view";
import { defineRoute } from "./contract";

// The agent's SOP (docs/sop-plan.md): the portal's SOP tab and the back office's view of it. Both
// read the same view, made by code from the agent's setup now (never the bundle, instructions,
// prompts or cost: invariant 11, checked by the contract test like every portal route).

const Id = z.string().refine((v) => isUuid(v), "not an id");
const IdParams = z.object({ id: Id });
const OPS = ["operator"] as const;
const CLIENT = ["client_admin", "client_user"] as const;

export const sopRoutes = {
  portalAgentSop: defineRoute({
    method: "GET",
    path: "/api/services/:id/sop",
    auth: "session",
    roles: CLIENT,
    summary:
      "An agent's SOP as the client reads it: its process, who takes part, its controls, systems and data, made from how it is set up now, with its revision and their history",
    params: IdParams,
    response: SopView,
  }),
  // S2 (docs/sop-plan.md §6 "Across agents"): the portal's Procedures page. One row per agent the
  // reader can open (a limited client user, only theirs), each made from that agent's own SOP.
  portalSops: defineRoute({
    method: "GET",
    path: "/api/sops",
    auth: "session",
    roles: CLIENT,
    summary:
      "Every agent's SOP in a row: its stage, revision, revision date, what changed last, the systems it uses and who else takes part",
    response: SopList,
  }),
  opsAgentSop: defineRoute({
    method: "GET",
    path: "/api/ops/agents/:id/sop",
    auth: "session",
    roles: OPS,
    summary: "A client agent's SOP, as its client reads it",
    params: IdParams,
    response: SopView,
  }),
};
