// The agent's SOP as a person reads it (docs/sop-plan.md; owner, 2026-11-21): document control
// with its revision, then thirteen numbered sections, made by code on the server (core `sopView`)
// from how the agent is set up now. Nothing in it waits on anyone. Every name is a link or a filter
// inside it; Find narrows every section to what matches; it prints with its code, revision and
// revision date on every page. The labels are in the reader's language; what the SOP says stays in
// English as written, as the manual's does.

import type {
  SopControl,
  SopParty,
  SopPathLine,
  SopRevisionEntry,
  SopStepLine,
  SopView,
} from "@countersign/core";
import { Fragment, type ReactElement, type ReactNode, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "../i18n/i18n";
import { TextInput } from "../ui/forms";
import { Icon } from "../ui/icons";
import { Button, Card, cx } from "../ui/primitives";
import { SopIcon } from "./icons";

/** A line someone says is wrong: the manual's feedback route takes it (docs/builder-plan.md §7). */
export interface SopLine {
  section: "what" | "how" | "decision";
  lineId?: string;
  line: string;
}

type Filter = { kind: "party" | "system"; key: string; name: string } | null;

const has = (text: string | null | undefined, q: string) =>
  !!text && text.toLowerCase().includes(q);

/** Text with every match of the query marked. */
function Hl({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const parts: ReactNode[] = [];
  const lower = text.toLowerCase();
  let at = 0;
  let i = lower.indexOf(q, at);
  while (i >= 0) {
    if (i > at) parts.push(text.slice(at, i));
    parts.push(
      <mark key={i} className="sop-mark">
        {text.slice(i, i + q.length)}
      </mark>,
    );
    at = i + q.length;
    i = lower.indexOf(q, at);
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}

function PartyIcon({ party }: { party: SopParty }) {
  if (party.kind === "agent") return <SopIcon name="agent" className="text-ink" />;
  return (
    <Icon name={party.kind === "person" ? "lead" : "team"} size={14} className="text-copper" />
  );
}

/** A person (copper) or an agent (ink), with its icon; a filter on the procedure when clicked. */
function Party({
  party,
  onPick,
  q = "",
}: {
  party: SopParty;
  onPick?: ((p: SopParty) => void) | undefined;
  q?: string;
}) {
  const people = party.kind !== "agent";
  const cls = cx("sop-party", people ? "sop-party--person" : "sop-party--agent");
  const inner = (
    <>
      <PartyIcon party={party} />
      <Hl text={party.name} q={q} />
    </>
  );
  return onPick ? (
    <button type="button" className={cls} onClick={() => onPick(party)} data-testid="sop-party">
      {inner}
    </button>
  ) : (
    <span className={cls}>{inner}</span>
  );
}

function Section({
  id,
  n,
  title,
  lede,
  children,
  testId,
}: {
  id: string;
  n: number;
  title: string;
  lede?: string | undefined;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section id={id} className="sop-section" data-testid={testId}>
      <div className="sop-section__head">
        <span className="sop-section__n">{n}</span>
        <h2 className="type-heading text-ink">{title}</h2>
      </div>
      {lede ? <p className="mb-3 max-w-3xl text-sm text-ink-muted">{lede}</p> : null}
      {children}
    </section>
  );
}

export function SopDocument({
  view,
  askHref,
  wrong,
}: {
  view: SopView;
  /** "Ask about this": where Sloan opens with the line quoted; absent: none. */
  askHref?: ((line: string) => string) | undefined;
  /** "This is wrong" on a step or a decision: the form it opens; absent: none. */
  wrong?: ((line: SopLine, close: () => void) => ReactNode) | undefined;
}) {
  const { t, fmt } = useI18n();
  const [findText, setFind] = useState("");
  const [filter, setFilter] = useState<Filter>(null);
  const [open, setOpen] = useState<string | null>(null);
  const q = findText.trim().toLowerCase().length >= 2 ? findText.trim().toLowerCase() : "";

  const steps = view.procedure.filter((l): l is SopStepLine => l.line === "step");
  const byStep = useMemo(() => new Map(steps.map((s) => [s.number, s])), [steps]);
  const partyIndex = new Map(view.matrix.parties.map((p, i) => [p.key, i]));
  const inStep = (s: SopStepLine, f: NonNullable<Filter>) => {
    if (f.kind === "system") return s.systems.some((x) => x.id === f.key);
    if (s.who?.key === f.key) return true;
    const i = partyIndex.get(f.key);
    const row = view.matrix.rows.find((r) => r.step === s.number);
    return i !== undefined && !!row && row.cells[i] !== "";
  };
  const pickParty = (p: SopParty) => setFilter({ kind: "party", key: p.key, name: p.name });
  const pickSystem = (id: string, name: string) => setFilter({ kind: "system", key: id, name });

  const stepText = (s: SopStepLine) =>
    [
      s.number,
      s.name,
      s.purpose,
      s.kindWords,
      s.model,
      s.who?.name,
      ...(s.approval?.approvers.map((a) => a.party.name) ?? []),
      ...s.told.map((p) => p.name),
      ...s.systems.map((x) => x.name),
      ...s.data.map((x) => x.words),
      ...s.controls,
    ].join(" ");
  const showStep = (s: SopStepLine) =>
    (!filter || inStep(s, filter)) && (!q || has(stepText(s), q));

  const controlShown = (c: SopControl) =>
    !q || has(`${c.id} ${c.name} ${c.owner?.name ?? ""} ${c.evidence}`, q);
  const systems = view.systems.filter((s) => !q || has(`${s.id} ${s.name} ${s.account ?? ""}`, q));
  const data = view.data.filter(
    (d) => !q || has(`${d.id} ${d.record} ${d.livesIn} ${d.agentDoes}`, q),
  );
  const history = view.history.filter((r) => !q || has(revisionText(r), q));
  const decisions = view.decisions.filter(
    (d) => !q || has(`${d.what} ${d.value ?? ""} ${d.setBy}`, q),
  );
  const exceptions = view.exceptions.filter((e) => !q || has(e.words, q));
  const shownSteps = steps.filter(showStep);
  const matches = q
    ? shownSteps.length +
      view.controls.filter(controlShown).length +
      systems.length +
      data.length +
      history.length +
      decisions.length +
      exceptions.length +
      (has(view.purpose, q) ? 1 : 0)
    : 0;

  const ask = (line: string) =>
    askHref ? (
      <Link to={askHref(line)} className="ds-btn ds-btn--link text-xs" data-testid="sop-ask-line">
        {t("manual.ask")}
      </Link>
    ) : null;
  const wrongButton = (line: SopLine) => {
    if (!wrong) return null;
    const key = `${line.section}:${line.lineId ?? line.line}`;
    return (
      <button
        type="button"
        className="ds-btn ds-btn--link text-xs"
        aria-expanded={open === key}
        onClick={() => setOpen(open === key ? null : key)}
        data-testid="sop-wrong"
      >
        {t("manual.wrong")}
      </button>
    );
  };
  const wrongForm = (line: SopLine) => {
    const key = `${line.section}:${line.lineId ?? line.line}`;
    return wrong && open === key ? (
      <div className="mt-2">{wrong(line, () => setOpen(null))}</div>
    ) : null;
  };

  const levelWords = (verb: string, level: string | null) =>
    level === null
      ? "–"
      : level === "off"
        ? t("sop.level.off")
        : verb === "read"
          ? t("sop.level.on")
          : t(level === "auto" ? "sop.level.auto" : "sop.level.ask");

  const method = (s: SopStepLine) => {
    if (s.method === "person")
      return s.who ? <Party party={s.who} onPick={pickParty} q={q} /> : null;
    if (!s.method) return null;
    const ai = s.method === "ai" || s.method === "rules_then_ai";
    return (
      <span className={cx("sop-method", ai && "sop-method--ai")} data-testid="sop-method">
        {s.method !== "ai" ? <SopIcon name="rules" /> : null}
        {s.method === "rules" ? t("sop.method.rules") : null}
        {s.method === "rules_then_ai" ? `${t("sop.method.rulesThen")} ` : null}
        {ai ? <SopIcon name="ai" /> : null}
        {ai ? t("sop.method.ai") : null}
        {ai && s.model ? <span className="sop-method__model">{s.model}</span> : null}
      </span>
    );
  };

  const sep = <span className="sop-sep">·</span>;
  const stepFacts = (s: SopStepLine) => {
    const facts: ReactElement[] = [];
    if (s.approval?.level === "ask" && s.approval.approvers.length > 0) {
      facts.push(
        <span key="approves">
          {t("sop.approves")}{" "}
          {s.approval.approvers.map((a) => (
            <Fragment key={a.party.key}>
              <Party party={a.party} onPick={pickParty} q={q} />
              {a.condition ? <span> {a.condition} </span> : " "}
            </Fragment>
          ))}
          {s.approval.byWhen ? t("sop.within", { when: s.approval.byWhen }) : null}
          {s.approval.ifNoAnswer
            ? `; ${t("sop.ifNoAnswer", { what: s.approval.ifNoAnswer })}`
            : null}
        </span>,
      );
    }
    if (s.byWhen) facts.push(<span key="by">{t("sop.within", { when: s.byWhen })}</span>);
    for (const x of s.systems) {
      facts.push(
        <span key={`sys-${x.id}-${x.verb}`}>
          <button
            type="button"
            className="sop-system"
            onClick={() => pickSystem(x.id, x.name)}
            data-testid="sop-system"
          >
            <Hl text={x.name} q={q} />
          </button>{" "}
          <b className={cx("font-medium", x.level === "ask" ? "text-copper-ink" : "text-ink")}>
            {x.verb}: {levelWords(x.verb.toLowerCase(), x.level)}
          </b>
        </span>,
      );
    }
    for (const d of s.data) {
      facts.push(
        <a key={`data-${d.id}-${d.words}`} href={`#sop-${d.id}`}>
          <Hl text={d.words} q={q} />
        </a>,
      );
    }
    if (s.told.length > 0) {
      facts.push(
        <span key="told">
          {t("sop.told")}{" "}
          {s.told.map((p) => (
            <Party key={p.key} party={p} onPick={pickParty} q={q} />
          ))}
        </span>,
      );
    }
    if (s.controls.length > 0) {
      facts.push(
        <span key="controls">
          {t("sop.controls")}{" "}
          {s.controls.map((c, i) => (
            <Fragment key={c}>
              {i > 0 ? " " : null}
              <a href={`#sop-${c}`} className="font-mono">
                {c}
              </a>
            </Fragment>
          ))}
        </span>,
      );
    }
    if (s.approval?.level === "ask" && s.approval.ifRejected) {
      facts.push(<span key="rej">{t("sop.ifRejected", { what: s.approval.ifRejected })}</span>);
    }
    if (s.onError) facts.push(<span key="err">{t("sop.onError", { what: s.onError })}</span>);
    // Each fact carries its own key; its separator is keyed after it.
    return facts.flatMap((f, i) =>
      i === 0 ? [f] : [<Fragment key={`sep-${(f as ReactElement).key}`}>{sep}</Fragment>, f],
    );
  };

  const pathLine = (l: SopPathLine, i: number) => (
    <li key={`path-${i}`} className="sop-path" style={{ paddingLeft: `${1 + l.depth * 2}rem` }}>
      <b>{l.label === "if" ? t("sop.path.if") : t("sop.path.otherwise")}</b>{" "}
      {l.label === "otherwise" && l.empty ? t("sop.path.straightOn") : <Hl text={l.words} q={q} />}
    </li>
  );

  const rev = view.revision;
  const sections = [
    "control",
    "purpose",
    "scope",
    "roles",
    "start",
    "procedure",
    "controls",
    "systems",
    "data",
    "exceptions",
    "decisions",
    "measures",
    "references",
    "history",
  ] as const;

  return (
    <div className="sop" data-testid="sop">
      <div className="sop-toolbar" data-print="hide">
        <TextInput
          type="search"
          value={findText}
          onChange={(e) => setFind(e.target.value)}
          placeholder={t("sop.find")}
          aria-label={t("sop.find")}
          className="min-w-0 flex-1"
          data-testid="sop-find"
        />
        {askHref ? (
          <Link
            to={askHref(t("sop.askLine", { agent: view.agent.name }))}
            className="ds-btn ds-btn--secondary"
            data-testid="sop-ask"
          >
            {t("sop.ask")}
          </Link>
        ) : null}
        <Button variant="primary" onClick={() => window.print()} data-testid="sop-print">
          {t("sop.print")}
        </Button>
        {q || filter ? (
          <p className="w-full text-xs text-ink-muted" role="status" data-testid="sop-filter-note">
            {filter
              ? t(filter.kind === "party" ? "sop.filter.party" : "sop.filter.system", {
                  name: filter.name,
                })
              : matches > 0
                ? t("sop.find.count", { count: matches, text: findText.trim() })
                : t("sop.find.none", { text: findText.trim() })}{" "}
            <button
              type="button"
              className="ds-btn ds-btn--link text-xs"
              onClick={() => {
                setFilter(null);
                setFind("");
              }}
              data-testid="sop-clear"
            >
              {t("sop.showAll")}
            </button>
          </p>
        ) : null}
      </div>

      <div className="sop-layout">
        <nav className="sop-toc" aria-label={t("sop.contents")} data-print="hide">
          {sections.map((s, i) => (
            <a key={s} href={`#sop-sec-${s}`}>
              <span className="sop-toc__n">{i}</span>
              {t(`sop.sec.${s}`)}
            </a>
          ))}
        </nav>

        <article className="sop-doc">
          {/* 0. Document control */}
          <section id="sop-sec-control" className="sop-section" data-testid="sop-control">
            <Card pad>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="font-mono text-xs text-ink-muted" data-testid="sop-code">
                    {view.code}
                  </p>
                  <h2 className="type-heading text-ink">
                    {t("sop.title", { agent: view.agent.name })}
                  </h2>
                  <p className="text-xs text-ink-muted">
                    {t("sop.subtitle", { agent: view.agent.name })}
                  </p>
                </div>
                <p className="text-right text-xs text-ink-muted">
                  {view.client}
                  <br />
                  {t("sop.asOf", { date: fmt.time(view.asOf) })}
                </p>
              </div>
              <dl className="sop-kv">
                <div>
                  <dt>{t("sop.revision")}</dt>
                  <dd data-testid="sop-revision">{rev?.number ?? t("sop.notRecorded")}</dd>
                </div>
                <div>
                  <dt>{t("sop.revisionDate")}</dt>
                  <dd data-testid="sop-revision-date">{rev ? fmt.date(rev.at) : "–"}</dd>
                </div>
                <div>
                  <dt>{t("sop.stage")}</dt>
                  <dd>{view.stage.words}</dd>
                </div>
                <div>
                  <dt>{t("sop.area")}</dt>
                  <dd>{view.area.words}</dd>
                </div>
                <div>
                  <dt>{t("sop.accountable")}</dt>
                  <dd className="flex flex-wrap gap-1">
                    {view.accountable.length > 0
                      ? view.accountable.map((p) => (
                          <Party key={p.key} party={p} onPick={pickParty} />
                        ))
                      : "–"}
                  </dd>
                </div>
                <div>
                  <dt>{t("sop.areaOwner")}</dt>
                  <dd>
                    {view.owner ? <Party party={view.owner.party} onPick={pickParty} /> : "–"}
                  </dd>
                </div>
                <div>
                  <dt>{t("sop.lead")}</dt>
                  <dd>{view.lead ? <Party party={view.lead} onPick={pickParty} /> : "–"}</dd>
                </div>
                <div>
                  <dt>{t("sop.previous")}</dt>
                  <dd>
                    {view.previous ? (
                      <a href="#sop-sec-history">
                        {view.previous.number}, {fmt.date(view.previous.at)}
                      </a>
                    ) : (
                      "–"
                    )}
                  </dd>
                </div>
              </dl>
              {rev ? (
                <div className="sop-lastchange" data-testid="sop-last-change">
                  <span className="sop-label">{t("sop.whatChanged", { number: rev.number })}</span>
                  <ul className="mt-1 flex flex-col gap-0.5 text-sm text-ink">
                    {rev.changes.map((c) => (
                      <li key={`${c.ref ?? ""}:${c.words}`}>
                        {c.words}
                        {c.was ? (
                          <span className="text-ink-muted">; {t("sop.was", { value: c.was })}</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1 text-xs text-ink-muted">
                    {[rev.by, rev.where, fmt.date(rev.at)].filter(Boolean).join(", ")}
                    <span data-print="hide">
                      {" · "}
                      <a href="#sop-sec-history">{t("sop.allRevisions")}</a>
                    </span>
                  </p>
                </div>
              ) : null}
            </Card>
          </section>

          {!q || has(view.purpose, q) ? (
            <Section id="sop-sec-purpose" n={1} title={t("sop.sec.purpose")}>
              <p className="max-w-3xl text-sm text-ink">
                <Hl text={view.purpose || t("sop.noPurpose")} q={q} />
              </p>
              <p className="mt-1 flex gap-3" data-print="hide">
                {view.purpose ? ask(view.purpose) : null}
                {view.purpose ? wrongButton({ section: "what", line: view.purpose }) : null}
              </p>
              {view.purpose ? wrongForm({ section: "what", line: view.purpose }) : null}
            </Section>
          ) : null}

          {!q ? (
            <Section id="sop-sec-scope" n={2} title={t("sop.sec.scope")}>
              <div className="sop-three">
                <Card title={t("sop.covers")} pad>
                  <ul className="sop-list">
                    {view.scope.covers.map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                </Card>
                <Card title={t("sop.notCovered")} pad>
                  {view.scope.notCovered.length > 0 ? (
                    <ul className="sop-list">
                      {view.scope.notCovered.map((c) => (
                        <li key={c}>{c}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-ink-muted">{t("sop.nothingLeftOut")}</p>
                  )}
                </Card>
                <Card title={t("sop.never")} pad>
                  <ul className="sop-list">
                    {view.scope.never.map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                </Card>
              </div>
            </Section>
          ) : null}

          {!q ? (
            <Section id="sop-sec-roles" n={3} title={t("sop.sec.roles")} lede={t("sop.roles.lede")}>
              <div className="sop-two mb-5">
                {view.roles.map((r) => (
                  <Card key={`${r.role}-${r.party.key}`} pad>
                    <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-ink">
                      {r.role} <Party party={r.party} onPick={pickParty} />
                    </h3>
                    <p className="mt-1 text-xs text-ink-muted">{r.words}</p>
                  </Card>
                ))}
              </div>
              {view.matrix.rows.length > 0 ? (
                <Card
                  titleAbove
                  title={t("sop.whoElse")}
                  meta={t("sop.whoElse.hint", { agent: view.agent.name })}
                >
                  <div className="dt dt-ana overflow-x-auto">
                    <table data-testid="sop-matrix">
                      <thead>
                        <tr className="dt-cols">
                          <th>{t("sop.col.step")}</th>
                          {view.matrix.parties.map((p) => (
                            <th key={p.key} className="text-center">
                              <span className="inline-flex items-center gap-1">
                                <PartyIcon party={p} />
                                {p.name}
                              </span>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {view.matrix.rows.map((r) => (
                          <tr key={r.step}>
                            <td>
                              <a href={`#sop-step-${byStep.get(r.step)?.id ?? r.step}`}>
                                {r.step} {r.name}
                              </a>
                            </td>
                            {r.cells.map((c, i) => (
                              <td key={view.matrix.parties[i]?.key ?? i} className="text-center">
                                {c ? (
                                  <span className={cx("sop-cell", `sop-cell--${c}`)}>
                                    {r.notes[i] ?? t(`sop.cell.${c}`)}
                                  </span>
                                ) : null}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              ) : null}
            </Section>
          ) : null}

          {!q ? (
            <Section id="sop-sec-start" n={4} title={t("sop.sec.start")}>
              <ul className="sop-list text-sm text-ink">
                {view.start.triggers.map((tr) => (
                  <li key={tr}>{tr}</li>
                ))}
                {view.start.runByHand ? <li>{view.start.runByHand}</li> : null}
                {view.start.hours ? <li>{t("sop.hours", { hours: view.start.hours })}</li> : null}
              </ul>
            </Section>
          ) : null}

          <Section
            id="sop-sec-procedure"
            n={5}
            title={t("sop.sec.procedure")}
            testId="sop-procedure"
          >
            <div className="sop-legend">
              <span>
                <Icon name="lead" size={14} className="text-copper" />
                {t("sop.legend.person")}
              </span>
              <span>
                <SopIcon name="agent" />
                {t("sop.legend.agent")}
              </span>
              <span>
                <SopIcon name="rules" />
                {t("sop.legend.rules")}
              </span>
              <span>
                <SopIcon name="ai" />
                {t("sop.legend.ai")}
              </span>
            </div>
            <Card>
              <p className="sop-proc-sum" data-testid="sop-summary">
                {t("sop.summary.lead", { agent: view.agent.name })}{" "}
                {t("sop.summary.counts", {
                  steps: String(view.summary.steps),
                  rules: String(view.summary.rules),
                  ai: String(view.summary.ai),
                  mixed: String(view.summary.rulesThenAi),
                  person: String(view.summary.person),
                })}
                {view.summary.writesByRules ? ` ${t("sop.summary.writes")}` : ""}
                {view.owner ? (
                  <>
                    {" "}
                    {t("sop.summary.owner", { owner: view.owner.party.name })}
                    {` (${t("sop.method.ai")}${view.owner.model ? `: ${view.owner.model}` : ""}).`}
                  </>
                ) : null}
              </p>
              <ol className="sop-steps">
                {view.procedure.map((l, i) => {
                  if (l.line === "path") return filter || q ? null : pathLine(l, i);
                  if (!showStep(l)) return null;
                  const line: SopLine = {
                    section: "how",
                    lineId: l.id,
                    line: `${l.number}. ${l.name}`,
                  };
                  return (
                    <li
                      key={l.id}
                      id={`sop-step-${l.id}`}
                      className="sop-step"
                      style={{ paddingLeft: `${1 + l.depth * 2}rem` }}
                      data-testid="sop-step"
                    >
                      <span className="sop-step__n">{l.number}</span>
                      <div className="min-w-0">
                        <div className="sop-step__head">
                          <span className="sop-step__name">
                            <Hl text={l.name} q={q} />
                          </span>
                          {method(l)}
                          {l.method !== "person" && l.who ? (
                            <Party party={l.who} onPick={pickParty} q={q} />
                          ) : null}
                        </div>
                        <p className="sop-step__why" data-testid="sop-purpose">
                          <Hl text={l.purpose} q={q} />
                        </p>
                        <div className="sop-step__facts">
                          {stepFacts(l)}
                          <span className="sop-step__act" data-print="hide">
                            {ask(line.line)}
                            {wrongButton(line)}
                          </span>
                        </div>
                        {wrongForm(line)}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </Card>
          </Section>

          <Section
            id="sop-sec-controls"
            n={6}
            title={t("sop.sec.controls")}
            lede={t("sop.controls.lede")}
          >
            <Card>
              <div className="dt dt-ana overflow-x-auto">
                <table data-testid="sop-controls">
                  <thead>
                    <tr className="dt-cols">
                      <th>#</th>
                      <th>{t("sop.col.control")}</th>
                      <th>{t("sop.col.kind")}</th>
                      <th>{t("sop.col.how")}</th>
                      <th>{t("sop.col.steps")}</th>
                      <th>{t("sop.col.owner")}</th>
                      <th>{t("sop.col.evidence")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.controls.filter(controlShown).map((c) => (
                      <tr key={c.key} id={`sop-${c.id}`}>
                        <td className="font-mono">{c.id}</td>
                        <td>
                          <Hl text={c.name} q={q} />
                        </td>
                        <td>{t(`sop.kind.${c.kind}`)}</td>
                        <td>
                          {t(`sop.how.${c.how}`)}
                          {c.model ? <span className="text-ink-muted"> ({c.model})</span> : null}
                        </td>
                        <td>
                          {c.allSteps ? (
                            t("sop.allSteps")
                          ) : (
                            <StepLinks numbers={c.steps} byStep={byStep} />
                          )}
                        </td>
                        <td>{c.owner ? <Party party={c.owner} onPick={pickParty} /> : "–"}</td>
                        <td>{c.evidence}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </Section>

          {systems.length > 0 || !q ? (
            <Section
              id="sop-sec-systems"
              n={7}
              title={t("sop.sec.systems")}
              lede={t("sop.systems.lede")}
            >
              {systems.length === 0 ? (
                <p className="text-sm text-ink-muted">{t("sop.noSystems")}</p>
              ) : (
                <Card>
                  <div className="dt dt-ana overflow-x-auto">
                    <table data-testid="sop-systems">
                      <thead>
                        <tr className="dt-cols">
                          <th>#</th>
                          <th>{t("sop.col.system")}</th>
                          <th>{t("sop.col.read")}</th>
                          <th>{t("sop.col.create")}</th>
                          <th>{t("sop.col.update")}</th>
                          <th>{t("sop.col.delete")}</th>
                          <th>{t("sop.col.steps")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {systems.map((s) => (
                          <tr key={s.key} id={`sop-${s.id}`}>
                            <td className="font-mono">{s.id}</td>
                            <td>
                              <button
                                type="button"
                                className="sop-system"
                                onClick={() => pickSystem(s.id, s.name)}
                              >
                                <Hl text={s.name} q={q} />
                              </button>
                              <span className="block text-xs text-ink-muted">
                                {[
                                  s.account,
                                  s.connected
                                    ? s.connectedBy
                                      ? t("sop.connectedBy", { name: s.connectedBy })
                                      : null
                                    : t("sop.notConnected"),
                                ]
                                  .filter(Boolean)
                                  .join(". ")}
                              </span>
                            </td>
                            {(["read", "create", "update", "delete"] as const).map((verb) => (
                              <td
                                key={verb}
                                className={cx(
                                  s[verb] === "ask" && "text-copper-ink",
                                  (s[verb] === "off" || s[verb] === null) && "text-ink-faint",
                                )}
                              >
                                {levelWords(verb, s[verb])}
                              </td>
                            ))}
                            <td>
                              <StepLinks numbers={s.steps} byStep={byStep} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              )}
            </Section>
          ) : null}

          {data.length > 0 || !q ? (
            <Section id="sop-sec-data" n={8} title={t("sop.sec.data")} lede={t("sop.data.lede")}>
              <Card>
                <div className="dt dt-ana overflow-x-auto">
                  <table data-testid="sop-data">
                    <thead>
                      <tr className="dt-cols">
                        <th>#</th>
                        <th>{t("sop.col.record")}</th>
                        <th>{t("sop.col.livesIn")}</th>
                        <th>{t("sop.col.agentDoes")}</th>
                        <th>{t("sop.col.steps")}</th>
                        <th>{t("sop.col.readByAi")}</th>
                        <th>{t("sop.col.kept")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.map((d) => (
                        <tr key={d.key} id={`sop-${d.id}`}>
                          <td className="font-mono">{d.id}</td>
                          <td>
                            <Hl text={d.record} q={q} />
                          </td>
                          <td>{d.livesIn}</td>
                          <td>{d.agentDoes}</td>
                          <td>
                            <StepLinks numbers={d.steps} byStep={byStep} />
                          </td>
                          <td>{d.readByAi ?? t("sop.no")}</td>
                          <td>{d.kept}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
              <p className="mt-3 max-w-3xl text-xs text-ink-muted">{t("sop.data.ai")}</p>
              {view.learned ? (
                <Card titleAbove title={t("sop.learned")} className="mt-4">
                  {view.learned.length > 0 ? (
                    <ul className="sop-rows">
                      {view.learned.map((n) => (
                        <li key={n.id}>
                          {n.note}
                          <span className="text-xs text-ink-muted"> · {fmt.date(n.at)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="ui-card__body text-sm text-ink-muted">{t("manual.nothingYet")}</p>
                  )}
                </Card>
              ) : null}
            </Section>
          ) : null}

          {exceptions.length > 0 ? (
            <Section id="sop-sec-exceptions" n={9} title={t("sop.sec.exceptions")}>
              <ul className="sop-list text-sm text-ink">
                {exceptions.map((e) => (
                  <li key={e.id}>
                    <Hl text={e.words} q={q} />
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          {!q || decisions.length > 0 ? (
            <Section id="sop-sec-decisions" n={10} title={t("sop.sec.decisions")}>
              {decisions.length > 0 ? (
                <Card>
                  <div className="dt dt-ana overflow-x-auto">
                    <table data-testid="sop-decisions">
                      <thead>
                        <tr className="dt-cols">
                          <th>#</th>
                          <th>{t("sop.col.decision")}</th>
                          <th>{t("sop.col.kind")}</th>
                          <th>{t("sop.col.setBy")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {decisions.map((d, i) => {
                          const line: SopLine = { section: "decision", lineId: d.id, line: d.what };
                          return (
                            <tr key={d.id}>
                              <td className="font-mono">10.{i + 1}</td>
                              <td>
                                <Hl text={d.value ? `${d.what}: ${d.value}` : d.what} q={q} />
                                {d.step ? (
                                  <span className="block text-xs text-ink-muted">
                                    {t("sop.onStep", { step: d.step })}
                                  </span>
                                ) : null}
                                <span className="flex gap-3" data-print="hide">
                                  {ask(d.what)}
                                  {wrongButton(line)}
                                </span>
                                {wrongForm(line)}
                              </td>
                              <td>{t(`manual.kind.${d.kind}`)}</td>
                              <td>
                                {d.setBy === "Us"
                                  ? t("sop.us")
                                  : d.setBy === "Confirmed with you"
                                    ? t("sop.confirmedWithYou")
                                    : d.setBy}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </Card>
              ) : (
                <p className="text-sm text-ink-muted">{t("sop.noDecisions")}</p>
              )}
              {view.settings.length > 0 && !q ? (
                <Card titleAbove title={t("sop.settings")} className="mt-4">
                  <ul className="sop-rows">
                    {view.settings.map((s) => (
                      <li key={s.label}>
                        <b className="font-medium">{s.label}:</b> {s.value}
                        {s.limits ? <span className="text-ink-muted"> ({s.limits})</span> : null}
                        {s.changedBy ? (
                          <span className="text-xs text-ink-muted"> · {s.changedBy}</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </Card>
              ) : null}
              {view.setup.length > 0 && !q ? (
                <Card titleAbove title={t("sop.setup")} className="mt-4">
                  <ul className="sop-rows">
                    {view.setup.map((s) => (
                      <li key={s.label}>
                        <b className="font-medium">{s.label}:</b> {s.answer}
                      </li>
                    ))}
                  </ul>
                </Card>
              ) : null}
            </Section>
          ) : null}

          {!q && view.measures.length > 0 ? (
            <Section id="sop-sec-measures" n={11} title={t("sop.sec.measures")}>
              <div className="sop-three">
                {view.measures.map((m) => (
                  <Card key={m.label} pad>
                    <p className="text-xs text-ink-muted">{m.label}</p>
                    <p className="type-heading text-ink">{m.value}</p>
                  </Card>
                ))}
              </div>
            </Section>
          ) : null}

          {!q ? (
            <Section id="sop-sec-references" n={12} title={t("sop.sec.references")}>
              <div className="sop-three">
                <RefCard title={t("sop.follows")} items={view.references.follows} />
                {view.references.handsOverTo.length > 0 ? (
                  <RefCard title={t("sop.handsOverTo")} items={view.references.handsOverTo} />
                ) : null}
                {view.references.takesOverFrom.length > 0 ? (
                  <RefCard title={t("sop.takesOverFrom")} items={view.references.takesOverFrom} />
                ) : null}
                {view.references.knowledge.length > 0 ? (
                  <RefCard title={t("sop.knowledge")} items={view.references.knowledge} />
                ) : null}
              </div>
            </Section>
          ) : null}

          {history.length > 0 || !q ? (
            <Section
              id="sop-sec-history"
              n={13}
              title={t("sop.sec.history")}
              lede={t("sop.history.lede", { agent: view.agent.name })}
            >
              <Card>
                <div className="dt dt-ana overflow-x-auto">
                  <table data-testid="sop-history">
                    <thead>
                      <tr className="dt-cols">
                        <th>{t("sop.col.revision")}</th>
                        <th>{t("sop.col.date")}</th>
                        <th>{t("sop.col.changes")}</th>
                        <th>{t("sop.col.by")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.map((r) => (
                        <tr key={r.number}>
                          <td className="font-mono">{r.number}</td>
                          <td className="whitespace-nowrap">{fmt.date(r.at)}</td>
                          <td>
                            <ul className="sop-list">
                              {r.changes.map((c) => (
                                <li key={`${c.ref ?? ""}:${c.words}`}>
                                  <Hl text={c.words} q={q} />
                                  {c.was ? (
                                    <span className="text-ink-muted">
                                      ; {t("sop.was", { value: c.was })}
                                    </span>
                                  ) : null}
                                </li>
                              ))}
                            </ul>
                          </td>
                          <td>
                            {r.by ?? r.where}
                            {r.by ? (
                              <span className="block text-xs text-ink-muted">{r.where}</span>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            </Section>
          ) : null}

          <p className="sop-print-footer" aria-hidden>
            {t("sop.printFooter", {
              code: view.code,
              agent: view.agent.name,
              number: rev?.number ?? "–",
              date: rev ? fmt.date(rev.at) : "–",
            })}
          </p>
        </article>
      </div>
    </div>
  );
}

function revisionText(r: SopRevisionEntry): string {
  return [r.number, r.by ?? "", r.where, ...r.changes.map((c) => `${c.words} ${c.was ?? ""}`)].join(
    " ",
  );
}

function StepLinks({
  numbers,
  byStep,
}: {
  numbers: readonly string[];
  byStep: Map<string, SopStepLine>;
}) {
  return (
    <>
      {numbers.map((n, i) => (
        <Fragment key={n}>
          {i > 0 ? ", " : null}
          <a href={`#sop-step-${byStep.get(n)?.id ?? n}`}>{n}</a>
        </Fragment>
      ))}
    </>
  );
}

function RefCard({ title, items }: { title: string; items: readonly string[] }) {
  return (
    <Card title={title} pad>
      <ul className="sop-list text-sm">
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
    </Card>
  );
}
