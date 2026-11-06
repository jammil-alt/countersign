import { z } from "zod";
import { ToolAmount } from "../approvals/rules";
import { ToolRecipient } from "../directory/autonomy";
import { JsonSchema, LocalizedTemplate, ToolId } from "./common";
import { EntityId, SideEffect, Verb } from "./permissions";
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
    // v0.12 W1-G: a send tool names the person it messages (docs/plan.md §1.42), so the gate adds
    // their autonomy for the channel as a ceiling.
    recipient: ToolRecipient.optional(),
    // v0.12 W1-F: the record type the tool touches (ARCHITECTURE §6.1 "Permissions per record
    // type"), e.g. `invoice`. v0.12 W2-A: one of its connector's `permissionEntities`; matrices and
    // grants set levels per entity.
    entity: EntityId.optional(),
    // v0.12 W2-A: a tool that works on several record types names the input field that says which
    // (Zoho's `module`), and the entity of each of its values. The gate reads the entity from the
    // call's input; a value it can't map is `off`.
    // DECISION: declared data, not a connector hook, so the gate stays a pure function of the
    // spec, the input and the matrices.
    entityInput: z
      .strictObject({
        field: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/),
        values: z.record(z.string().min(1).max(64), EntityId),
      })
      .optional(),
  })
  .refine((t) => t.entity === undefined || t.entityInput === undefined, {
    message: "a tool names its entity or the input field that says it, not both",
    path: ["entityInput"],
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
