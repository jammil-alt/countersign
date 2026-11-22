import { z } from "zod";
import { AssuranceView } from "../assurance/view";
import { isUuid } from "../ids";
import { defineRoute } from "./contract";

// Agent assurance (docs/agent-assurance-plan.md §5): the SOP's section 14 for the client's admins and
// the team members who work with the agent, and the back office's Security tab. The client's view
// carries no evidence, issue, bundle, instructions, prompts or cost (invariant 11, checked by the
// contract test like every portal route).

const Id = z.string().refine((v) => isUuid(v), "not an id");
const IdParams = z.object({ id: Id });
const OPS = ["operator"] as const;
const CLIENT = ["client_admin", "client_user"] as const;

export const assuranceRoutes = {
  portalAgentAssurance: defineRoute({
    method: "GET",
    path: "/api/services/:id/assurance",
    auth: "session",
    roles: CLIENT,
    summary:
      "An agent's architecture and security: where its work comes from and goes, every security check with its latest result, every control's state, what it keeps and where, what goes to AI, and access to each tool",
    params: IdParams,
    response: AssuranceView,
  }),
  opsAgentAssurance: defineRoute({
    method: "GET",
    path: "/api/ops/agents/:id/assurance",
    auth: "session",
    roles: OPS,
    summary: "A client agent's security checks with their evidence and the issues they opened",
    params: IdParams,
    response: AssuranceView,
  }),
  opsAgentAssuranceRun: defineRoute({
    method: "POST",
    path: "/api/ops/agents/:id/assurance/run",
    auth: "session",
    roles: OPS,
    summary: "Run a client agent's security checks now and keep their results",
    params: IdParams,
    body: z.object({}).strict(),
    response: AssuranceView,
  }),
};
