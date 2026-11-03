import { z } from "zod";
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
  return z.toJSONSchema(SCHEMAS[name], { io: "input", unrepresentable: "any" }) as Record<
    string,
    unknown
  >;
}
