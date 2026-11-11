import { z } from "zod";
import { ToolAmount } from "../approvals/rules";
import { ToolRecipient } from "../directory/autonomy";
import { JsonSchema, LocalizedTemplate, ToolId } from "./common";
import { EntityId, SideEffect, Verb } from "./permissions";
import { ToolDisplay } from "./tool-display";

// R5 (docs/plan.md §1.86, §9): how a write is taken back. A late "no" (an approval answered after
// its deadline let the write go ahead) is offered this undo, never applied by itself.
/**
 * How a write to a client's tool is taken back.
 * - `none`: it can't be (a message sent, a post made, a call placed, or a create with no void).
 * - `reverse`: another tool of the same connector reverses it (a void, never a delete: delete stays
 *   off), given what the write returned.
 * - `restore`: write the saved before state (`external_action.before`) back, with the same tool
 *   or the named update tool.
 */
export const ToolUndo = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("none") }),
    z.strictObject({ kind: z.literal("reverse"), tool: ToolId }),
    z.strictObject({ kind: z.literal("restore"), tool: ToolId.optional() }),
  ])
  .meta({ id: "ToolUndo" });
export type ToolUndo = z.infer<typeof ToolUndo>;

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
    // §1.73: a verb a person always signs (publishing a page, posting for the client). No
    // connection matrix, grant, step setting or agent mode makes it run on its own, and a step
    // using it can't be set to run without approval (workflow validation, `approval_always`).
    approval: z.literal("always").optional(),
    // R5 (docs/plan.md §9): how the write is taken back. Writes only.
    // DECISION: optional, so specs stored or built before R5 still parse; every connector write
    // tool declares it (a connectors test), and a write without it is treated as `none`.
    undo: ToolUndo.optional(),
    // Skill model (2026-11-10): a tool whose code calls a model inside (reading a document,
    // matching by a model's reading, translating, a web search) says so, with why, so a skill
    // that calls it is labelled AI, never deterministic (`skillKind`). Only a tool that declares
    // it is handed a model (apps/api's pack adapter), and a model call from a tool that doesn't
    // is caught (the runtime's `onUndeclaredModelCall`).
    // DECISION: optional and absent on every tool that calls no model, so specs stored before it
    // parse unchanged.
    usesModel: z.string().min(1).max(300).optional(),
  })
  .refine((t) => t.approval === undefined || t.sideEffect === "external", {
    message: "only external tools can always need a person's signature",
    path: ["approval"],
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
  .refine((t) => t.undo === undefined || t.sideEffect === "external", {
    message: "only external tools say how they are taken back",
    path: ["undo"],
  })
  .refine((t) => t.undo?.kind !== "reverse" || t.undo.tool !== t.id, {
    message: "a write isn't reversed by itself; use restore",
    path: ["undo", "tool"],
  })
  .meta({ id: "ToolSpec" });
export type ToolSpec = z.infer<typeof ToolSpec>;

/** External tools are the builder's "actions": they change a client's tool. */
export function isExternalTool(tool: Pick<ToolSpec, "sideEffect">): boolean {
  return tool.sideEffect === "external";
}

/** Whether the tool's code calls a model inside it (it declares `usesModel`). */
export function toolUsesModel(tool: Pick<ToolSpec, "usesModel"> | undefined): boolean {
  return tool?.usesModel !== undefined;
}

/** §1.73: whether every call of the tool waits for a person's signature, whatever else says. */
export function isAlwaysSigned(tool: Pick<ToolSpec, "sideEffect" | "approval">): boolean {
  return tool.sideEffect === "external" && tool.approval === "always";
}
