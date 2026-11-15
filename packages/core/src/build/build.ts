// Builds (docs/plan.md §1.108): a new agent's or skill's way from intake to go-live, as a project.
// The phases and their words, the records each phase keeps (the brief, the fit-gap, the test plan,
// the QA record), the open items, and the gates: what must be true to move on. The API and the
// screen share these, so the screen says why a move is off with the server's own reasons.

import { z } from "zod";

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
  text: z.string().trim().max(1000),
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

export const FitRow = z.object({
  id: ShortId,
  need: z.string().trim().min(1).max(300).describe("What the brief needs, in a few words"),
  verdict: FitVerdict,
  how: z
    .string()
    .trim()
    .max(500)
    .describe("How: the platform part that does it, what to configure or build, or why not"),
  dropped: z.boolean().default(false).describe("Taken out of scope by the operator"),
});
export type FitRow = z.infer<typeof FitRow>;

export const NeedsTrue = z.object({
  id: ShortId,
  text: z.string().trim().min(1).max(300),
  done: z.boolean().default(false),
});
export type NeedsTrue = z.infer<typeof NeedsTrue>;

export const FitGap = z.object({
  rows: z.array(FitRow).max(40).default([]),
  needsTrue: z.array(NeedsTrue).max(20).default([]),
});
export type FitGap = z.infer<typeof FitGap>;

export function readFitGap(raw: unknown): FitGap {
  const parsed = FitGap.safeParse(raw ?? {});
  return parsed.success ? parsed.data : { rows: [], needsTrue: [] };
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
 * items carry over from phase to phase; they hold the move into the client test and the go-live.
 */
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
      if (f.fitgap.rows.filter((r) => !r.dropped).length === 0) {
        out.push("The fit-gap has no rows in scope.");
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
    case "poc":
      if (!f.poc.passed) out.push(f.poc.detail);
      if (f.openItems > 0) out.push(openWords(f.openItems));
      break;
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
