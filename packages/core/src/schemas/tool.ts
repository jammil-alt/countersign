import { z } from "zod";
import { ToolAmount } from "../approvals/rules";
import { JsonSchema, LocalizedTemplate, ToolId } from "./common";
import { SideEffect, Verb } from "./permissions";
import { ToolDisplay } from "./tool-display";

/**
 * The serializable description of a tool (ARCHITECTURE §9.4): what manifests, the Builder and the
 * builder palette see. The registry in packages/agents pairs it with a handler.
 */
export const ToolSpec = z
  .object({
    id: ToolId,
    description: z.string(),
    input: JsonSchema,
    output: JsonSchema,
    sideEffect: SideEffect,
    verb: Verb,
    /** 'platform', a connector id or a pack id. */
    source: z.string().min(1),
    /** The connector whose connection the tool acts through; required for `external` tools. */
    connector: z.string().min(1).optional(),
    /** Client timeline line over the tool's output, e.g. "Attached {{filename}}". */
    summary: LocalizedTemplate.optional(),
    /**
     * Input fields the tool turns into instructions (e.g. a voice agent's prompt and opening line),
     * so they must be fixed text in the agent's version: an action step's own literal input, never
     * filled from a template or written by a model (invariant 9). The gate refuses any other call,
     * and workflow validation flags them.
     */
    fixedInputs: z.array(z.string().min(1)).optional(),
    /**
     * Where a write carries money in its input, for approver rules on an amount (docs/plan.md
     * §1.20). Tools without it never match an amount rule.
     */
    amount: ToolAmount.optional(),
    /**
     * How the change reads on an approval card: its name, the fields a person reads, their labels
     * and kinds. Writes only; without it the card falls back to the record's own fields.
     */
    display: ToolDisplay.optional(),
  })
  // DECISION: an external tool names its connector explicitly, so the permission gate and the
  // publish check find the connection matrix without guessing from `source`.
  .refine((t) => t.sideEffect !== "external" || t.connector !== undefined, {
    message: "external tools must name their connector",
    path: ["connector"],
  })
  .refine((t) => t.sideEffect !== "none" || t.verb === "read", {
    message: "a tool without side effects must have verb 'read'",
    path: ["verb"],
  })
  .refine((t) => t.display === undefined || t.sideEffect === "external", {
    message: "only external tools describe a change for approval",
    path: ["display"],
  })
  .meta({ id: "ToolSpec" });
export type ToolSpec = z.infer<typeof ToolSpec>;

/** External tools are the builder's "actions": they change a client's tool. */
export function isExternalTool(tool: Pick<ToolSpec, "sideEffect">): boolean {
  return tool.sideEffect === "external";
}
