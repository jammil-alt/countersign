// Builds (docs/plan.md §1.108): a new agent's or skill's way from intake to go-live, as a project.
// The phases and their words, the records each phase keeps (the brief, the fit-gap, the test plan,
// the QA record), the open items, and the gates: what must be true to move on. The API and the
// screen share these, so the screen says why a move is off with the server's own reasons.

import { z } from "zod";
import { sliceWhole, storable } from "../text";

export const BUILD_KINDS = ["agent", "skill"] as const;
export const BuildKind = z.enum(BUILD_KINDS);
export type BuildKind = z.infer<typeof BuildKind>;

export const BUILD_PHASES = ["intake", "fitgap", "draft", "poc", "client_test", "qa"] as const;
export const BuildPhase = z.enum(BUILD_PHASES);
export type BuildPhase = z.infer<typeof BuildPhase>;

export const BUILD_STATUSES = ["open", "live", "stopped"] as const;
export const BuildStatus = z.enum(BUILD_STATUSES);
export type BuildStatus = z.infer<typeof BuildStatus>;

/** Each phase's name and what closes it, in the operator's words. */
export const PHASE_WORDS: Record<BuildPhase, { label: string; closes: string }> = {
  intake: { label: "Intake", closes: "Closes when you confirm the brief." },
  fitgap: { label: "Fit-gap", closes: "Closes when you agree the direction; the draft is made." },
  draft: { label: "Draft", closes: "Closes when the draft has no missing or invalid steps." },
  poc: { label: "POC test", closes: "Closes when every required test passes." },
  client_test: {
    label: "Client test",
    closes: "Closes when the client's trial is done, or you move on with a reason.",
  },
  qa: { label: "QA and go / no-go", closes: "Closes when QA is signed and the client signs off." },
};

/** The phases a build goes through: a skill is tested inside the agents that use it. */
// DECISION: a skill build skips the client test (plan §1.108).
export function phasesOf(kind: BuildKind): readonly BuildPhase[] {
  return kind === "skill" ? BUILD_PHASES.filter((p) => p !== "client_test") : BUILD_PHASES;
}

export function nextPhase(kind: BuildKind, phase: BuildPhase): BuildPhase | null {
  const list = phasesOf(kind);
  const i = list.indexOf(phase);
  return i >= 0 && i < list.length - 1 ? (list[i + 1] ?? null) : null;
}

export function phaseIndex(kind: BuildKind, phase: BuildPhase): number {
  return phasesOf(kind).indexOf(phase);
}

// ── Intake: the brief ────────────────────────────────────────────────────────────────────────────

export const BRIEF_FIELDS = [
  "goal",
  "measure",
  "trigger",
  "dataIn",
  "dataOut",
  "people",
  "rules",
  "volume",
  "outOfScope",
] as const;
export const BriefFieldKey = z.enum(BRIEF_FIELDS);
export type BriefFieldKey = z.infer<typeof BriefFieldKey>;

export const BRIEF_LABELS: Record<BriefFieldKey, string> = {
  goal: "Goal",
  measure: "Done well means",
  trigger: "Starts when",
  dataIn: "Data in",
  dataOut: "Data out",
  people: "People",
  rules: "Rules",
  volume: "How many",
  outOfScope: "Not in scope",
};

/** What the Builder asks about each field, when it is still open. */
export const BRIEF_HINTS: Record<BriefFieldKey, string> = {
  goal: "What the work is for, in one sentence.",
  measure: "How you'll know it's done well.",
  trigger: "What starts it, and how often.",
  dataIn: "What it reads, and where each comes from.",
  dataOut: "What it writes or sends, and where.",
  people: "Who approves, who is told, who handles the exceptions.",
  rules: "Tolerances, and the cases that need a person.",
  volume: "How many, how fast.",
  outOfScope: "What it won't do.",
};

/** The fields intake can't close without. */
export const BRIEF_REQUIRED: readonly BriefFieldKey[] = ["goal", "trigger", "dataIn", "dataOut"];

export const BRIEF_STATES = ["confirmed", "assumed", "open"] as const;
export const BriefFieldState = z.enum(BRIEF_STATES);
export type BriefFieldState = z.infer<typeof BriefFieldState>;

export const BriefField = z.object({
  text: storable(z.string().trim().max(1000)),
  state: BriefFieldState,
});
export type BriefField = z.infer<typeof BriefField>;

export const Brief = z.object(
  Object.fromEntries(BRIEF_FIELDS.map((k) => [k, BriefField.optional()])) as Record<
    BriefFieldKey,
    z.ZodOptional<typeof BriefField>
  >,
);
export type Brief = z.infer<typeof Brief>;

/** The brief as stored: anything unreadable is left out rather than failing the build. */
export function readBrief(raw: unknown): Brief {
  const out: Brief = {};
  if (!raw || typeof raw !== "object") return out;
  for (const key of BRIEF_FIELDS) {
    const field = BriefField.safeParse((raw as Record<string, unknown>)[key]);
    if (field.success && (field.data.text || field.data.state === "open")) out[key] = field.data;
  }
  return out;
}

const BRIEF_STATE_RANK: Record<BriefFieldState, number> = { open: 0, assumed: 1, confirmed: 2 };

/**
 * The Builder's brief fields onto the stored brief (BUILDER_QA AI-2), and the fields it changed. A
 * field's state never goes down: a confirmed field (the operator wrote it, or said it) changes only
 * to another confirmed text, which the Builder sends only for what the operator said; an assumed
 * or open answer for it is ignored.
 */
// DECISION: "never lower a field's state" rather than marking the fields the operator wrote: the
// operator can still change a field by saying so in the conversation, and the brief needs no new
// stored marks.
export function mergeBrief(
  before: Brief,
  answer: Brief,
): { brief: Brief; changed: BriefFieldKey[] } {
  const brief: Brief = { ...before };
  const changed: BriefFieldKey[] = [];
  for (const key of BRIEF_FIELDS) {
    const a = answer[key];
    if (!a) continue;
    const p = before[key];
    if (p && BRIEF_STATE_RANK[a.state] < BRIEF_STATE_RANK[p.state]) continue;
    if (p && p.text === a.text && p.state === a.state) continue;
    brief[key] = a;
    changed.push(key);
  }
  return { brief, changed };
}

// ── Fit-gap ─────────────────────────────────────────────────────────────────────────────────────

export const FIT_VERDICTS = ["native", "configure", "build", "figure_out", "not_possible"] as const;
export const FitVerdict = z.enum(FIT_VERDICTS);
export type FitVerdict = z.infer<typeof FitVerdict>;

export const FIT_WORDS: Record<FitVerdict, string> = {
  native: "Native",
  configure: "Configure",
  build: "Build",
  figure_out: "Figure out",
  not_possible: "Not possible",
};

const ShortId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/)
  .describe("A short id, lowercase letters, digits and dashes");

/**
 * How much work a verdict means, least first. The operator may set a row to more work at once,
 * with a reason; less work is a challenge the Builder answers against the catalog, since only the
 * catalog says a part exists.
 */
// DECISION: the operator never sets a verdict to less work: picking "Native" doesn't make the part
// exist, and it would drop the open item that tracks the gap. A challenge goes to the Builder.
export const FIT_WORK: Record<FitVerdict, number> = {
  native: 0,
  configure: 1,
  build: 2,
  figure_out: 3,
  not_possible: 4,
};

/** A reason the operator gives for a verdict: why the Builder's is wrong. */
export const FIT_REASON_MIN = 20;
export const FitReason = z.string().trim().min(FIT_REASON_MIN).max(1000);

/** The operator set the row to more work than the Builder did. */
export const FitOverride = z.object({
  /** The Builder's verdict. */
  from: FitVerdict,
  reason: FitReason,
  by: z.string().nullable().default(null),
  at: z.string().nullable().default(null),
});
export type FitOverride = z.infer<typeof FitOverride>;

/** The operator asked the Builder to look again; cleared by the Builder's next fit-gap. */
export const FitChallenge = z.object({
  wanted: FitVerdict,
  reason: FitReason,
  by: z.string().nullable().default(null),
  at: z.string().nullable().default(null),
});
export type FitChallenge = z.infer<typeof FitChallenge>;

/** A row as the Builder writes it. */
export const FitRowDraft = z.object({
  id: ShortId,
  need: z.string().trim().min(1).max(300).describe("What the brief needs, in a few words"),
  verdict: FitVerdict,
  how: z
    .string()
    .trim()
    .max(500)
    .describe("How: the platform part that does it, what to configure or build, or why not"),
  dropped: z.boolean().default(false).describe("Taken out of scope by the operator"),
  later: z
    .boolean()
    .default(false)
    .describe(
      "A known risk: an exception or rare case the first version doesn't build (several in one file, another currency, a late or duplicate input). Until it shows up in runs it goes to a person",
    ),
});

export const FitRow = FitRowDraft.extend({
  override: FitOverride.nullish(),
  challenge: FitChallenge.nullish(),
});
export type FitRow = z.infer<typeof FitRow>;

/**
 * Happy path first (owner, 2026-11-17): the first version builds the normal case. A row is on it
 * (`main`), a known risk left for later (`later`: it goes to a person until it shows up in runs),
 * or out of scope (`out`).
 */
export const FIT_SCOPES = ["main", "later", "out"] as const;
export type FitScope = (typeof FIT_SCOPES)[number];

export const FIT_SCOPE_WORDS: Record<FitScope, string> = {
  main: "First version",
  later: "Known risk",
  out: "Out of scope",
};

export function fitScope(r: Pick<FitRow, "dropped" | "later">): FitScope {
  return r.dropped ? "out" : r.later ? "later" : "main";
}

export function withFitScope<R extends Pick<FitRow, "dropped" | "later">>(
  row: R,
  scope: FitScope,
): R {
  return { ...row, dropped: scope === "out", later: scope === "later" };
}

export const NeedsTrue = z.object({
  id: ShortId,
  text: z.string().trim().min(1).max(300),
  done: z.boolean().default(false),
});
export type NeedsTrue = z.infer<typeof NeedsTrue>;

/** A "needs to be true" line as stored: the Builder's rewrites keep the operator's lines. */
export const NeedsTrueRow = NeedsTrue.extend({
  /** Added or changed (marked done) by the operator. */
  byOperator: z.boolean().optional(),
});
export type NeedsTrueRow = z.infer<typeof NeedsTrueRow>;

// ── The client intake form (a template's) ───────────────────────────────────────────────────────

/**
 * What we get from each client to set up their copy of a template: a tool they connect, an answer
 * (a value such as a tolerance or an address) or a file (contracts, a list). Only what the client
 * gives us: our own setup (switching on a pack) is ours to do, never asked of them.
 * A template has no client yet, so these are a form that travels with the build, not open items.
 */
// DECISION (owner, 2026-11-16): a template's "what needs to be true" is its client intake form,
// kept on the build (in its fit-gap record, no migration); a build for one client keeps open items.
// DECISION (owner, 2026-11-17): "no set up should be in here from that side": the form holds only
// what the client gives us. "Switch on a pack" is gone; a pack the template needs is a configure
// row of the fit-gap, done by us when we set up the client's copy. Stored pack fields are dropped
// when read (`readFitGap`).
export const SETUP_KINDS = ["connect", "answer", "file"] as const;
export const SetupKind = z.enum(SETUP_KINDS);
export type SetupKind = z.infer<typeof SetupKind>;

export const SETUP_WORDS: Record<SetupKind, string> = {
  connect: "Connect a tool",
  answer: "Answer",
  file: "File",
};

/** A field as the Builder writes it. */
export const SetupFieldDraft = z.object({
  id: ShortId,
  label: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe("What we ask the client, as a question or a short label"),
  kind: SetupKind.describe(
    "connect (a tool they connect, by name), answer (a value: a tolerance, an address, a person), file (contracts, a vendor list)",
  ),
  hint: z
    .string()
    .trim()
    .max(300)
    .default("")
    .describe("Why we need it, or an example answer, in one sentence"),
});

export const SetupField = SetupFieldDraft.extend({
  /** Not asked of clients: taken out by the operator. */
  dropped: z.boolean().default(false),
  /** Added or changed by the operator: the Builder's rewrites keep it as it is. */
  byOperator: z.boolean().default(false),
});
export type SetupField = z.infer<typeof SetupField>;

/** Whether a build makes a client intake form: an agent for every client (a template). */
export function buildHasSetupForm(b: { kind: BuildKind; clientId: string | null }): boolean {
  return b.kind === "agent" && !b.clientId;
}

// ── Decisions (docs/builder-plan.md §4) ─────────────────────────────────────────────────────────

/**
 * Every decision the Builder makes about the process to get the happy path running, one row each.
 * They are part of the process and need no confirmation, except the high-risk ones (§4.2), which
 * must be looked at before the client test. Kept on the build's fit-gap record (no migration).
 */
export const DECISION_KINDS = ["assumption", "decision_point", "client_setup"] as const;
export const DecisionKind = z.enum(DECISION_KINDS);
export type DecisionKind = z.infer<typeof DecisionKind>;

export const DECISION_KIND_WORDS: Record<DecisionKind, string> = {
  assumption: "Assumption",
  decision_point: "Decision point",
  client_setup: "Client setup",
};

export const DECISION_RISKS = ["high", "normal"] as const;
export const DecisionRisk = z.enum(DECISION_RISKS);
export type DecisionRisk = z.infer<typeof DecisionRisk>;

export const DECISION_STATUSES = ["never_discussed", "discussed", "confirmed", "changed"] as const;
export const DecisionStatus = z.enum(DECISION_STATUSES);
export type DecisionStatus = z.infer<typeof DecisionStatus>;

export const DECISION_STATUS_WORDS: Record<DecisionStatus, string> = {
  never_discussed: "Never discussed",
  discussed: "Discussed",
  confirmed: "Confirmed",
  changed: "Changed",
};

/** The statuses the operator sets (a change is the Builder's rewrite of a looked-at row). */
export const DECISION_OPERATOR_STATUSES = ["never_discussed", "discussed", "confirmed"] as const;
export const DecisionOperatorStatus = z.enum(DECISION_OPERATOR_STATUSES);

/** The high-risk list (§4.2, agreed 2026-11-19): a decision in one of these is always high risk. */
export const DECISION_CATEGORIES = [
  "writes",
  "money",
  "contact",
  "vendor_data",
  "approvals",
  "overwrite",
] as const;
export const DecisionCategory = z.enum(DECISION_CATEGORIES);
export type DecisionCategory = z.infer<typeof DecisionCategory>;

export const DECISION_CATEGORY_WORDS: Record<DecisionCategory, string> = {
  writes: "Writes into a client's tool",
  money: "Money",
  contact: "Contacts people outside the client",
  vendor_data: "Data leaving to a vendor of ours",
  approvals: "Approvals and permissions",
  overwrite: "Overwrites or removes records",
};

export const DECISION_WHAT_MAX = 300;
export const DECISION_WHY_MAX = 500;
export const DECISION_VALUE_MAX = 300;

/** A decision as the Builder writes it: never its status, which is the operator's. */
export const DecisionDraft = z.object({
  id: ShortId,
  what: z
    .string()
    .trim()
    .min(1)
    .max(DECISION_WHAT_MAX)
    .describe("The decision, in one plain sentence: Freight and tax stay out of the catalog"),
  why: z
    .string()
    .trim()
    .max(DECISION_WHY_MAX)
    .default("")
    .describe("One sentence: what it rests on (the brief, the catalog, a document you read)"),
  value: z
    .string()
    .trim()
    .max(DECISION_VALUE_MAX)
    .optional()
    .describe("When it is a number or a list: the starting value, e.g. 2% or 5 business days"),
  kind: DecisionKind.describe(
    "assumption (you decided; part of the process), decision_point (a person decides in each run: a person step), client_setup (differs by client: asked once at onboarding)",
  ),
  risk: DecisionRisk.default("normal").describe(
    "high when it touches writing into a client's tool, money, contacting people outside the client, data leaving to a vendor of ours, approvals and who signs, or overwriting records; else normal",
  ),
  stepId: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe("The draft's step it shapes, by its id, when there is one"),
  category: DecisionCategory.optional().describe(
    "Which high-risk kind it is: writes, money, contact, vendor_data, approvals or overwrite",
  ),
});
export type DecisionDraft = z.infer<typeof DecisionDraft>;

export const Decision = DecisionDraft.extend({
  status: DecisionStatus.default("never_discussed"),
  /** Who looked at it last (the operator's name), and when. */
  by: z.string().nullable().default(null),
  at: z.string().nullable().default(null),
  // B5 (docs/builder-plan.md §7): a client admin's change on the agent's settings is written here
  // as `changed`, by them; `side` says whose `by` is. Optional with no default, so the rows a
  // build wrote (the operator's) parse and hash as they were.
  side: z.enum(["client", "operator"]).optional(),
});
export type Decision = z.infer<typeof Decision>;

export const DECISIONS_MAX = 60;

/**
 * Decisions as the model may send them: longer text than a row keeps, so one wordy row doesn't
 * throw the whole answer away. `clampDecisions` cuts them to size.
 */
// DECISION: as the fit-gap's "how", a model's long "what" or "why" is cut at a sentence, not
// refused.
export const DecisionAnswer = DecisionDraft.extend({
  what: z
    .string()
    .trim()
    .min(1)
    .max(1000)
    .describe(DecisionDraft.shape.what.description ?? ""),
  why: z
    .string()
    .trim()
    .max(2000)
    .default("")
    .describe(DecisionDraft.shape.why.description ?? ""),
  value: z.string().trim().max(1000).optional().describe("The starting value, when there is one"),
});
export type DecisionAnswer = z.infer<typeof DecisionAnswer>;

export function clampDecisions(list: readonly DecisionAnswer[]): DecisionDraft[] {
  return list.map((d) => ({
    ...d,
    what: clampText(d.what, DECISION_WHAT_MAX),
    why: clampText(d.why, DECISION_WHY_MAX),
    ...(d.value !== undefined ? { value: clampText(d.value, DECISION_VALUE_MAX) } : {}),
  }));
}

/** Looked at by a person: discussed, confirmed, or changed after a look. */
export function decisionReviewed(d: Pick<Decision, "status">): boolean {
  return d.status !== "never_discussed";
}

/** High risk and nobody has looked at it yet: it holds the move into the client test. */
export function decisionUnreviewed(d: Pick<Decision, "status" | "risk">): boolean {
  return d.risk === "high" && !decisionReviewed(d);
}

/**
 * The Builder's new and updated decisions onto the stored ones. Rows are never dropped by being
 * left out (an answer lists only what it adds or changes). A row the Builder updates keeps the
 * operator's status, who and when; if a person had looked at it and its words, value or kind
 * changed, it is "changed" (it was looked at, then changed in the conversation). Risk only rises.
 */
// DECISION: once high, a decision stays high: code never lowers it, and neither does the Builder's
// rewrite (strict first, as approvals).
export function mergeDecisions(
  before: readonly Decision[],
  updates: readonly DecisionDraft[],
): Decision[] {
  const out = before.map((d) => ({ ...d }));
  let at = new Map(out.map((d, i) => [d.id, i]));
  for (const u of updates) {
    const i = at.get(u.id);
    if (i === undefined) {
      if (out.length >= DECISIONS_MAX) {
        // BUILDER_QA AI-5: a high-risk decision is never dropped for want of room. It takes the
        // place of the oldest normal-risk one nobody has looked at (and that shapes no step, whose
        // risk the draft may raise); with none, it is left out and the turn doesn't claim it.
        if (decisionRisk(u) !== "high") continue;
        const room = out.findIndex(
          (d) => !decisionReviewed(d) && decisionRisk(d) === "normal" && d.stepId === undefined,
        );
        if (room < 0) continue;
        out.splice(room, 1);
        at = new Map(out.map((d, k) => [d.id, k]));
      }
      at.set(u.id, out.length);
      out.push({ ...u, status: "never_discussed", by: null, at: null });
      continue;
    }
    const p = out[i] as Decision;
    const changed = p.what !== u.what || (p.value ?? "") !== (u.value ?? "") || p.kind !== u.kind;
    out[i] = {
      ...u,
      risk: p.risk === "high" || u.risk === "high" ? "high" : "normal",
      ...(u.category === undefined && p.category !== undefined ? { category: p.category } : {}),
      ...(u.stepId === undefined && p.stepId !== undefined ? { stepId: p.stepId } : {}),
      status: decisionReviewed(p) && changed ? "changed" : p.status,
      by: p.by,
      at: p.at,
    };
  }
  return out;
}

/**
 * A decision's risk worked out by code (§4.2), with the Builder's flag on top: high when the
 * Builder said so, when it has a category on the high-risk list, or when the step it shapes writes
 * to a client's tool or contacts people (`writes`, from the draft: `writingStepIds`). Code never
 * lowers the Builder's high.
 */
export function decisionRisk(
  d: Pick<Decision, "risk" | "category" | "stepId">,
  writes: ReadonlySet<string> = new Set(),
): DecisionRisk {
  if (d.risk === "high") return "high";
  if (d.category !== undefined) return "high";
  if (d.stepId !== undefined && writes.has(d.stepId)) return "high";
  return "normal";
}

/** The decisions with their risk worked out by code, as the build shows them and its gate reads. */
export function withDecisionRisk(
  decisions: readonly Decision[],
  writes: ReadonlySet<string> = new Set(),
): Decision[] {
  return decisions.map((d) => {
    const risk = decisionRisk(d, writes);
    return risk === d.risk ? d : { ...d, risk };
  });
}

/** The operator marks a decision discussed or confirmed (or back to never discussed). */
export function setDecisionStatus(
  decisions: readonly Decision[],
  id: string,
  status: (typeof DECISION_OPERATOR_STATUSES)[number],
  by: string | null,
  at: string,
): Decision[] | null {
  if (!decisions.some((d) => d.id === id)) return null;
  return decisions.map((d) =>
    d.id !== id
      ? d
      : status === "never_discussed"
        ? { ...d, status, by: null, at: null }
        : { ...d, status, by, at },
  );
}

/** "2 high-risk decisions haven't been looked at yet." */
export function unreviewedWords(n: number): string {
  return n === 1
    ? "1 high-risk decision hasn't been looked at yet."
    : `${n} high-risk decisions haven't been looked at yet.`;
}

/** Decisions as stored: a row that no longer reads is left out rather than losing the record. */
function readDecisions(raw: unknown): Decision[] {
  if (!Array.isArray(raw)) return [];
  const out: Decision[] = [];
  for (const r of raw) {
    const parsed = Decision.safeParse(r);
    if (parsed.success && out.length < DECISIONS_MAX) out.push(parsed.data);
  }
  return out;
}

export const FitGap = z.object({
  rows: z.array(FitRow).max(40).default([]),
  needsTrue: z.array(NeedsTrueRow).max(20).default([]),
  /** A template's client intake form. */
  setup: z.array(SetupField).max(30).default([]),
  /** The Builder's decisions (docs/builder-plan.md §4). */
  decisions: z.array(Decision).max(DECISIONS_MAX).default([]),
});
export type FitGap = z.infer<typeof FitGap>;

/**
 * A stored fit-gap without the intake form's old "Switch on a pack" fields (owner, 2026-11-17):
 * they are ours to do, not the client's, and a kind the form no longer has would fail the whole
 * record's parse and lose the rest of it.
 */
function withoutPackFields(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const setup = (raw as { setup?: unknown }).setup;
  if (!Array.isArray(setup)) return raw;
  return {
    ...raw,
    setup: setup.filter((f) => (f as { kind?: unknown } | null)?.kind !== "pack"),
  };
}

export function readFitGap(raw: unknown): FitGap {
  // Decisions are read row by row (as the intake form's old fields are dropped): one row that no
  // longer reads must not lose the rows, the form or the other decisions.
  const decisions = readDecisions((raw as { decisions?: unknown } | null)?.decisions);
  const rest =
    typeof raw === "object" && raw !== null ? { ...(raw as object), decisions: [] } : raw;
  const parsed = FitGap.safeParse(withoutPackFields(rest ?? {}));
  return parsed.success
    ? { ...parsed.data, decisions }
    : { rows: [], needsTrue: [], setup: [], decisions };
}

/**
 * A fit-gap as the Builder writes it: no overrides or challenges, which are the operator's. Its
 * decisions, when sent, are new or updated rows (`mergeDecisions`).
 */
export const FitGapDraft = z.object({
  rows: z.array(FitRowDraft).max(40).default([]),
  needsTrue: z.array(NeedsTrue).max(20).default([]),
  setup: z.array(SetupFieldDraft).max(30).default([]),
  decisions: z.array(DecisionDraft).max(DECISIONS_MAX).optional(),
});
export type FitGapDraft = z.infer<typeof FitGapDraft>;

/** The longest "how" and "need" a row keeps. */
export const FIT_HOW_MAX = 500;
export const FIT_NEED_MAX = 300;

/**
 * The fit-gap as the model may send it: longer text than a row keeps, so one wordy row doesn't
 * throw the whole answer away. `clampFitGap` cuts it to size.
 */
// DECISION: a model's "how" over the limit is cut at a sentence, not refused (a refused answer
// loses the whole turn).
export const FitGapAnswer = z.object({
  rows: z
    .array(
      FitRowDraft.extend({
        need: z.string().trim().min(1).max(1000).describe("What the brief needs, in a few words"),
        how: z
          .string()
          .trim()
          .max(2000)
          .describe(
            `How: the platform part that does it, what to configure or build, or why not. At most two sentences, under ${FIT_HOW_MAX} characters`,
          ),
      }),
    )
    .max(40)
    .default([]),
  needsTrue: z
    .array(NeedsTrue)
    .max(20)
    .default([])
    .describe("A build for one client only: what the client or we must make true"),
  setup: z
    .array(SetupFieldDraft)
    .max(30)
    .default([])
    .describe(
      "A template only: the client intake form, what we get from each client to set up their copy",
    ),
});
export type FitGapAnswer = z.infer<typeof FitGapAnswer>;

/**
 * Cuts text to `max` characters, at the last sentence end that fits, else at a word, with "…".
 * Never inside a character (BUILDER_QA INPUT-3: half an emoji fails the jsonb write).
 */
export function clampText(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = sliceWhole(text, max - 1);
  const stop = Math.max(head.lastIndexOf(". "), head.lastIndexOf("; "));
  if (stop >= max / 2) return head.slice(0, stop + 1);
  const space = head.lastIndexOf(" ");
  return `${(space > max / 2 ? head.slice(0, space) : head).trimEnd()}…`;
}

export function clampFitGap(answer: FitGapAnswer): FitGapDraft {
  return {
    rows: answer.rows.map((r) => ({
      ...r,
      need: clampText(r.need, FIT_NEED_MAX),
      how: clampText(r.how, FIT_HOW_MAX),
    })),
    needsTrue: answer.needsTrue,
    setup: answer.setup,
  };
}

/**
 * The Builder's new fit-gap with the operator's changes kept: dropped rows stay dropped, a row the
 * operator set to more work keeps that verdict, and a challenged row takes the Builder's answer
 * (its challenge is answered, and an override on it goes). A row the operator changed that the
 * Builder left out is kept.
 */
export function mergeFitGap(before: FitGap, after: FitGapDraft): FitGap {
  const prev = new Map(before.rows.map((r) => [r.id, r]));
  const rows: FitRow[] = after.rows.map((r) => {
    const p = prev.get(r.id);
    // BUILDER_QA AI-3a: out of scope is the operator's call ("taken out of scope by the
    // operator"), never the Builder's: its rewrite keeps the stored mark, and a new row is in.
    const dropped = p?.dropped ?? false;
    const base: FitRow = { ...r, dropped, override: null, challenge: null };
    if (!p) return base;
    // DECISION (owner, 2026-11-17): a row's place (first version or known risk) is set by the
    // Builder when the row is new and by the operator after that; a rewrite keeps it.
    const later = p.later;
    if (p.challenge) return { ...base, dropped, later };
    if (p.override) return { ...base, dropped, later, verdict: p.verdict, override: p.override };
    return { ...base, dropped, later };
  });
  const ids = new Set(rows.map((r) => r.id));
  for (const p of before.rows) {
    if (!ids.has(p.id) && (p.dropped || p.override)) rows.push({ ...p, challenge: null });
  }
  return {
    rows: rows.slice(0, 40),
    needsTrue: mergeNeedsTrue(before.needsTrue, after.needsTrue),
    setup: mergeSetup(before.setup, after.setup),
    // A fit-gap rewrite never drops a decision; the ones it sends are added or updated.
    decisions: mergeDecisions(before.decisions, after.decisions ?? []),
  };
}

/**
 * The Builder's intake form with the operator's changes kept: fields the operator added or changed
 * stay as they are, and fields taken out stay out (the Builder's version of them is ignored).
 */
function mergeSetup(before: readonly SetupField[], after: FitGapDraft["setup"]): SetupField[] {
  // An answer without a form leaves the form as it was.
  if (after.length === 0) return [...before];
  const kept = new Map(before.filter((f) => f.byOperator || f.dropped).map((f) => [f.id, f]));
  const out: SetupField[] = after.map(
    (f) => kept.get(f.id) ?? { ...f, dropped: false, byOperator: false },
  );
  const ids = new Set(out.map((f) => f.id));
  for (const f of kept.values()) if (!ids.has(f.id)) out.push(f);
  return out.slice(0, 30);
}

/**
 * The Builder's "what needs to be true" with the operator's lines kept, as the intake form is
 * merged (BUILDER_QA AI-3b): an answer without it leaves it as it was, and lines the operator added
 * or changed (marked done) stay as they are.
 */
function mergeNeedsTrue(
  before: readonly NeedsTrueRow[],
  after: readonly NeedsTrue[],
): NeedsTrueRow[] {
  if (after.length === 0) return [...before];
  const kept = new Map(before.filter((n) => n.byOperator).map((n) => [n.id, n]));
  const out: NeedsTrueRow[] = after.map((n) => kept.get(n.id) ?? { ...n });
  const ids = new Set(out.map((n) => n.id));
  for (const n of kept.values()) if (!ids.has(n.id)) out.push(n);
  return out.slice(0, 20);
}

/**
 * The operator's save of the fit-gap (what's in scope, what needs to be true) onto the stored one.
 * Rows, verdicts, overrides and challenges stay as stored: a verdict changes only with a reason
 * (`fitVerdictChange`). Returns why not, or the fit-gap to save.
 */
export function operatorFitGap(
  stored: FitGap,
  sent: FitGap,
): { ok: true; fitgap: FitGap } | { ok: false; reason: string } {
  const byId = new Map(sent.rows.map((r) => [r.id, r]));
  for (const r of sent.rows) {
    const s = stored.rows.find((x) => x.id === r.id);
    if (!s) return { ok: false, reason: "The Builder writes the fit-gap's rows." };
    if (s.verdict !== r.verdict) {
      return {
        ok: false,
        reason: `"${s.need}" is ${FIT_WORDS[s.verdict]}. Change a verdict with a reason.`,
      };
    }
  }
  return {
    ok: true,
    fitgap: {
      rows: stored.rows.map((s) => ({
        ...s,
        dropped: byId.get(s.id)?.dropped ?? s.dropped,
        later: byId.get(s.id)?.later ?? s.later,
      })),
      needsTrue: sent.needsTrue.map((n) => {
        const s = stored.needsTrue.find((x) => x.id === n.id);
        const changed = !s || s.text !== n.text || s.done !== n.done;
        return { ...n, byOperator: !!(s?.byOperator || n.byOperator || changed) };
      }),
      setup: sent.setup.map((f) => {
        const s = stored.setup.find((x) => x.id === f.id);
        const changed =
          !s ||
          s.label !== f.label ||
          s.kind !== f.kind ||
          s.hint !== f.hint ||
          s.dropped !== f.dropped;
        return { ...f, byOperator: f.byOperator || changed };
      }),
      // Decisions change only by their own route (a status) and the Builder's turns: what a save
      // of the fit-gap sends for them is ignored.
      decisions: stored.decisions,
    },
  };
}

/** What a verdict change does: more work is set now, less work asks the Builder. */
export function fitChangeKind(from: FitVerdict, to: FitVerdict): "override" | "challenge" {
  return FIT_WORK[to] > FIT_WORK[from] ? "override" : "challenge";
}

// ── POC test: the test plan ─────────────────────────────────────────────────────────────────────

export const DATA_SOURCES = ["generate", "upload", "sandbox"] as const;
export const DataSource = z.enum(DATA_SOURCES);
export type DataSource = z.infer<typeof DataSource>;

export const Dataset = z.object({
  id: ShortId,
  name: z.string().trim().min(1).max(120).describe("What the data is, e.g. Invoices (PDF)"),
  count: z.number().int().min(1).max(200),
  covers: z
    .string()
    .trim()
    .max(500)
    .describe("The cases it must cover, e.g. 2 over price, 1 duplicate, 1 unknown vendor"),
  source: DataSource,
});
export type Dataset = z.infer<typeof Dataset>;

export const TestPlan = z.object({ datasets: z.array(Dataset).max(20).default([]) });
export type TestPlan = z.infer<typeof TestPlan>;

export function readTestPlan(raw: unknown): TestPlan {
  const parsed = TestPlan.safeParse(raw ?? {});
  return parsed.success ? parsed.data : { datasets: [] };
}

// ── QA ──────────────────────────────────────────────────────────────────────────────────────────

export const QA_CHECKS = ["tests", "trial", "rejections", "approvals", "rollback"] as const;
export const QaCheckId = z.enum(QA_CHECKS);
export type QaCheckId = z.infer<typeof QaCheckId>;

export const QA_WORDS: Record<QaCheckId, string> = {
  tests: "Required test cases pass",
  trial: "Trial minimums met",
  rejections: "Rejected in the trial under 10%",
  approvals: "Approval on for every write",
  rollback: "A version to roll back to",
};

/** The share of the trial's writes the client may reject before QA flags it. */
export const QA_MAX_REJECTED = 0.1;

export const QaRecord = z.object({
  /** Checks that failed and were accepted, with the reason. */
  accepted: z
    .partialRecord(
      QaCheckId,
      z.object({ reason: z.string().trim().min(1).max(500), by: z.string(), at: z.string() }),
    )
    .default({}),
  signedBy: z.string().nullable().default(null),
  signedAt: z.string().nullable().default(null),
  decision: z.enum(["go", "no_go"]).nullable().default(null),
});
export type QaRecord = z.infer<typeof QaRecord>;

export function readQa(raw: unknown): QaRecord {
  const parsed = QaRecord.safeParse(raw ?? {});
  return parsed.success
    ? parsed.data
    : { accepted: {}, signedBy: null, signedAt: null, decision: null };
}

export const QA_CHECK_STATES = ["pass", "fail", "accepted", "unknown"] as const;
export const QaCheck = z.object({
  id: QaCheckId,
  label: z.string(),
  state: z.enum(QA_CHECK_STATES),
  detail: z.string(),
  /** The reason it was accepted. */
  reason: z.string().nullable(),
});
export type QaCheck = z.infer<typeof QaCheck>;

// ── Open items ──────────────────────────────────────────────────────────────────────────────────

export const BUILD_ITEM_KINDS = [
  "question",
  "gap",
  "precondition",
  "test",
  "feedback",
  "qa",
  "note",
] as const;
export const BuildItemKind = z.enum(BUILD_ITEM_KINDS);
export type BuildItemKind = z.infer<typeof BuildItemKind>;

export const BUILD_ITEM_OWNERS = ["operator", "builder", "client", "engineering"] as const;
export const BuildItemOwner = z.enum(BUILD_ITEM_OWNERS);
export type BuildItemOwner = z.infer<typeof BuildItemOwner>;

export const OWNER_WORDS: Record<BuildItemOwner, string> = {
  operator: "You",
  builder: "Builder",
  client: "Client",
  engineering: "Mezonas engineering",
};

export const BUILD_ITEM_STATES = ["open", "in_progress", "waiting", "done", "deferred"] as const;
export const BuildItemState = z.enum(BUILD_ITEM_STATES);
export type BuildItemState = z.infer<typeof BuildItemState>;

export const ITEM_STATE_WORDS: Record<BuildItemState, string> = {
  open: "Open",
  in_progress: "In progress",
  waiting: "Waiting",
  done: "Done",
  deferred: "Put off",
};

/** Still to do: not done and not put off. */
export function itemOpen(state: BuildItemState): boolean {
  return state !== "done" && state !== "deferred";
}

// ── Gates ───────────────────────────────────────────────────────────────────────────────────────

/** What a gate reads: the build's records and what the API read about its draft and tests. */
export interface GateFacts {
  kind: BuildKind;
  phase: BuildPhase;
  brief: Brief;
  fitgap: FitGap;
  /** The draft exists (an agent or a skill, or a skill conversation). */
  draft: boolean;
  /** The draft's latest version's validation errors (missing steps included). */
  draftErrors: number;
  /** The POC passed (suite or test run), and why not. */
  poc: { passed: boolean; detail: string };
  /** The copy under test reached sign-off or live. */
  trialDone: boolean;
  qaSigned: boolean;
  /** Items not done and not put off. */
  openItems: number;
}

/**
 * Why the build can't move on from its phase (empty: it can). Moving back needs no gate. Open
 * items carry over from phase to phase; they hold only the go-live.
 */
// DECISION (owner, 2026-11-17, happy path first): open items no longer hold the POC test. A
// question such as a tolerance is answered by what the POC shows, so it can't be a reason not to
// run one; the client's trial signs every write, and QA still needs every item done or put off.
export function gateReasons(f: GateFacts): string[] {
  const out: string[] = [];
  switch (f.phase) {
    case "intake":
      for (const key of BRIEF_REQUIRED) {
        const field = f.brief[key];
        if (!field?.text.trim())
          out.push(`The brief has no ${BRIEF_LABELS[key].toLowerCase()} yet.`);
      }
      break;
    case "fitgap":
      if (f.fitgap.rows.filter((r) => !r.dropped && !r.later).length === 0) {
        out.push("The fit-gap has nothing in the first version.");
      }
      {
        const asked = f.fitgap.rows.filter((r) => !r.dropped && r.challenge).length;
        if (asked > 0) {
          out.push(
            asked === 1
              ? "1 challenged verdict is waiting on the Builder."
              : `${asked} challenged verdicts are waiting on the Builder.`,
          );
        }
      }
      break;
    case "draft":
      if (!f.draft) out.push("There is no draft yet.");
      else if (f.draftErrors > 0) {
        out.push(
          f.draftErrors === 1
            ? "The draft has 1 problem to fix."
            : `The draft has ${f.draftErrors} problems to fix.`,
        );
      }
      break;
    case "poc": {
      if (!f.poc.passed) out.push(f.poc.detail);
      // docs/builder-plan.md §4.2: a high-risk decision is looked at before the client test.
      // DECISION: a skill build (no client test) is held the same way, before QA.
      const unreviewed = f.fitgap.decisions.filter(decisionUnreviewed).length;
      if (unreviewed > 0) out.push(unreviewedWords(unreviewed));
      break;
    }
    case "client_test":
      if (!f.trialDone) out.push("The client's trial isn't done yet.");
      break;
    case "qa":
      if (!f.qaSigned) out.push("QA isn't signed yet.");
      if (f.openItems > 0) out.push(openWords(f.openItems));
      break;
  }
  return out;
}

function openWords(n: number): string {
  return n === 1
    ? "1 open item is not done or put off."
    : `${n} open items are not done or put off.`;
}

// ── Issues and the Builder's proposals ──────────────────────────────────────────────────────────

/**
 * What the Builder may propose to settle an issue. Nothing changes until the operator agrees; then
 * the API makes the change through the build's own routes, as the operator (audited, checked).
 */
// DECISION (owner, 2026-11-17): the Builder proposes one change at a time and the operator agrees;
// it never changes the build on its own, and it never proposes accepting the approvals check.
const Short = z.string().min(1).max(100);
const Lines = z.array(z.string().trim().min(1).max(500)).max(20);

export const BuildAction = z.discriminatedUnion("do", [
  z.object({
    do: z.literal("close_item"),
    itemId: z.string().min(1).max(100).describe("The open item's id"),
    state: z
      .enum(["done", "deferred"])
      .describe("done when it is settled, deferred (put off) when it waits for later"),
  }),
  z.object({
    do: z.literal("reopen_item"),
    itemId: z.string().min(1).max(100).describe("The done or put-off item's id"),
  }),
  z.object({
    do: z.literal("accept_check"),
    check: QaCheckId.exclude(["approvals"]),
    reason: z.string().trim().min(20).max(500).describe("Why it can go live as it is"),
  }),
  z.object({
    do: z.literal("go_back"),
    to: BuildPhase.describe("An earlier phase"),
    reason: z.string().trim().min(20).max(500).describe("What has to be redone there"),
  }),
  z.object({ do: z.literal("run_tests") }),
  // The Dev queue (docs/plan.md §1.125): bucket B, new code, filed with the triage done; a link
  // to an open request; its approval; bucket A, a skill drafted as a skill build of its own. The
  // Builder's rules (packages/agents, BUILD_RULES) say how to fill them; this file is in the web
  // app's first load, so the schemas carry no descriptions of their own.
  z.object({
    do: z.literal("file_code_request"),
    itemId: Short.optional(),
    stepId: Short.optional(),
    workflowId: Short.optional(),
    request: z.object({
      title: z.string().trim().min(1).max(200),
      kind: z.enum(["extend_existing", "new_tool", "new_skill_code", "config_only"]),
      summary: z.string().trim().min(1).max(2000),
      inputs: Lines.min(1),
      outputs: Lines.min(1),
      rules: Lines.default([]),
      acceptance: Lines.min(1),
      part: z.string().trim().min(1).max(200),
      decision: z.enum(["extend", "new_general", "one_off"]),
      decisionReason: z.string().trim().min(25).max(2000),
      otherUses: z.array(z.string().trim().min(1).max(300)).max(20).default([]),
      considered: z
        .array(
          z.object({
            partId: z.string().min(1).max(300),
            verdict: z.enum(["use", "extend", "reject"]),
            reason: z.string().trim().max(1000).default(""),
            missing: z.string().trim().max(1000).default(""),
          }),
        )
        .max(10)
        .default([]),
      questions: z
        .array(
          z.object({
            question: z.string().trim().min(1).max(1000),
            mode: z.enum(["answer_first", "investigate_during_build"]),
          }),
        )
        .max(10)
        .default([]),
    }),
  }),
  z.object({
    do: z.literal("link_code_request"),
    requestId: Short,
    ref: z.string().min(1).max(20),
    itemId: Short.optional(),
    stepId: Short.optional(),
    workflowId: Short.optional(),
  }),
  z.object({
    do: z.literal("approve_code_request"),
    requestId: Short,
    ref: z.string().min(1).max(20),
  }),
  z.object({
    do: z.literal("draft_skill"),
    itemId: Short.optional(),
    stepId: Short.optional(),
    title: z.string().trim().min(1).max(200),
    goal: z.string().trim().min(10).max(1000),
    dataIn: z.string().trim().min(1).max(1000),
    dataOut: z.string().trim().min(1).max(1000),
    rules: z.string().trim().max(1000).default(""),
  }),
  z.object({
    do: z.literal("edit_draft"),
    request: z
      .string()
      .trim()
      .min(10)
      .max(1000)
      .describe(
        "The change to the draft, as you'd ask the workflow's Builder: the step by name, what to change and why",
      ),
    stepId: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe("The step it changes, by its id in the draft's steps, when it is about one step"),
  }),
]);
export type BuildAction = z.infer<typeof BuildAction>;

export const BuildProposal = z.object({
  summary: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .describe("What agreeing does, in a few plain words: Close “W-9 check” as done"),
  action: BuildAction,
});
export type BuildProposal = z.infer<typeof BuildProposal>;

/** `unchanged`: agreed, but the workflow's Builder made no change (it said why). */
export const PROPOSAL_STATES = ["proposed", "agreed", "unchanged", "declined", "undone"] as const;
export const ProposalState = z.enum(PROPOSAL_STATES);
export type ProposalState = z.infer<typeof ProposalState>;

/**
 * Undo is offered where the change has an exact opposite: an item's state. A draft edit is undone
 * by its own changes (the Builder session's undo), not by an action.
 */
export function proposalUndo(
  action: BuildAction,
  before: BuildItemState | null,
): BuildAction | null {
  if (action.do === "close_item") return { do: "reopen_item", itemId: action.itemId };
  if (action.do === "reopen_item" && before && !itemOpen(before)) {
    return { do: "close_item", itemId: action.itemId, state: before as "done" | "deferred" };
  }
  return null;
}

// ── What a back-office build has to settle (owner, 2026-11-17) ──────────────────────────────────

/**
 * The questions most back-office builds have to settle before they're built, whatever the area.
 * The Builder works through them in intake, and a reviewer checks a brief against them before it
 * is confirmed. From the QA runs on staging: the vendor onboarding build missed a client with no
 * accounting system, a contract that arrives weeks later, scanned contracts, where the item list
 * lives and the W-9 check; each is a case of one of these.
 */
// DECISION (owner, 2026-11-17): one checklist for every area to start; a pack's own (purchasing,
// bookkeeping) can add to it later. Questions, not answers: what applies is the Builder's to judge.
export const BUILD_CHECKLIST = [
  {
    id: "source",
    question:
      "Where does each input come from, and what if a client doesn't have that system (no ERP or accounting tool, a different one)?",
  },
  {
    id: "timing",
    question:
      "What if an input arrives late, out of order, or never (a contract weeks after the form, a statement missing)? How does a late one find what it belongs to?",
  },
  {
    id: "format",
    question:
      "What do the documents really look like: scanned or photographed, tables or exhibits, several in one file, other languages?",
  },
  {
    id: "matching",
    question:
      "How is each record matched to the right vendor, customer or account when names, numbers or emails differ or are missing?",
  },
  {
    id: "duplicates",
    question: "What if the same input comes twice, or the agent runs twice on it?",
  },
  {
    id: "thresholds",
    question:
      "Which amounts, tolerances, windows and dates differ by client, and what are the defaults?",
  },
  {
    id: "approvals",
    question:
      "Who approves which writes, by role or amount, and what happens when nobody answers in time?",
  },
  {
    id: "schedule",
    question: "When does it run: time zone, business days, holidays, month-end?",
  },
  {
    id: "contact",
    question:
      "Who does it contact, from which mailbox or number, and have they agreed to hear from the client that way?",
  },
  {
    id: "sensitive",
    question:
      "Does it handle tax ids, bank details or other sensitive data? It may check them, never store or repeat them.",
  },
  {
    id: "exceptions",
    question:
      "What does it do with what it can't handle (no match, missing data, an error), and who gets it?",
  },
  {
    id: "afterwards",
    question:
      "Where do its results live afterwards, and what else reads them (another agent, invoice matching, a report)?",
  },
  {
    id: "volume",
    question: "How many a day or month, and at the busiest time?",
  },
] as const satisfies readonly { id: string; question: string }[];
