// Grants per record type and data sets (docs/step-model-plan.md §10f, parts 3 and 4). An agent's
// grant lists, per record type, whether it may read, create and update; a data set is a named group
// of such grants for one use case, across areas, turned on or off for the agent. Both are saved
// with the agent's version (`definition.data`) and published like any change: the runtime reads them
// only from the pinned version (invariant 4), and nothing in a run can change them (invariant 9).
//
// Nothing is granted by default: an agent without a grant reaches no record type through the
// standard actions. Writing into another area is explicit and shown on the agent
// (`crossAreaWrites`). Writes to our own records need no client approval; they are always logged
// with their evidence (the record_write log, invariant 10).
//
// Pure: the gate in packages/agents calls `recordGrantAllows`; the API and the agent screen the rest.

import { z } from "zod";
import { Slug } from "../schemas/common";
import { type RecordType, RecordTypeId, recordTypeAllows } from "./record-type";

/** What an agent may do with one record type. */
export const RecordGrant = z.strictObject({
  recordType: RecordTypeId,
  read: z.boolean().default(false),
  create: z.boolean().default(false),
  update: z.boolean().default(false),
});
export type RecordGrant = z.infer<typeof RecordGrant>;

/** A named group of record grants for one use case ("Margin and ROI"), across areas. */
export const DataSet = z
  .strictObject({
    id: Slug,
    name: z.string().trim().min(1).max(60),
    about: z.string().trim().max(200).optional(),
    /** Turned on or off for this agent; an off set grants nothing. */
    on: z.boolean().default(true),
    grants: z.array(RecordGrant).min(1).max(30),
  })
  .refine((s) => new Set(s.grants.map((g) => g.recordType)).size === s.grants.length, {
    message: "a data set names each record type once",
    path: ["grants"],
  });
export type DataSet = z.infer<typeof DataSet>;

/**
 * An agent's data access (`definition.data`): its own grants and its data sets. Optional on the
 * definition with no default, so bundles without it parse and hash as they were.
 */
export const AgentData = z
  .strictObject({
    grants: z.array(RecordGrant).max(50).default([]),
    sets: z.array(DataSet).max(20).default([]),
  })
  .refine((d) => new Set(d.grants.map((g) => g.recordType)).size === d.grants.length, {
    message: "the agent's grants name each record type once",
    path: ["grants"],
  })
  .refine((d) => new Set(d.sets.map((s) => s.id)).size === d.sets.length, {
    message: "two data sets have the same id",
    path: ["sets"],
  });
export type AgentData = z.infer<typeof AgentData>;

/** The access a grant gives. */
export type RecordAccess = "read" | "create" | "update";
export const RECORD_ACCESS: readonly RecordAccess[] = ["read", "create", "update"];

/** The standard action and the access it needs. */
export function accessFor(action: "find" | "get" | "create" | "update"): RecordAccess {
  return action === "find" || action === "get" ? "read" : action;
}

/**
 * What an agent may do per record type: its own grants and every data set that is on, together.
 * DECISION: the union, since each is something the operator granted on purpose; a set turned off
 * gives nothing, and nothing here ever adds what neither grants.
 */
export function effectiveRecordGrants(
  data: AgentData | undefined,
): Map<string, Record<RecordAccess, boolean>> {
  const out = new Map<string, Record<RecordAccess, boolean>>();
  const add = (g: RecordGrant) => {
    const cur = out.get(g.recordType) ?? { read: false, create: false, update: false };
    out.set(g.recordType, {
      read: cur.read || g.read,
      create: cur.create || g.create,
      update: cur.update || g.update,
    });
  };
  for (const g of data?.grants ?? []) add(g);
  for (const s of data?.sets ?? []) if (s.on) for (const g of s.grants) add(g);
  return out;
}

/** Whether the agent's version grants this access to a record type. */
export function recordGrantAllows(
  data: AgentData | undefined,
  recordType: string,
  access: RecordAccess,
): boolean {
  return effectiveRecordGrants(data).get(recordType)?.[access] === true;
}

/** The record types an agent can read, for the pickers: what it is granted, nothing more. */
export function grantedRecordTypes(data: AgentData | undefined, access: RecordAccess): string[] {
  return [...effectiveRecordGrants(data)]
    .filter(([, a]) => a[access])
    .map(([t]) => t)
    .sort();
}

/**
 * What a grant asks that the record types can't give, in plain words (empty: none): a record type
 * nobody declares, or a write the record type doesn't allow.
 */
export function agentDataProblems(
  data: AgentData | undefined,
  types: readonly Pick<RecordType, "id" | "name" | "operations">[],
): string[] {
  const out: string[] = [];
  const byId = new Map(types.map((t) => [t.id, t]));
  const check = (g: RecordGrant, where: string) => {
    const t = byId.get(g.recordType);
    if (!t) {
      out.push(`${where} names ${g.recordType}, which isn't a record type`);
      return;
    }
    if (g.create && !recordTypeAllows(t, "create")) {
      out.push(`${where} grants creating ${t.name.toLowerCase()} records, which can't be created`);
    }
    if (g.update && !recordTypeAllows(t, "update")) {
      out.push(`${where} grants changing ${t.name.toLowerCase()} records, which can't be changed`);
    }
  };
  for (const g of data?.grants ?? []) check(g, "The agent's grant");
  for (const s of data?.sets ?? []) for (const g of s.grants) check(g, `Data set ${s.name}`);
  return out;
}

/**
 * The writes an agent may make into another area's records (§10f: "Writing into another area is
 * explicit, shown on the agent and reviewable"). The agent's area is its own; `shared` is every
 * area's, so writes there are listed too.
 */
export function crossAreaWrites(
  data: AgentData | undefined,
  agentArea: string,
  types: readonly Pick<RecordType, "id" | "area">[],
): { recordType: string; area: string; create: boolean; update: boolean }[] {
  const areaOf = new Map(types.map((t) => [t.id, t.area]));
  return [...effectiveRecordGrants(data)]
    .filter(([id, a]) => (a.create || a.update) && areaOf.get(id) !== agentArea)
    .map(([id, a]) => ({
      recordType: id,
      area: areaOf.get(id) ?? "unknown",
      create: a.create,
      update: a.update,
    }))
    .sort((x, y) => x.recordType.localeCompare(y.recordType));
}

/**
 * What one version grants that the one before it didn't, in plain words (empty: nothing new). Shown
 * when a version is reviewed, so a widened grant is never missed.
 */
export function widenedRecordGrants(
  before: AgentData | undefined,
  after: AgentData | undefined,
): string[] {
  const was = effectiveRecordGrants(before);
  const out: string[] = [];
  for (const [type, access] of effectiveRecordGrants(after)) {
    for (const a of RECORD_ACCESS) {
      if (access[a] && !was.get(type)?.[a]) out.push(`${a} ${type}`);
    }
  }
  return out.sort();
}
