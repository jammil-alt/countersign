// The Sales pack's tools (docs/plan.md §1.164). Agent reasoning reaches the Sales area's records
// only through these (invariant 2). `sales.match_records` and `sales.keys.refresh` save the area's
// own records (`internal`); the look-up reads. None writes to a client's CRM: an update after a
// match is the connector's external tool, approval on (invariant 8).

import { withTenant } from "@countersign/db";
import { z } from "zod";
import { MatchRecordsInput, matchRecords } from "./match/match";
import { defineTool, type PackTool, SalesRefusal } from "./pack";
import { CRM_MATCH_DECISIONS, CRM_MATCH_METHODS } from "./schema";
import {
  EMBED_DUE_MAX,
  embedDueKeys,
  LOOKUP_MAX,
  lookupRecords,
  REFRESH_MAX,
  refreshRecordKeys,
  salesOn,
} from "./store";

const Values = z.record(z.string(), z.string());
const Keys = z.object({
  email: z.string().optional(),
  phone: z.string().optional(),
  domain: z.string().optional(),
  company: z.string().optional(),
  name: z.string().optional(),
  deal: z.string().optional(),
});
const RecordRef = z.object({
  recordKeyId: z.string(),
  connectionId: z.string(),
  module: z.string(),
  externalId: z.string(),
  values: Values,
});
const Candidate = RecordRef.extend({
  score: z.number(),
  foundBy: z.array(z.enum(["key", "alias", "text", "meaning"])),
  key: z.enum(["email", "phone", "domain"]).nullable(),
  vetoed: z.enum(["email", "phone"]).nullable(),
  textSimilarity: z.number().nullable(),
  meaningSimilarity: z.number().nullable(),
});
const EmbedOut = z.object({ embedded: z.number(), left: z.number(), refused: z.boolean() });

export const MatchRecordsOutput = z.object({
  batchId: z.string(),
  rows: z.array(
    z.object({
      index: z.number().int(),
      decision: z.enum(CRM_MATCH_DECISIONS),
      method: z.enum(CRM_MATCH_METHODS),
      score: z.number(),
      record: RecordRef.nullable(),
      suggestion: Candidate.nullable(),
      candidates: z.array(Candidate),
      keys: Keys,
      values: Values,
      needsReview: z.boolean(),
      reason: z.string().nullable(),
      sources: z.array(z.string()),
      matchId: z.string().nullable(),
    }),
  ),
  counts: z.object({ matched: z.number(), none: z.number(), unsure: z.number() }),
  anyNeedsReview: z.boolean(),
  threshold: z.number(),
  keys: z.object({ built: z.number(), embedded: EmbedOut.nullable() }),
  meaning: z.enum(["searched", "refused"]).nullable(),
  testRun: z.boolean(),
  sources: z.array(z.string()),
});

/** Save to records: rows matched to the client's synced CRM records, each decision recorded. */
export const matchRecordsTool = defineTool({
  id: "sales.match_records",
  usesModel:
    "embeds the rows and records for the search by meaning (OpenAI embeddings), and has a small model choose among close candidates",
  description:
    "Matches each row (a spreadsheet's, or a step's list) to the client's synced CRM records in the modules given: exact email, phone or website first, then the answers a person gave before, then similar names and similar meaning, then a small model choosing among at most five candidates. Two different emails or phones are never the same record. Rows under the threshold, or with two equally sure records, wait for a person. `keys` names the row's field for each key (email, phone, website, company, name or firstName and lastName, deal).",
  sideEffect: "internal",
  entity: "crm_match",
  summary: "Matched {{counts.matched}} rows; {{counts.unsure}} for a person",
  input: MatchRecordsInput,
  output: MatchRecordsOutput,
  run: (input, ctx) => matchRecords(ctx, input),
});

/** Save to records: the record keys built from newly synced records, and their embeddings. */
export const keysRefreshTool = defineTool({
  id: "sales.keys.refresh",
  usesModel: "embeds the records' match text for the search by meaning (OpenAI embeddings)",
  description:
    "Brings the Sales area's record keys up to date: the keys of CRM records synced since the last pass (all of them with `rebuild`, after the client's match fields change), and the embeddings of those whose match text is new. A test run builds the keys and embeds nothing.",
  sideEffect: "internal",
  verb: "update",
  entity: "crm_record",
  summary: "Built {{built}} record keys, embedded {{embedded.embedded}}",
  input: z.object({
    modules: z.array(z.string().min(1).max(100)).min(1).max(10).optional(),
    rebuild: z.boolean().optional(),
    /** How many due records to embed at most. */
    embed: z.number().int().min(0).max(EMBED_DUE_MAX).optional(),
  }),
  output: z.object({
    built: z.number(),
    more: z.boolean(),
    embedded: EmbedOut.nullable(),
    testRun: z.boolean(),
  }),
  async run(input, ctx) {
    const refreshed = await withTenant(ctx.db, ctx.tenantId, async (tx) => {
      if (!(await salesOn(tx, ctx.tenantId))) {
        throw new SalesRefusal("the Sales area is off for this client");
      }
      return refreshRecordKeys(tx, ctx.tenantId, {
        modules: input.modules,
        rebuild: input.rebuild,
        limit: REFRESH_MAX,
      });
    });
    const embed = input.embed ?? EMBED_DUE_MAX;
    const embedded =
      ctx.mode === "test" || !ctx.llm || embed === 0
        ? null
        : await embedDueKeys(ctx, { limit: embed, modules: input.modules });
    return { ...refreshed, embedded, testRun: ctx.mode === "test" };
  },
});

export const LookupRecordOut = z.object({
  recordKeyId: z.string(),
  connectionId: z.string(),
  module: z.string(),
  externalId: z.string(),
  name: z.string().nullable(),
  company: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  deal: z.string().nullable(),
  stage: z.string().nullable(),
  amount: z.string().nullable(),
  similarity: z.number(),
});

/** Read: the client's synced records in one module by name, company, email, phone or deal. */
export const recordsLookupTool = defineTool({
  id: "sales.records.lookup",
  description:
    "Finds the client's synced CRM records in one module by what a person would type: a name, company, email, phone or deal name. Exact emails and phones first, then similar text; at most 20.",
  sideEffect: "none",
  entity: "crm_record",
  summary: "Found {{records.length}} records",
  input: z.object({
    module: z.string().min(1).max(100),
    q: z.string().min(1).max(200),
    limit: z.number().int().min(1).max(LOOKUP_MAX).optional(),
  }),
  output: z.object({ records: z.array(LookupRecordOut), sources: z.array(z.string()) }),
  async run(input, ctx) {
    const records = await withTenant(ctx.db, ctx.tenantId, (tx) =>
      lookupRecords(tx, ctx.tenantId, input),
    );
    return { records, sources: records.map((r) => r.recordKeyId) };
  },
});

export const SALES_TOOLS: readonly PackTool[] = [
  matchRecordsTool,
  keysRefreshTool,
  recordsLookupTool,
];
