import { z } from "zod";
import { Step as StepModelStep } from "../steps/schema";
import { AgentBundle, AgentDefinition } from "./agent";
import { ConnectorManifest } from "./connector";
import { EventTypeSpec } from "./event";
import { PackManifest } from "./pack";
import { PermissionMatrix } from "./permissions";
import { SkillDefinition } from "./skill";
import { ToolSpec } from "./tool";
import { Workflow } from "./workflow";

const SCHEMAS = {
  AgentBundle,
  AgentDefinition,
  SkillDefinition,
  Workflow,
  ToolSpec,
  ConnectorManifest,
  PermissionMatrix,
  PackManifest,
  EventTypeSpec,
} as const;
export type SchemaName = keyof typeof SCHEMAS;
export const SCHEMA_NAMES = Object.keys(SCHEMAS) as SchemaName[];

/**
 * The JSON Schema of a definition schema, in its input form (defaults optional), for the Builder
 * prompt and for anything outside TypeScript.
 */
export function toJsonSchema(name: SchemaName): Record<string, unknown> {
  return z.toJSONSchema(SCHEMAS[name], {
    io: "input",
    unrepresentable: "any",
    metadata: METADATA,
  }) as Record<string, unknown>;
}

/**
 * The registry the export reads ids and descriptions from: the global one, with the step model's
 * `Step` (v5) under its own id beside v3's `Step`, now that a bundle may hold both.
 */
// DECISION (step model, wave 1): renamed here, not in `steps/schema.ts` (frozen); the v5 id goes
// back to `Step` when v3 goes (wave 4).
const METADATA = {
  get(schema: z.core.$ZodType) {
    const meta = z.globalRegistry.get(schema);
    return schema === StepModelStep && meta ? { ...meta, id: "StepV5" } : meta;
  },
} as unknown as typeof z.globalRegistry;
