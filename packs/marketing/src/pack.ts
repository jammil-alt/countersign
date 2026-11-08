// The contracts every area of the Marketing pack builds on (docs/marketing-plan.md §11, the wave
// contract; docs/plan.md §1.73). Each area (measure, search, content, agents, forum) has an
// `index.ts` exporting one `AreaModule`; manifest.ts adds them up, so a builder adds a tool, skill,
// template, event, screen, report or action in its own area's files and never edits manifest.ts
// or index.ts.
//
// Tools: apps/api adapts every pack's tools to the tool registry (apps/api/src/packs.ts `adapt`),
// with the same call context Materials' tools get; `PackToolContext` here is the part of it this
// pack uses, so the adapter's context fits it. Pack tools are reads (`none`) or the pack's own
// records (`internal`); a write to anything outside is a connector's external tool, never a
// pack's (invariant 8).

import type {
  AgentBundle,
  EventTypeSpec,
  Role,
  SkillDefinition,
  ToolSpec,
} from "@countersign/core";
import type { Db, Tx } from "@countersign/db";
import type { LlmClient } from "@countersign/llm";
import { z } from "zod";
import { PACK_ID } from "./ids";

/** What a pack tool gets for one call: one client, one agent version, one step's settings. */
export interface PackToolContext {
  tenantId: string;
  /** The agent version making the call: every row an agent makes records it (invariant 10). */
  agentVersionId: string;
  /** The run the call belongs to; null outside a run. */
  runId: string | null;
  /** A test run never writes outside, and its rows are the client's test data. */
  mode: "live" | "test";
  /** The settings of the skill the step runs. */
  settings: Readonly<Record<string, unknown>>;
  /** Opened in the client's transaction by the tool itself (`withTenant(db, tenantId, …)`). */
  db: Db;
  /** The model, its cost added to the step; null where no transport is configured. */
  llm: LlmClient | null;
}

export interface PackTool {
  spec: ToolSpec;
  input: z.ZodType;
  output: z.ZodType;
  run(input: unknown, ctx: PackToolContext): Promise<unknown>;
}

export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<
    string,
    unknown
  >;
  delete json.$schema;
  return json;
}

/**
 * A pack tool, named `marketing.<area>.<what>`. Its input is parsed before `run`, and its output
 * is the tool result the model reads: page text, search queries and forum threads are data there,
 * never instructions (invariant 9).
 */
export function defineTool<I extends z.ZodType, O extends z.ZodType>(def: {
  id: `${typeof PACK_ID}.${string}`;
  description: string;
  sideEffect: "none" | "internal";
  /** An internal tool that changes the pack's records in place says so; else `create`. */
  verb?: "update";
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
      verb: def.sideEffect === "none" ? "read" : (def.verb ?? "create"),
      source: PACK_ID,
      ...(def.summary ? { summary: def.summary } : {}),
    },
    input: def.input,
    output: def.output,
    run: (input, ctx) => def.run(def.input.parse(input) as z.output<I>, ctx),
  };
}

/**
 * A report for the back office (`GET /api/ops/clients/:id/reports/marketing/<name>`) and, from
 * M50, the portal (`/api/reports/marketing/<name>`), as JSON and CSV, with the query parameters
 * its `query` schema takes (the platform passes them as strings, `client` left out, and answers
 * 400 when they don't parse). Never returns bundles, prompts, model ids or cost: the contract
 * tests' forbidden keys.
 */
export interface PackReportHandler {
  title: string;
  /** Its query parameters; none when absent. */
  query?: z.ZodType;
  json(
    tx: Tx,
    tenantId: string,
    today: string,
    query: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  csv(tx: Tx, tenantId: string, today: string, query: Record<string, unknown>): Promise<string>;
  /** One row in full (`…/items/:itemId`, a uuid); null when it isn't this client's. */
  item?(
    tx: Tx,
    tenantId: string,
    id: string,
    today: string,
    query: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null>;
}

/** A report with its query typed from its schema. */
export function defineReport<Q extends z.ZodType = z.ZodObject<Record<string, never>>>(def: {
  title: string;
  query?: Q;
  json(tx: Tx, tenantId: string, today: string, query: z.output<Q>): Promise<object>;
  csv(tx: Tx, tenantId: string, today: string, query: z.output<Q>): Promise<string>;
  item?(
    tx: Tx,
    tenantId: string,
    id: string,
    today: string,
    query: z.output<Q>,
  ): Promise<object | null>;
}): PackReportHandler {
  const { item } = def;
  return {
    title: def.title,
    ...(def.query ? { query: def.query } : {}),
    json: async (tx, tenantId, today, query) => ({
      ...(await def.json(tx, tenantId, today, query as z.output<Q>)),
    }),
    csv: (tx, tenantId, today, query) => def.csv(tx, tenantId, today, query as z.output<Q>),
    ...(item
      ? {
          item: async (tx, tenantId, id, today, query) => {
            const found = await item(tx, tenantId, id, today, query as z.output<Q>);
            return found ? { ...found } : null;
          },
        }
      : {}),
  };
}

/**
 * A person's action on one client's marketing data from the back office
 * (`POST /api/ops/clients/:id/packs/marketing/actions/<name>`), never an agent's. It opens its own
 * transaction for that client; a refusal is a `PackRefusal` (422).
 */
export interface PackActionHandler {
  input: z.ZodType;
  run(
    db: Db,
    ctx: { tenantId: string; userId: string; input: unknown },
  ): Promise<Record<string, unknown>>;
}

export function defineAction<I extends z.ZodType>(def: {
  input: I;
  run(
    db: Db,
    ctx: { tenantId: string; userId: string; input: z.output<I> },
  ): Promise<Record<string, unknown>>;
}): PackActionHandler {
  return {
    input: def.input,
    run: (db, ctx) => def.run(db, { ...ctx, input: ctx.input as z.output<I> }),
  };
}

/** A refusal the platform answers 422 `refused` (its name is what apps/api looks for). */
export class PackRefusal extends Error {
  override name = "PackRefusal";
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** A template the pack ships: installed as template v1 the first time the pack is switched on. */
export interface PackTemplate {
  slug: string;
  bundle: AgentBundle;
}

/** A portal screen (M50); the back office's screens are apps/web's own routes. */
export interface PackScreen {
  route: string;
  title: string;
  roles: Role[];
}

/** What one area of the pack adds. */
export interface AreaModule {
  TOOLS: readonly PackTool[];
  SKILLS: readonly SkillDefinition[];
  TEMPLATES: readonly PackTemplate[];
  /** Named `marketing.<area>.<what>` (the manifest refuses any other). */
  EVENTS: readonly EventTypeSpec[];
  SCREENS: readonly PackScreen[];
  REPORTS: Readonly<Record<string, PackReportHandler>>;
  ACTIONS: Readonly<Record<string, PackActionHandler>>;
  /**
   * Its part of the pack's nightly pass (03:41 UTC), after measurement's build and sweep: e.g.
   * search's import. Runs over every client with the pack on, each in its own transaction;
   * `onError` reports one client's failure (no client data in it) and the pass goes on.
   */
  NIGHTLY?: (
    db: Db,
    now: Date,
    onError?: (tenantId: string, error: unknown) => void,
  ) => Promise<unknown>;
}

/** An area with nothing in it yet. */
export const EMPTY_AREA: AreaModule = {
  TOOLS: [],
  SKILLS: [],
  TEMPLATES: [],
  EVENTS: [],
  SCREENS: [],
  REPORTS: {},
  ACTIONS: {},
};

export const QueryDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date, yyyy-mm-dd");

/**
 * The query most reports take: which site (absent = the client's first site) and which days
 * (absent = the report's own default period, e.g. the last 28 finished days), plus a report's own
 * parameters. Strings in, as the platform passes them; unknown parameters are refused.
 */
export function siteRangeQuery<T extends z.ZodRawShape>(extra: T = {} as T) {
  return z
    .strictObject({
      site: z.uuid().optional(),
      from: QueryDay.optional(),
      to: QueryDay.optional(),
      ...extra,
    })
    .refine(
      (q) => {
        const { from, to } = q as { from?: string; to?: string };
        return !from || !to || from <= to;
      },
      { message: "`from` is after `to`" },
    );
}
export const SiteRangeQuery = siteRangeQuery();
export type SiteRangeQuery = z.infer<typeof SiteRangeQuery>;
