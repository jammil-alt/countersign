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
import { inArray } from "drizzle-orm";

export { ComplianceRefusal };

/** Clients' profiles: one client's, or several read together (`many`). */
export interface ProfileReader {
  (tenantId: string): Promise<ComplianceProfile>;
  many(tenantIds: readonly string[]): Promise<ComplianceProfile[]>;
}

/**
 * Clients' profiles, read once per client for the life of the returned reader: through the
 * database, or through a request's open transaction (a Worker's request has one connection).
 * `many` reads the clients not read yet in one query.
 */
export function profileReader(db: Db | Tx): ProfileReader {
  const cache = new Map<string, Promise<ComplianceProfile>>();
  const many = (tenantIds: readonly string[]) => {
    const missing = [...new Set(tenantIds)].filter((id) => !cache.has(id));
    if (missing.length > 0) {
      const rows = db
        .select({ id: tenant.id, settings: tenant.settings })
        .from(tenant)
        .where(inArray(tenant.id, missing))
        .then((found) => new Map(found.map((r) => [r.id, r.settings])));
      for (const id of missing) {
        cache.set(
          id,
          rows.then((byId) => complianceOf(byId.get(id) as Record<string, unknown> | undefined)),
        );
      }
    }
    return Promise.all(tenantIds.map((id) => cache.get(id) as Promise<ComplianceProfile>));
  };
  const one = async (tenantId: string) => (await many([tenantId]))[0] as ComplianceProfile;
  return Object.assign(one, { many });
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

/** Several clients' profiles: in one query when the reader can. */
function readAll(
  profiles: (tenantId: string) => Promise<ComplianceProfile>,
  ids: readonly string[],
): Promise<ComplianceProfile[]> {
  return "many" in profiles
    ? (profiles as ProfileReader).many(ids)
    : Promise.all(ids.map((id) => profiles(id)));
}

/** The first refusal among the clients, or null when every one of them allows the processor. */
async function refusalFor(
  tenantIds: string | readonly string[],
  profiles: (tenantId: string) => Promise<ComplianceProfile>,
  covered: ReadonlySet<Processor>,
  processor: Processor,
  what: string,
): Promise<string | null> {
  const ids = typeof tenantIds === "string" ? [tenantIds] : tenantIds;
  for (const profile of await readAll(profiles, ids)) {
    const refusal = processingRefusal(profile, covered, [processor], what);
    if (refusal) return refusal;
  }
  return null;
}

/** Of the clients, those that may not send data to the processor (HIPAA mode without its BAA). */
export async function refusingClients(
  tenantIds: readonly string[],
  profiles: ProfileReader,
  covered: ReadonlySet<Processor>,
  processor: Processor,
): Promise<Set<string>> {
  const read = await profiles.many(tenantIds);
  return new Set(
    tenantIds.filter(
      (_, i) => processingRefusal(read[i] as ComplianceProfile, covered, [processor], "") !== null,
    ),
  );
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
      for (const profile of await readAll(profiles, tenantIds)) {
        const refusal = processingRefusal(
          profile,
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
