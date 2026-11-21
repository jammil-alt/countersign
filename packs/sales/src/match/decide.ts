// A person's decision about one matched row (docs/plan.md §1.164 "Confirm matches", "What it
// teaches"): Approve the suggestion, pick another candidate, a record found by the look-up, or No
// match. Each is a new crm_match row (method `human`, the person who decided) after the agent's,
// never a change to it (invariant 3). A record chosen teaches a `crm_alias` (the row's key values →
// the record), so the same row matches by itself next time; No match teaches nothing. Learning
// stays with this client (invariant 1). The Confirm matches card (the next piece) calls this.

import { type Db, withTenant } from "@countersign/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { keysHash } from "../keys/build";
import { SalesRefusal } from "../pack";
import { type CrmKeys, crmAlias, crmMatch } from "../schema";
import { keyRowsByIds } from "../store";
import type { MatchedRecord } from "./match";

export interface RowDecisionInput {
  tenantId: string;
  /** The person deciding. */
  userId: string;
  /** The agent's decision about the row (any crm_match row of it: its batch and row are kept). */
  matchId: string;
  /** The record the row is (a candidate or a look-up's), or null for No match. */
  recordKeyId: string | null;
  /** A test run's card records nothing: it answers what would be recorded. */
  testRun?: boolean | undefined;
}

export interface RowDecision {
  /** The new crm_match row; null in a test run. */
  matchId: string | null;
  batchId: string;
  rowIndex: number;
  decision: "matched" | "none";
  record: MatchedRecord | null;
  /** The alias taught (null for No match, and in a test run). */
  aliasId: string | null;
  sources: string[];
}

/** Records a person's decision about a matched row, and the alias it teaches. */
export async function decideRow(db: Db, input: RowDecisionInput): Promise<RowDecision> {
  return withTenant(db, input.tenantId, async (tx) => {
    const [earlier] = await tx
      .select({
        batchId: crmMatch.batchId,
        rowIndex: crmMatch.rowIndex,
        runId: crmMatch.runId,
        step: crmMatch.step,
        keys: crmMatch.keys,
      })
      .from(crmMatch)
      .where(and(eq(crmMatch.id, input.matchId), eq(crmMatch.tenantId, input.tenantId)));
    if (!earlier) throw new SalesRefusal(`match ${input.matchId} not found`);
    let record: MatchedRecord | null = null;
    let rawRecordId: string | null = null;
    if (input.recordKeyId) {
      const [row] = await keyRowsByIds(tx, input.tenantId, [input.recordKeyId]);
      if (!row) throw new SalesRefusal(`record ${input.recordKeyId} not found`);
      record = {
        recordKeyId: row.id,
        connectionId: row.connectionId,
        module: row.module,
        externalId: row.externalId,
        values: row.display,
      };
      rawRecordId = row.rawRecordId;
    }
    const sources = record && rawRecordId ? [rawRecordId, record.recordKeyId] : [];
    const decision = record ? ("matched" as const) : ("none" as const);
    if (input.testRun) {
      return {
        matchId: null,
        batchId: earlier.batchId,
        rowIndex: earlier.rowIndex,
        decision,
        record,
        aliasId: null,
        sources,
      };
    }
    const [made] = await tx
      .insert(crmMatch)
      .values({
        tenantId: input.tenantId,
        batchId: earlier.batchId,
        runId: earlier.runId,
        step: earlier.step,
        rowIndex: earlier.rowIndex,
        keys: earlier.keys,
        decision,
        method: "human",
        recordKeyId: record?.recordKeyId ?? null,
        connectionId: record?.connectionId ?? null,
        module: record?.module ?? null,
        externalId: record?.externalId ?? null,
        score: "1.000",
        sources,
        decidedByUserId: input.userId,
      })
      .returning({ id: crmMatch.id });
    if (!made) throw new Error("the decision wasn't recorded");
    let aliasId: string | null = null;
    const keys = earlier.keys as CrmKeys;
    if (record && Object.keys(keys).length > 0) {
      const [alias] = await tx
        .insert(crmAlias)
        .values({
          tenantId: input.tenantId,
          connectionId: record.connectionId,
          module: record.module,
          keyHash: await keysHash(keys),
          keys,
          recordKeyId: record.recordKeyId,
          externalId: record.externalId,
          matchId: made.id,
          createdByUserId: input.userId,
        })
        .onConflictDoUpdate({
          target: [crmAlias.tenantId, crmAlias.connectionId, crmAlias.module, crmAlias.keyHash],
          set: {
            recordKeyId: record.recordKeyId,
            externalId: record.externalId,
            matchId: made.id,
            createdByUserId: input.userId,
            updatedAt: sql`now()`,
          },
        })
        .returning({ id: crmAlias.id });
      aliasId = alias?.id ?? null;
    }
    return {
      matchId: made.id,
      batchId: earlier.batchId,
      rowIndex: earlier.rowIndex,
      decision,
      record,
      aliasId,
      sources: aliasId ? [...sources, aliasId] : sources,
    };
  });
}

/** The newest decision about each row of a batch (a person's after the agent's), by row index. */
export async function latestDecisions(db: Db, input: { tenantId: string; batchId: string }) {
  return withTenant(db, input.tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: crmMatch.id,
        rowIndex: crmMatch.rowIndex,
        decision: crmMatch.decision,
        method: crmMatch.method,
        score: crmMatch.score,
        recordKeyId: crmMatch.recordKeyId,
        module: crmMatch.module,
        externalId: crmMatch.externalId,
        candidates: crmMatch.candidates,
        keys: crmMatch.keys,
        decidedByUserId: crmMatch.decidedByUserId,
        decidedAt: crmMatch.decidedAt,
      })
      .from(crmMatch)
      .where(and(eq(crmMatch.tenantId, input.tenantId), eq(crmMatch.batchId, input.batchId)))
      .orderBy(crmMatch.rowIndex, desc(crmMatch.decidedAt), desc(crmMatch.id));
    const latest = new Map<number, (typeof rows)[number]>();
    for (const r of rows) if (!latest.has(r.rowIndex)) latest.set(r.rowIndex, r);
    return [...latest.values()];
  });
}
