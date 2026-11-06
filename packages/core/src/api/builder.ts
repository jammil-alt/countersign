import { z } from "zod";
import { isUuid } from "../ids";
import { NodeId, Slug } from "../schemas/common";
import { defineRoute } from "./contract";

// v0.12 W3-A: the Builder as a conversation (ARCHITECTURE §9.6; docs/plan.md §1.51). A session holds
// the working draft of one agent (new or existing, template or client agent) or one skill; each
// operator turn is answered by the Builder with text and labelled changes, each undoable on its
// own. Every route is the back office's: no portal route returns a session, a bundle, a prompt or a
// cost (invariant 11).

const Id = z.string().refine((v) => isUuid(v), "not an id");
const IdParams = z.object({ id: Id });
const OPS = ["operator"] as const;

export const BuilderSessionKind = z.enum(["agent", "skill"]);
export const BuilderSessionStatus = z.enum(["open", "saved", "closed"]);
export const BuilderTurnRole = z.enum(["operator", "builder"]);

const CheckError = z.object({
  stepId: z.string().nullable(),
  field: z.string(),
  message: z.string(),
  code: z.string(),
  workflow: z.string().optional(),
});

/** One labelled change of a turn (`builder_turn.changes`). */
export const BuilderChange = z.object({
  /** What undo names: a selectable change id (`step:<id>`, `bundle#/definition/…`) or a field. */
  id: z.string().min(1).max(500),
  label: z.string().max(500),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  /** An undo turn's entry: the turn and change it reverted. */
  undoes: z.object({ turnId: z.string(), changeId: z.string() }).optional(),
});
export type BuilderChange = z.infer<typeof BuilderChange>;

/** What a turn keeps besides its text and changes (`builder_turn.meta`). */
export const BuilderTurnMeta = z.object({
  questions: z.array(z.string()).default([]),
  gaps: z.array(z.string()).default([]),
  notes: z.array(z.string()).default([]),
  errors: z.array(CheckError).default([]),
  /** The `/command` as parsed: its name and what it named. */
  command: z
    .object({ name: z.string(), target: z.string().nullable(), args: z.string() })
    .optional(),
  model: z.string().optional(),
});
export type BuilderTurnMeta = z.infer<typeof BuilderTurnMeta>;

export const BuilderTurnView = z.object({
  id: z.string(),
  seq: z.number().int(),
  role: BuilderTurnRole,
  text: z.string(),
  command: z.string().nullable(),
  changes: z.array(BuilderChange.extend({ undone: z.boolean() })),
  questions: z.array(z.string()),
  gaps: z.array(z.string()),
  notes: z.array(z.string()),
  errors: z.array(CheckError),
  savedVersionId: z.string().nullable(),
  /** USD, the Builder's model calls (operator only). */
  costUsd: z.string(),
  undoneAt: z.string().nullable(),
  createdAt: z.string(),
});
export type BuilderTurnView = z.infer<typeof BuilderTurnView>;

/** A template like the draft (core's bundleSimilarity), offered to fork instead. */
export const ClosestTemplate = z.object({
  agentId: z.string(),
  slug: z.string(),
  name: z.string(),
  version: z.number().int(),
  /** 0–1. */
  score: z.number(),
});
export type ClosestTemplate = z.infer<typeof ClosestTemplate>;

export const BuilderSessionView = z.object({
  id: z.string(),
  kind: BuilderSessionKind,
  clientId: z.string().nullable(),
  clientName: z.string().nullable(),
  agentId: z.string().nullable(),
  skillId: z.string().nullable(),
  baseVersionId: z.string().nullable(),
  status: BuilderSessionStatus,
  /** The working draft: an agent bundle, or `{definition, cases}` for a skill. */
  bundle: z.unknown(),
  /** What would stop a publish of the draft as it stands. */
  errors: z.array(CheckError),
  closest: z.array(ClosestTemplate),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type BuilderSessionView = z.infer<typeof BuilderSessionView>;

/** An example the operator attaches to a skill turn: the input, and the answer when known. */
export const BuilderExample = z.strictObject({
  name: z.string().trim().min(1).max(200).optional(),
  input: z.unknown(),
  expected: z.unknown().optional(),
});
export type BuilderExample = z.infer<typeof BuilderExample>;

const SessionDetail = z.object({ session: BuilderSessionView, turns: z.array(BuilderTurnView) });

export const builderRoutes = {
  opsBuilderSessions: defineRoute({
    method: "GET",
    path: "/api/ops/builder/sessions",
    auth: "session",
    roles: OPS,
    summary: "Builder conversations, newest first, by agent, skill, client or status",
    query: z.object({
      agent: Id.optional(),
      skill: Id.optional(),
      client: Id.optional(),
      status: BuilderSessionStatus.optional(),
    }),
    response: z.object({
      sessions: z.array(BuilderSessionView.omit({ bundle: true, errors: true, closest: true })),
    }),
  }),
  opsStartBuilderSession: defineRoute({
    method: "POST",
    path: "/api/ops/builder/sessions",
    auth: "session",
    roles: OPS,
    summary: "Start a Builder conversation about a new or existing agent, or a new or existing skill",
    body: z
      .strictObject({
        kind: BuilderSessionKind,
        /** An existing agent (template or client agent). */
        agentId: Id.optional(),
        /** Default: the agent's latest version, or the skill's. */
        fromVersionId: Id.optional(),
        /** An existing operator skill. */
        skillId: Id.optional(),
        /** A new client agent or skill for this client (else a template or a shared skill). */
        clientId: Id.optional(),
        /** A new agent's name and area. */
        name: z.string().trim().min(1).max(200).optional(),
        role: z.string().max(200).optional(),
      })
      .refine((b) => b.kind === "agent" || b.agentId === undefined, {
        message: "a skill conversation names no agent",
      })
      .refine((b) => b.kind === "skill" || b.skillId === undefined, {
        message: "an agent conversation names no skill",
      }),
    response: SessionDetail,
  }),
  opsBuilderSession: defineRoute({
    method: "GET",
    path: "/api/ops/builder/sessions/:id",
    auth: "session",
    roles: OPS,
    summary: "A Builder conversation: the working draft, its turns and the closest templates",
    params: IdParams,
    response: SessionDetail,
  }),
  opsBuilderTurn: defineRoute({
    method: "POST",
    path: "/api/ops/builder/sessions/:id/turns",
    auth: "session",
    roles: OPS,
    summary: "The operator's turn (text or /skill, /automation, /trigger) and the Builder's answer",
    params: IdParams,
    body: z.strictObject({
      text: z.string().trim().min(1).max(4000),
      /** Skill conversations: examples that become test cases. */
      examples: z.array(BuilderExample).max(50).optional(),
      /** A client's change request handed to the Builder (a client agent's conversation). */
      requestId: Id.optional(),
    }),
    response: SessionDetail.extend({ turn: BuilderTurnView }),
  }),
  opsBuilderUndo: defineRoute({
    method: "POST",
    path: "/api/ops/builder/sessions/:id/undo",
    auth: "session",
    roles: OPS,
    summary: "Undo one change of a turn by three-way merge; 409 undo_conflict when a later change",
    params: IdParams,
    body: z.strictObject({ turnId: Id, changeId: z.string().min(1).max(500) }),
    response: SessionDetail.extend({ turn: BuilderTurnView }),
  }),
  opsBuilderSaveAutomation: defineRoute({
    method: "POST",
    path: "/api/ops/builder/sessions/:id/automation",
    auth: "session",
    roles: OPS,
    summary: "Save selected steps of the draft as an automation draft, used in their place",
    params: IdParams,
    body: z.strictObject({
      stepIds: z.array(NodeId).min(1).max(100),
      slug: Slug,
      name: z.string().trim().min(1).max(120),
      description: z.string().max(2000).optional(),
    }),
    response: SessionDetail.extend({
      turn: BuilderTurnView,
      automation: z.object({ id: z.string(), slug: z.string(), ref: z.string() }),
      automationVersion: z.object({ id: z.string(), version: z.number().int() }),
    }),
  }),
  opsBuilderSave: defineRoute({
    method: "POST",
    path: "/api/ops/builder/sessions/:id/save",
    auth: "session",
    roles: OPS,
    summary: "Save the draft as an ordinary draft version (nothing is published from here)",
    params: IdParams,
    body: z.strictObject({
      /** A new agent's or skill's address; default from its name, made unique. */
      slug: Slug.optional(),
      changeNote: z.string().trim().min(1).max(300).optional(),
    }),
    response: SessionDetail.extend({
      turn: BuilderTurnView,
      agent: z.object({ id: z.string(), slug: z.string() }).nullable(),
      skill: z.object({ id: z.string(), slug: z.string(), ref: z.string() }).nullable(),
      version: z.object({ id: z.string(), version: z.number().int() }),
      /** Test cases saved with a skill (new ones only). */
      cases: z.array(z.object({ id: z.string(), name: z.string(), clientId: z.string().nullable() })),
      errors: z.array(CheckError),
    }),
  }),
  opsCloseBuilderSession: defineRoute({
    method: "POST",
    path: "/api/ops/builder/sessions/:id/close",
    auth: "session",
    roles: OPS,
    summary: "Close a Builder conversation (it stays readable; nothing is deleted)",
    params: IdParams,
    response: SessionDetail,
  }),
} as const;
