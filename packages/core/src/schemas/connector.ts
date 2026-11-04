import { z } from "zod";
import { EventTypeSpec } from "./event";
import { PermissionMatrix } from "./permissions";
import { ToolSpec } from "./tool";

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
    m.events?.forEach((e, i) => {
      if (!e.type.startsWith(`${m.id}.`)) {
        ctx.addIssue({
          code: "custom",
          message: `event ${e.type} must start with "${m.id}."`,
          path: ["events", i, "type"],
        });
      }
    });
    const ids = m.tools.map((t) => t.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: "custom", message: "tool ids must be unique", path: ["tools"] });
    }
  })
  .meta({ id: "ConnectorManifest" });
export type ConnectorManifest = z.infer<typeof ConnectorManifest>;
