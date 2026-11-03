import { z } from "zod";
import { JsonSchema, TemplateString, ToolId } from "./common";
import { SideEffect, Verb } from "./permissions";

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
    summary: TemplateString.optional(),
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
  .meta({ id: "ToolSpec" });
export type ToolSpec = z.infer<typeof ToolSpec>;

/** External tools are the builder's "actions": they change a client's tool. */
export function isExternalTool(tool: Pick<ToolSpec, "sideEffect">): boolean {
  return tool.sideEffect === "external";
}
