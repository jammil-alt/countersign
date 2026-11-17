// The Dev queue (docs/plan.md §1.125, owner 2026-11-17): what a build needs that no catalog part
// can be made into goes to engineering as a numbered request (DQ-001). Triage pushes hard toward
// reusing or extending what exists: a reuse check names the parts that might already do it, each
// judged use, extend or reject with what it lacks; the decision ladder goes down one step at a
// time, each with a reason; and one request is one part. The guards are here so the API refuses
// and the screen disables a move with the same plain reason.

import { z } from "zod";
import { CODE_REQUEST_STATUS_WORDS, DECISION_WORDS } from "./code-request-words";

export const CODE_REQUEST_KINDS = [
  "extend_existing",
  "new_tool",
  "new_skill_code",
  "config_only",
] as const;
export const CodeRequestKind = z.enum(CODE_REQUEST_KINDS);
export type CodeRequestKind = z.infer<typeof CodeRequestKind>;

import { CODE_REQUEST_STATUSES, CodeRequestStatus } from "./code-request-status";

export { CODE_REQUEST_STATUSES, CodeRequestStatus };

/** Not shipped and not closed. */
export function requestOpen(status: CodeRequestStatus): boolean {
  return status !== "shipped" && status !== "closed";
}

/**
 * The decision ladder, most reuse first. Each step down needs a reason saying why the step above
 * won't do.
 */
export const CODE_REQUEST_DECISIONS = [
  "exists",
  "config",
  "extend",
  "new_general",
  "one_off",
] as const;
export const CodeRequestDecision = z.enum(CODE_REQUEST_DECISIONS);
export type CodeRequestDecision = z.infer<typeof CodeRequestDecision>;

export const CODE_REQUEST_CLOSE_REASONS = [
  "exists",
  "config",
  "merged",
  "not_worth_it",
  "not_possible",
  "superseded",
] as const;
export const CloseReason = z.enum(CODE_REQUEST_CLOSE_REASONS);
export type CloseReason = z.infer<typeof CloseReason>;

export const CODE_REQUEST_CREATORS = ["builder", "operator", "session"] as const;
export const CodeRequestCreator = z.enum(CODE_REQUEST_CREATORS);
export type CodeRequestCreator = z.infer<typeof CodeRequestCreator>;

export const CODE_REQUEST_EVENT_KINDS = [
  "status",
  "note",
  "reuse_check",
  "merge",
  "claim",
  "pr",
  "notified",
  "shipped",
] as const;
export const CodeRequestEventKind = z.enum(CODE_REQUEST_EVENT_KINDS);
export type CodeRequestEventKind = z.infer<typeof CodeRequestEventKind>;

export const CODE_REQUEST_ACTORS = ["operator", "builder", "session", "system"] as const;
export const CodeRequestActor = z.enum(CODE_REQUEST_ACTORS);
export type CodeRequestActor = z.infer<typeof CodeRequestActor>;

/** DQ-012. */
export function dqNumber(n: number): string {
  return `DQ-${String(n).padStart(3, "0")}`;
}

/** 12 from "DQ-012", "dq-12" or "12"; null otherwise. */
export function parseDqNumber(text: string): number | null {
  const m = /^\s*(?:dq-?)?0*(\d{1,7})\s*$/i.exec(text);
  if (!m?.[1]) return null;
  const n = Number(m[1]);
  return n >= 1 ? n : null;
}

// ── The request ──────────────────────────────────────────────────────────────────────────────────

const Line = z.string().trim().min(1).max(500);

/**
 * What the code must do. `inputs` and `outputs` are general ("invoice rows", never "step 4's
 * output"); `acceptance` says how to check it's right; `parts` names the catalog part it adds or
 * changes, and `packages` where the code goes: one each (split it first).
 */
export const CodeRequestSpec = z.object({
  summary: z.string().trim().max(2000).default(""),
  inputs: z.array(Line).max(20).default([]),
  outputs: z.array(Line).max(20).default([]),
  rules: z.array(Line).max(20).default([]),
  acceptance: z.array(Line).max(20).default([]),
  parts: z.array(z.string().trim().min(1).max(200)).max(10).default([]),
  packages: z.array(z.string().trim().min(1).max(200)).max(10).default([]),
});
export type CodeRequestSpec = z.infer<typeof CodeRequestSpec>;

export function readSpec(raw: unknown): CodeRequestSpec {
  const parsed = CodeRequestSpec.safeParse(raw ?? {});
  return parsed.success ? parsed.data : CodeRequestSpec.parse({});
}

export const QUESTION_MODES = ["answer_first", "investigate_during_build"] as const;
export const QuestionMode = z.enum(QUESTION_MODES);
export type QuestionMode = z.infer<typeof QuestionMode>;

export const OpenQuestion = z.object({
  question: z.string().trim().min(1).max(1000),
  answer: z.string().trim().max(2000).nullable().default(null),
  mode: QuestionMode.default("answer_first"),
});
export type OpenQuestion = z.infer<typeof OpenQuestion>;

export function readQuestions(raw: unknown): OpenQuestion[] {
  const parsed = z.array(OpenQuestion).safeParse(raw ?? []);
  return parsed.success ? parsed.data : [];
}

// ── The reuse check ──────────────────────────────────────────────────────────────────────────────

export const PART_TYPES = ["skill", "tool", "connector", "pack", "operation", "request"] as const;
export const PartType = z.enum(PART_TYPES);
export type PartType = z.infer<typeof PartType>;

export const REUSE_VERDICTS = ["use", "extend", "reject"] as const;
export const ReuseVerdict = z.enum(REUSE_VERDICTS);
export type ReuseVerdict = z.infer<typeof ReuseVerdict>;

/**
 * The least a reason or a "missing" says. Not a word list: a reject must name the input, output or
 * behaviour the candidate lacks, and that takes a sentence.
 */
export const REASON_MIN = 25;

export const ReuseCandidate = z.object({
  partType: PartType,
  /** A tool id, skill ref, connector or pack id, `<part>#<operation>`, or a request's id. */
  partId: z.string().min(1).max(300),
  name: z.string().max(300),
  /** The deterministic score, 0 to 1. */
  score: z.number().min(0).max(1),
  /** The judge thinks it bears on the request; only these need a verdict. */
  relevant: z.boolean().default(true),
  verdict: ReuseVerdict.nullable().default(null),
  reason: z.string().max(1000).default(""),
  /** A reject: the input, output or behaviour it lacks. */
  missing: z.string().max(1000).default(""),
  judgedBy: z.enum(["model", "operator", "builder"]).nullable().default(null),
  /** A request candidate: its number, and whether it's still open. */
  number: z.number().int().nullable().default(null),
  open: z.boolean().nullable().default(null),
});
export type ReuseCandidate = z.infer<typeof ReuseCandidate>;

export const ReuseCheck = z.object({
  ranAt: z.string(),
  candidates: z.array(ReuseCandidate).max(20).default([]),
  /** The judge couldn't run (no model): the candidates are unjudged. */
  unjudged: z.boolean().default(false),
});
export type ReuseCheck = z.infer<typeof ReuseCheck>;

export function readReuseCheck(raw: unknown): ReuseCheck | null {
  if (raw == null) return null;
  const parsed = ReuseCheck.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** The reuse check is current for this long. */
export const REUSE_CHECK_MAX_AGE_MS = 7 * 24 * 3_600_000;

/** Why a candidate's verdict and reason won't do; null when they do. */
export function candidateProblem(c: ReuseCandidate): string | null {
  if (!c.relevant) return null;
  const name = c.name || c.partId;
  if (!c.verdict) return `“${name}” has no verdict yet.`;
  if (c.verdict === "reject") {
    if (c.missing.trim().length < REASON_MIN) {
      return `The reject of “${name}” doesn't say what it lacks: name the input, output or behaviour it's missing.`;
    }
    if (sameWords(c.missing, name)) {
      return `The reject of “${name}” only repeats its name: say what it lacks.`;
    }
    return null;
  }
  if (c.reason.trim().length < REASON_MIN) {
    return `The verdict on “${name}” needs a reason: what it does for this request.`;
  }
  return null;
}

function sameWords(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  return norm(a) === norm(b);
}

/** A catalog or shipped part the judge marked `use`: the request may already be covered. */
export function coveredBy(check: ReuseCheck | null): ReuseCandidate | null {
  if (!check) return null;
  return (
    check.candidates.find(
      (c) => c.relevant && c.verdict === "use" && (c.partType !== "request" || c.open === false),
    ) ?? null
  );
}

/** An open request the judge marked `use`: the same capability, already asked for. */
export function duplicateOf(check: ReuseCheck | null, selfId?: string): ReuseCandidate | null {
  if (!check) return null;
  return (
    check.candidates.find(
      (c) =>
        c.relevant &&
        c.verdict === "use" &&
        c.partType === "request" &&
        c.open === true &&
        c.partId !== selfId,
    ) ?? null
  );
}

// ── Guards ───────────────────────────────────────────────────────────────────────────────────────

/** A claim lapses after this long with no event. */
export const CLAIM_LAPSE_MS = 2 * 3_600_000;

/** What the guards read: a request as stored, plus its links. */
export interface RequestFacts {
  id: string;
  status: CodeRequestStatus;
  kind: CodeRequestKind;
  spec: CodeRequestSpec;
  openQuestions: readonly OpenQuestion[];
  reuseCheck: ReuseCheck | null;
  decision: CodeRequestDecision | null;
  decisionReason: string | null;
  otherUses: readonly string[];
  oneOffApprovedAt: string | null;
  claimedBy: string | null;
  claimedAt: string | null;
  lastEventAt: string;
  prUrl: string | null;
  expectedPartId: string | null;
}

/** The claim lapsed: In progress with no event for 2 hours. */
export function claimLapsed(r: Pick<RequestFacts, "status" | "lastEventAt">, now: Date): boolean {
  return r.status === "in_progress" && now.getTime() - Date.parse(r.lastEventAt) >= CLAIM_LAPSE_MS;
}

/** Why the decision and its reason won't do (the ladder's rules); empty when they do. */
export function decisionProblems(
  r: Pick<RequestFacts, "decision" | "decisionReason" | "otherUses" | "oneOffApprovedAt">,
): string[] {
  const out: string[] = [];
  if (!r.decision) return ["There's no decision yet: exists, config, extend, new or one-off."];
  const step = CODE_REQUEST_DECISIONS.indexOf(r.decision);
  if (step >= CODE_REQUEST_DECISIONS.indexOf("extend")) {
    if ((r.decisionReason ?? "").trim().length < REASON_MIN) {
      const above = CODE_REQUEST_DECISIONS[step - 1] ?? "config";
      out.push(
        `“${DECISION_WORDS[r.decision]}” needs a reason saying why “${DECISION_WORDS[above]}” won't do.`,
      );
    }
  }
  if (r.decision === "new_general" && r.otherUses.length === 0) {
    out.push("A new, general part needs at least one other use. With none, it's a one-off.");
  }
  if (r.decision === "one_off" && !r.oneOffApprovedAt) {
    out.push("A one-off needs your approval first.");
  }
  return out;
}

/** Why the spec isn't ready to build; empty when it is. */
export function specProblems(spec: CodeRequestSpec): string[] {
  const out: string[] = [];
  if (spec.inputs.length === 0) out.push("The spec has no inputs.");
  if (spec.outputs.length === 0) out.push("The spec has no outputs.");
  if (spec.acceptance.length === 0) out.push("The spec doesn't say how to check it's right.");
  if (spec.parts.length === 0) out.push("The spec doesn't name the part it adds or changes.");
  if (spec.parts.length > 1 || spec.packages.length > 1) {
    out.push("It touches more than one part or package. Split it into one request per part first.");
  }
  return out;
}

/** Why Triage → Accepted is refused; empty when it may go. */
export function acceptReasons(r: RequestFacts, now: Date): string[] {
  if (r.status !== "triage") return [`It's ${CODE_REQUEST_STATUS_WORDS[r.status]}, not in triage.`];
  const out: string[] = [];
  const check = r.reuseCheck;
  if (!check) out.push("The reuse check hasn't run. Run it first.");
  else {
    if (now.getTime() - Date.parse(check.ranAt) > REUSE_CHECK_MAX_AGE_MS) {
      out.push("The reuse check is more than 7 days old. Run it again.");
    }
    if (check.unjudged) out.push("The reuse check's candidates haven't been judged yet.");
    for (const c of check.candidates) {
      const p = candidateProblem(c);
      if (p) out.push(p);
    }
  }
  out.push(...decisionProblems(r));
  if (r.decision === "exists" || r.decision === "config") {
    out.push("Decided as exists or config: close it with that reason; there's nothing to build.");
  }
  const unsettled = r.openQuestions.filter(
    (q) => q.mode === "answer_first" && !(q.answer ?? "").trim(),
  ).length;
  if (unsettled > 0) {
    out.push(
      unsettled === 1
        ? "1 question must be answered first (or marked to investigate during the build)."
        : `${unsettled} questions must be answered first (or marked to investigate during the build).`,
    );
  }
  out.push(...specProblems(r.spec));
  return out;
}

export const CODE_REQUEST_MOVES = [
  "accept",
  "claim",
  "attach_pr",
  "close",
  "rerun_reuse",
  "approve_one_off",
] as const;
export type CodeRequestMove = (typeof CODE_REQUEST_MOVES)[number];

export interface MoveState {
  allowed: boolean;
  /** Why not, in plain words; empty when allowed. */
  reason: string;
}

/**
 * Each move as the screen shows it: allowed, or disabled with the reason. The API checks the same
 * function before it moves. Shipped is the system's, never a person's, so it isn't a move.
 */
export function requestMoves(
  r: RequestFacts,
  now: Date,
  who: { userId: string },
): Record<CodeRequestMove, MoveState> {
  const yes: MoveState = { allowed: true, reason: "" };
  const no = (reason: string): MoveState => ({ allowed: false, reason });
  const open = requestOpen(r.status);
  const accept = acceptReasons(r, now);
  const lapsed = claimLapsed(r, now);
  return {
    accept: accept.length === 0 ? yes : no(accept[0] ?? ""),
    claim:
      r.status === "accepted" || lapsed
        ? yes
        : r.status === "in_progress"
          ? no(
              r.claimedBy === who.userId
                ? "You have it."
                : "Someone has it. A claim lapses 2 hours after its last event.",
            )
          : no("Only an accepted request can be claimed."),
    attach_pr:
      r.status === "in_progress" && r.claimedBy === who.userId && !lapsed
        ? yes
        : no(
            r.status === "in_progress"
              ? "Only whoever has it attaches the PR."
              : "Claim it first: a PR goes on a request in progress.",
          ),
    close: open ? yes : no(`It's ${CODE_REQUEST_STATUS_WORDS[r.status].toLowerCase()} already.`),
    rerun_reuse: open ? yes : no("It's no longer open."),
    approve_one_off:
      r.status !== "triage"
        ? no("Only a request in triage is approved as a one-off.")
        : r.decision !== "one_off"
          ? no("It isn't decided as a one-off.")
          : r.oneOffApprovedAt
            ? no("Approved already.")
            : (r.decisionReason ?? "").trim().length < REASON_MIN
              ? no("Say first why a new, general part won't do.")
              : yes,
  };
}

/** Why a close is refused; null when it may close. */
export function closeProblem(
  r: Pick<RequestFacts, "id" | "status">,
  reason: CloseReason,
  mergedIntoId: string | null,
): string | null {
  if (!requestOpen(r.status)) return "It's closed or shipped already.";
  if (reason === "merged" && !mergedIntoId) return "Say which request it's merged into.";
  if (reason !== "merged" && mergedIntoId) return "Only a merge names another request.";
  if (mergedIntoId === r.id) return "A request can't be merged into itself.";
  return null;
}

/** Why a PR can't be attached; null when it can. */
export function prProblem(prUrl: string, expectedPartId: string): string | null {
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(prUrl.trim())) {
    return "The PR link must be a GitHub pull request: https://github.com/<owner>/<repo>/pull/<n>.";
  }
  if (!expectedPartId.trim()) return "Say which catalog part the code adds.";
  return null;
}

// ── Catalog parts ────────────────────────────────────────────────────────────────────────────────

/**
 * A part's id: a tool id or skill ref (`qbo.aging_report`), a connector or pack id, or one
 * operation of a part (`data.reshape#dateOffset`). The ship check looks for it in the catalog.
 */
export function splitPartId(partId: string): { base: string; operation: string | null } {
  const at = partId.indexOf("#");
  return at < 0
    ? { base: partId.trim(), operation: null }
    : { base: partId.slice(0, at).trim(), operation: partId.slice(at + 1).trim() || null };
}

/** "Shipped to staging" or "In production", by the environment a deploy happened in. */
export type ShipEnvironment = "staging" | "production";

export function shipEnvironment(env: string | undefined): ShipEnvironment | null {
  const e = (env ?? "").trim().toLowerCase();
  if (e === "production") return "production";
  if (e === "staging") return "staging";
  return null;
}
