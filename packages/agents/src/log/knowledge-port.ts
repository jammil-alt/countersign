// The knowledge base behind `knowledge.search` (KnowledgePort), over packages/documents: one
// client-scoped transaction that first indexes the client's new or re-read documents, then
// searches. Only that client's rows are visible in it (invariant 1).

import { type Db, withTenant } from "@countersign/db";
import { indexDocuments, listVoiceSamples, searchKnowledge } from "@countersign/documents";
import type { KnowledgePort } from "../tools/types";

export function dbKnowledgePort(db: Db): KnowledgePort {
  return {
    search(tenantId, input) {
      return withTenant(db, tenantId, async (tx) => {
        await indexDocuments(tx, tenantId);
        return searchKnowledge(tx, tenantId, {
          query: input.query,
          limit: input.limit,
          memory: input.memory,
        });
      });
    },
    // v0.12 W1-G: `knowledge.voice_samples` (docs/plan.md §1.42), this client's samples only.
    voiceSamples(tenantId, input) {
      return withTenant(db, tenantId, (tx) => listVoiceSamples(tx, tenantId, input));
    },
  };
}
