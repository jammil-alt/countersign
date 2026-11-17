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
});

export const FitRow = FitRowDraft.extend({
  override: FitOverride.nullish(),
  challenge: FitChallenge.nullish(),
});
export type FitRow = z.infer<typeof FitRow>;

export const NeedsTrue = z.object({
  id: ShortId,
  text: z.string().trim().min(1).max(300),
  done: z.boolean().default(false),
});
export type NeedsTrue = z.infer<typeof NeedsTrue>;

// ── The client intake form (a template's) ───────────────────────────────────────────────────────

/**
 * What we get from each client to set up their copy of a template: a tool to connect, a pack to
 * switch on, an answer (a value such as a tolerance or an address) or a file (contracts, a list).
 * A template has no client yet, so these are a form that travels with the build, not open items.
 */
// DECISION (owner, 2026-11-16): a template's "what needs to be true" is its client intake form,
// kept on the build (in its fit-gap record, no migration); a build for one client keeps open items.
export const SETUP_KINDS = ["connect", "pack", "answer", "file"] as const;
export const SetupKind = z.enum(SETUP_KINDS);
export type SetupKind = z.infer<typeof SetupKind>;

export const SETUP_WORDS: Record<SetupKind, string> = {
  connect: "Connect a tool",
  pack: "Switch on a pack",
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
    "connect (a tool they connect, by name), pack (a pack switched on for them), answer (a value: a tolerance, an address, a person), file (contracts, a vendor list)",
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

export const FitGap = z.object({
  rows: z.array(FitRow).max(40).default([]),
  needsTrue: z.array(NeedsTrue).max(20).default([]),
  /** A template's client intake form. */
  setup: z.array(SetupField).max(30).default([]),
});
export type FitGap = z.infer<typeof FitGap>;

export function readFitGap(raw: unknown): FitGap {
  const parsed = FitGap.safeParse(raw ?? {});
  return parsed.success ? parsed.data : { rows: [], needsTrue: [], setup: [] };
}

/** A fit-gap as the Builder writes it: no overrides or challenges, which are the operator's. */
export const FitGapDraft = z.object({
  rows: z.array(FitRowDraft).max(40).default([]),
  needsTrue: z.array(NeedsTrue).max(20).default([]),
  setup: z.array(SetupFieldDraft).max(30).default([]),
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

/** Cuts text to `max` characters, at the last sentence end that fits, else at a word, with "…". */
export function clampText(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max - 1);
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
    const base: FitRow = { ...r, override: null, challenge: null };
    if (!p) return base;
    const dropped = p.dropped || r.dropped;
    if (p.challenge) return { ...base, dropped };
    if (p.override) return { ...base, dropped, verdict: p.verdict, override: p.override };
    return { ...base, dropped };
  });
  const ids = new Set(rows.map((r) => r.id));
  for (const p of before.rows) {
    if (!ids.has(p.id) && (p.dropped || p.override)) rows.push({ ...p, challenge: null });
  }
  return {
    rows: rows.slice(0, 40),
    needsTrue: after.needsTrue,
    setup: mergeSetup(before.setup, after.setup),
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
      rows: stored.rows.map((s) => ({ ...s, dropped: byId.get(s.id)?.dropped ?? s.dropped })),
      needsTrue: sent.needsTrue,
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

// ── Issues and the Builder's proposals ──────────────────────────────────────────────────────────

/**
 * What the Builder may propose to settle an issue. Nothing changes until the operator agrees; then
 * the API makes the change through the build's own routes, as the operator (audited, checked).
 */
// DECISION (owner, 2026-11-17): the Builder proposes one change at a time and the operator agrees;
// it never changes the build on its own, and it never proposes accepting the approvals check.
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

export const PROPOSAL_STATES = ["proposed", "agreed", "declined", "undone"] as const;
export const ProposalState = z.enum(PROPOSAL_STATES);
export type ProposalState = z.infer<typeof ProposalState>;

/** Undo is offered where the change has an exact opposite: an item's state. */
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
