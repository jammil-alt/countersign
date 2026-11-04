// The pack's tools for catalog and matching (ARCHITECTURE §12.2, §9.4). Agent reasoning reaches
// the catalog only through these (invariant 2). Each is `none` (reads) or `internal` (the pack's
// own records); none writes to a client's tool. apps/api adapts them to the tool registry's shape
// (the pack never imports packages/agents) and hands each call its database and model transport.
// M8b adds the pricing tools to MATERIALS_TOOLS.

import type { ToolSpec } from "@countersign/core";
import { type Db, docExtraction, docLine, withTenant } from "@countersign/db";
import { createLlmClient, type LlmClient, type LlmTransport } from "@countersign/llm";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { compareKeys, parseNormalized } from "./catalog/keys";
import { type MatchLineResult, matchLine } from "./catalog/match";
import { modelParse } from "./catalog/model";
import { normalize } from "./catalog/normalize";
import { MATCH_CONFIDENCE_AUTO } from "./catalog/settings";
import { createItem, itemView, latestMatch, liveItem, searchCatalog } from "./catalog/store";
import { CATEGORIES, catalogItem } from "./schema";

/** What a pack tool gets for one call: one client, one agent version, one step's settings. */
export interface PackToolContext {
  tenantId: string;
  agentVersionId: string;
  mode: "live" | "test";
  /** The settings of the skill the step runs (e.g. `match_confidence_auto`). */
  settings: Readonly<Record<string, unknown>>;
  db: Db;
  /** The model, with each call's cost added to the step; null where no transport is configured. */
  llm: LlmClient | null;
}

export interface PackTool {
  spec: ToolSpec;
  input: z.ZodType;
  output: z.ZodType;
  run(input: unknown, ctx: PackToolContext): Promise<unknown>;
}

export interface ToolContextSource {
  tenantId: string;
  agentVersionId: string;
  mode: "live" | "test";
  settings?: Readonly<Record<string, unknown>> | undefined;
  db: Db;
  transport?: LlmTransport | null | undefined;
  recordUsage?:
    | ((usage: { costUsd: string; tokensIn: number; tokensOut: number }) => Promise<void>)
    | undefined;
}

/** Builds a call's context; the model client adds each call's cost to the step (§13). */
export function packToolContext(source: ToolContextSource): PackToolContext {
  const llm = source.transport
    ? createLlmClient({
        transport: source.transport,
        onCall: async (r) => {
          await source.recordUsage?.({
            costUsd: r.costUsd ?? "0",
            tokensIn: r.usage.inputTokens + r.usage.cacheWriteTokens + r.usage.cacheReadTokens,
            tokensOut: r.usage.outputTokens,
          });
        },
      })
    : null;
  return {
    tenantId: source.tenantId,
    agentVersionId: source.agentVersionId,
    mode: source.mode,
    settings: source.settings ?? {},
    db: source.db,
    llm,
  };
}

function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<
    string,
    unknown
  >;
  delete json.$schema;
  return json;
}

function defineTool<I extends z.ZodType, O extends z.ZodType>(def: {
  id: string;
  description: string;
  sideEffect: "none" | "internal";
  summary?: string;
  input: I;
  output: O;
  run(input: z.output<I>, ctx: PackToolContext): Promise<z.input<O>>;
}): PackTool {
  return {
    spec: {
      id: def.id,
      description: def.description,
      input: jsonSchemaOf(def.input),
      output: jsonSchemaOf(def.output),
      sideEffect: def.sideEffect,
      verb: def.sideEffect === "none" ? "read" : "create",
      source: "materials",
      ...(def.summary ? { summary: def.summary } : {}),
    },
    input: def.input,
    output: def.output,
    run: (input, ctx) => def.run(def.input.parse(input) as z.output<I>, ctx),
  };
}

/** `match_confidence_auto` from the step's skill settings, else the default. */
export function thresholdFrom(settings: Readonly<Record<string, unknown>>): number {
  const v = Number(settings.match_confidence_auto);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : MATCH_CONFIDENCE_AUTO;
}

const Category = z.enum(CATEGORIES);
const Attributes = z.record(z.string(), z.string());

const ItemOut = z.object({
  id: z.string(),
  category: Category,
  name: z.string(),
  attributes: Attributes,
  standardUom: z.string(),
});

export const catalogSearch = defineTool({
  id: "materials.catalog.search",
  description:
    "Searches the client's catalog of materials by name, optionally in one category (sheet_goods, hardwood, mouldings, hardware, finishes, other). Answers live items with their attributes and unit.",
  sideEffect: "none",
  input: z.object({
    query: z.string().max(200).optional(),
    category: Category.optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  output: z.object({ items: z.array(ItemOut), sources: z.array(z.string()) }),
  async run(input, ctx) {
    const rows = await withTenant(ctx.db, ctx.tenantId, (tx) =>
      searchCatalog(tx, ctx.tenantId, {
        query: input.query ? normalize(input.query) : undefined,
        category: input.category,
        limit: input.limit,
      }),
    );
    return { items: rows.map(itemView), sources: rows.map((r) => r.id) };
  },
});

export const catalogCreateItem = defineTool({
  id: "materials.catalog.create_item",
  description:
    "Adds an item to the client's catalog from a description such as '3/4 BB/BB BALTIC BIRCH 5X5'. Answers the existing item instead when one has the same key attributes. Refuses a description that doesn't state the category's required attributes.",
  sideEffect: "internal",
  summary: "Added {{item.name}} to the catalog",
  input: z.object({ description: z.string().min(1).max(500) }),
  output: z.object({ item: ItemOut, created: z.boolean(), sources: z.array(z.string()) }),
  async run(input, ctx) {
    const normalized = normalize(input.description);
    let parsed = parseNormalized(normalized);
    if (!parsed.complete && ctx.llm) {
      parsed = await modelParse(
        ctx.llm,
        { raw: input.description, normalized },
        "materials.catalog.create_item",
      );
    }
    if (!parsed.complete) {
      throw new Error(
        `the description doesn't state ${parsed.missing.join(", ")}; a ${parsed.category} item needs them`,
      );
    }
    const made = await withTenant(ctx.db, ctx.tenantId, (tx) =>
      createItem(tx, ctx.tenantId, parsed, { agentVersionId: ctx.agentVersionId }),
    );
    return { item: itemView(made.item), created: made.created, sources: [made.item.id] };
  },
});

const LineOut = z.object({
  docLineId: z.string(),
  matchId: z.string(),
  decision: z.enum(["matched", "new_item", "unsure"]),
  catalogItemId: z.string().nullable(),
  catalogItemName: z.string().nullable(),
  createdItem: z.boolean(),
  confidence: z.number(),
  method: z.enum(["alias", "rules", "llm", "human"]),
  hingeAttribute: z.string().nullable(),
  needsReview: z.boolean(),
  category: z.string(),
  attributes: Attributes,
  candidates: z.array(
    z.object({
      catalogItemId: z.string(),
      name: z.string(),
      confidence: z.number(),
      hinge: z.string().nullable(),
      similarity: z.number().nullable(),
      vetoed: z.boolean(),
    }),
  ),
});

/**
 * A line already decided (matched or new item) is answered from its latest decision, so a retried
 * step or a re-run adds nothing; an unsure line is matched again (aliases may have been learned).
 */
// DECISION: re-matching is skipped for decided lines, kept for unsure ones.
async function matchOrRecall(
  ctx: PackToolContext,
  input: { docLineId: string; vendorId?: string | undefined },
): Promise<MatchLineResult> {
  const prior = await withTenant(ctx.db, ctx.tenantId, async (tx) => {
    const m = await latestMatch(tx, ctx.tenantId, input.docLineId);
    if (!m || m.decision === "unsure" || !m.catalogItemId) return null;
    const item = await liveItem(tx, ctx.tenantId, m.catalogItemId);
    return item ? { m, item } : null;
  });
  if (prior) {
    return {
      docLineId: input.docLineId,
      matchId: prior.m.id,
      decision: prior.m.decision,
      catalogItemId: prior.item.id,
      catalogItemName: prior.item.canonicalName,
      createdItem: false,
      confidence: Number(prior.m.confidence),
      method: prior.m.method,
      hingeAttribute: prior.m.hingeAttribute,
      needsReview: false,
      candidates: [],
      category: prior.item.category,
      attributes: prior.item.attributes as Record<string, string>,
    };
  }
  return matchLine(
    { db: ctx.db, llm: ctx.llm },
    {
      tenantId: ctx.tenantId,
      docLineId: input.docLineId,
      vendorId: input.vendorId,
      agentVersionId: ctx.agentVersionId,
      threshold: thresholdFrom(ctx.settings),
      testRun: ctx.mode === "test",
    },
  );
}

const sourcesOf = (r: MatchLineResult) => [
  r.docLineId,
  r.matchId,
  ...(r.catalogItemId ? [r.catalogItemId] : []),
];

export const matchLineTool = defineTool({
  id: "materials.match_line",
  description:
    "Matches one document line to the client's catalog: the vendor's alias, then the rules, then a model check of the closest candidates. Lines below the confidence threshold are left for a person (needsReview).",
  sideEffect: "internal",
  summary: "Line matched: {{decision}}",
  input: z.object({ docLineId: z.uuid(), vendorId: z.uuid().optional() }),
  output: LineOut.extend({ sources: z.array(z.string()) }),
  async run(input, ctx) {
    const r = await matchOrRecall(ctx, input);
    return { ...r, sources: sourcesOf(r) };
  },
});

export const matchLinesTool = defineTool({
  id: "materials.match_lines",
  description:
    "Matches every line of a document's latest extraction to the client's catalog, and lists the lines a person needs to review.",
  sideEffect: "internal",
  summary: "Matched {{matched}} of {{total}} lines; {{needsReview}} to review",
  input: z.object({ documentId: z.uuid(), vendorId: z.uuid().optional() }),
  output: z.object({
    documentId: z.string(),
    extractionId: z.string(),
    total: z.number(),
    matched: z.number(),
    newItems: z.number(),
    needsReview: z.number(),
    belowThreshold: z.array(z.string()),
    lines: z.array(LineOut.extend({ lineNo: z.number(), description: z.string() })),
    sources: z.array(z.string()),
  }),
  async run(input, ctx) {
    const found = await withTenant(ctx.db, ctx.tenantId, async (tx) => {
      const [extraction] = await tx
        .select({ id: docExtraction.id })
        .from(docExtraction)
        .where(
          and(
            eq(docExtraction.tenantId, ctx.tenantId),
            eq(docExtraction.documentId, input.documentId),
          ),
        )
        .orderBy(desc(docExtraction.createdAt), desc(docExtraction.id))
        .limit(1);
      if (!extraction) return null;
      const lines = await tx
        .select({ id: docLine.id, lineNo: docLine.lineNo, description: docLine.rawDescription })
        .from(docLine)
        .where(and(eq(docLine.tenantId, ctx.tenantId), eq(docLine.extractionId, extraction.id)))
        .orderBy(asc(docLine.lineNo));
      return { extractionId: extraction.id, lines };
    });
    if (!found) throw new Error(`document ${input.documentId} has no extraction; read it first`);
    const lines = [];
    for (const line of found.lines) {
      const r = await matchOrRecall(ctx, { docLineId: line.id, vendorId: input.vendorId });
      lines.push({ ...r, lineNo: line.lineNo, description: line.description });
    }
    const review = lines.filter((l) => l.needsReview);
    return {
      documentId: input.documentId,
      extractionId: found.extractionId,
      total: lines.length,
      matched: lines.filter((l) => l.decision === "matched").length,
      newItems: lines.filter((l) => l.decision === "new_item").length,
      needsReview: review.length,
      belowThreshold: review.map((l) => l.docLineId),
      lines,
      sources: [input.documentId, found.extractionId, ...lines.flatMap(sourcesOf)],
    };
  },
});

// DECISION: likely duplicates are pairs of live items in one category that no key attribute
// tells apart (some stated on one side only), compared in code over at most 500 items a category.
const DUPLICATE_SCAN_LIMIT = 500;

export const catalogDuplicates = defineTool({
  id: "materials.catalog.duplicates",
  description:
    "Lists pairs of catalog items that may be the same thing: same category, and no key attribute differs (one item states something the other doesn't).",
  sideEffect: "none",
  input: z.object({
    category: Category.optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  output: z.object({
    pairs: z.array(z.object({ a: ItemOut, b: ItemOut, unstated: z.array(z.string()) })),
    sources: z.array(z.string()),
  }),
  async run(input, ctx) {
    const categories = input.category ? [input.category] : CATEGORIES.filter((c) => c !== "other");
    const pairs: {
      a: ReturnType<typeof itemView>;
      b: ReturnType<typeof itemView>;
      unstated: string[];
    }[] = [];
    const limit = input.limit ?? 20;
    await withTenant(ctx.db, ctx.tenantId, async (tx) => {
      for (const category of categories) {
        const rows = await tx
          .select()
          .from(catalogItem)
          .where(
            and(
              eq(catalogItem.tenantId, ctx.tenantId),
              eq(catalogItem.category, category),
              isNull(catalogItem.mergedIntoId),
            ),
          )
          .orderBy(asc(catalogItem.createdAt))
          .limit(DUPLICATE_SCAN_LIMIT);
        for (let i = 0; i < rows.length && pairs.length < limit; i++) {
          for (let j = i + 1; j < rows.length && pairs.length < limit; j++) {
            const a = rows[i];
            const b = rows[j];
            if (!a || !b || a.standardUom !== b.standardUom) continue;
            const c = compareKeys(
              { category, attributes: a.attributes as Record<string, string> },
              { category, attributes: b.attributes as Record<string, string> },
            );
            if (c.differ.length === 0 && c.equal.length > 0) {
              pairs.push({ a: itemView(a), b: itemView(b), unstated: c.oneSided });
            }
          }
        }
      }
    });
    return { pairs, sources: pairs.flatMap((p) => [p.a.id, p.b.id]) };
  },
});

export const MATERIALS_TOOLS: readonly PackTool[] = [
  catalogSearch,
  catalogCreateItem,
  matchLineTool,
  matchLinesTool,
  catalogDuplicates,
];
