// docs/plan.md §1.212 (round 4, plan 2): the scorecard, per template workflow and version. Two
// tables: the golden datasets as CI measured them on replay (every pull request that changes a
// skill or a template must keep them exact), and each version's latest suite run, shared or a
// client's (cases saved from approved and corrected changes). Loaded on its own, only when opened.
import { evalsRoutes, type GoldenScorecardRow, type ScorecardRow } from "@countersign/core";
import { Link } from "react-router-dom";
import { useApi } from "../../api/useApi";
import { Loaded, Page } from "../../ui/page";
import { cx, EmptyState, PageHeader } from "../../ui/primitives";
import { TableCard } from "../screens/business";

const pct = (n: number | null) => (n === null ? "—" : `${Math.round(n * 1000) / 10}%`);
/** §1.211: "9 of 10 · 1 disagreed", or a dash when the verifier looked at nothing. */
const verified = (
  rate: number | null,
  v: { agreed: number; disagreed: number; cannotVerify: number },
) => {
  const looked = v.agreed + v.disagreed + v.cannotVerify;
  if (rate === null || looked === 0) return "—";
  const off = [
    v.disagreed > 0 ? `${v.disagreed} disagreed` : null,
    v.cannotVerify > 0 ? `${v.cannotVerify} couldn't check` : null,
  ].filter(Boolean);
  return [`${pct(rate)} of ${looked}`, ...off].join(" · ");
};
const usd = (s: string) => `$${Number(s).toFixed(4)}`;
const time = (n: number | null) =>
  n === null ? "—" : n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(1)} s`;

function Golden({ rows }: { rows: GoldenScorecardRow[] }) {
  return (
    <TableCard
      title="Golden datasets"
      meta="Replayed in CI on every change"
      testId="scorecard-golden"
    >
      <table>
        <thead>
          <tr className="dt-cols">
            <th>Template</th>
            <th>Workflow</th>
            <th className="text-right">Cases</th>
            <th className="text-right">Exact writes</th>
            <th className="text-right">Verifier agrees</th>
            <th className="text-right">Cost per case</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.template}/${r.workflow}`} data-testid={`scorecard-golden-${r.template}`}>
              <td className="reference text-sm">{r.template}</td>
              <td className="reference text-sm">{r.workflow}</td>
              <td className="n">{r.cases}</td>
              <td className={cx("n", r.exactRate < 1 && "text-risk")}>{pct(r.exactRate)}</td>
              <td className="n">{verified(r.verifierAgreement, r.verification)}</td>
              <td className="n">{usd(r.costPerCase)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableCard>
  );
}

function Versions({ rows }: { rows: ScorecardRow[] }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No suite runs yet"
        line="Run a template's tests from its page, or save an approved change in Escalations as a test case."
        testId="scorecard-empty"
      />
    );
  }
  return (
    <TableCard title="By version" meta="The latest suite run of each" testId="scorecard-versions">
      <table>
        <thead>
          <tr className="dt-cols">
            <th>Template</th>
            <th>Version</th>
            <th>Workflow</th>
            <th>Cases from</th>
            <th className="text-right">Passed</th>
            <th className="text-right">Exact writes</th>
            <th className="text-right">Verifier agrees</th>
            <th className="text-right">Cost per case</th>
            <th className="text-right">Run time</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.suiteRunId}/${r.workflow}`} data-testid={`scorecard-row-${r.suiteRunId}`}>
              <td>
                <Link
                  to={`/ops/templates/${r.templateSlug}`}
                  className="font-medium text-ink hover:underline"
                >
                  {r.templateName}
                </Link>
              </td>
              <td className="reference text-sm">{r.version === null ? "—" : `v${r.version}`}</td>
              <td className="reference text-sm">{r.workflow}</td>
              <td className="text-sm">{r.clientName ?? "Shared cases"}</td>
              <td className={cx("n", r.passed < r.cases && "text-risk")}>
                {r.passed} of {r.cases}
              </td>
              <td className={cx("n", r.exactRate !== null && r.exactRate < 1 && "text-risk")}>
                {r.writeCases === 0 ? "—" : `${pct(r.exactRate)} of ${r.writeCases}`}
              </td>
              <td className="n">{verified(r.verifierAgreement, r.verification)}</td>
              <td className="n">{usd(r.costPerCase)}</td>
              <td className="n">{time(r.msMedian)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableCard>
  );
}

export default function ScorecardScreen() {
  const state = useApi(evalsRoutes.opsScorecard);
  return (
    <Page testId="scorecard">
      <PageHeader
        title="Scorecard"
        subtitle="Whether a change to a skill, prompt, model or template made a workflow better or worse, before a client sees it."
      />
      <Loaded state={state}>
        {(data) => (
          <div className="flex flex-col gap-4">
            <Golden rows={data.golden} />
            <Versions rows={data.rows} />
          </div>
        )}
      </Loaded>
    </Page>
  );
}
