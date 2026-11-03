import { z } from "zod";

export const Verb = z.enum(["read", "create", "update", "delete"]);
export type Verb = z.infer<typeof Verb>;

export const SideEffect = z.enum(["none", "internal", "external"]);
export type SideEffect = z.infer<typeof SideEffect>;

/** What a connection allows per verb (ARCHITECTURE §6.1). For writes it is a ceiling. */
export const PermissionLevel = z.enum(["auto", "approval", "off"]);
export type PermissionLevel = z.infer<typeof PermissionLevel>;

export const PermissionMatrix = z
  .object({
    read: PermissionLevel.default("auto"),
    create: PermissionLevel.default("approval"),
    update: PermissionLevel.default("approval"),
    delete: PermissionLevel.default("off"),
    /** Connector-specific scope, e.g. "bills, purchases, vendors" or a Gmail label. */
    scope: z.unknown().optional(),
  })
  .meta({ id: "PermissionMatrix" });
export type PermissionMatrix = z.infer<typeof PermissionMatrix>;

/** Defaults when a tool is connected: read auto, create and update approval, delete off. */
export const DEFAULT_PERMISSIONS: PermissionMatrix = {
  read: "auto",
  create: "approval",
  update: "approval",
  delete: "off",
};

/** The agent's own setting (ARCHITECTURE §9.1). `suggest_only`: every write waits. */
export const AgentMode = z.enum(["suggest_only", "act"]);
export type AgentMode = z.infer<typeof AgentMode>;

export const ApprovalRequirement = z.enum(["required", "not_required"]);
export type ApprovalRequirement = z.infer<typeof ApprovalRequirement>;
