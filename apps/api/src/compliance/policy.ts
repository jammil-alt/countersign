// HIPAA mode at run time (docs/plan.md §1.35): a client in HIPAA mode sends data only to vendors
// with a signed BAA (`BAA_PROCESSORS`). The runtime's tool policy refuses a tool call whose
// processors aren't covered; the model guard refuses a model call whose provider isn't. Both read
// the client's profile from `tenant` (a global table) once per client and keep it for the run.

import type { ToolPolicy } from "@countersign/agents";
import {
  type ComplianceProfile,
  ComplianceRefusal,
  complianceOf,
  type Processor,
  processingRefusal,
  processorForEmbedding,
  processorForModel,
  processorsForTool,
  VOICE_FEATURE,
} from "@countersign/core";
import { type Db, type Tx, tenant } from "@countersign/db";
import type { EmbedRequest, LlmTransport, Transcriber } from "@countersign/llm";
import { eq } from "drizzle-orm";

export { ComplianceRefusal };

/**
 * A client's profile, read once per client for the life of the returned function: through the
 * database, or through a request's open transaction (a Worker's request has one connection).
 */
export function profileReader(db: Db | Tx): (tenantId: string) => Promise<ComplianceProfile> {
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

/** The first refusal among the clients, or null when every one of them allows the processor. */
async function refusalFor(
  tenantIds: string | readonly string[],
  profiles: (tenantId: string) => Promise<ComplianceProfile>,
  covered: ReadonlySet<Processor>,
  processor: Processor,
  what: string,
): Promise<string | null> {
  for (const id of typeof tenantIds === "string" ? [tenantIds] : tenantIds) {
    const refusal = processingRefusal(await profiles(id), covered, [processor], what);
    if (refusal) return refusal;
  }
  return null;
}

/**
 * A transport that refuses any model whose provider isn't covered for the client, or for any of
 * the clients (a call that may carry several clients' data, such as a back-office question).
 */
export function guardModels(
  inner: LlmTransport,
  tenantIds: string | readonly string[],
  profiles: (tenantId: string) => Promise<ComplianceProfile>,
  covered: ReadonlySet<Processor>,
): LlmTransport {
  return {
    async create(request, options) {
      const model = String(request.model);
      const refusal = await refusalFor(
        tenantIds,
        profiles,
        covered,
        processorForModel(model),
        `The model ${model}`,
      );
      if (refusal) throw new ComplianceRefusal(refusal);
      return inner.create(request, options);
    },
    // §1.88: embeddings are held to the same rule, by their own model's provider.
    ...(inner.embed
      ? {
          embed: async (request: EmbedRequest, options?: { signal?: AbortSignal }) => {
            const refusal = await refusalFor(
              tenantIds,
              profiles,
              covered,
              processorForEmbedding(request.model),
              `Embedding with ${request.model}`,
            );
            if (refusal) throw new ComplianceRefusal(refusal);
            return (inner.embed as NonNullable<LlmTransport["embed"]>)(request, options);
          },
        }
      : {}),
  };
}

/** Speech-to-text held to the same rule: voice typing's vendor must be covered for the clients. */
export function guardTranscriber(
  inner: Transcriber,
  tenantIds: readonly string[],
  profiles: (tenantId: string) => Promise<ComplianceProfile>,
  covered: ReadonlySet<Processor>,
): Transcriber {
  return {
    async transcribe(request, options) {
      for (const id of tenantIds) {
        const refusal = processingRefusal(
          await profiles(id),
          covered,
          VOICE_FEATURE.processors,
          VOICE_FEATURE.what,
        );
        if (refusal) throw new ComplianceRefusal(refusal);
      }
      return inner.transcribe(request, options);
    },
  };
}
