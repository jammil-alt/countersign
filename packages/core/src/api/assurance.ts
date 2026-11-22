import { z } from "zod";
import { AssuranceEvidence, AssuranceRollup } from "../assurance/evidence";
import { AssuranceView } from "../assurance/view";
import { isUuid } from "../ids";
import { defineRoute } from "./contract";
import { ExportFile } from "./exports";

// Agent assurance (docs/agent-assurance-plan.md §5): the SOP's section 14 for the client's admins and
// the team members who work with the agent, and the back office's Security tab. The client's view
// carries no evidence, issue, bundle, instructions, prompts or cost (invariant 11, checked by the
// contract test like every portal route).

const Id = z.string().refine((v) => isUuid(v), "not an id");
const IdParams = z.object({ id: Id });
const OPS = ["operator"] as const;

/** The evidence's filter: a period of dates (UTC, the last 30 days by default), a client, an agent. */
export const EvidenceQuery = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  client: Id.optional(),
  agent: Id.optional(),
});
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
  // §1.231.3 (A4): the evidence for an auditor and the rollup on /ops/security. Back office only:
  // the plan shows neither in the portal (§5). mount() writes each request's audit row.
  opsAssuranceEvidence: defineRoute({
    method: "GET",
    path: "/api/ops/assurance/evidence",
    auth: "session",
    roles: OPS,
    summary:
      "The security checks' stored results over a period, per agent and client, with their evidence ids: the printable page",
    query: EvidenceQuery,
    response: AssuranceEvidence,
  }),
  opsAssuranceEvidenceCsv: defineRoute({
    method: "GET",
    path: "/api/ops/assurance/evidence.csv",
    auth: "session",
    roles: OPS,
    summary: "The same evidence as CSV",
    query: EvidenceQuery,
    response: ExportFile,
  }),
  opsAssuranceRollup: defineRoute({
    method: "GET",
    path: "/api/ops/assurance/rollup",
    auth: "session",
    roles: OPS,
    summary:
      "Per register control, how many agents' checks were verified over the period, across the clients served",
    query: EvidenceQuery.pick({ from: true, to: true }),
    response: AssuranceRollup,
  }),
};
