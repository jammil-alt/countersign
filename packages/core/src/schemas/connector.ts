import { z } from "zod";
import { EventTypeSpec } from "./event";
import { PermissionMatrix } from "./permissions";
import { ToolSpec } from "./tool";

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

/** ARCHITECTURE §6.1. The code side (sync, handlers, OAuth) lives in packages/connectors. */
export const ConnectorManifest = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
    name: z.string(),
    description: z.string(),
    icon: z.string(),
    auth: z.enum(["oauth2", "api_key", "none"]),
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
  })
  .superRefine((m, ctx) => {
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
