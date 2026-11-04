import { z } from "zod";
import { Duration } from "../duration";
import { ApprovalRequirement } from "./permissions";

/**
 * A write step's approval (ARCHITECTURE §10.1, v0.8): `required` unless the operator switches it
 * off, which validation allows only where the step writes and the connection allows `auto`.
 */
export const Approval = z
  .object({
    required: ApprovalRequirement.default("required"),
    /** A role (`client_admin`, `operator`) or a user id, used when none of the client's approver
     * rules fits; else the agent's, else the client's (docs/plan.md §1.20). */
    approver: z.string().min(1).optional(),
    timeout: Duration.optional(),
    onReject: z.enum(["stop", "continue"]).default("stop"),
  })
  .meta({ id: "Approval" });
export type Approval = z.infer<typeof Approval>;

/** What every new write step starts with. */
export const DEFAULT_APPROVAL: Approval = { required: "required", onReject: "stop" };
