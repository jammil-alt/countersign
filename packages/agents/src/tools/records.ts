// The standard actions on every record type (docs/step-model-plan.md §10f): Find, Get by id,
// Create and Update, made for each record type the areas declare (core `recordActionSpecs`) and
// registered as platform tools. They reach our own records only through the `RecordsPort` apps/api
// gives them, which keeps clients apart, runs the record type's rules (custom fields included) on
// every write, records the agent version and the evidence, and never saves twice (the
// record_write log). The gate (runtime/call-tool.ts) checks the agent version's grant before any
// of them runs.
//
// Find is "Filter, group and total a list" (./group-list.ts) over one client's records: the
// same rules, grouping and decimal totals, on a typed query, never SQL.

import {
  FIND_MAX,
  FindQuery,
  hashJson,
  type RecordAction,
  type RecordType,
  recordActionSpecs,
} from "@countersign/core";
import { z } from "zod";
import { groupList } from "./group-list";
import type { InternalTool, RunMode, ToolInvocation } from "./types";

/** One record as a step sees it: `id`, its built-in fields and the client's custom fields. */
export type RecordValues = Record<string, unknown>;

/** Who and what a standard write is for (the record_write log's row). */
export interface RecordWriteMeta {
  agentVersionId: string;
  runId: string;
  stepRunId: string;
  /** The write's idempotency key: the same step's same write finds its first one. */
  key: string;
  /** Record ids the write rests on (invariant 10). */
  sources: string[];
  /** A test run checks the write and saves nothing (invariant 8: test runs never write). */
  mode: RunMode;
}

/**
 * Our own records by record type, for one client at a time (apps/api, over each area's store).
 * Every call is its own client-scoped transaction. Errors are plain words a person can act on.
 */
export interface RecordsPort {
  /** The client's records of a type, newest first, at most `limit`; `truncated` if there were more. */
  list(
    tenantId: string,
    recordType: string,
    options: { limit: number },
  ): Promise<{ records: RecordValues[]; truncated: boolean }>;
  /** The client's records of a type with these ids (missing ones left out). */
  get(tenantId: string, recordType: string, ids: readonly string[]): Promise<RecordValues[]>;
  create(
    tenantId: string,
    recordType: string,
    values: RecordValues,
    meta: RecordWriteMeta,
  ): Promise<RecordValues>;
  update(
    tenantId: string,
    recordType: string,
    id: string,
    values: RecordValues,
    meta: RecordWriteMeta,
  ): Promise<RecordValues>;
  /**
   * A write that waits for a person's signature (the agent suggests only, is in its trial or
   * sign-off stage, or the step adds an approver): checked by the record type's rules now, then
   * one approval card per key, assigned as routed. `done`: this key's write was already signed
   * and made (a retried step); `rejected`: a person turned it down. Live runs only.
   */
  propose?(tenantId: string, request: RecordProposal): Promise<RecordProposalOutcome>;
}

/** A record write proposed for a person's signature. */
export interface RecordProposal {
  recordType: string;
  action: "create" | "update";
  /** The record an update changes. */
  id?: string | undefined;
  values: RecordValues;
  meta: RecordWriteMeta;
  agentId: string;
  /** Why it waits, in plain words, for the card. */
  why: string;
  assignee: {
    assigneeRole: "operator" | "client_admin" | "client_user" | null;
    assigneeUserId: string | null;
  };
}

export type RecordProposalOutcome =
  | { status: "proposed"; inboxItemId: string }
  | { status: "done"; record: RecordValues }
  | { status: "rejected" };

/** A record write's parts from its tool input: the record (an update's), the values, the evidence. */
export function recordWriteParts(
  action: "create" | "update",
  input: unknown,
): { id?: string; values: RecordValues; sources: string[] } {
  const parsed = (action === "update" ? UpdateInput : WriteInput).parse(input) as {
    id?: string;
    sources: string[];
  } & RecordValues;
  const { id, sources, ...values } = parsed;
  return { ...(action === "update" ? { id: id as string } : {}), values, sources };
}

/** The key a write is saved once under: the run, the step and what it writes. */
// DECISION: the step's id and the write's input, not the step run's id, so a retried step (a new
// step run) finds the write its first try made; the same write twice in one step is one write.
export async function recordWriteKey(
  at: { runId: string; stepId: string },
  toolId: string,
  input: unknown,
): Promise<string> {
  return `rec:${at.runId}:${at.stepId}:${toolId}:${(await hashJson(input)).slice(0, 32)}`;
}

function port(ctx: ToolInvocation): RecordsPort {
  if (!ctx.records) throw new Error("our records aren't reachable from here");
  return ctx.records;
}

const Id = z.string().uuid("a record's id");
const Sources = z.array(z.string().min(1).max(100)).max(100).default([]);

const WriteInput = z.looseObject({ sources: Sources });
const UpdateInput = z.looseObject({ id: Id, sources: Sources });

function meta(ctx: ToolInvocation, key: string, sources: string[]): RecordWriteMeta {
  return {
    agentVersionId: ctx.agentVersionId,
    runId: ctx.runId,
    stepRunId: ctx.stepRunId,
    key,
    sources,
    mode: ctx.mode,
  };
}

const FindOutput = z.object({
  items: z.array(z.record(z.string(), z.unknown())),
  count: z.number().int(),
  groups: z.array(
    z.object({
      key: z.string(),
      count: z.number().int(),
      totals: z.record(z.string(), z.string()),
      items: z.array(z.record(z.string(), z.unknown())),
    }),
  ),
  totals: z.record(z.string(), z.string()).optional(),
  truncated: z.boolean(),
});
type FindOutput = z.infer<typeof FindOutput>;

/** Runs a Find: the client's records, their followed links, then the rules, groups and totals. */
export async function runFind(
  records: RecordsPort,
  tenantId: string,
  type: Pick<RecordType, "id" | "links">,
  query: FindQuery,
  today?: Date,
): Promise<FindOutput> {
  const { records: rows, truncated } = await records.list(tenantId, type.id, { limit: FIND_MAX });
  let items = rows;
  for (const name of query.follow) {
    const link = type.links.find((l) => l.name === name);
    if (!link) throw new Error(`there is no link ${name}`);
    const ids = [
      ...new Set(items.map((r) => r[link.field]).filter((v): v is string => typeof v === "string")),
    ];
    const linked = ids.length > 0 ? await records.get(tenantId, link.to, ids) : [];
    const byId = new Map(linked.map((r) => [r.id, r]));
    items = items.map((r) => {
      const id = r[link.field];
      return { ...r, [name]: typeof id === "string" ? (byId.get(id) ?? null) : null };
    });
  }
  const grouped = groupList(
    {
      items,
      keep: query.where,
      ...(query.groupBy ? { groupBy: query.groupBy } : {}),
      totals: query.totals,
      ...(query.minTotal ? { minTotal: query.minTotal } : {}),
      ...(query.asOf ? { asOf: query.asOf } : {}),
    },
    today,
  );
  const kept = grouped.groups.flatMap((g) => g.items).concat(grouped.noKey);
  return {
    items: kept.slice(0, query.limit),
    count: grouped.keptCount,
    groups: query.groupBy ? grouped.groups : [],
    ...(!query.groupBy && query.totals.length > 0
      ? { totals: grouped.groups[0]?.totals ?? {} }
      : {}),
    truncated,
  };
}

/** One record type's standard actions as platform tools. */
export function recordTools(type: RecordType): InternalTool[] {
  return recordActionSpecs(type).map((spec) => {
    const action = spec.record?.action as RecordAction;
    switch (action) {
      case "find":
        return {
          spec,
          input: FindQuery,
          output: FindOutput,
          async run(input, ctx) {
            return runFind(port(ctx), ctx.tenantId, type, input as FindQuery, ctx.now?.());
          },
        };
      case "get":
        return {
          spec,
          input: z.object({ id: Id }),
          output: z.record(z.string(), z.unknown()),
          async run(input, ctx) {
            const { id } = input as { id: string };
            const [found] = await port(ctx).get(ctx.tenantId, type.id, [id]);
            if (!found) throw new Error(`there is no ${type.name.toLowerCase()} ${id}`);
            return found;
          },
        };
      case "create":
        return {
          spec,
          input: WriteInput,
          output: z.record(z.string(), z.unknown()),
          async run(input, ctx) {
            const { sources, ...values } = input as z.output<typeof WriteInput>;
            const key = await recordWriteKey(ctx, spec.id, input);
            return port(ctx).create(ctx.tenantId, type.id, values, meta(ctx, key, sources));
          },
        };
      default:
        // `update`: a record type's actions are these four (core `RECORD_ACTIONS`).
        return {
          spec,
          input: UpdateInput,
          output: z.record(z.string(), z.unknown()),
          async run(input, ctx) {
            const { id, sources, ...values } = input as z.output<typeof UpdateInput>;
            const key = await recordWriteKey(ctx, spec.id, input);
            return port(ctx).update(ctx.tenantId, type.id, id, values, meta(ctx, key, sources));
          },
        };
    }
  });
}

/** Every declared record type's standard actions. */
export function recordToolsFor(types: readonly RecordType[]): InternalTool[] {
  return types.flatMap(recordTools);
}
