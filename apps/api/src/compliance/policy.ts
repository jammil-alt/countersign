// HIPAA mode at run time (docs/plan.md §1.35): a client in HIPAA mode sends data only to vendors
// with a signed BAA (`BAA_PROCESSORS`). The runtime's tool policy refuses a tool call whose
// processors aren't covered; the model guard refuses a model call whose provider isn't. Both read
// the client's profile from `tenant` (a global table) once per client and keep it for the run.

import type { ToolPolicy } from "@countersign/agents";
import {
  type ComplianceProfile,
  complianceOf,
  type Processor,
  processingRefusal,
  processorForEmbedding,
  processorForModel,
  processorsForTool,
} from "@countersign/core";
import { type Db, tenant } from "@countersign/db";
import type { EmbedRequest, LlmTransport } from "@countersign/llm";
import { eq } from "drizzle-orm";

export class ComplianceRefusal extends Error {
  override name = "ComplianceRefusal";
}

/** A client's profile, read once per client for the life of the returned function. */
export function profileReader(db: Db): (tenantId: string) => Promise<ComplianceProfile> {
  const cache = new Map<string, Promise<ComplianceProfile>>();
  return (tenantId) => {
    let p = cache.get(tenantId);
    if (!p) {
      p = db
        .select({ settings: tenant.settings })
        .from(tenant)
        .where(eq(tenant.id, tenantId))
        .then(([row]) => complianceOf(row?.settings as Record<string, unknown> | undefined));
      cache.set(tenantId, p);
    }
    return p;
  };
}

export function hipaaToolPolicy(
  profiles: (tenantId: string) => Promise<ComplianceProfile>,
  covered: ReadonlySet<Processor>,
): ToolPolicy {
  return {
    async refuseTool({ tenantId, toolId, connectorId }) {
      const needed = processorsForTool(toolId, connectorId);
      if (needed.length === 0) return null;
      return processingRefusal(await profiles(tenantId), covered, needed, toolId);
    },
  };
}

/** A transport that refuses, for one client, any model whose provider isn't covered. */
export function guardModels(
  inner: LlmTransport,
  tenantId: string,
  profiles: (tenantId: string) => Promise<ComplianceProfile>,
  covered: ReadonlySet<Processor>,
): LlmTransport {
  return {
    async create(request, options) {
      const model = String(request.model);
      const refusal = processingRefusal(
        await profiles(tenantId),
        covered,
        [processorForModel(model)],
        `The model ${model}`,
      );
      if (refusal) throw new ComplianceRefusal(refusal);
      return inner.create(request, options);
    },
    // §1.88: embeddings are held to the same rule, by their own model's provider.
    ...(inner.embed
      ? {
          embed: async (request: EmbedRequest, options?: { signal?: AbortSignal }) => {
            const refusal = processingRefusal(
              await profiles(tenantId),
              covered,
              [processorForEmbedding(request.model)],
              `Embedding with ${request.model}`,
            );
            if (refusal) throw new ComplianceRefusal(refusal);
            return (inner.embed as NonNullable<LlmTransport["embed"]>)(request, options);
          },
        }
      : {}),
  };
}
