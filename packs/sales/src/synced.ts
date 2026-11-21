// What apps/api calls after a sync page committed (docs/plan.md §1.164 "Where matching happens"):
// the record keys of the records the page stored, for a client with the Sales area on. Keys are
// built here, deterministically; embeddings follow on the next match or `sales.keys.refresh`.

import type { Db } from "@countersign/db";
import { CRM_MAPPERS } from "./keys/zoho";
import { keysAfterSync } from "./store";

export const SALES_SYNCED = {
  /** The connectors whose synced records the Sales area keys. */
  connectors: Object.keys(CRM_MAPPERS),
  async run(
    db: Db,
    input: { tenantId: string; connectionId: string; rawRecordIds: readonly string[] },
  ): Promise<{ built: number } | null> {
    const r = await keysAfterSync(db, input);
    return r ? { built: r.built } : null;
  },
};
