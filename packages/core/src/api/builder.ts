import { z } from "zod";
import { isUuid } from "../ids";
import { JsonSchema, Slug } from "../schemas/common";
import { TableColumn } from "../schemas/table";
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
  /** v0.18 (docs/plan.md §1.105): the step the operator was working on, by id and its name then. */
  focus: z.object({ stepId: z.string(), name: z.string() }).optional(),
  /** A skill turn's sample file, by name and kind (the file itself is never kept). */
  sample: z
    .object({ filename: z.string(), kind: z.enum(["table", "document", "other"]) })
    .optional(),
  /**
   * Two rounds (owner, 2026-11-24): the parts the conversation's first turn shortlisted, by id;
   * later turns show these in full without asking again.
   */
  shortlist: z
    .object({
      skills: z.array(z.string()),
      tools: z.array(z.string()),
      automations: z.array(z.string()),
      events: z.array(z.string()),
    })
    .optional(),
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
  /** v0.18: an operator turn sent while working on one step: that step. */
  focus: z.object({ stepId: z.string(), name: z.string() }).optional(),
  /** A skill turn's sample file, by name and kind. */
  sample: z
    .object({ filename: z.string(), kind: z.enum(["table", "document", "other"]) })
    .optional(),
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
// A skill's sample file (owner, 2026-11-24: "allow the upload of a file like excel or csv or pdf,
// jpeg etc ... then with words specify the input and the output"). The operator adds one when
// describing a skill; the server reads it and the Builder sees it as data. Never stored: like
// Read table's and Collect reports' samples, it never becomes a client's document.

/** 5 MB of bytes, as base64: the most a sample file is read at. */
export const SAMPLE_FILE_BASE64_MAX = Math.ceil((5 * 1024 * 1024) / 3) * 4;

/** A sample file as the browser sends it. */
export const BuilderSampleFile = z.strictObject({
  filename: z.string().trim().min(1).max(255),
  /** As the browser declared it; the extension decides when it is generic. */
  mimeType: z.string().max(200).default(""),
  base64: z.string().min(1).max(SAMPLE_FILE_BASE64_MAX),
});
export type BuilderSampleFile = z.infer<typeof BuilderSampleFile>;

/** The sample kinds: a table read in code, a document a model reads, or neither. */
export const SAMPLE_KINDS = ["table", "document", "other"] as const;

/** A sample file as read: a table's columns and first rows, as Read table would give them. */
export const SkillSampleView = z.object({
  filename: z.string(),
  mimeType: z.string(),
  kind: z.enum(SAMPLE_KINDS),
  table: z
    .object({
      /** The worksheet read (an .xlsx file's), and every worksheet it has. */
      sheet: z.string().nullable(),
      sheets: z.array(z.string()),
      /** Read table's expected columns for it: one per header, typed from its rows. */
      columns: z.array(TableColumn),
      /** The first rows, keyed by those columns' fields (at most 5). */
      rows: z.array(z.record(z.string(), z.unknown())),
      rowCount: z.number().int(),
      /** Why it couldn't be read whole; null when it could. */
      failure: z.string().nullable(),
    })
    .nullable(),
  /** Why the file can't be a sample; null when it can. */
  failure: z.string().nullable(),
});
export type SkillSampleView = z.infer<typeof SkillSampleView>;

// Check the skill (owner, 2026-11-24: "do the edit-and-try screen next"): the operator changes
// what a drafted skill gets, does and gives back by hand, and tries it once on a sample or an
// input before saving. A try runs on the test bench: in memory, every write refused, nothing kept
// but what the operator keeps as a test.

/** The most rows of a sample spreadsheet a try runs on. */
export const TRY_ROWS_MAX = 50;

/** A change to a skill draft made by hand: each part given replaces the draft's. */
export const SkillDraftEdit = z.strictObject({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().min(1).max(500).optional(),
  instructions: z.string().trim().min(1).max(20_000).optional(),
  input: JsonSchema.optional(),
  output: JsonSchema.optional(),
  /** A test case to add: a try's input with its output as the expected answer. */
  addCase: z
    .strictObject({
      name: z.string().trim().min(1).max(200),
      input: z.unknown(),
      expected: z.unknown(),
    })
    .optional(),
});
export type SkillDraftEdit = z.infer<typeof SkillDraftEdit>;

/** One try of a skill draft: what it got, what it gave back, or why it failed. */
export const SkillTryView = z.object({
  status: z.enum(["succeeded", "failed"]),
  /** The input as the skill got it (a sample's rows, a document's id, or the JSON given). */
  input: z.unknown(),
  /** What it got from a sample, in words ("the first 50 of 412 rows of ucc.xlsx"). */
  from: z.string().nullable(),
  output: z.unknown(),
  error: z.string().nullable(),
  /** USD, the try's model calls (operator only). */
  costUsd: z.string(),
  modelCalls: z.number().int(),
  toolCalls: z.array(
    z.object({ tool: z.string(), status: z.string(), reason: z.string().nullable() }),
  ),
  /** Whether its input can be kept as a test (a sample document can't: it isn't stored). */
  keepable: z.boolean(),
});
export type SkillTryView = z.infer<typeof SkillTryView>;

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
      sessions: z.array(
        BuilderSessionView.omit({ bundle: true, errors: true, closest: true }).extend({
          /** Its first message (what it was about), for a list of past conversations. */
          title: z.string().nullable().optional(),
          /** How many messages it has, both sides. */
          turns: z.number().int().optional(),
          /** Started by the operator asking. */
          mine: z.boolean().optional(),
        }),
      ),
    }),
  }),
  opsStartBuilderSession: defineRoute({
    method: "POST",
    path: "/api/ops/builder/sessions",
    auth: "session",
    roles: OPS,
    summary:
      "Start a Builder conversation about a new or existing agent, or a new or existing skill",
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
      /**
       * v0.18 (docs/plan.md §1.105): an agent conversation's turn about one step of the working
       * draft (the step the operator has open): the Builder answers about it or changes it.
       */
      focusStepId: z.string().min(1).max(100).optional(),
      /**
       * Skill conversations: a sample of what the skill gets. A spreadsheet's columns and first
       * rows reach the Builder as data (and its first rows become a test case); a PDF or an image
       * is attached to its model call. Never stored.
       */
      sample: BuilderSampleFile.optional(),
    }),
    response: SessionDetail.extend({ turn: BuilderTurnView }),
  }),
  opsBuilderSkillEdit: defineRoute({
    method: "POST",
    path: "/api/ops/builder/sessions/:id/skill",
    auth: "session",
    roles: OPS,
    summary:
      "Change a skill draft by hand: what it gets, its instructions, what it gives back, or add a tried input as a test. Undoable like the Builder's changes",
    params: IdParams,
    body: SkillDraftEdit,
    response: SessionDetail.extend({ turn: BuilderTurnView }),
  }),
  opsBuilderSkillTry: defineRoute({
    method: "POST",
    path: "/api/ops/builder/sessions/:id/try",
    auth: "session",
    roles: OPS,
    summary:
      "Try a skill draft once on a sample file or an input, on the test bench: in memory, every write refused, nothing kept",
    params: IdParams,
    body: z
      .strictObject({ input: z.unknown().optional(), sample: BuilderSampleFile.optional() })
      .refine((b) => b.input !== undefined || b.sample !== undefined, {
        message: "give an input or a sample file",
      }),
    response: SkillTryView,
  }),
  opsSkillSample: defineRoute({
    method: "POST",
    path: "/api/ops/skills/sample",
    auth: "session",
    roles: OPS,
    summary:
      "Read a skill's sample file: a spreadsheet's columns and first rows as Read table gives them, or what kind of document it is. Nothing is stored or sent to a model",
    body: z.strictObject({ file: BuilderSampleFile }),
    response: SkillSampleView,
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
      cases: z.array(
        z.object({ id: z.string(), name: z.string(), clientId: z.string().nullable() }),
      ),
      errors: z.array(CheckError),
    }),
  }),
  opsSyncBuilderSession: defineRoute({
    method: "POST",
    path: "/api/ops/builder/sessions/:id/sync",
    auth: "session",
    roles: OPS,
    summary:
      "Carry an agent conversation on from a version the operator saved since (their edits outside the chat): the draft becomes that version's, the turns stay",
    params: IdParams,
    body: z.strictObject({ fromVersionId: Id }),
    response: SessionDetail,
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
