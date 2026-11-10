// Skill model (2026-11-10): the database half of the matching split (./split.ts). Look up existing
// reads only (aliases, the catalog, earlier decisions); Save to records writes the decisions the
// way `matchLine` always has (`recordVerdict`: an item_match row with the agent version, a new item
// when it is one, the vendor's `auto` aliases, the line's event). No model is called here.

import { type Db, docExtraction, docLine, withTenant } from "@countersign/db";
import { and, asc, desc, eq } from "drizzle-orm";
import { materialsEventRegistry } from "../events";
import { parseNormalized } from "./keys";
import { MatchError, type MatchLineResult, prepare, recordVerdict, type Verdict } from "./match";
import {
  type CandidateItem,
  type CheckedLine,
  decideByRules,
  type LookedUpLine,
  thresholdOf,
  withModelReading,
} from "./split";
import { findAlias, findCandidates, latestMatch, liveItem } from "./store";

export interface LookupResult {
  documentId: string;
  extractionId: string;
  lines: LookedUpLine[];
}

/**
 * Look up existing for every line of a document's latest extraction. A line decided before (a
 * retried step, a re-run) is answered from that decision; an unsure one is looked up again.
 */
// DECISION: as `materials.match_lines`, a decided line keeps its decision ("recalled"); an unsure
// one is looked up again, since aliases may have been learned since.
export async function lookupDocument(
  db: Db,
  tenantId: string,
  input: { documentId: string; vendorId?: string | undefined },
): Promise<LookupResult> {
  return withTenant(db, tenantId, async (tx) => {
    const [extraction] = await tx
      .select({ id: docExtraction.id })
      .from(docExtraction)
      .where(
        and(eq(docExtraction.tenantId, tenantId), eq(docExtraction.documentId, input.documentId)),
      )
      .orderBy(desc(docExtraction.createdAt), desc(docExtraction.id))
      .limit(1);
    if (!extraction) {
      throw new MatchError(
        "not_found",
        `document ${input.documentId} has no reading; read it first`,
      );
    }
    const rows = await tx
      .select({ id: docLine.id, lineNo: docLine.lineNo, description: docLine.rawDescription })
      .from(docLine)
      .where(and(eq(docLine.tenantId, tenantId), eq(docLine.extractionId, extraction.id)))
      .orderBy(asc(docLine.lineNo));
    const lines: LookedUpLine[] = [];
    for (const row of rows) {
      const line = { docLineId: row.id, lineNo: row.lineNo, description: row.description };
      const prior = await latestMatch(tx, tenantId, row.id);
      const priorItem =
        prior && prior.decision !== "unsure" && prior.catalogItemId
          ? await liveItem(tx, tenantId, prior.catalogItemId)
          : null;
      if (prior && priorItem) {
        lines.push({
          ...line,
          category: priorItem.category,
          attributes: priorItem.attributes as Record<string, string>,
          missing: [],
          decision: "matched",
          catalogItemId: priorItem.id,
          catalogItemName: priorItem.canonicalName,
          method: "recalled",
          confidence: Number(prior.confidence),
          hinge: prior.hingeAttribute,
          candidates: [],
        });
        continue;
      }
      const prepared = await prepare(tx, {
        tenantId,
        docLineId: row.id,
        vendorId: input.vendorId,
      });
      const parsed = parseNormalized(prepared.line.normalized);
      const alias = await findAlias(tx, tenantId, {
        vendorId: prepared.vendorId,
        vendorSku: prepared.line.sku,
        descriptionHash: prepared.line.hash,
      });
      if (alias) {
        lines.push({
          ...line,
          category: parsed.category,
          attributes: parsed.attributes,
          missing: parsed.missing,
          decision: "matched",
          catalogItemId: alias.item.id,
          catalogItemName: alias.item.canonicalName,
          method: "alias",
          confidence: 1,
          hinge: null,
          candidates: [],
        });
        continue;
      }
      const found = await findCandidates(tx, tenantId, parsed);
      const items: CandidateItem[] = found.map((c) => ({
        catalogItemId: c.item.id,
        name: c.item.canonicalName,
        category: c.item.category,
        attributes: c.item.attributes as Record<string, string>,
        standardUom: c.item.standardUom,
        similarity: c.similarity,
      }));
      lines.push(decideByRules(line, parsed, items));
    }
    return { documentId: input.documentId, extractionId: extraction.id, lines };
  });
}

export interface RecordMatchesInput {
  tenantId: string;
  agentVersionId: string;
  vendorId?: string | undefined;
  lines: readonly CheckedLine[];
  threshold?: number | undefined;
  testRun?: boolean | undefined;
}

/**
 * Save to records: each checked line becomes an item_match row (a new item made for a sure new
 * one, `auto` aliases learned for a decided one), exactly as `matchLine` records. A line already
 * decided (recalled, or recorded by an earlier try of this step) is not recorded again.
 */
// DECISION: recording is idempotent per line: a line whose latest decision is matched or new item
// is skipped, so a retried write step adds nothing; an unsure line is recorded again.
export async function recordMatches(
  db: Db,
  input: RecordMatchesInput,
): Promise<(MatchLineResult & { recorded: boolean })[]> {
  const registry = materialsEventRegistry();
  const threshold = thresholdOf(input.threshold);
  const out: (MatchLineResult & { recorded: boolean })[] = [];
  for (const line of input.lines) {
    const result = await withTenant(db, input.tenantId, async (tx) => {
      const prior = await latestMatch(tx, input.tenantId, line.docLineId);
      if (prior && prior.decision !== "unsure" && prior.catalogItemId) {
        const item = await liveItem(tx, input.tenantId, prior.catalogItemId);
        if (item) {
          return {
            docLineId: line.docLineId,
            matchId: prior.id,
            decision: prior.decision,
            catalogItemId: item.id,
            catalogItemName: item.canonicalName,
            createdItem: false,
            confidence: Number(prior.confidence),
            method: prior.method,
            hingeAttribute: prior.hingeAttribute,
            needsReview: false,
            candidates: [],
            category: item.category,
            attributes: item.attributes as Record<string, string>,
            recorded: false,
          };
        }
      }
      const prepared = await prepare(tx, {
        tenantId: input.tenantId,
        docLineId: line.docLineId,
        vendorId: input.vendorId,
      });
      // The rules' reading, with what the model read where the parsers stated nothing.
      const rules = parseNormalized(prepared.line.normalized);
      const parsed = {
        ...withModelReading(
          {
            description: prepared.line.normalized,
            category: rules.category,
            attributes: rules.attributes,
          },
          line.attributes,
        ),
        normalized: prepared.line.normalized,
      };
      const item =
        line.decision === "matched" && line.catalogItemId
          ? await liveItem(tx, input.tenantId, line.catalogItemId)
          : null;
      if (line.decision === "matched" && !item) {
        throw new MatchError("not_found", `catalog item ${line.catalogItemId} not found`);
      }
      const verdict: Verdict = {
        decision: line.decision,
        item,
        confidence: line.confidence,
        method: line.method === "recalled" ? "rules" : line.method,
        hinge: line.hingeAttribute,
      };
      const r = await recordVerdict(
        tx,
        {
          tenantId: input.tenantId,
          docLineId: line.docLineId,
          vendorId: input.vendorId,
          agentVersionId: input.agentVersionId,
          threshold,
          testRun: input.testRun,
        },
        prepared,
        parsed,
        verdict,
        line.candidates.map((c) => ({
          catalogItemId: c.catalogItemId,
          name: c.name,
          confidence: c.confidence,
          hinge: c.hinge,
          similarity: c.similarity,
          vetoed: c.vetoed,
        })),
        line.method !== "alias",
        threshold,
        registry,
      );
      return { ...r, recorded: true };
    });
    out.push(result);
  }
  return out;
}
