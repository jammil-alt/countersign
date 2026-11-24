// The Collect reports step as a person sees it: each report with its owner, what it must be, when
// it's due, how we follow up and what has happened so far; then who a late one goes to. Shown on
// the run's first step and, while one is out, on the agent's overview.
import { Link } from "react-router-dom";
import { PersonBadge } from "../../../ui/badges";
import { Badge, cx } from "../../../ui/primitives";
import { StatusChip } from "../../../ui/status";
import { ESCALATION, INBOX, REPORTS, type Report, reportEvents } from "./data";

export function reportIn(r: Report, stage: number): boolean {
  return r.key === "sales" || stage >= 1;
}

export function ReportCards({ stage, compact }: { stage: number; compact?: boolean }) {
  return (
    <div className="flex flex-col gap-4">
      {REPORTS.map((r) => (
        <ReportCard key={r.key} r={r} stage={stage} compact={compact ?? false} />
      ))}
      {compact ? null : <Escalation />}
    </div>
  );
}

function ReportCard({ r, stage, compact }: { r: Report; stage: number; compact: boolean }) {
  const done = reportIn(r, stage);
  const events = reportEvents(r.key, stage);
  return (
    <section className="demo-report">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium text-ink">{r.name}</p>
          <p className="text-sm text-ink-muted">{r.from}</p>
        </div>
        {done ? (
          <StatusChip state="done">In · checks passed</StatusChip>
        ) : (
          <StatusChip state="person">Due 9:00 AM · followed up</StatusChip>
        )}
      </div>
      <dl className="demo-report__facts">
        <div>
          <dt>Owner</dt>
          <dd>
            <PersonBadge name={r.owner} line={r.ownerRole} size="sm" />
          </dd>
        </div>
        <div>
          <dt>Due</dt>
          <dd>
            {r.due}
            <span className="block text-xs text-ink-muted">{r.dueRule}</span>
          </dd>
        </div>
        <div>
          <dt>Follow-ups</dt>
          <dd className="text-sm">{r.followUp}</dd>
        </div>
      </dl>
      {compact ? null : (
        <>
          <dl className="demo-report__facts demo-report__facts--wide">
            <div>
              <dt>What it must be</dt>
              <dd className="text-sm">
                {r.format}, emailed to {INBOX}, every row dated the business day before. Columns:{" "}
                <span className="font-mono text-xs">{r.columns.join(", ")}</span>
              </dd>
            </div>
          </dl>
          <ol className="demo-timeline">
            {events.map((e) => (
              <li key={e.when + e.what} className={cx(e.tone && `is-${e.tone}`)}>
                <span className="demo-timeline__when">{e.when}</span>
                <span>{e.what}</span>
              </li>
            ))}
          </ol>
          {done ? (
            <p className="mt-2 text-sm">
              <span className="font-mono text-xs">{r.file}</span> · {r.rows} rows
            </p>
          ) : (
            <p className="mt-2 text-sm">
              <Link to="/mail/followup" className="text-link hover:underline">
                See the follow-up
              </Link>{" "}
              ·{" "}
              <Link to="/r/register" className="text-link hover:underline">
                Open the link in it
              </Link>
            </p>
          )}
        </>
      )}
    </section>
  );
}

function Escalation() {
  return (
    <section className="demo-report demo-report--escalate">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="font-medium text-ink">If a report is late</p>
        <Badge tone="person">Escalation</Badge>
      </div>
      <dl className="demo-report__facts">
        <div>
          <dt>Goes to</dt>
          <dd>
            <PersonBadge name={ESCALATION.to} line={ESCALATION.role} size="sm" />
          </dd>
        </div>
        <div>
          <dt>When</dt>
          <dd className="text-sm">{ESCALATION.after}</dd>
        </div>
        <div>
          <dt>They choose</dt>
          <dd className="text-sm">{ESCALATION.choices.join(" · ")}</dd>
        </div>
      </dl>
      <p className="mt-2 text-sm text-ink-muted">No answer by 3:00 PM: {ESCALATION.ifNoAnswer}.</p>
    </section>
  );
}
