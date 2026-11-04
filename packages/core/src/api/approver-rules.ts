import { z } from "zod";
import {
  APPROVER_REASON_MAX,
  APPROVER_RULES_MAX,
  ApproverRule,
  ApproverRuleInput,
} from "../approvals/rules";
import { isUuid } from "../ids";
import { Verb } from "../schemas/permissions";
import { defineRoute } from "./contract";

// Approver rules (docs/plan.md §1.17, §1.20): who approves a client's changes. The operator sets a
// client's rules from the back office; the client admin can only make them stricter from the
// portal. Every save is logged with who and why (tenant_change).

const Id = z.string().refine((v) => isUuid(v), "not an id");
const OPS = ["operator"] as const;
const CLIENT = ["client_admin", "client_user"] as const;

export const ApproverPerson = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string(),
  role: z.enum(["client_admin", "client_user"]),
});
export type ApproverPerson = z.infer<typeof ApproverPerson>;

/** A write tool rules can match on; `amount` says whether it carries one. */
export const ApproverToolOption = z.object({
  id: z.string(),
  description: z.string(),
  verb: Verb,
  amount: z.boolean(),
});

export const ApproverConnectorOption = z.object({
  id: z.string(),
  name: z.string(),
  tools: z.array(ApproverToolOption),
});
export type ApproverConnectorOption = z.infer<typeof ApproverConnectorOption>;

export const ApproverRuleChange = z.object({
  id: z.string(),
  /** Who saved it: the operator's side ("we") or the client's. */
  side: z.enum(["operator", "client"]),
  /** The person's name; the portal leaves the operator's people unnamed. */
  by: z.string().nullable(),
  reason: z.string(),
  revision: z.number().int(),
  createdAt: z.string(),
});
export type ApproverRuleChange = z.infer<typeof ApproverRuleChange>;

const ViewBase = z.object({
  revision: z.number().int().min(0),
  rules: z.array(ApproverRule),
  people: z.array(ApproverPerson),
  connectors: z.array(ApproverConnectorOption),
  /** Newest first. */
  changes: z.array(ApproverRuleChange),
});

/** The back office's view: also each agent's own approver and the client's default, for "try it". */
export const OpsApproverRulesView = ViewBase.extend({
  agents: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      /** What the agent names when no rule matches: its definition's, else the client agent's. */
      approver: z.string().nullable(),
    }),
  ),
  /** `tenant.settings.approvals.external_actions`, when set. */
  clientDefault: z.string().nullable(),
});
export type OpsApproverRulesView = z.infer<typeof OpsApproverRulesView>;

export const PortalApproverRulesView = ViewBase.extend({
  /** The client's own services, by the name it knows them by. */
  agents: z.array(z.object({ id: z.string(), name: z.string() })),
  /** Whether this person may tighten (the client admin). */
  canTighten: z.boolean(),
});
export type PortalApproverRulesView = z.infer<typeof PortalApproverRulesView>;

export const SaveApproverRules = z.strictObject({
  /** The revision the editor started from: a save over someone else's is refused (409 stale). */
  revision: z.number().int().min(0),
  rules: z.array(ApproverRuleInput).max(APPROVER_RULES_MAX),
  reason: z.string().trim().min(1).max(APPROVER_REASON_MAX),
});
export type SaveApproverRules = z.infer<typeof SaveApproverRules>;

export const approverRuleRoutes = {
  opsApproverRules: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/approver-rules",
    auth: "session",
    roles: OPS,
    summary: "A client's approver rules in order, what they can name, and who changed them and why",
    params: z.object({ id: Id }),
    response: OpsApproverRulesView,
  }),
  opsSaveApproverRules: defineRoute({
    method: "PUT",
    path: "/api/ops/clients/:id/approver-rules",
    auth: "session",
    roles: OPS,
    summary: "Replace a client's approver rules (ordered), with a reason; 409 stale or no_op",
    params: z.object({ id: Id }),
    body: SaveApproverRules,
    response: OpsApproverRulesView,
  }),
  portalApproverRules: defineRoute({
    method: "GET",
    path: "/api/approver-rules",
    auth: "session",
    roles: CLIENT,
    summary: "Who approves this client's changes: the rules in order",
    response: PortalApproverRulesView,
  }),
  portalSaveApproverRules: defineRoute({
    method: "PUT",
    path: "/api/approver-rules",
    auth: "session",
    roles: ["client_admin"] as const,
    summary:
      "Make the approver rules stricter, with a reason; 403 loosening for anything looser (never the operator, never removing a rule)",
    body: SaveApproverRules,
    response: PortalApproverRulesView,
  }),
} as const;
