// Wave 6 (docs/plan.md §1.86 "Run audit (wave 6)"): the run view's audit parts. Each step's owner
// checks (what the owner did on each attempt: nothing off, flagged, reviewed, not watched), the
// run's place in the audit queue with its marks and the reviewer's mark (looks right, or a problem
// with a note), and the run's whole trail as one file for an auditor (printable HTML or JSON, AI
// prompts and answers only when ticked). Back office only (invariant 11).
import {
  AUDIT_NOTE_MAX,
  type AuditMarkView,
  buildPath,
  type OwnerCheckView,
  type RunAuditState,
  type RunAuditVerdict,
} from "@countersign/core";
import { useState } from "react";
import { Link } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApiClient } from "../../api/useApi";
import { shortTime } from "../../runs/format";
import { Field, TextArea } from "../../ui/forms";
import { Badge, Button, buttonClass, Card, ErrorNotice, type Tone } from "../../ui/primitives";

// ── The owner's check on each attempt ──

/**
 * A step's owner checks, one line per attempt: "Owner checked: nothing off", "Flagged: total 4×
 * its usual → reviewed → carried on". A reviewed check links to the owner's decision in Details.
 */
export function OwnerCheckLines({
  checks,
  runId,
  testId,
}: {
  checks: readonly OwnerCheckView[];
  runId: string;
  testId: string;
}) {
  if (checks.length === 0) return null;
  const attempts = new Set(checks.map((c) => c.attempt)).size > 1;
  return (
    <ul className="flex flex-col gap-0.5" data-testid={testId}>
      {[...checks]
        .sort((a, b) => a.attempt - b.attempt)
        .map((c) => (
          <li
            key={c.id}
            data-testid={`ops-run-owner-check-${c.id}`}
            data-result={c.result}
            // Agents' work stays ink; clean and unwatched are quieter than a flag.
            className={
              c.result === "clean" || c.result === "not_watched"
                ? "text-sm text-ink-muted"
                : "text-sm text-ink"
            }
          >
            {attempts ? `Attempt ${c.attempt}: ` : ""}
            {c.words}
            {c.result === "reviewed" && c.decisionId ? (
              <>
                {" · "}
                <Link
                  to={`/ops/runs/${runId}?tab=details`}
                  className="text-link underline"
                  data-testid={`ops-run-owner-check-decision-${c.id}`}
                >
                  the owner's note
                </Link>
              </>
            ) : null}
          </li>
        ))}
    </ul>
  );
}

// ── The audit: queued, marks, and the reviewer's mark ──

const VERDICT: Record<RunAuditVerdict, { label: string; tone: Tone }> = {
  looks_right: { label: "Looks right", tone: "positive" },
  problem: { label: "Problem", tone: "risk" },
};

export function VerdictBadge({ verdict, testId }: { verdict: RunAuditVerdict; testId?: string }) {
  const v = VERDICT[verdict];
  return (
    <Badge tone={v.tone} {...(testId ? { testId } : {})}>
      {v.label}
    </Badge>
  );
}

/** "Every run that wrote to the client's tools", "Sampled: 5% of the runs without a write". */
export function queuedWords(queued: NonNullable<RunAuditState["queued"]>): string {
  switch (queued.reason) {
    case "wrote":
      return "Queued: it wrote to the client's tools";
    case "sampled":
      return queued.rule
        ? `Queued: sampled, ${queued.rule.percent}% of runs without a write`
        : "Queued: sampled";
    case "by_hand":
      return "Added by a reviewer's mark";
  }
}

export function reviewerName(m: AuditMarkView): string {
  return m.markedBy.name ?? m.markedBy.email;
}

/**
 * The run's audit, on the run view's rail: why it was queued (or that it wasn't), its marks newest
 * first, and the reviewer's mark once the run is over. A mark is never edited: a new one supersedes
 * it for display and both are kept.
 */
// DECISION (wave 6): the audit card sits on the run view's rail, under About this run, for
// every run; the mark form shows once the run is over (the API answers 409 before). A problem's
// note is required before Save is enabled, as the API requires it.
export function RunAuditCard({
  runId,
  audit,
  finished,
  onMarked,
}: {
  runId: string;
  audit: RunAuditState | undefined;
  finished: boolean;
  onMarked: () => void;
}) {
  const api = useApiClient();
  const [verdict, setVerdict] = useState<RunAuditVerdict | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const marks = audit?.marks ?? [];
  const latest = audit?.latest ?? null;
  const needsNote = verdict === "problem" && note.trim() === "";

  async function submit() {
    if (!verdict || needsNote) return;
    setBusy(true);
    setError(null);
    try {
      await api.call(apiRoutes.opsMarkRunAudit, {
        params: { id: runId },
        body: { verdict, ...(note.trim() ? { note: note.trim() } : {}) },
      });
      setVerdict(null);
      setNote("");
      onMarked();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Audit"
      meta={latest ? <VerdictBadge verdict={latest.verdict} testId="ops-run-audit-latest" /> : null}
      pad
      testId="ops-run-audit"
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-muted" data-testid="ops-run-audit-queued">
          {audit?.queued
            ? queuedWords(audit.queued)
            : "Not in the audit queue. Marking it adds it."}
        </p>
        {marks.length > 0 ? (
          <ul className="flex flex-col gap-2" data-testid="ops-run-audit-marks">
            {marks.map((m, i) => (
              <li
                key={m.id}
                data-testid={`ops-run-audit-mark-${m.id}`}
                className={i === 0 ? "text-sm text-ink" : "text-sm text-ink-muted"}
              >
                <span className="flex flex-wrap items-center gap-2">
                  <VerdictBadge verdict={m.verdict} />
                  <span>
                    {reviewerName(m)} · {shortTime(m.createdAt)}
                    {i > 0 ? " · superseded" : ""}
                  </span>
                </span>
                {m.note ? <span className="mt-1 block">{m.note}</span> : null}
                {m.inboxItemId ? (
                  <Link to="/ops/inbox" className="text-link underline">
                    Its item in Escalations
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {finished ? (
          <div className="flex flex-col gap-2" data-testid="ops-run-audit-form">
            <div className="ds-seg self-start">
              {(["looks_right", "problem"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={verdict === v}
                  data-testid={`ops-run-audit-${v}`}
                  onClick={() => setVerdict(v)}
                >
                  {VERDICT[v].label}
                </button>
              ))}
            </div>
            {verdict ? (
              <>
                <Field
                  label={verdict === "problem" ? "What is wrong" : "Note (optional)"}
                  hint={
                    verdict === "problem"
                      ? "A problem opens an item in Escalations for us."
                      : undefined
                  }
                >
                  <TextArea
                    data-testid="ops-run-audit-note"
                    rows={3}
                    maxLength={AUDIT_NOTE_MAX}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                </Field>
                <Button
                  variant="primary"
                  size="sm"
                  className="self-start"
                  data-testid="ops-run-audit-save"
                  disabled={busy || needsNote}
                  onClick={() => void submit()}
                >
                  {busy ? "Saving" : latest ? "Add this mark" : "Save the mark"}
                </Button>
              </>
            ) : null}
            {error ? <ErrorNotice error={error} /> : null}
          </div>
        ) : (
          <p className="text-sm text-ink-muted">You can mark it once it is over.</p>
        )}
      </div>
    </Card>
  );
}

// ── The run's trail as one file ──

/** `/api/ops/runs/:id/export?format=…` (and `modelCalls=1` when ticked). */
export function runExportHref(runId: string, format: "html" | "json", modelCalls: boolean) {
  const query = new URLSearchParams({ format });
  if (modelCalls) query.set("modelCalls", "1");
  return `${buildPath(apiRoutes.opsRunExport.path, { id: runId })}?${query.toString()}`;
}

/** Two downloads for an auditor; each is logged in the audit log. */
// DECISION (wave 6): two plain download links (the session cookie goes with them; the browser
// saves the file the route names), offered on every run, a running one too: the trail so far.
// "Include AI calls" is off by default, so a full prompt leaves only when someone ticks it.
export function RunExportCard({ runId }: { runId: string }) {
  const [modelCalls, setModelCalls] = useState(false);
  return (
    <Card title="Export for an auditor" pad testId="ops-run-export">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-muted">
          The whole trail in one file: every step, its checks, the owner's decisions, the writes and
          the audit marks. Secrets are never in it. Each download is logged.
        </p>
        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            className="size-4 accent-slate"
            type="checkbox"
            data-testid="ops-run-export-model-calls"
            checked={modelCalls}
            onChange={(e) => setModelCalls(e.target.checked)}
          />
          Include AI calls (each prompt and answer)
        </label>
        <div className="flex flex-wrap gap-2">
          <a
            href={runExportHref(runId, "html", modelCalls)}
            download
            className={buttonClass("secondary", undefined, "sm")}
            data-testid="ops-run-export-html"
          >
            Printable (HTML)
          </a>
          <a
            href={runExportHref(runId, "json", modelCalls)}
            download
            className={buttonClass("secondary", undefined, "sm")}
            data-testid="ops-run-export-json"
          >
            JSON
          </a>
        </div>
      </div>
    </Card>
  );
}
