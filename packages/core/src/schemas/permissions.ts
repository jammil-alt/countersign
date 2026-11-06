import { z } from "zod";

export const Verb = z.enum(["read", "create", "update", "delete"]);
export type Verb = z.infer<typeof Verb>;

export const SideEffect = z.enum(["none", "internal", "external"]);
export type SideEffect = z.infer<typeof SideEffect>;

/** What a connection allows per verb (ARCHITECTURE §6.1). For writes it is a ceiling. */
export const PermissionLevel = z.enum(["auto", "approval", "off"]);
export type PermissionLevel = z.infer<typeof PermissionLevel>;

// ── v0.12 W2-A: permissions per record type (ARCHITECTURE §6.1, docs/plan.md §1.44) ─────────────

/**
 * Names an entity or a scope can't take: used as a key they would reach an object's built-in
 * machinery (`entities.constructor`), so they are refused wherever a key comes from input.
 */
const RESERVED_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "hasownproperty",
  "isprototypeof",
  "propertyisenumerable",
  "tolocalestring",
  "tostring",
  "valueof",
]);

/** Whether `key` may name an entity or a scope (not one of an object's built-in names). */
export function isSafeKey(key: string): boolean {
  return !RESERVED_KEYS.has(key.toLowerCase());
}

/** A record type a connector touches (`bill`, `invoice`), or one of its scopes (`notes_only`). */
export const EntityId = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,39}$/, "lowercase letters, digits and underscores")
  .refine(isSafeKey, "a reserved name");
export type EntityId = z.infer<typeof EntityId>;

/** The scope chosen per verb on an entity, by the scope's id. */
export const EntityScopes = z.strictObject({
  read: EntityId.optional(),
  create: EntityId.optional(),
  update: EntityId.optional(),
  delete: EntityId.optional(),
});
export type EntityScopes = z.infer<typeof EntityScopes>;

/**
 * One entity's levels. A verb left out takes the verb's level (no narrowing); a scope narrows a
 * verb to the scope's tools.
 */
export const EntityLevels = z.strictObject({
  read: PermissionLevel.optional(),
  create: PermissionLevel.optional(),
  update: PermissionLevel.optional(),
  delete: PermissionLevel.optional(),
  scope: EntityScopes.optional(),
});
export type EntityLevels = z.infer<typeof EntityLevels>;

/** At most this many entities in a matrix or a grant. */
export const ENTITIES_MAX = 64;

/** `{[entity]: levels}` on a matrix or a grant; an entity left out takes the verbs' levels. */
export const EntityPermissions = z
  .record(EntityId, EntityLevels)
  .refine((v) => Object.keys(v).length <= ENTITIES_MAX, `at most ${ENTITIES_MAX} entities`)
  .meta({ id: "EntityPermissions" });
export type EntityPermissions = z.infer<typeof EntityPermissions>;

/** A scope a connector declares on one of its entities: a verb narrowed to these tools. */
export const PermissionScope = z.strictObject({
  id: EntityId,
  label: z.string().min(1).max(80),
  verb: Verb,
  tools: z.array(z.string().min(1).max(200)).min(1).max(50),
});
export type PermissionScope = z.infer<typeof PermissionScope>;

/**
 * A record type a connector declares (ARCHITECTURE §6.1 `permissionEntities`): its id, a label
 * people read ("Bills"), the verbs its tools use, and its scopes.
 */
export const PermissionEntity = z
  .strictObject({
    id: EntityId,
    label: z.string().min(1).max(80),
    verbs: z.array(Verb).min(1).max(4),
    scopes: z.array(PermissionScope).max(8).optional(),
  })
  .meta({ id: "PermissionEntity" });
export type PermissionEntity = z.infer<typeof PermissionEntity>;

export const PermissionMatrix = z
  .object({
    read: PermissionLevel.default("auto"),
    create: PermissionLevel.default("approval"),
    update: PermissionLevel.default("approval"),
    delete: PermissionLevel.default("off"),
    /** Connector-specific scope, e.g. "bills, purchases, vendors" or a Gmail label. */
    scope: z.unknown().optional(),
    // v0.12 W2-A: levels per entity, each applied with the verb's (the stricter wins). A matrix
    // without them (every matrix saved before v0.12) gives every entity the verb's level.
    entities: EntityPermissions.optional(),
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
