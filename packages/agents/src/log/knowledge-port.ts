// The knowledge base behind `knowledge.search` (KnowledgePort), over packages/documents: one
// client-scoped transaction that first indexes the client's new or re-read documents, then
// searches. Only that client's rows are visible in it (invariant 1).

import { type Db, withTenant } from "@countersign/db";
import { indexDocuments, listVoiceSamples, searchKnowledge } from "@countersign/documents";
import type { KnowledgePort } from "../tools/types";
import { accountReaderOf } from "./account-port";

export function dbKnowledgePort(db: Db): KnowledgePort {
  return {
    search(tenantId, input) {
      return withTenant(db, tenantId, async (tx) => {
        await indexDocuments(tx, tenantId);
        // The account agent (Sloan) sees only what the portal shows the person asking
        // (invariant 11): FAQs and policies are a client admin's page only.
        const reader = input.run
          ? await accountReaderOf(tx, tenantId, { agentId: input.memory.agentId, ...input.run })
          : null;
        const narrowed = reader !== null && reader.role !== "client_admin";
        return searchKnowledge(tx, tenantId, {
          query: input.query,
          limit: input.limit,
          // DECISION: for a reader other than the client admin, the account agent's own notes are
          // left out too: they may hold what it learned in an admin's conversation, which the
          // admin may read and a client user may not.
          memory: narrowed ? null : input.memory,
          entries: !narrowed,
        });
      });
    },
    // v0.12 W1-G: `knowledge.voice_samples` (docs/plan.md §1.42), this client's samples only.
    voiceSamples(tenantId, input) {
      return withTenant(db, tenantId, (tx) => listVoiceSamples(tx, tenantId, input));
    },
  };
}
