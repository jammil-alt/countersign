// The agent manual (docs/builder-plan.md §5, B3) as a person reads it, shared by the back office's
// Manual tab and the portal's: what it does, how it works (its steps in words), its decisions,
// where a person decides, its known risks, what we set up with the client, what it learned for
// them and what it reads. Everything shown comes from the API's view, made by code (never the
// bundle, instructions, prompts or cost). The portal passes its words in the reader's language and
// "Ask about this" on each line; the back office its English words.

import type {
  DecisionKind,
  DecisionStatus,
  ManualLineSection,
  ManualView,
} from "@countersign/core";
import { type ReactNode, useState } from "react";
import { Link } from "react-router-dom";
import { EN } from "../i18n/i18n";
import { Badge, Card, cx, Tag, type Tone } from "../ui/primitives";

/** The words around the manual's content: section titles, labels and empty states. */
export interface ManualText {
  whatItDoes: string;
  howItWorks: string;
  decisions: string;
  decisionPoints: string;
  knownRisks: string;
  setup: string;
  learned: string;
  reads: string;
  notWritten: string;
  nothingYet: string;
  notAnswered: string;
  highRisk: string;
  /** Shown in place of the notes when this reader may not see them (a client user). */
  learnedHidden?: string | undefined;
  ask: string;
  startsAt: (value: string) => string;
  onStep: (step: string) => string;
  who: (who: string) => string;
  byWhen: (when: string) => string;
  lookedAtBy: (name: string) => string;
  /**
   * B5: "Changed by Ada on Nov 19, 2026" for a change on the agent's settings; `who` is null for
   * one of ours in the portal ("by us").
   */
  changedBy?: ((who: string | null, date: string | null) => string) | undefined;
  kind: (kind: DecisionKind) => string;
  status: (status: DecisionStatus) => string;
  date: (iso: string) => string;
}

const OPS_DATE = (iso: string) => EN.fmt.date(iso);

/** The back office's words (it reads in English). */
export const OPS_MANUAL_TEXT: ManualText = {
  whatItDoes: "What it does",
  howItWorks: "How it works",
  decisions: "Decisions",
  decisionPoints: "Where a person decides",
  knownRisks: "Known risks",
  setup: "What we set up with the client",
  learned: "What it learned",
  reads: "What it reads",
  notWritten: "No build has written this agent's manual yet. How it works is read from its steps.",
  nothingYet: "Nothing yet.",
  notAnswered: "Not answered yet",
  highRisk: "High risk",
  ask: "Ask about this",
  startsAt: (v) => `Starts at ${v}`,
  onStep: (s) => `Step: ${s}`,
  who: (w) => `Who: ${w}`,
  byWhen: (w) => `Within ${w}`,
  lookedAtBy: (n) => `By ${n}`,
  changedBy: (who, date) => `Changed by ${who ?? "us"}${date ? ` on ${OPS_DATE(date)}` : ""}`,
  kind: (k) =>
    k === "assumption" ? "Assumption" : k === "decision_point" ? "Decision point" : "Client setup",
  status: (s) =>
    s === "never_discussed"
      ? "Never discussed"
      : s === "discussed"
        ? "Discussed"
        : s === "confirmed"
          ? "Confirmed"
          : "Changed",
  date: OPS_DATE,
};

/** A line of the manual someone says is wrong (B5): which section, its id, and its words. */
export interface ManualLine {
  section: ManualLineSection;
  lineId?: string | undefined;
  line: string;
}

/** B5: "This is wrong" on each line, and the form it opens under the line. */
export interface ManualFeedback {
  label: string;
  render: (line: ManualLine, close: () => void) => ReactNode;
}

const STATUS_TONE: Record<DecisionStatus, Tone> = {
  never_discussed: "neutral",
  discussed: "accent",
  confirmed: "positive",
  changed: "person",
};

/** How deep a step sits (inside an if, a for each or a repeat), as indentation. */
const DEPTH = ["", "pl-5", "pl-10", "pl-14"] as const;

function Row({
  children,
  ask,
  wrong,
  testId,
}: {
  children: ReactNode;
  /** Where "Ask about this" goes, if this surface offers it. */
  ask?: { href: string; label: string } | null | undefined;
  /** B5: "This is wrong" on this line, and its form when open. */
  wrong?: { label: string; open: boolean; toggle: () => void; form: ReactNode } | null | undefined;
  testId?: string;
}) {
  return (
    <li
      className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-3 last:border-b-0"
      data-testid={testId}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">{children}</div>
      {ask || wrong ? (
        <span className="flex shrink-0 items-center gap-3">
          {ask ? (
            <Link to={ask.href} className="ds-btn ds-btn--link text-xs" data-testid="manual-ask">
              {ask.label}
            </Link>
          ) : null}
          {wrong ? (
            <button
              type="button"
              className="ds-btn ds-btn--link text-xs"
              aria-expanded={wrong.open}
              onClick={wrong.toggle}
              data-testid="manual-wrong"
            >
              {wrong.label}
            </button>
          ) : null}
        </span>
      ) : null}
      {wrong?.open ? <div className="w-full">{wrong.form}</div> : null}
    </li>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-5 py-4 text-sm text-ink-muted">{children}</p>;
}

export function ManualSections({
  view,
  text,
  askHref,
  feedback,
}: {
  view: ManualView;
  text: ManualText;
  /** "Ask about this" on a line: where it opens the chat with the line quoted; absent: none. */
  askHref?: ((line: string) => string) | undefined;
  /** B5: "This is wrong" on a line, in the portal; absent: none. */
  feedback?: ManualFeedback | undefined;
}) {
  const ask = (line: string) => (askHref ? { href: askHref(line), label: text.ask } : null);
  const [open, setOpen] = useState<string | null>(null);
  const wrong = (l: ManualLine) => {
    if (!feedback) return null;
    const key = `${l.section}:${l.lineId ?? l.line}`;
    const close = () => setOpen(null);
    return {
      label: feedback.label,
      open: open === key,
      toggle: () => setOpen(open === key ? null : key),
      form: open === key ? feedback.render(l, close) : null,
    };
  };
  return (
    <div className="flex flex-col gap-6" data-testid="manual">
      <Card title={text.whatItDoes} testId="manual-what">
        <ul>
          <Row
            ask={view.whatItDoes ? ask(view.whatItDoes) : null}
            wrong={view.whatItDoes ? wrong({ section: "what", line: view.whatItDoes }) : null}
          >
            <p className="text-sm text-ink">{view.whatItDoes || text.nothingYet}</p>
            {view.written ? null : (
              <p className="text-xs text-ink-muted" data-testid="manual-not-written">
                {text.notWritten}
              </p>
            )}
          </Row>
        </ul>
      </Card>

      <Card title={text.howItWorks} titleAbove testId="manual-how">
        {view.howItWorks.length === 0 ? (
          <Empty>{text.nothingYet}</Empty>
        ) : (
          <ol>
            {view.howItWorks.map((l) => (
              <Row
                key={`${l.workflow}:${l.stepId}`}
                ask={ask(`${l.name}: ${l.words}`)}
                wrong={wrong({ section: "how", lineId: l.stepId, line: `${l.name}: ${l.words}` })}
                testId={`manual-step-${l.stepId}`}
              >
                <span className={cx("flex flex-col gap-0.5", DEPTH[Math.min(l.depth, 3)])}>
                  <span className="text-sm font-medium text-ink">{l.name}</span>
                  <span className="text-xs text-ink-muted">{l.words}</span>
                </span>
              </Row>
            ))}
          </ol>
        )}
      </Card>

      <Card title={text.decisions} titleAbove testId="manual-decisions">
        {view.decisions.length === 0 ? (
          <Empty>{text.nothingYet}</Empty>
        ) : (
          <ul>
            {view.decisions.map((d) => (
              <Row
                key={d.id}
                ask={ask(d.what)}
                wrong={wrong({ section: "decision", lineId: d.id, line: d.what })}
                testId={`manual-decision-${d.id}`}
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-ink">{d.what}</span>
                  <Tag tone={d.kind === "decision_point" ? "person" : "neutral"}>
                    {text.kind(d.kind)}
                  </Tag>
                  {d.risk === "high" ? <Tag>{text.highRisk}</Tag> : null}
                  <Badge tone={STATUS_TONE[d.status]} testId={`manual-decision-${d.id}-status`}>
                    {text.status(d.status)}
                  </Badge>
                </span>
                {d.value ? <p className="text-xs text-ink">{text.startsAt(d.value)}</p> : null}
                {d.why ? <p className="text-xs text-ink-muted">{d.why}</p> : null}
                {d.step ? <p className="text-xs text-ink-muted">{text.onStep(d.step)}</p> : null}
                {d.status === "changed" && d.side && text.changedBy ? (
                  <p className="text-xs text-ink-muted" data-testid={`manual-decision-${d.id}-by`}>
                    {text.changedBy(d.by, d.at ?? null)}
                  </p>
                ) : d.by && d.status !== "never_discussed" ? (
                  <p className="text-xs text-ink-muted">{text.lookedAtBy(d.by)}</p>
                ) : null}
              </Row>
            ))}
          </ul>
        )}
      </Card>

      <Card title={text.decisionPoints} titleAbove testId="manual-points">
        {view.decisionPoints.length === 0 ? (
          <Empty>{text.nothingYet}</Empty>
        ) : (
          <ul>
            {view.decisionPoints.map((p) => (
              <Row
                key={`${p.stepId ?? "none"}:${p.what}`}
                ask={ask(p.what)}
                wrong={wrong({ section: "point", lineId: p.stepId ?? undefined, line: p.what })}
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-ink">{p.what}</span>
                  {p.notDiscussed ? (
                    <Badge tone="neutral">{text.status("never_discussed")}</Badge>
                  ) : null}
                </span>
                {p.who || p.byWhen ? (
                  <p className="text-xs text-ink-muted">
                    {[p.who ? text.who(p.who) : null, p.byWhen ? text.byWhen(p.byWhen) : null]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                ) : null}
              </Row>
            ))}
          </ul>
        )}
      </Card>

      <Card title={text.knownRisks} titleAbove testId="manual-risks">
        {view.knownRisks.length === 0 ? (
          <Empty>{text.nothingYet}</Empty>
        ) : (
          <ul>
            {view.knownRisks.map((r) => (
              <Row
                key={r.id}
                ask={ask(r.what)}
                wrong={wrong({ section: "risk", lineId: r.id, line: r.what })}
              >
                <span className="text-sm font-medium text-ink">{r.what}</span>
                {r.detail ? <p className="text-xs text-ink-muted">{r.detail}</p> : null}
              </Row>
            ))}
          </ul>
        )}
      </Card>

      {/* What we set up with the client: only when the agent has its setup answers (B4). */}
      {view.setup.length > 0 ? (
        <Card title={text.setup} titleAbove testId="manual-setup">
          <ul>
            {view.setup.map((s) => (
              <Row
                key={s.label}
                ask={ask(s.label)}
                wrong={wrong({ section: "setup", line: `${s.label}: ${s.answer ?? ""}` })}
              >
                <span className="text-sm font-medium text-ink">{s.label}</span>
                <p className={cx("text-xs", s.answer ? "text-ink" : "text-ink-muted")}>
                  {s.answer ?? text.notAnswered}
                </p>
              </Row>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card title={text.learned} titleAbove testId="manual-learned">
        {view.learned.length === 0 ? (
          <Empty>{text.learnedHidden ?? text.nothingYet}</Empty>
        ) : (
          <ul>
            {view.learned.map((n) => (
              <Row key={n.id} ask={ask(n.note)}>
                <span className="text-sm text-ink">{n.note}</span>
                <span className="text-xs text-ink-muted">{text.date(n.at)}</span>
              </Row>
            ))}
          </ul>
        )}
      </Card>

      <Card title={text.reads} titleAbove testId="manual-reads">
        <ul>
          {view.reads.map((r) => (
            <Row key={r}>
              <span className="text-sm text-ink">{r}</span>
            </Row>
          ))}
        </ul>
      </Card>
    </div>
  );
}
