// The packs this deployment registers (ARCHITECTURE §12.1): the one place, with platform.ts, that
// names a pack; nothing in packages/* does. Each pack's tools are adapted to the tool registry's
// shape here, because a pack never imports packages/agents: the adapter hands each call the run's
// database and model transport (`ToolInvocation.services`) and the step's skill settings.

import type { InternalTool, PackToolSource } from "@countersign/agents";
import type { PackManifest } from "@countersign/core";
import type { Db } from "@countersign/db";
import type { LlmTransport } from "@countersign/llm";
import {
  MATERIALS_HANDLERS,
  materialsManifest,
  type PackTool,
  packToolContext,
} from "@countersign/pack-materials";

export interface RegisteredPack {
  manifest: PackManifest;
  handlers: Readonly<Record<string, PackTool>>;
}

/** Every pack the deployment registers. Enabling one for a client is a `tenant_pack` row. */
export const DEPLOYMENT_PACKS: readonly RegisteredPack[] = [
  { manifest: materialsManifest, handlers: MATERIALS_HANDLERS },
];

function adapt(tool: PackTool): InternalTool {
  return {
    spec: tool.spec,
    input: tool.input,
    output: tool.output,
    async run(input, ctx) {
      const db = ctx.services?.db as Db | undefined;
      if (!db) throw new Error(`${tool.spec.id} needs the run's database, which wasn't passed`);
      const transport = (ctx.services?.transport as LlmTransport | null | undefined) ?? null;
      return tool.run(
        input,
        packToolContext({
          tenantId: ctx.tenantId,
          agentVersionId: ctx.agentVersionId,
          mode: ctx.mode,
          settings: ctx.settings,
          db,
          transport,
          recordUsage: ctx.recordUsage,
        }),
      );
    },
  };
}

/** A pack's tools as the tool registry takes them. */
export function packToolSource(pack: RegisteredPack): PackToolSource {
  return {
    manifest: pack.manifest,
    handlers: Object.fromEntries(
      Object.entries(pack.handlers).map(([id, tool]) => [id, adapt(tool)]),
    ),
  };
}
