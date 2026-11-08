// The packs this deployment registers (ARCHITECTURE §12.1): the one place, with platform.ts, that
// names a pack; nothing in packages/* does. Each pack's tools are adapted to the tool registry's
// shape here, because a pack never imports packages/agents: the adapter hands each call the run's
// database and model transport (`ToolInvocation.packServices`) and the step's skill settings.

import type { InternalTool, PackToolSource } from "@countersign/agents";
import type { ContentStore } from "@countersign/connectors";
import type { PackManifest } from "@countersign/core";
import type { Db } from "@countersign/db";
import type { LlmTransport } from "@countersign/llm";
import {
  MATERIALS_ACTIONS,
  MATERIALS_HANDLERS,
  MATERIALS_REPORTS,
  MATERIALS_REVIEWS,
  materialsManifest,
  type PackActionHandler,
  type PackReportHandler,
  type PackReviewHandler,
  type PackTool,
  packToolContext,
} from "@countersign/pack-materials";

export interface RegisteredPack {
  manifest: PackManifest;
  handlers: Readonly<Record<string, PackTool>>;
  /** Its client reports by name (`/api/reports/:pack/:report`). */
  reports?: Readonly<Record<string, PackReportHandler>>;
  /** Its inbox review cards by the `review` key of an item's payload (e.g. `materials.match`). */
  reviews?: Readonly<Record<string, PackReviewHandler>>;
  /** People's actions on a client's pack data from the back office (e.g. a catalog merge). */
  actions?: Readonly<Record<string, PackActionHandler>>;
}

/** Every pack the deployment registers. Enabling one for a client is a `tenant_pack` row. */
export const DEPLOYMENT_PACKS: readonly RegisteredPack[] = [
  {
    manifest: materialsManifest,
    handlers: MATERIALS_HANDLERS,
    reports: MATERIALS_REPORTS,
    reviews: MATERIALS_REVIEWS,
    actions: MATERIALS_ACTIONS,
  },
];

function adapt(tool: PackTool): InternalTool {
  return {
    spec: tool.spec,
    input: tool.input,
    output: tool.output,
    async run(input, ctx) {
      const db = ctx.packServices?.db as Db | undefined;
      if (!db) throw new Error(`${tool.spec.id} needs the run's database, which wasn't passed`);
      const transport = (ctx.packServices?.transport as LlmTransport | null | undefined) ?? null;
      // P-5: the client's document storage, for a document a pack tool makes (a purchase order).
      const content = (ctx.packServices?.content as ContentStore | null | undefined) ?? null;
      return tool.run(
        input,
        packToolContext({
          tenantId: ctx.tenantId,
          agentVersionId: ctx.agentVersionId,
          runId: ctx.runId,
          mode: ctx.mode,
          settings: ctx.settings,
          db,
          transport,
          recordUsage: ctx.recordUsage,
          content,
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
