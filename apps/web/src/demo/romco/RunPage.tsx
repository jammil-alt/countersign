// One run of the UCC filings review, R-1042 (October's file), as the portal's run page draws it: its
// steps on the left (the real `StepList`), the open step's output on the right. Each output is what
// that step made: the raw file, the records, what verification removed, the matches, the
// territories, the forms, the answers, the analysis and the Excel report.
import { type ReactNode, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { KpiStrip, ProgressBar, StatTile } from "../../ui/figures";
import { Badge, buttonClass, cx, Tag } from "../../ui/primitives";
import { StatusChip } from "../../ui/status";
import type { StepItem } from "../../ui/steps";
import { runChip } from "./AgentPage";
import {
  BY_REP,
  FILE,
  FILINGS,
  type Filing,
  GROUP_WORDS,
  type Group,
  JSON_SAMPLE,
  RAW,
  REMOVED,
  REMOVED_SAMPLE,
  THEMES,
  TOTALS,
} from "./filings";
import { REPS, RUN_ID, repByKey, UCC_ID } from "./people";
import { Facts, How, NextLink, RunFrame } from "./RunFrame";
import { AGENT, RUN, useDemo } from "./state";
import { Workbook } from "./Workbook";

interface RunStep {
  key: string;
  title: string;
  sop: string;
  time: string;
  detail: string;
}

const STEPS: RunStep[] = [
  {
    key: "receive",
    sop: "1",
    title: "Receive the UCC file",
    time: "8:02",
    detail: `${FILE.name} · ${FILE.rows} rows`,
  },
  {
    key: "records",
    sop: "2",
    title: "Turn the file into records",
    time: "8:02",
    detail: "412 records · 0 unreadable",
  },
  {
    key: "verify",
    sop: "3",
    title: "Verify and remove what doesn't apply",
    time: "8:04",
    detail: "138 kept · 274 removed · 4 marked",
  },
  {
    key: "match",
    sop: "4",
    title: "Match each filing",
    time: "8:09",
    detail: "41 on a deal · 52 existing · 45 new",
  },
  {
    key: "territory",
    sop: "5",
    title: "Assign a sales manager by ZIP code",
    time: "8:10",
    detail: "6 sales managers · 2 by county",
  },
  { key: "forms", sop: "6", title: "Build the review forms", time: "8:11", detail: "6 forms" },
  { key: "send", sop: "7", title: "Email the forms", time: "", detail: "" },
  { key: "answers", sop: "8", title: "Sales managers complete their forms", time: "", detail: "" },
  { key: "analyse", sop: "9", title: "Analyse the answers", time: "", detail: "" },
  { key: "report", sop: "10", title: "Build the dashboard and Excel report", time: "", detail: "" },
  { key: "email", sop: "11", title: "Email the report for review", time: "", detail: "" },
];

type S = ReturnType<typeof useDemo>["state"];

function stepState(key: string, s: S): StepItem["state"] {
  const done = ["receive", "records", "verify", "match", "territory", "forms"];
  if (done.includes(key)) return "done";
  if (key === "send") return s.formsSent ? "done" : "waiting";
  if (key === "answers") return s.marcusDone ? "done" : s.formsSent ? "person" : "todo";
  if (key === "analyse" || key === "report") return s.marcusDone ? "done" : "todo";
  if (key === "email") return s.reportSent ? "done" : s.marcusDone ? "waiting" : "todo";
  return "todo";
}

function stepLine(key: string, s: S): { time: string; detail: string } {
  switch (key) {
    case "send":
      return s.formsSent
        ? { time: "8:47", detail: "6 emails sent · signed by Dana Whitfield" }
        : { time: "8:11", detail: "Waiting on Dana Whitfield to sign" };
    case "answers":
      return s.marcusDone
        ? { time: "Nov 7", detail: "6 of 6 back · 3 filings moved" }
        : s.formsSent
          ? { time: "Nov 6", detail: "5 of 6 back · Marcus Bell due Mon Nov 10" }
          : { time: "next", detail: "" };
    case "analyse":
      return s.marcusDone
        ? { time: "Nov 7", detail: "5 themes · each with its filings" }
        : { time: "", detail: "" };
    case "report":
      return s.marcusDone
        ? { time: "Nov 7", detail: "Dashboard updated · workbook written" }
        : { time: "", detail: "" };
    case "email":
      return s.reportSent
        ? { time: "Nov 7", detail: "Sent to Dana Whitfield and 3 regional managers" }
        : s.marcusDone
          ? { time: "Nov 7", detail: "Waiting on Dana Whitfield to sign" }
          : { time: "", detail: "" };
    default:
      return { time: "", detail: "" };
  }
}

export function RunPage() {
  const { step = "receive" } = useParams();
  const { state } = useDemo();
  return (
    <RunFrame
      agent={{ id: UCC_ID, name: "UCC filings review" }}
      runId={RUN_ID}
      title="October 2026 UCC file"
      started={`started Mon Nov 3, 8:02 AM from an email to ${FILE.to}`}
      chip={runChip(state)}
      steps={STEPS.map((s) => {
        const live = stepLine(s.key, state);
        return {
          key: s.key,
          sop: s.sop,
          title: s.title,
          time: s.time || live.time || "",
          detail: s.detail || live.detail,
          state: stepState(s.key, state),
          anchor: sopAnchor(s.key),
        };
      })}
      current={step}
      runPath={RUN}
      output={<Output step={STEPS.some((s) => s.key === step) ? step : "receive"} />}
    />
  );
}

function sopAnchor(key: string): string {
  return (
    (
      { match: "each", analyse: "analyse", answers: "answer", report: "report" } as Record<
        string,
        string
      >
    )[key] ?? key
  );
}

function Output({ step }: { step: string }) {
  switch (step) {
    case "receive":
      return <Receive />;
    case "records":
      return <Records />;
    case "verify":
      return <Verify />;
    case "match":
      return <Match />;
    case "territory":
      return <Territory />;
    case "forms":
      return <Forms />;
    case "send":
      return <Send />;
    case "answers":
      return <Answers />;
    case "analyse":
      return <Analyse />;
    case "report":
      return <ReportStep />;
    default:
      return <EmailStep />;
  }
}

function Receive() {
  return (
    <>
      <Facts
        rows={[
          [
            "File",
            <span key="f" className="font-mono text-xs">
              {FILE.name}
            </span>,
          ],
          ["From", FILE.from],
          ["To", FILE.to],
          ["Arrived", FILE.arrived],
          ["Size", `${FILE.size} · ${FILE.rows} rows · ${FILE.period}`],
        ]}
      />
      <How>Rules · nothing is changed; the original is kept with the run.</How>
      <p className="eyebrow mt-5 mb-2 text-ink-muted">The file as it came</p>
      <pre className="demo-code demo-code--raw">{RAW}</pre>
      <NextLink to={RUN("records")}>Next: the records</NextLink>
    </>
  );
}

function Records() {
  return (
    <>
      <KpiStrip>
        <StatTile label="Records" value="412" note="one per row" />
        <StatTile label="Unreadable" value="0" />
        <StatTile label="Equipment read by AI" value="347" note="from the collateral text" />
      </KpiStrip>
      <How>
        Rules split the columns · <b>Claude Sonnet 5.5</b> reads the equipment, year and serial out
        of the collateral text. The text is data, never instructions.
      </How>
      <p className="eyebrow mt-5 mb-2 text-ink-muted">The first three records (JSON)</p>
      <pre className="demo-code">{JSON_SAMPLE}</pre>
      <NextLink to={RUN("verify")}>Next: verification</NextLink>
    </>
  );
}

function Verify() {
  return (
    <>
      <KpiStrip>
        <StatTile
          label="Kept"
          value={String(TOTALS.kept)}
          tone="positive"
          note="ROMCO's kind of sale"
        />
        <StatTile label="Removed" value={String(TOTALS.removed)} note="each with its reason" />
        <StatTile
          label="Marked"
          value={String(TOTALS.unsure)}
          note="AI unsure: kept for the sales manager"
          tone="signal"
          noteTone="signal"
        />
      </KpiStrip>
      <How>
        Rules first · then <b>Claude Sonnet 5.5</b> on what's left · Sol checked the removals at
        8:05.
      </How>
      <div className="dt dt-ana mt-5">
        <div className="dt-scroll">
          <table>
            <thead>
              <tr className="dt-cols">
                <th>Removed because</th>
                <th>By</th>
                <th className="n">Filings</th>
              </tr>
            </thead>
            <tbody>
              {REMOVED.map((r) => (
                <tr key={r.key}>
                  <td>{r.reason}</td>
                  <td>
                    <Tag>{r.how}</Tag>
                  </td>
                  <td className="n">
                    <span className="dt-inbar">
                      <span className="dt-track">
                        <i style={{ width: `${(r.count / 82) * 100}%` }} />
                      </span>
                      <span style={{ minWidth: 28 }}>{r.count}</span>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p className="eyebrow mt-6 mb-2 text-ink-muted">Some of what was removed</p>
      <div className="dt dt-ana">
        <div className="dt-scroll">
          <table>
            <thead>
              <tr className="dt-cols">
                <th>Filing</th>
                <th>Debtor</th>
                <th>What</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {REMOVED_SAMPLE.map((r) => (
                <tr key={r.fileNo + r.why}>
                  <td className="font-mono text-xs">{r.fileNo}</td>
                  <td>{r.debtor}</td>
                  <td className="text-sm text-ink-muted">{r.what}</td>
                  <td className="text-sm">
                    {r.why} <span className="text-xs text-ink-muted">· {r.how}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <NextLink to={RUN("match")}>Next: matching</NextLink>
    </>
  );
}

const GROUP_TONE: Record<Group, "accent" | "neutral" | "person" | "warning"> = {
  won: "accent",
  lost: "neutral",
  existing: "person",
  new: "person",
};

export function GroupPill({ g }: { g: Group }) {
  return <Badge tone={GROUP_TONE[g]}>{GROUP_WORDS[g]}</Badge>;
}

/** Won, lost, existing and new as one bar: ROMCO saw the slate part, missed the copper part. */
export function ShareBar({
  won,
  lost,
  existing,
  fresh,
  big,
}: {
  won: number;
  lost: number;
  existing: number;
  fresh: number;
  big?: boolean;
}) {
  const total = won + lost + existing + fresh;
  const seg = (n: number, cls: string, label: string) =>
    n > 0 ? (
      <i className={cls} style={{ width: `${(n / total) * 100}%` }} title={`${label}: ${n}`} />
    ) : null;
  return (
    <span className={cx("demo-share", big && "demo-share--big")}>
      {seg(won, "is-won", "Won")}
      {seg(lost, "is-lost", "Lost")}
      {seg(existing, "is-existing", "Existing client, no deal")}
      {seg(fresh, "is-new", "New to ROMCO")}
    </span>
  );
}

export function ShareLegend() {
  return (
    <span className="demo-legend">
      <span>
        <i className="is-won" />
        Won
      </span>
      <span>
        <i className="is-lost" />
        Lost
      </span>
      <span>
        <i className="is-existing" />
        Existing client, not quoted
      </span>
      <span>
        <i className="is-new" />
        New to ROMCO
      </span>
    </span>
  );
}

const FILTER_WORDS: Record<Group, string> = {
  won: "Won",
  lost: "Lost",
  existing: "Existing client, no deal",
  new: "New to ROMCO",
};

function Match() {
  const [show, setShow] = useState<Group | "all">("all");
  const rows = FILINGS.filter((f) => show === "all" || f.group === show);
  return (
    <>
      <KpiStrip>
        <StatTile label="On a deal" value="41" note="17 won · 24 lost" tone="slate" />
        <StatTile
          label="Existing client, no deal"
          value="52"
          note="bought elsewhere, not quoted"
          tone="copper"
        />
        <StatTile label="New to ROMCO" value="45" note="not in Zoho CRM" tone="copper" />
      </KpiStrip>
      <div className="mt-4 flex flex-col gap-2">
        <ShareBar won={17} lost={24} existing={52} fresh={45} big />
        <ShareLegend />
      </div>
      <How>
        In order: deals first (same customer and equipment, closed in the 120 days before), then
        accounts by name, address or phone. Rules, then <b>Claude Sonnet 5.5</b> for names that
        differ. Zoho CRM is read only.
      </How>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <fieldset className="ds-seg flex-wrap" aria-label="Show">
          {(["all", "won", "lost", "existing", "new"] as const).map((g) => (
            <button key={g} type="button" aria-pressed={show === g} onClick={() => setShow(g)}>
              {g === "all" ? "All" : FILTER_WORDS[g]}
            </button>
          ))}
        </fieldset>
        <span className="text-sm text-ink-muted">Showing {rows.length} of 138</span>
      </div>
      <FilingTable rows={rows} />
      <NextLink to={RUN("territory")}>Next: territories</NextLink>
    </>
  );
}

function FilingTable({ rows }: { rows: Filing[] }) {
  return (
    <div className="dt dt-ana mt-3">
      <div className="dt-scroll">
        <table>
          <thead>
            <tr className="dt-cols">
              <th>Debtor</th>
              <th>Equipment</th>
              <th>Group</th>
              <th>Matched in Zoho CRM</th>
              <th className="n">Sure</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((f) => (
              <tr key={f.id}>
                <td className="dt-who">
                  <b>{f.debtor}</b>
                  <span>
                    {f.city} {f.zip} · {f.securedParty}
                  </span>
                </td>
                <td className="text-sm">{f.equipment}</td>
                <td>
                  <GroupPill g={f.group} />
                </td>
                <td className="text-sm">
                  {f.deal ? (
                    <>
                      <span className="font-mono text-xs">Deal {f.deal.id}</span> {f.deal.name}
                      <span className="block text-xs text-ink-muted">{f.why}</span>
                    </>
                  ) : f.account ? (
                    <>
                      <span className="font-mono text-xs">Account {f.account.id}</span> client since{" "}
                      {f.account.since}
                      <span className="block text-xs text-ink-muted">{f.why}</span>
                    </>
                  ) : (
                    <span className="text-ink-muted">{f.why}</span>
                  )}
                </td>
                <td className="n">
                  {f.confidence < 92 ? (
                    <Badge tone="warning">{f.confidence}% · confirm</Badge>
                  ) : (
                    `${f.confidence}%`
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Territory() {
  return (
    <>
      <How>
        Rules · the debtor's ZIP on the "Territories by ZIP" sheet. Two ZIPs weren't on it (77363
        and 78671) and went by county; both are marked on the forms.
      </How>
      <div className="dt dt-ana mt-4">
        <div className="dt-scroll">
          <table>
            <thead>
              <tr className="dt-cols">
                <th>Sales manager</th>
                <th>Territory</th>
                <th>Copied</th>
                <th className="n">Filings</th>
                <th>Where they went</th>
              </tr>
            </thead>
            <tbody>
              {REPS.map((r) => {
                const [w, l, e, n] = BY_REP[r.key] ?? [0, 0, 0, 0];
                return (
                  <tr key={r.key}>
                    <td className="dt-who">
                      <b>{r.name}</b>
                      <span className="font-mono">{r.zips}</span>
                    </td>
                    <td>{r.territory}</td>
                    <td>{r.manager}</td>
                    <td className="n">{r.filings}</td>
                    <td style={{ minWidth: 160 }}>
                      <ShareBar won={w} lost={l} existing={e} fresh={n} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <div className="mt-3">
        <ShareLegend />
      </div>
      <NextLink to={RUN("forms")}>Next: the forms</NextLink>
    </>
  );
}

function formStatus(key: string, s: S): ReactNode {
  if (!s.formsSent) return <Badge>Ready to send</Badge>;
  if (key === "marcus" && !s.marcusDone)
    return <StatusChip state="person">Sent · due Mon Nov 10</StatusChip>;
  return <StatusChip state="done">Answered</StatusChip>;
}

function Forms() {
  const { state } = useDemo();
  return (
    <>
      <How>
        Rules · one form per sales manager, their filings in three parts: confirm they're yours,
        explain the existing clients ROMCO didn't quote, and say whether the new buyers were on your
        radar.
      </How>
      <div className="dt dt-ana mt-4">
        <div className="dt-scroll">
          <table>
            <thead>
              <tr className="dt-cols">
                <th>Form</th>
                <th className="n">Filings</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {REPS.map((r) => (
                <tr key={r.key}>
                  <td className="dt-who">
                    <b>{r.name}</b>
                    <span>
                      To {r.email} · copy {r.manager}
                    </span>
                  </td>
                  <td className="n">{r.filings}</td>
                  <td>{formStatus(r.key, state)}</td>
                  <td>
                    {r.key === "marcus" ? (
                      <Link to="/f/marcus" className="text-sm text-link hover:underline">
                        Preview
                      </Link>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {!state.formsSent ? (
        <div className="demo-wait mt-5">
          <Badge tone="warning">Waiting on you</Badge>
          <p className="text-sm text-ink">
            Nothing is emailed until Dana Whitfield signs. It's in the Inbox.
          </p>
          <Link to="/inbox" className={buttonClass("primary")}>
            Open in Inbox
          </Link>
        </div>
      ) : (
        <NextLink to={RUN("send")}>Next: the emails</NextLink>
      )}
    </>
  );
}

function Send() {
  const { state } = useDemo();
  if (!state.formsSent) {
    return (
      <div className="demo-wait">
        <Badge tone="warning">Waiting on you</Badge>
        <p className="text-sm text-ink">
          6 emails from sales-ops@romco.example, each to one sales manager with their regional
          manager copied. Gmail asks first: Dana Whitfield signs.
        </p>
        <Link to="/inbox" className={buttonClass("primary")}>
          Open in Inbox
        </Link>
      </div>
    );
  }
  return (
    <>
      <Facts
        rows={[
          ["Signed", "Dana Whitfield, Mon Nov 3, 8:46 AM"],
          ["Sent", "6 emails from sales-ops@romco.example, 8:47 AM"],
          ["Each one", "A link to the sales manager's own form; their regional manager copied"],
        ]}
      />
      <How>Gmail · Send, after a person approves · once each, with its before and after kept.</How>
      <NextLink to="/mail/form">See the email Marcus Bell got</NextLink>
    </>
  );
}

const ANSWERS: { rep: string; at: string; moved: number; note: string }[] = [
  {
    rep: "kelsey",
    at: "Tue Nov 4, 3:12 PM",
    moved: 1,
    note: "Moved Gulf Coast Ditching to Luis Ortega (Brazoria job).",
  },
  {
    rep: "tyler",
    at: "Wed Nov 5, 9:40 AM",
    moved: 0,
    note: "8 existing clients bought through a national account.",
  },
  {
    rep: "andre",
    at: "Tue Nov 4, 11:05 AM",
    moved: 1,
    note: "Piney Woods Clearing is Kelsey's: Beaumont yard.",
  },
  {
    rep: "luis",
    at: "Thu Nov 6, 4:30 PM",
    moved: 0,
    note: "Lost two on financing terms; new buyers mostly pipeline work.",
  },
  {
    rep: "hannah",
    at: "Wed Nov 5, 1:18 PM",
    moved: 0,
    note: "Brazos Valley Earthworks confirmed as A-10088.",
  },
  {
    rep: "marcus",
    at: "Fri Nov 7, 10:02 AM",
    moved: 1,
    note: "Willis Ready Mix belongs to Kelsey's Conroe branch account.",
  },
];

function Answers() {
  const { state } = useDemo();
  const back = state.marcusDone ? 6 : state.formsSent ? 5 : 0;
  return (
    <>
      <div className="flex items-center gap-3">
        <span className="type-heading">{back} of 6 back</span>
        <span className="flex-1">
          <ProgressBar
            value={back}
            max={6}
            label={`${back} of 6 forms back`}
            tone={back < 6 ? "waiting" : "accent"}
          />
        </span>
      </div>
      <How>
        A person · each sales manager, by Mon Nov 10; a reminder on day 3; their regional manager is
        asked on day 5.
      </How>
      <div className="dt dt-ana mt-4">
        <div className="dt-scroll">
          <table>
            <thead>
              <tr className="dt-cols">
                <th>Sales manager</th>
                <th>Answered</th>
                <th className="n">Moved</th>
                <th>What they said</th>
              </tr>
            </thead>
            <tbody>
              {ANSWERS.map((a) => {
                const r = repByKey(a.rep);
                const open = a.rep === "marcus" && !state.marcusDone;
                return (
                  <tr key={a.rep}>
                    <td className="dt-who">
                      <b>{r.name}</b>
                      <span>{r.territory}</span>
                    </td>
                    <td>
                      {!state.formsSent ? (
                        <Badge>Not sent</Badge>
                      ) : open ? (
                        <StatusChip state="person">Due Mon Nov 10</StatusChip>
                      ) : (
                        <span className="text-sm">{a.at}</span>
                      )}
                    </td>
                    <td className="n">{open || !state.formsSent ? "–" : a.moved}</td>
                    <td className="text-sm">
                      {open ? (
                        <Link to="/f/marcus" className="text-link hover:underline">
                          Open Marcus Bell's form
                        </Link>
                      ) : state.formsSent ? (
                        a.note
                      ) : (
                        "–"
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      {state.marcusDone ? <NextLink to={RUN("analyse")}>Next: the analysis</NextLink> : null}
    </>
  );
}

function Analyse() {
  const { state } = useDemo();
  if (!state.marcusDone) {
    return (
      <p className="text-sm text-ink-muted">Starts when all six forms are back (5 of 6 now).</p>
    );
  }
  return (
    <>
      <How>
        <b>Claude Opus 5.5</b> groups the answers into themes; rules work out every figure. Each
        theme links to its filings and answers.
      </How>
      <KpiStrip>
        <StatTile label="ROMCO saw" value="30%" note="41 of 138 sales" tone="slate" />
        <StatTile
          label="ROMCO won"
          value="12%"
          note="17 of 138 sales · 41% of deals"
          tone="positive"
        />
        <StatTile
          label="Missed clients"
          value="52"
          note="existing clients, not quoted"
          tone="copper"
        />
        <StatTile
          label="Not on the radar"
          value="31 of 45"
          note="new buyers no one knew"
          tone="copper"
        />
      </KpiStrip>
      <p className="eyebrow mt-6 mb-2 text-ink-muted">Why ROMCO missed or lost a sale</p>
      <ul className="demo-themes">
        {THEMES.map((t) => (
          <li key={t.theme}>
            <span className="flex items-baseline justify-between gap-3">
              <b className="text-ink">{t.theme}</b>
              <span className="figures text-sm">{t.n} filings</span>
            </span>
            <span className="dt-track demo-theme-bar">
              <i style={{ width: `${(t.n / 38) * 100}%` }} />
            </span>
            <span className="text-sm text-ink-muted">{t.words}</span>
            <span className="text-sm text-ink">{t.quote}</span>
          </li>
        ))}
      </ul>
      <NextLink to={`${AGENT}/report`}>Next: the dashboard</NextLink>
    </>
  );
}

function ReportStep() {
  const { state } = useDemo();
  if (!state.marcusDone) {
    return <p className="text-sm text-ink-muted">Built when the forms are back.</p>;
  }
  return (
    <>
      <How>
        Rules · the Report tab is updated and the workbook is written, every figure with its
        sources.
      </How>
      <Workbook />
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Link to={`${AGENT}/report`} className={buttonClass("secondary")}>
          Open the dashboard
        </Link>
        {state.reportSent ? (
          <Link to="/mail/report" className={buttonClass("primary")}>
            See the email
          </Link>
        ) : (
          <Link to="/inbox" className={buttonClass("primary")}>
            Sign to send it
          </Link>
        )}
      </div>
    </>
  );
}

function EmailStep() {
  const { state } = useDemo();
  if (!state.marcusDone)
    return <p className="text-sm text-ink-muted">After the report is built.</p>;
  if (!state.reportSent) {
    return (
      <div className="demo-wait">
        <Badge tone="warning">Waiting on you</Badge>
        <p className="text-sm text-ink">
          The workbook to Dana Whitfield, copying Ray Delgado, Jenna Holt and Paul Reyes.
        </p>
        <Link to="/inbox" className={buttonClass("primary")}>
          Open in Inbox
        </Link>
      </div>
    );
  }
  return (
    <>
      <Facts
        rows={[
          ["Signed", "Dana Whitfield, Fri Nov 7, 10:31 AM"],
          ["Sent", "To Dana Whitfield; copy Ray Delgado, Jenna Holt, Paul Reyes"],
          ["Attached", "ROMCO UCC review – October 2026.xlsx"],
        ]}
      />
      <NextLink to="/mail/report">See the email</NextLink>
    </>
  );
}
