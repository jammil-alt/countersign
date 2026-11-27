// What the supervisor (the agent's owner, the area's owner agent; ARCHITECTURE §10.11, §10.15)
// verified and decided on one step (owner, 2026-11-27), from the run's own data: its rule checks on
// each attempt (`ownerChecks`, the cheap watch's signals), the write's second check against the
// run's sources (`verification`: on a test run's step output, on a live write's approval card), and
// its decisions (`oversight`). Two compact lines under the step, Verified and Decided, with the note,
// what it changed and the records it cited folded under "Note and sources". The run page's
// timeline and Try it's results show the same lines.
import {
  changedFields,
  type OversightActionName,
  type OversightDecisionView,
  type OwnerCheckView,
  signalWords,
  WriteVerification,
} from "@countersign/core";
import type { ReactNode } from "react";
import type { ResponseOf } from "../../api/client";
import type { apiRoutes } from "../../api/routes";
import { SourceLinks } from "../../records/SourceLinks";
import { Badge, type Tone } from "../../ui/primitives";

type RunData = ResponseOf<typeof apiRoutes.opsRun>;

export interface StepSupervisionDecision {
  id: string;
  action: OversightActionName;
  /** The tag: "Continued", "Retried with a corrected input", "Asked a person", "Stopped". */
  tag: string;
  tone: Tone;
  /** The note's first sentence, short. */
  reason: string;
  note: string;
  /** A corrected input's fields ("total, vendor"). */
  changed: string[];
  /** The question a person was asked (its inbox item's title). */
  question: string | null;
  proposal: string | null;
  sources: string[];
}

export interface StepSupervision {
  /** The parts of the Verified line, in order. */
  verified: { text: string; tone: "ink" | "risk" }[];
  /** Every attempt was clean and nothing was decided: said quietly. */
  quiet: boolean;
  decisions: StepSupervisionDecision[];
}

const DECIDED: Record<OversightActionName, { tag: string; tone: Tone }> = {
  continue: { tag: "Continued", tone: "neutral" },
  retry: { tag: "Retried", tone: "neutral" },
  retry_with: { tag: "Retried with a corrected input", tone: "neutral" },
  // Signal gold is for what waits on a person, with its word; a stop is the run's error.
  ask: { tag: "Asked a person", tone: "warning" },
  stop: { tag: "Stopped", tone: "risk" },
};

const VERIFY_CANNOT_WORDS: Record<string, string> = {
  no_sources: "the run kept nothing to check it against",
  not_derivable: "the sources don't say what this change should be",
  nothing_compared: "it found nothing to compare",
  review_failed: "the check didn't finish",
};

/** The write's second check, in words: agrees, disagrees on which fields, or couldn't check. */
export function verificationWords(v: WriteVerification): { text: string; tone: "ink" | "risk" } {
  switch (v.outcome) {
    case "agreed":
      return {
        text: `Write matches the sources (${v.checked} ${v.checked === 1 ? "field" : "fields"})`,
        tone: "ink",
      };
    case "disagreed":
      return {
        text: `Write differs from the sources on ${v.differences.map((d) => d.path).join(", ")}`,
        tone: "risk",
      };
    case "cannot_verify":
      return {
        text: `Write not checked: ${VERIFY_CANNOT_WORDS[v.reason ?? "review_failed"] ?? "the check didn't finish"}`,
        tone: "ink",
      };
  }
}

/** The note's first sentence, at most about a line. */
export function shortReason(note: string): string {
  const first = note.trim().split(/(?<=[.!?])\s/)[0] ?? "";
  return first.length > 120 ? `${first.slice(0, 117).trimEnd()}…` : first;
}

/** What the rules saw on the step's attempts, in a few words. */
function rulesWords(
  checks: readonly OwnerCheckView[],
): { text: string; tone: "ink" | "risk" } | null {
  const watched = checks.filter((c) => c.result !== "not_watched");
  if (watched.length === 0) return null;
  const signals = watched.flatMap((c) => c.signals);
  if (signals.length > 0) {
    return {
      text: `Rules flagged ${[...new Set(signals.map(signalWords))].join(", ")}`,
      tone: "ink",
    };
  }
  if (watched.some((c) => c.attemptOutcome === "failed")) {
    return { text: "Rules: the step failed", tone: "ink" };
  }
  return { text: "Rules: no issues", tone: "ink" };
}

/** The write verifications of these step runs: a test run's step output, a live write's card. */
function verificationsOf(run: RunData, rows: RunData["steps"]): WriteVerification[] {
  const out: WriteVerification[] = [];
  const ids = new Set(rows.map((r) => r.id));
  for (const r of rows) {
    const v = WriteVerification.safeParse(
      (r.output as { verification?: unknown } | null)?.verification,
    );
    if (v.success) out.push(v.data);
  }
  for (const a of run.actions) {
    if (!a.stepRunId || !ids.has(a.stepRunId) || !a.inboxItemId) continue;
    const item = run.inbox.find((i) => i.id === a.inboxItemId);
    const v = WriteVerification.safeParse(item?.payload.verification);
    if (v.success) out.push(v.data);
  }
  return out;
}

/**
 * What the supervisor verified and decided on these step runs (one step's rows: a loop runs it
 * more than once). Null when it has nothing to say: the step isn't watched, or nothing is recorded.
 */
export function stepSupervision(
  run: RunData,
  stepRunIds: readonly string[],
): StepSupervision | null {
  const ids = new Set(stepRunIds);
  const rows = run.steps.filter((r) => ids.has(r.id));
  if (rows.length === 0) return null;
  const nodes = new Set(rows.map((r) => r.nodeId));
  const checks = (run.ownerChecks ?? []).filter((c) => nodes.has(c.nodeId));
  const decisions = (run.oversight ?? []).filter((d) => ids.has(d.stepRunId));
  const verification = verificationsOf(run, rows).at(-1);
  const rules = rulesWords(checks);
  const reviewed = decisions.length > 0 || checks.some((c) => c.result === "reviewed");
  // The owner's review of a step-model run reads the step against the run's goal and plan.
  const stepModel =
    (run.workflow?.definition as { schemaVersion?: unknown } | null | undefined)?.schemaVersion ===
    5;
  const verified = [
    ...(rules ? [rules] : []),
    ...(verification ? [verificationWords(verification)] : []),
    ...(reviewed
      ? [{ text: stepModel ? "Read against the run's goal" : "Reviewed", tone: "ink" as const }]
      : []),
  ];
  const flagged = checks.some((c) => c.result === "flagged" || c.result === "reviewed");
  const quiet =
    !flagged && !verification && decisions.length === 0 && rules?.text === "Rules: no issues";
  if (verified.length === 0 && decisions.length === 0) return null;
  return {
    verified,
    quiet,
    decisions: decisions.map((d) => decisionOf(d, run)),
  };
}

function decisionOf(d: OversightDecisionView, run: RunData): StepSupervisionDecision {
  const item = d.inboxItemId ? run.inbox.find((i) => i.id === d.inboxItemId) : undefined;
  return {
    id: d.id,
    action: d.action,
    ...DECIDED[d.action],
    reason: shortReason(d.note),
    note: d.note,
    changed: d.action === "retry_with" ? changedFields(d.inputBefore, d.inputAfter) : [],
    question: d.action === "ask" ? (item?.title ?? null) : null,
    proposal: d.proposal?.summary ?? null,
    sources: d.sources,
  };
}

/**
 * The two lines under a step: Verified (what it checked) and Decided (a tag and its short reason),
 * with "Note and sources" folded. A clean step says "Checked by rules: no issues", quietly.
 * `attempts` (the run page's line per attempt) goes inside the fold.
 */
export function SupervisionLines({
  supervision,
  run,
  testId,
  attempts,
}: {
  supervision: StepSupervision;
  run: RunData;
  testId: string;
  attempts?: ReactNode;
}) {
  const s = supervision;
  if (s.quiet) {
    return (
      <details className="text-sm" data-testid={testId}>
        <summary className="cursor-pointer text-ink-muted" data-testid={`${testId}-quiet`}>
          Checked by rules: no issues
        </summary>
        {attempts ? <div className="mt-1">{attempts}</div> : null}
      </details>
    );
  }
  const folded = s.decisions.some(
    (d) => d.note || d.changed.length || d.question || d.proposal || d.sources.length,
  );
  return (
    <div className="flex flex-col gap-1 text-sm" data-testid={testId}>
      <p className="text-ink" data-testid={`${testId}-verified`}>
        <span className="eyebrow text-ink-muted">Verified</span>{" "}
        {s.verified.map((v, i) => (
          <span key={v.text} className={v.tone === "risk" ? "text-risk-ink" : undefined}>
            {i > 0 ? " · " : ""}
            {v.text}
          </span>
        ))}
      </p>
      {s.decisions.map((d) => (
        <p
          key={d.id}
          className="flex flex-wrap items-center gap-x-1.5 text-ink"
          data-testid={`${testId}-decided-${d.id}`}
          data-action={d.action}
        >
          <span className="eyebrow text-ink-muted">Decided</span>
          <Badge tone={d.tone}>{d.tag}</Badge>
          {d.reason ? <span>{d.reason}</span> : null}
        </p>
      ))}
      {folded || attempts ? (
        <details data-testid={`${testId}-more`}>
          <summary className="cursor-pointer text-slate">
            {folded ? "Note and sources" : "Each attempt"}
          </summary>
          <div className="mt-1 flex flex-col gap-1.5">
            {s.decisions.map((d) => (
              <div key={d.id} className="flex flex-col gap-1">
                {d.note ? <p className="text-ink">{d.note}</p> : null}
                {d.changed.length > 0 ? (
                  <p className="text-ink" data-testid={`${testId}-changed-${d.id}`}>
                    <span className="text-ink-muted">Changed: </span>
                    {d.changed.join(", ")}
                  </p>
                ) : null}
                {d.question ? (
                  <p className="text-ink">
                    <span className="text-ink-muted">Asked: </span>
                    {d.question}
                  </p>
                ) : null}
                {d.proposal ? (
                  <p className="text-ink">
                    <span className="text-ink-muted">Lasting fix to make in the builder: </span>
                    {d.proposal}
                  </p>
                ) : null}
                <SourceLinks
                  ids={d.sources}
                  href={(id) => `/ops/clients/${run.run.tenantId}/records/${id}`}
                  names={run.sourceNames}
                  testId={`${testId}-sources-${d.id}`}
                />
              </div>
            ))}
            {attempts}
          </div>
        </details>
      ) : null}
    </div>
  );
}
