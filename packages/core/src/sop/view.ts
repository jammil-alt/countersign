// The agent's SOP (docs/sop-plan.md; owner, 2026-11-21): one formal document per client agent,
// made by code from how the agent is set up now. This file is its shape: what the portal's SOP tab
// reads, what the back office reads, and what each revision stores (`sop_revision.view`).
//
// Made by code, never by a model, and never the bundle, instructions, prompts, budgets or cost
// (invariant 11): only step names and purposes, plain words for what each step is, who takes part,
// the controls the gate applies, the systems and data, and the model each AI step runs on (the
// owner chose to show it, 2026-11-21). Nothing in it waits on anyone: it says how the process runs.

import { z } from "zod";
import { DecisionKind } from "../build/build";

/** Someone who takes part: a person, the client's team, an agent, or Mezonas. */
export const SOP_PARTY_KINDS = ["person", "team", "agent", "mezonas"] as const;
export const SopParty = z.object({
  /** Stable within one SOP: a role, a person's id or an agent's slug. Filters match on it. */
  key: z.string(),
  kind: z.enum(SOP_PARTY_KINDS),
  name: z.string(),
});
export type SopParty = z.infer<typeof SopParty>;

/** How a step does its work (docs/sop-plan.md §3). */
export const SOP_METHODS = ["rules", "ai", "rules_then_ai", "person"] as const;
export const SopMethod = z.enum(SOP_METHODS);
export type SopMethod = z.infer<typeof SopMethod>;

/** What the agent may do in a system for one verb, in the client's words. */
export const SOP_LEVELS = ["auto", "ask", "off"] as const;
export const SopLevel = z.enum(SOP_LEVELS);
export type SopLevel = z.infer<typeof SopLevel>;

export const SopApprover = z.object({
  party: SopParty,
  /** "over USD 5,000"; null for the approver of everything else. */
  condition: z.string().nullable(),
});
export type SopApprover = z.infer<typeof SopApprover>;

export const SopStepLine = z.object({
  line: z.literal("step"),
  id: z.string(),
  /** "5", "5.1". */
  number: z.string(),
  depth: z.number().int().min(0),
  /** The workflow it is in, when the agent has more than one. */
  workflow: z.string().nullable(),
  name: z.string(),
  /** The step's kind in plain words ("Updates your tools, after a person approves"). */
  kindWords: z.string(),
  /** Null when it can't be told (a skill that isn't found). */
  method: SopMethod.nullable(),
  /** The AI model by name and maker, for AI steps; null otherwise or when it has no client name. */
  model: z.string().nullable(),
  /** One sentence on why the step is there: the operator's, else one made by code. */
  purpose: z.string(),
  purposeWritten: z.boolean(),
  /** Who does it, only when it isn't this agent: a person, another agent. */
  who: SopParty.nullable(),
  /** For a step that changes a client's tool: what happens, and who approves. */
  approval: z
    .object({
      level: SopLevel,
      approvers: z.array(SopApprover),
      byWhen: z.string().nullable(),
      ifNoAnswer: z.string().nullable(),
      ifRejected: z.string().nullable(),
    })
    .nullable(),
  /** Who is told (notices on the step, or a notify step's recipients). */
  told: z.array(SopParty),
  systems: z.array(
    z.object({ id: z.string(), name: z.string(), verb: z.string(), level: SopLevel }),
  ),
  data: z.array(z.object({ id: z.string(), words: z.string() })),
  controls: z.array(z.string()),
  /** What happens when the step fails, when it says. */
  onError: z.string().nullable(),
  /** A person step's or a deadline's: by when. */
  byWhen: z.string().nullable(),
});
export type SopStepLine = z.infer<typeof SopStepLine>;

/** A path of an `if`: "If a price alert or a new vendor", "Otherwise". */
export const SopPathLine = z.object({
  line: z.literal("path"),
  depth: z.number().int().min(0),
  label: z.enum(["if", "otherwise"]),
  words: z.string(),
  /** The path has no steps: straight on. */
  empty: z.boolean(),
});
export type SopPathLine = z.infer<typeof SopPathLine>;

export const SopProcedureLine = z.discriminatedUnion("line", [SopStepLine, SopPathLine]);
export type SopProcedureLine = z.infer<typeof SopProcedureLine>;

export const SOP_CONTROL_KINDS = ["prevents", "catches"] as const;
export const SOP_CONTROL_HOW = ["person", "automatic", "rules", "ai"] as const;
export const SopControl = z.object({
  /** "C1": its place in this SOP. */
  id: z.string(),
  /** Stable across revisions ("approval:step-6", "system:<connection>", "platform:no_delete"). */
  key: z.string(),
  name: z.string(),
  kind: z.enum(SOP_CONTROL_KINDS),
  how: z.enum(SOP_CONTROL_HOW),
  /** The model, for a control done by AI. */
  model: z.string().nullable(),
  /** Step numbers; empty for one that covers every step. */
  steps: z.array(z.string()),
  allSteps: z.boolean(),
  owner: SopParty.nullable(),
  evidence: z.string(),
});
export type SopControl = z.infer<typeof SopControl>;

export const SopSystem = z.object({
  /** "S1". */
  id: z.string(),
  key: z.string(),
  name: z.string(),
  /** The account, when connected ("Harbor Millwork LLC"). */
  account: z.string().nullable(),
  connected: z.boolean(),
  connectedBy: z.string().nullable(),
  /** Per verb, null where the system has no such verb for this agent. */
  read: SopLevel.nullable(),
  create: SopLevel.nullable(),
  update: SopLevel.nullable(),
  delete: SopLevel.nullable(),
  steps: z.array(z.string()),
});
export type SopSystem = z.infer<typeof SopSystem>;

export const SopData = z.object({
  /** "D1". */
  id: z.string(),
  key: z.string(),
  record: z.string(),
  livesIn: z.string(),
  /** "Reads", "Saves", "Reads and changes". */
  agentDoes: z.string(),
  steps: z.array(z.string()),
  /** The AI that reads it, by step: "Step 1, Claude Sonnet 5.5"; null when no AI step does. */
  readByAi: z.string().nullable(),
  kept: z.string(),
});
export type SopData = z.infer<typeof SopData>;

/** One change between two revisions, in words, by code (`sopChanges`). */
export const SopChange = z.object({
  section: z.enum([
    "header",
    "roles",
    "start",
    "procedure",
    "controls",
    "systems",
    "decisions",
    "references",
  ]),
  /** The step, control or system it touches ("6", "C2", "S1"), when one. */
  ref: z.string().nullable(),
  words: z.string(),
  was: z.string().nullable(),
});
export type SopChange = z.infer<typeof SopChange>;

export const SopRevisionEntry = z.object({
  /** "7.2". */
  number: z.string(),
  at: z.string(),
  changes: z.array(SopChange),
  /** Who made the change: a client's person by name, "Mezonas", or null for our hourly check. */
  by: z.string().nullable(),
  /** Where it was made, in words ("Approval rules"). */
  where: z.string(),
});
export type SopRevisionEntry = z.infer<typeof SopRevisionEntry>;

export const SopView = z
  .object({
    agent: z.object({ id: z.string(), name: z.string(), key: z.string() }),
    code: z.string(),
    client: z.string(),
    area: z.object({ id: z.string(), words: z.string() }),
    stage: z.object({ id: z.string(), words: z.string() }),
    /** When this view was made. */
    asOf: z.string(),
    /** The current revision and the one before; null until the first is recorded. */
    revision: SopRevisionEntry.nullable(),
    previous: z.object({ number: z.string(), at: z.string() }).nullable(),
    accountable: z.array(SopParty),
    owner: z.object({ party: SopParty, model: z.string().nullable() }).nullable(),
    lead: SopParty.nullable(),
    purpose: z.string(),
    scope: z.object({
      covers: z.array(z.string()),
      notCovered: z.array(z.string()),
      never: z.array(z.string()),
    }),
    roles: z.array(z.object({ role: z.string(), party: SopParty, words: z.string() })),
    /** Who else takes part, by step (never the agent itself, docs/sop-plan.md §3). */
    matrix: z.object({
      parties: z.array(SopParty),
      rows: z.array(
        z.object({
          step: z.string(),
          name: z.string(),
          cells: z.array(z.enum(["", "does", "approves", "checks", "told"])),
          /** A cell's condition ("Over USD 5,000"), by party index. */
          notes: z.array(z.string().nullable()),
        }),
      ),
    }),
    start: z.object({
      triggers: z.array(z.string()),
      hours: z.string().nullable(),
      runByHand: z.string().nullable(),
    }),
    summary: z.object({
      steps: z.number().int(),
      rules: z.number().int(),
      ai: z.number().int(),
      rulesThenAi: z.number().int(),
      person: z.number().int(),
      writesByRules: z.boolean(),
    }),
    procedure: z.array(SopProcedureLine),
    controls: z.array(SopControl),
    systems: z.array(SopSystem),
    data: z.array(SopData),
    /** What the agent learned for this client: the client admin's only; null when hidden. */
    learned: z.array(z.object({ id: z.string(), note: z.string(), at: z.string() })).nullable(),
    exceptions: z.array(z.object({ id: z.string(), words: z.string() })),
    decisions: z.array(
      z.object({
        id: z.string(),
        what: z.string(),
        value: z.string().nullable(),
        kind: DecisionKind,
        step: z.string().nullable(),
        setBy: z.string(),
      }),
    ),
    setup: z.array(z.object({ label: z.string(), answer: z.string() })),
    settings: z.array(
      z.object({
        label: z.string(),
        value: z.string(),
        limits: z.string().nullable(),
        changedBy: z.string().nullable(),
      }),
    ),
    measures: z.array(z.object({ label: z.string(), value: z.string() })),
    references: z.object({
      follows: z.array(z.string()),
      handsOverTo: z.array(z.string()),
      takesOverFrom: z.array(z.string()),
      knowledge: z.array(z.string()),
    }),
    history: z.array(SopRevisionEntry),
  })
  .meta({ id: "SopView" });
export type SopView = z.infer<typeof SopView>;
