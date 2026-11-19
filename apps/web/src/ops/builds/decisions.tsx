// Decisions on a build (docs/builder-plan.md §4): every decision the Builder made to get the normal
// case running, beside the issues and known risks. Each says what was decided, why, its starting
// value and its kind; a high-risk one nobody has looked at says "Check" (it holds the client test).
// The operator marks one discussed or confirmed, or asks the Builder about it in the conversation.

import {
  type BuildDetail,
  DECISION_CATEGORY_WORDS,
  DECISION_KIND_WORDS,
  DECISION_OPERATOR_STATUSES,
  DECISION_STATUS_WORDS,
  type DecisionStatus,
  decisionUnreviewed,
} from "@countersign/core";
import type { CallOptions } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { Select } from "../../ui/forms";
import { Badge, Card, cx, Tag, type Tone } from "../../ui/primitives";
import { plural } from "./words";

type Status = (typeof DECISION_OPERATOR_STATUSES)[number];

const STATUS_TONE: Record<DecisionStatus, Tone> = {
  never_discussed: "neutral",
  discussed: "accent",
  confirmed: "positive",
  changed: "person",
};

export function DecisionsCard({
  detail,
  focus,
  onTalk,
  busy,
  act,
}: {
  detail: BuildDetail;
  /** The issue the conversation is on (`decision:<id>` for a decision). */
  focus: string | null;
  /** Puts the conversation on a decision. */
  onTalk?: ((key: string) => void) | undefined;
  busy: boolean;
  act: (
    route: typeof apiRoutes.opsBuildDecisionStatus,
    opts: CallOptions<typeof apiRoutes.opsBuildDecisionStatus>,
  ) => Promise<boolean>;
}) {
  const id = detail.build.id;
  const decisions = detail.build.fitgap.decisions;
  const editable = detail.build.status === "open";
  const high = decisions.filter((d) => d.risk === "high").length;
  const toCheck = decisions.filter(decisionUnreviewed).length;
  return (
    <Card
      testId="build-decisions"
      title="Decisions"
      meta={
        <span className="flex flex-wrap items-center gap-1.5" data-testid="build-decisions-meta">
          <Badge tone="neutral">{plural(decisions.length, "decision")}</Badge>
          {high > 0 ? <Badge tone="neutral">{high} high risk</Badge> : null}
          {toCheck > 0 ? <Badge tone="warning">{toCheck} to check</Badge> : null}
        </span>
      }
    >
      {decisions.length === 0 ? (
        <p className="px-6 py-5 text-sm text-ink-muted">
          No decisions yet. The Builder writes down each one it makes from the fit-gap on.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface-subtle text-left text-xs text-ink-muted">
                <th className="px-4 py-2.5 font-medium">Decision</th>
                <th className="px-4 py-2.5 font-medium">Kind</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {decisions.map((d) => {
                const key = `decision:${d.id}`;
                const check = decisionUnreviewed(d);
                return (
                  <tr
                    key={d.id}
                    className={cx(
                      "border-b border-line align-top last:border-b-0",
                      focus === key && "bg-slate-tint",
                    )}
                    data-testid={`build-decision-${d.id}`}
                  >
                    <td className="px-4 py-3">
                      <div className="flex flex-col gap-1">
                        <span className="flex flex-wrap items-center gap-2">
                          {check ? (
                            <Badge tone="warning" testId={`build-decision-${d.id}-check`}>
                              Check
                            </Badge>
                          ) : d.risk === "high" ? (
                            <Tag>High risk</Tag>
                          ) : null}
                          <span className="font-medium text-ink">{d.what}</span>
                        </span>
                        {d.value ? (
                          <p className="text-xs text-ink">
                            <span className="text-ink-muted">Starts at: </span>
                            {d.value}
                          </p>
                        ) : null}
                        {d.why ? <p className="text-xs text-ink-muted">{d.why}</p> : null}
                        {d.risk === "high" && d.category ? (
                          <p className="text-xs text-ink-muted">
                            High risk: {DECISION_CATEGORY_WORDS[d.category].toLowerCase()}
                          </p>
                        ) : null}
                        {onTalk ? (
                          <span className="text-xs">
                            <button
                              type="button"
                              className="ds-btn ds-btn--link text-xs"
                              aria-pressed={focus === key}
                              onClick={() => onTalk(key)}
                              data-testid={`build-decision-${d.id}-ask`}
                            >
                              {focus === key ? "Talking about it" : "Ask about it"}
                            </button>
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Tag tone={d.kind === "decision_point" ? "person" : "neutral"}>
                        {DECISION_KIND_WORDS[d.kind]}
                      </Tag>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col gap-1">
                        {editable ? (
                          <Select
                            aria-label={`Status: ${d.what}`}
                            value={d.status}
                            disabled={busy}
                            data-testid={`build-decision-${d.id}-status`}
                            onChange={(e) =>
                              void act(apiRoutes.opsBuildDecisionStatus, {
                                params: { id, decisionId: d.id },
                                body: { status: e.target.value as Status },
                              })
                            }
                          >
                            {/* A change after a look is the Builder's: shown, never picked. */}
                            {d.status === "changed" ? (
                              <option value="changed" disabled>
                                {DECISION_STATUS_WORDS.changed}
                              </option>
                            ) : null}
                            {DECISION_OPERATOR_STATUSES.map((s) => (
                              <option key={s} value={s}>
                                {DECISION_STATUS_WORDS[s]}
                              </option>
                            ))}
                          </Select>
                        ) : (
                          <Badge tone={STATUS_TONE[d.status]}>
                            {DECISION_STATUS_WORDS[d.status]}
                          </Badge>
                        )}
                        {d.by && d.status !== "never_discussed" ? (
                          <span className="text-xs text-ink-muted">By {d.by}</span>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
