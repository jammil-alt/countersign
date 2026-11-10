import { z } from "zod";
import { entityProblems } from "../permissions/entities";
import { EventTypeSpec } from "./event";
import { PermissionEntity, PermissionMatrix } from "./permissions";
import { ToolSpec } from "./tool";

/**
 * v0.12 W2-A: problems with a manifest's entities (docs/plan.md §1.44): ids unique; every tool's
 * entity (or each one its input can name) declared, with the tool's verb among the entity's; every
 * scope's tools the connector's own, of that entity and the scope's verb; the starting matrix's
 * entities declared.
 */
export function manifestEntityProblems(m: {
  tools: readonly Pick<ToolSpec, "id" | "verb" | "entity" | "entityInput">[];
  permissionEntities?: readonly PermissionEntity[] | undefined;
  defaultPermissions?: { entities?: PermissionMatrix["entities"] } | undefined;
}): string[] {
  const problems: string[] = [];
  const declared = m.permissionEntities ?? [];
  const ids = declared.map((e) => e.id);
  if (new Set(ids).size !== ids.length) problems.push("entity ids must be unique");
  const entitiesOf = (t: Pick<ToolSpec, "entity" | "entityInput">): string[] =>
    t.entity ? [t.entity] : Object.values(t.entityInput?.values ?? {});
  for (const t of m.tools) {
    for (const id of entitiesOf(t)) {
      const e = declared.find((d) => d.id === id);
      if (!e) problems.push(`tool ${t.id} names entity ${id}, which the connector doesn't declare`);
      else if (!e.verbs.includes(t.verb)) {
        problems.push(`tool ${t.id} is a ${t.verb}, which entity ${id} doesn't list`);
      }
    }
  }
  for (const e of declared) {
    const scopeIds = (e.scopes ?? []).map((s) => s.id);
    if (new Set(scopeIds).size !== scopeIds.length) {
      problems.push(`entity ${e.id}: scope ids must be unique`);
    }
    for (const s of e.scopes ?? []) {
      if (!e.verbs.includes(s.verb)) {
        problems.push(`entity ${e.id}: scope ${s.id} is for ${s.verb}, which it doesn't list`);
      }
      for (const toolId of s.tools) {
        const t = m.tools.find((x) => x.id === toolId);
        if (!t) problems.push(`entity ${e.id}: scope ${s.id} names ${toolId}, not a tool of it`);
        else if (!entitiesOf(t).includes(e.id) || t.verb !== s.verb) {
          problems.push(
            `entity ${e.id}: scope ${s.id} names ${toolId}, not one of its ${s.verb} tools`,
          );
        }
      }
    }
  }
  for (const p of entityProblems(m.defaultPermissions?.entities, declared)) {
    problems.push(`defaultPermissions: ${p}`);
  }
  return problems;
}

/** `<id>.` and each shared namespace's `<ns>.`: what a connector's tool ids and events start with. */
export function connectorPrefixes(m: {
  id: string;
  sharedNamespaces?: readonly string[] | undefined;
}): string[] {
  return [m.id, ...(m.sharedNamespaces ?? [])].map((p) => `${p}.`);
}

/**
 * One field of an API-key connector's credentials (docs/plan.md §1.26 "Write-only secrets"): the
 * portal shows a form of these to the client admin. Secret fields are write-only: no route ever
 * returns them, only whether they are set. Non-secret fields (a username, an account id) may be
 * shown back.
 */
export const CredentialField = z.object({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/),
  label: z.string().min(1).max(80),
  secret: z.boolean(),
  /** A hint under the field, e.g. where to find the key. */
  hint: z.string().max(300).optional(),
});
export type CredentialField = z.infer<typeof CredentialField>;

/** A value entered for a credential field. */
export const CREDENTIAL_VALUE_MAX = 4000;

/**
 * How a client connects a connector: signs in (OAuth, or a hosted link such as Plaid's), enters
 * its key, or nothing at all (no sign-in).
 */
export const ConnectorAuth = z.enum(["oauth2", "api_key", "none"]);
export type ConnectorAuth = z.infer<typeof ConnectorAuth>;

/** ARCHITECTURE §6.1. The code side (sync, handlers, OAuth) lives in packages/connectors. */
export const ConnectorManifest = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
    name: z.string(),
    description: z.string(),
    icon: z.string(),
    auth: ConnectorAuth,
    /**
     * B-5 (docs/plan.md §1.79): a client may connect several accounts of it, one connection each
     * (a second bank); the rest keep one connection per connector.
     */
    multiple: z.boolean().optional(),
    /** What sync brings in: ['Purchase', 'Bill', ...]. */
    entities: z.array(z.string()),
    tools: z.array(ToolSpec),
    /** The matrix a new connection starts with; the platform defaults otherwise. */
    defaultPermissions: PermissionMatrix.optional(),
    /**
     * Event types the connector emits (e.g. `webhook.received`), named `<connector id>.<...>`.
     * They join the event catalogue for every client, like the platform's.
     */
    events: z.array(EventTypeSpec).optional(),
    /**
     * Namespaces the connector shares with other providers of the same thing (e.g. `whatsapp`, which
     * Twilio and, later, Meta both provide): its tool ids and event types may start with
     * `<namespace>.` as well as `<connector id>.`, so a workflow keeps its tools when a client
     * moves from one provider to another (docs/plan.md §1.19, §1.22).
     */
    sharedNamespaces: z
      .array(z.string().regex(/^[a-z][a-z0-9_]*$/))
      .max(8)
      .optional(),
    /**
     * API-key connectors the client admin sets up in the portal: the fields of their credentials
     * (docs/plan.md §1.26). Absent: the portal offers no form (keys the operator provisions).
     */
    credentialFields: z.array(CredentialField).min(1).max(12).optional(),
    // v0.12 W2-A: the record types its tools touch (ARCHITECTURE §6.1 "Permissions per record
    // type"), with their verbs and scopes. Absent: the verbs alone govern its tools.
    permissionEntities: z.array(PermissionEntity).max(32).optional(),
    /**
     * A connector for tests only (the testkit): offered and shown only where testing happens (the
     * Sandbox client and a template's test copies), never to a real client. See `showsTestOnly`.
     */
    testOnly: z.boolean().optional(),
  })
  .superRefine((m, ctx) => {
    // v0.12 W2-A: entities and scopes are the connector's own and agree with its tools.
    for (const p of manifestEntityProblems(m)) {
      ctx.addIssue({ code: "custom", message: p, path: ["permissionEntities"] });
    }
    m.tools.forEach((t, i) => {
      if (t.source !== m.id) {
        ctx.addIssue({
          code: "custom",
          message: `tool ${t.id} has source ${t.source}, not ${m.id}`,
          path: ["tools", i, "source"],
        });
      }
      if (t.connector !== undefined && t.connector !== m.id) {
        ctx.addIssue({
          code: "custom",
          message: `tool ${t.id} names connector ${t.connector}, not ${m.id}`,
          path: ["tools", i, "connector"],
        });
      }
    });
    const prefixes = connectorPrefixes(m);
    m.events?.forEach((e, i) => {
      if (!prefixes.some((p) => e.type.startsWith(p))) {
        ctx.addIssue({
          code: "custom",
          message: `event ${e.type} must start with "${m.id}."`,
          path: ["events", i, "type"],
        });
      }
    });
    if (m.credentialFields) {
      if (m.auth !== "api_key") {
        ctx.addIssue({
          code: "custom",
          message: "only api_key connectors declare credential fields",
          path: ["credentialFields"],
        });
      }
      const names = m.credentialFields.map((f) => f.name);
      if (new Set(names).size !== names.length) {
        ctx.addIssue({
          code: "custom",
          message: "credential field names must be unique",
          path: ["credentialFields"],
        });
      }
    }
    const ids = m.tools.map((t) => t.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: "custom", message: "tool ids must be unique", path: ["tools"] });
    }
  })
  .meta({ id: "ConnectorManifest" });
export type ConnectorManifest = z.infer<typeof ConnectorManifest>;

/**
 * Where a test-only connector (`testOnly`, the testkit) may show: in the Sandbox client and a
 * template's test copies, or where it is already in use (a connection the client has, a tool a
 * version already names), so nothing that exists disappears from view. Real clients never see it
 * offered: not in their connector lists, the builder's palette or the approver rules' options.
 */
// DECISION: "already in use" keeps it: the local seed's demo client has a testkit connection and
// agent, and the builder must still type a step that names a testkit tool.
export function showsTestOnly(where: {
  sandbox: boolean;
  testCopy?: boolean | undefined;
  inUse?: boolean | undefined;
}): boolean {
  return where.sandbox || where.testCopy === true || where.inUse === true;
}

/** Whether a connector is shown in a list for this client (see `showsTestOnly`). */
export function connectorShown(
  manifest: Pick<ConnectorManifest, "testOnly">,
  where: Parameters<typeof showsTestOnly>[0],
): boolean {
  return manifest.testOnly !== true || showsTestOnly(where);
}
