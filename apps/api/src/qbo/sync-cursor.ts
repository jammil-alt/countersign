// v0.12 W1-H: the QuickBooks cursor a page stores, keeping the sync claim beside it
// (./sync-now.ts): `running` (its `at` moved to the page's time) and `pending`.

import { connection } from "@countersign/db";
import { type SQL, sql } from "drizzle-orm";

/**
 * The cursor to store with a page, keeping the claim (`running`, its `at` moved to `now`) and any
 * `pending` already there: storeQboPage writes it, so a page never drops a queued sync.
 */
export function cursorKeepingClaim(cursor: object, now: Date): SQL {
  const current = sql`${connection.syncCursor}`;
  return sql`(${JSON.stringify(cursor)}::jsonb || jsonb_strip_nulls(jsonb_build_object(
    'running', case when ${current} -> 'running' is null then null
      else jsonb_set(${current} -> 'running', '{at}', to_jsonb(${now.toISOString()}::text)) end,
    'pending', ${current} -> 'pending')))`;
}
