// R8 (docs/plan.md §1.86, §9; ARCHITECTURE §10.14 "The Library and the client's settings"): the
// Library, the banks the operator builds from. Read only, the operator's only (invariant 11):
//
// - processes: the templates and their versions, each workflow read as a v4 process (stored v3
//   versions are never rewritten, invariant 3; they read through `processes.fromWorkflowV3`).
//   Automations (processes used inside another) stay on `GET /api/ops/automations`.
// - tools: every registered tool with its side effect, verb, record type and undo, and the
//   retiring built-in skills that only wrap it.
// - record types: the record types connectors' tools touch (their `permissionEntities`), with
//   their verbs, scopes and tools, and the platform's own records a source id can name.
// - conditions: the conditions the processes use, grouped where the same rules are used twice.
//   Named condition sets have no storage yet, so these are derived, never edited here.
//
// Skills and connectors keep their routes (`/api/ops/skills`, `/api/ops/connectors`,
// `/api/ops/browser-sites`); triggers are the six kinds with the event catalogue
// (`/api/ops/catalog/events`). The index counts every bank.

import { z } from "zod";
import { CONDITION_PLACES } from "../process/conditions";
import { PermissionScope, SideEffect, Verb } from "../schemas/permissions";
import { Rules } from "../schemas/rules";
import { ToolUndo } from "../schemas/tool";
import { defineRoute } from "./contract";

const OPS = ["operator"] as const;
const Count = z.number().int().min(0);

export const LIBRARY_BANKS = [
  "processes",
  "skills",
  "tools",
  "connectors",
  "triggers",
  "record_types",
  "conditions",
] as const;
export const LibraryBank = z.enum(LIBRARY_BANKS);
export type LibraryBank = z.infer<typeof LibraryBank>;

// ── The index ───────────────────────────────────────────────────────────────────────────────

export const LibraryIndex = z.object({
  banks: z.array(
    z.object({
      bank: LibraryBank,
      /** What the bank holds and is offered to build with (retired entries not counted). */
      count: Count,
      /** Entries kept for stored versions but no longer offered: today's tool-wrapper skills. */
      retired: Count,
    }),
  ),
});
export type LibraryIndex = z.infer<typeof LibraryIndex>;

// ── Processes ───────────────────────────────────────────────────────────────────────────────

export const LibraryTrigger = z.object({
  id: z.string(),
  /** The trigger's kind: event, schedule, manual, command, webhook, message, handoff. */
  kind: z.string(),
  /** The event type an event trigger names; null for other kinds. */
  event: z.string().nullable(),
});
export type LibraryTrigger = z.infer<typeof LibraryTrigger>;

export const LibraryProcessWorkflow = z.object({
  slug: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  /** As stored: 3 (read as v4 here) or 4. */
  schemaVersion: z.union([z.literal(3), z.literal(4)]),
  triggers: z.array(LibraryTrigger),
  /** Every step, inside `if` paths and loops too. */
  steps: Count,
  /** Steps by v4 kind: `{ read: 2, write: 1, person: 1 }`. */
  kinds: z.record(z.string(), Count),
  /** Steps carrying each check. */
  checks: z.object({ confer: Count, approval: Count, notify: Count }),
});
export type LibraryProcessWorkflow = z.infer<typeof LibraryProcessWorkflow>;

export const LibraryProcessVersion = z.object({
  id: z.string(),
  version: z.number().int(),
  status: z.string(),
  changeNote: z.string().nullable(),
  createdAt: z.string(),
  /** 4 when any of its workflows is stored as a v4 process, else 3. */
  schemaVersion: z.union([z.literal(3), z.literal(4)]),
});
export type LibraryProcessVersion = z.infer<typeof LibraryProcessVersion>;

export const LibraryProcess = z.object({
  /** The template's agent id. */
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  /** The template's mission, in its own words. */
  description: z.string(),
  liveVersion: z.number().int().nullable(),
  latestVersion: z.number().int().nullable(),
  /** The version `workflows` reads: the live one, else the latest. */
  shownVersion: z.number().int().nullable(),
  workflows: z.array(LibraryProcessWorkflow),
  /** Newest first. */
  versions: z.array(LibraryProcessVersion),
  /** Client agents forked from it, among the clients served (test copies aren't). */
  usedBy: Count,
});
export type LibraryProcess = z.infer<typeof LibraryProcess>;

// ── Tools ───────────────────────────────────────────────────────────────────────────────────

export const LibraryTool = z.object({
  id: z.string(),
  description: z.string(),
  /** 'platform', a connector id or a pack id. */
  source: z.string(),
  /** Its name in words: the connector's or pack's, or "Platform". */
  sourceName: z.string(),
  /** The connector whose connection it acts through; null for platform and pack tools. */
  connector: z.string().nullable(),
  sideEffect: SideEffect,
  verb: Verb,
  /** The record types it touches (one, or each its input can name). */
  entities: z.array(z.string()),
  /**
   * A write's undo as declared; null for tools that change nothing in a client's tool. A write
   * that declares none is treated as `none` (`undoDeclared` false says so).
   */
  undo: ToolUndo.nullable(),
  undoDeclared: z.boolean(),
  /** A verb a person always signs, whatever else is set (§1.73). */
  alwaysSigned: z.boolean(),
  /** Built-in skills that only wrap this tool: retiring, a read or write step on it instead. */
  wrappedBy: z.array(z.string()),
});
export type LibraryTool = z.infer<typeof LibraryTool>;

// ── Record types ────────────────────────────────────────────────────────────────────────────

export const LibraryRecordType = z.object({
  /** `qbo.bill`, as a conversation's `find` names it; the platform's own by kind (`document`). */
  id: z.string(),
  /** The connector that declares it; null for the platform's own records. */
  connector: z.string().nullable(),
  /** The connector's name, or "Platform". */
  sourceName: z.string(),
  entity: z.string(),
  label: z.string(),
  verbs: z.array(Verb),
  scopes: z.array(PermissionScope),
  tools: z.array(z.object({ id: z.string(), verb: Verb, sideEffect: SideEffect })),
});
export type LibraryRecordType = z.infer<typeof LibraryRecordType>;

// ── Condition sets ──────────────────────────────────────────────────────────────────────────

export const ConditionPlace = z.enum(CONDITION_PLACES);

export const LibraryConditionUse = z.object({
  processKind: z.enum(["template", "automation"]),
  /** The template's agent id or the automation's id. */
  processId: z.string(),
  processSlug: z.string(),
  processName: z.string(),
  version: z.number().int(),
  /** The bundle workflow's slug; null for an automation (one step list). */
  workflow: z.string().nullable(),
  place: ConditionPlace,
  stepId: z.string().nullable(),
  stepName: z.string().nullable(),
  /** The trigger's id or the `if` path's name. */
  label: z.string().nullable(),
});
export type LibraryConditionUse = z.infer<typeof LibraryConditionUse>;

export const LibraryConditionSet = z.object({
  /** Stable for the same rules: a hash of their canonical JSON. */
  key: z.string(),
  /** The first `if` path's name among its uses; null when no path names it. */
  name: z.string().nullable(),
  when: Rules,
  uses: z.array(LibraryConditionUse),
});
export type LibraryConditionSet = z.infer<typeof LibraryConditionSet>;

export const LibraryConditions = z.object({
  // DECISION (library): named condition sets have no storage yet; the bank is derived from the
  // processes (each template's live, else latest, version and each automation's), read only.
  source: z.literal("derived"),
  sets: z.array(LibraryConditionSet),
});
export type LibraryConditions = z.infer<typeof LibraryConditions>;

export const libraryRoutes = {
  opsLibrary: defineRoute({
    method: "GET",
    path: "/api/ops/library",
    auth: "session",
    roles: OPS,
    summary: "The Library's banks and how much each holds",
    response: LibraryIndex,
  }),
  opsLibraryProcesses: defineRoute({
    method: "GET",
    path: "/api/ops/library/processes",
    auth: "session",
    roles: OPS,
    summary: "Processes: the templates and their versions, each workflow read as a v4 process",
    response: z.object({ processes: z.array(LibraryProcess) }),
  }),
  opsLibraryTools: defineRoute({
    method: "GET",
    path: "/api/ops/library/tools",
    auth: "session",
    roles: OPS,
    summary: "Tools by connector: what each reads or writes, its record type and its undo",
    response: z.object({ tools: z.array(LibraryTool) }),
  }),
  opsLibraryRecordTypes: defineRoute({
    method: "GET",
    path: "/api/ops/library/record-types",
    auth: "session",
    roles: OPS,
    summary: "Record types: what connectors' tools touch, with verbs and scopes, and ours",
    response: z.object({ recordTypes: z.array(LibraryRecordType) }),
  }),
  opsLibraryConditions: defineRoute({
    method: "GET",
    path: "/api/ops/library/conditions",
    auth: "session",
    roles: OPS,
    summary: "Condition sets: the conditions the processes use, and where",
    response: LibraryConditions,
  }),
} as const;
