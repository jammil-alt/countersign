// An agent's architecture and security (docs/agent-assurance-plan.md §5): the SOP's section 14 in
// the portal, and the back office's Security tab, which adds each check's evidence and issue. The
// view is core's `assuranceView`, made by code; its sentences are written by code in English, as
// the SOP's are, and its labels are in the six languages.

import type { AssuranceView as View } from "@countersign/core";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "../i18n/i18n";
import { Card, cx } from "../ui/primitives";
import { ArchitectureDiagram } from "./ArchitectureDiagram";

type Row = View["checks"][number];

const RESULT_CLASS: Record<Row["result"], string> = {
  verified: "assure-result assure-result--verified",
  in_review: "assure-result assure-result--review",
  not_checked: "assure-result assure-result--unchecked",
  not_applicable: "assure-result assure-result--na",
};

export function ResultTag({ result }: { result: Row["result"] }) {
  const { t } = useI18n();
  return (
    <span className={RESULT_CLASS[result]} data-result={result}>
      {t(`assurance.result.${result}`)}
    </span>
  );
}

function Table({
  testId,
  head,
  children,
}: {
  testId: string;
  head: string[];
  children: ReactNode;
}) {
  return (
    <Card>
      <div className="dt dt-ana overflow-x-auto">
        <table data-testid={testId}>
          <thead>
            <tr className="dt-cols">
              {head.map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
      </div>
    </Card>
  );
}

/** A value of the evidence, short: ids beyond five are counted, objects written compactly. */
function evidenceValue(v: unknown): string {
  const one = (x: unknown) =>
    typeof x === "object" && x !== null
      ? Object.entries(x)
          .map(([k, y]) => `${k} ${String(y)}`)
          .join(" ")
      : String(x);
  if (!Array.isArray(v)) return one(v);
  if (v.length === 0) return "none";
  const shown = v.slice(0, 5).map(one).join(", ");
  return v.length > 5 ? `${shown} and ${v.length - 5} more` : shown;
}

function evidenceWords(e: Record<string, unknown> | undefined): string {
  if (!e) return "";
  return Object.entries(e)
    .map(([k, v]) => `${k}: ${evidenceValue(v)}`)
    .join(" · ");
}

export function AssuranceBody({
  view,
  audience,
  issueHref,
}: {
  view: View;
  audience: "client" | "ops";
  /** The back office: where a check's issue opens. */
  issueHref?: ((issueId: string) => string) | undefined;
}) {
  const { t, fmt } = useI18n();
  const groups = (["checked", "inherited", "not_applicable"] as const).map((state) => ({
    state,
    rows: view.coverage.filter((c) => c.state === state),
  }));
  return (
    <div className="assure" data-testid="assurance">
      <p className="mb-3 max-w-3xl text-sm text-ink-muted">
        {t("assurance.lede", { agent: view.agent.name })}
      </p>
      <Card className="p-4">
        <ArchitectureDiagram
          arch={view.architecture}
          label={t("assurance.diagramLabel", { agent: view.agent.name })}
        />
      </Card>
      <p className="mt-2 text-xs text-ink-muted">{t("assurance.diagramKey")}</p>

      <div className="assure-states">
        {(["verified", "in_review", "not_checked", "not_applicable"] as const).map((r) => (
          <div key={r}>
            <ResultTag result={r} />
            <p className="mt-1 text-xs text-ink-muted">{t(`assurance.resultWhat.${r}`)}</p>
          </div>
        ))}
      </div>

      <div className="assure-stats">
        <Card className="p-3">
          <div className="text-xs text-ink-muted">{t("assurance.stat.checks")}</div>
          <div className="assure-stat">{view.counts.checks}</div>
        </Card>
        <Card className="p-3">
          <div className="text-xs text-ink-muted">{t("assurance.result.verified")}</div>
          <div className="assure-stat text-positive">{view.counts.verified}</div>
        </Card>
        <Card className="p-3">
          <div className="text-xs text-ink-muted">{t("assurance.result.in_review")}</div>
          <div className="assure-stat">{view.counts.inReview}</div>
        </Card>
        <Card className="p-3">
          <div className="text-xs text-ink-muted">{t("assurance.stat.lastChecked")}</div>
          <div className="assure-stat assure-stat--small">
            {view.lastChecked ? fmt.date(view.lastChecked) : t("assurance.stat.never")}
          </div>
        </Card>
      </div>

      <Table
        testId="assurance-checks"
        head={[
          "#",
          t("assurance.col.check"),
          t("assurance.col.how"),
          t("assurance.col.result"),
          audience === "ops" ? t("assurance.col.evidence") : t("assurance.col.found"),
          t("assurance.col.checked"),
        ]}
      >
        {view.checks.map((c) => (
          <tr key={c.id} data-check={c.id}>
            <td className="font-mono">{c.number}</td>
            <td>
              {c.name}
              <span className="block font-mono text-xs text-ink-muted">
                {c.controls.join(" · ")}
              </span>
              {c.soc2.length > 0 ? (
                <span className="assure-maps">SOC 2 {c.soc2.join(", ")}</span>
              ) : null}
              {c.hipaa.length > 0 ? (
                <span className="assure-maps">HIPAA {c.hipaa.join(", ")}</span>
              ) : null}
            </td>
            <td>
              <span className="assure-kind">{t(`assurance.kind.${c.kind}`)}</span>
            </td>
            <td>
              <ResultTag result={c.result} />
            </td>
            <td>
              {c.result === "in_review" && audience === "client"
                ? t("assurance.inReviewSince", { date: c.since ? fmt.date(c.since) : "–" })
                : c.found}
              {audience === "ops" && c.evidence && Object.keys(c.evidence).length > 0 ? (
                <span className="block font-mono text-xs text-ink-muted">
                  {evidenceWords(c.evidence)}
                </span>
              ) : null}
              {audience === "ops" && c.issueId && issueHref ? (
                <Link className="block text-xs" to={issueHref(c.issueId)}>
                  {t("assurance.openIssue")}
                </Link>
              ) : null}
            </td>
            <td className="whitespace-nowrap text-xs text-ink-muted">
              {c.checkedAt ? fmt.date(c.checkedAt) : "–"}
            </td>
          </tr>
        ))}
      </Table>
      <p className="mt-2 max-w-3xl text-xs text-ink-muted">{t("assurance.soc2Note")}</p>

      <h3 className="assure-h3">{t("assurance.coverage.title")}</h3>
      <p className="mb-3 text-sm text-ink-muted">{t("assurance.coverage.lede")}</p>
      <div className="assure-coverage" data-testid="assurance-coverage">
        {groups.map((g) => (
          <Card key={g.state} className="p-4">
            <h4 className="text-sm font-medium text-ink">
              {t(`assurance.state.${g.state}`)}{" "}
              <span className="text-ink-muted">{g.rows.length}</span>
            </h4>
            <ul className="mt-2 space-y-1 text-xs text-ink-muted">
              {g.rows.map((c) => (
                <li key={c.id}>
                  <span className="font-mono text-ink">{c.id}</span> {c.title}
                  {g.state === "not_applicable" && c.why ? `: ${c.why}` : null}
                  {g.state !== "not_applicable" && c.status !== "in_place" ? (
                    <span className={cx("assure-status", `assure-status--${c.status}`)}>
                      {" "}
                      {t(`assurance.status.${c.status}`)}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>

      <h3 className="assure-h3">{t("assurance.data.title")}</h3>
      <p className="mb-3 text-sm text-ink-muted">{t("assurance.data.lede")}</p>
      <Table
        testId="assurance-data"
        head={[
          t("assurance.col.data"),
          t("assurance.col.from"),
          t("assurance.col.keptWhere"),
          t("assurance.col.keptFor"),
          t("assurance.col.whoSees"),
        ]}
      >
        {view.data.map((d) => (
          <tr key={`${d.data}:${d.keptWhere}`}>
            <td>
              {d.data}
              {d.fields ? <span className="block text-xs text-ink-muted">{d.fields}</span> : null}
            </td>
            <td>{d.from}</td>
            <td>{d.keptWhere}</td>
            <td className={d.gap ? "font-medium" : undefined}>{d.keptFor}</td>
            <td>{d.whoSees}</td>
          </tr>
        ))}
      </Table>

      <h3 className="assure-h3">{t("assurance.ai.title")}</h3>
      {view.ai.length === 0 ? (
        <p className="text-sm text-ink-muted">{t("assurance.ai.none")}</p>
      ) : (
        <Table
          testId="assurance-ai"
          head={[
            t("assurance.col.use"),
            t("assurance.col.provider"),
            t("assurance.col.sent"),
            t("assurance.col.protection"),
            t("assurance.col.providerKeeps"),
          ]}
        >
          {view.ai.map((r) => (
            <tr key={`${r.use}:${r.model}`}>
              <td>{r.use}</td>
              <td>
                {r.provider}, {r.model}
              </td>
              <td>{r.sent}</td>
              <td>{r.protection}</td>
              <td>{r.providerKeeps}</td>
            </tr>
          ))}
        </Table>
      )}

      <h3 className="assure-h3">{t("assurance.access.title")}</h3>
      <Table
        testId="assurance-access"
        head={[
          t("assurance.col.tool"),
          t("assurance.col.signsIn"),
          t("assurance.col.credential"),
          t("assurance.col.agentMay"),
          t("assurance.col.whoChanges"),
        ]}
      >
        {view.access.map((r) => (
          <tr key={r.tool}>
            <td className={r.person ? "text-copper-ink" : undefined}>
              {r.tool}
              {r.detail ? <span className="block text-xs text-ink-muted">{r.detail}</span> : null}
            </td>
            <td>{r.signsIn}</td>
            <td>{r.credential}</td>
            <td>{r.agentMay}</td>
            <td>{r.whoChanges}</td>
          </tr>
        ))}
      </Table>
    </div>
  );
}
