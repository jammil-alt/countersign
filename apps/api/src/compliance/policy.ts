// HIPAA mode at run time (docs/plan.md §1.35): a client in HIPAA mode sends data only to vendors
// with a signed BAA (`BAA_PROCESSORS`). The runtime's tool policy refuses a tool call whose
// processors aren't covered; the model guard refuses a model call whose provider isn't. Both read
// the client's profile from `tenant` (a global table) once per client and keep it for the run.

import type { ToolPolicy } from "@countersign/agents";
import {
  type ComplianceProfile,
  complianceOf,
  type Processor,
  parseCoveredProcessors,
  processingRefusal,
  processorForModel,
  processorsForTool,
} from "@countersign/core";
import { type Db, tenant } from "@countersign/db";
import type { LlmTransport } from "@countersign/llm";
import { eq, inArray } from "drizzle-orm";

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
  };
}

// docs/hipaa-plan.md T2: the back office's own model calls (the Builder, plain-words questions)
// held to HIPAA mode like a run's. Checked before the call, so a refusal costs nothing.

async function hipaaOf(db: Pick<Db, "select">, tenantIds: readonly string[]): Promise<Set<string>> {
  if (tenantIds.length === 0) return new Set();
  const rows = await db
    .select({ id: tenant.id, settings: tenant.settings })
    .from(tenant)
    .where(inArray(tenant.id, [...new Set(tenantIds)]));
  return new Set(
    rows
      .filter((r) => complianceOf(r.settings as Record<string, unknown> | undefined).hipaa)
      .map((r) => r.id),
  );
}

/** Why `model` may not read this client's data (HIPAA mode, no BAA with its provider), or null. */
export async function modelRefusal(
  db: Pick<Db, "select">,
  baaProcessors: string | undefined,
  tenantId: string | null,
  model: string,
): Promise<string | null> {
  if (!tenantId) return null;
  const hipaa = (await hipaaOf(db, [tenantId])).has(tenantId);
  return processingRefusal(
    { hipaa },
    parseCoveredProcessors(baaProcessors),
    [processorForModel(model)],
    `The model ${model}`,
  );
}

/** The clients whose data `model` may read: those in HIPAA mode without its provider's BAA left out. */
export async function clientsForModel(
  db: Pick<Db, "select">,
  baaProcessors: string | undefined,
  tenantIds: readonly string[],
  model: string,
): Promise<string[]> {
  if (parseCoveredProcessors(baaProcessors).has(processorForModel(model))) return [...tenantIds];
  const hipaa = await hipaaOf(db, tenantIds);
  return tenantIds.filter((id) => !hipaa.has(id));
}
