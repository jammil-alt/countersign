// One run of the Invoice CRM update, R-1051 (Thursday, November 6), on the shared run frame. Each
// output is what that step made: the two reports and their follow-ups, the reconciliation with
// invoice numbers applied, the exception report, the Zoho matches, the deals sales ops found, the
// Zoho updates and the summary.
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { KpiStrip, ProgressBar, StatTile } from "../../../ui/figures";
import { Badge, buttonClass } from "../../../ui/primitives";
import { StatusChip } from "../../../ui/status";
import type { StepItem } from "../../../ui/steps";
import { INVOICE_ID, INVOICE_RUN_ID } from "../people";
import { Facts, How, NextLink, RunFrame } from "../RunFrame";
import { INV_AGENT, INV_RUN, useDemo } from "../state";
import {
  EXAMPLE_PICKS,
  EXCEPTION_GROUPS,
  EXCEPTIONS,
  type ExceptionGroup,
  MATCHED,
  NOT_FOUND,
  RECON,
  RECONCILED,
  ZOHO,
} from "./data";
import { invoiceChip } from "./InvoicePage";
import { ReportCards } from "./Reports";

type Stage = 0 | 1 | 2 | 3;

interface Step {
  key: string;
  sop: string;
  title: string;
  anchor: string;
  at: (s: Stage) => { state: StepItem["state"]; time: string; detail: string };
}

const todo = { state: "todo" as const, time: "", detail: "" };

const STEPS: Step[] = [
  {
    key: "collect",
    sop: "1",
    title: "Collect the day's two reports",
    anchor: "collect",
    at: (s) =>
      s === 0
        ? {
            state: "person",
            time: "7:00",
            detail: "1 of 2 in · invoice register due 9:00 AM, followed up",
          }
        : { state: "done", time: "10:47", detail: "2 of 2 in · 1 follow-up · checks passed" },
  },
  {
    key: "reconcile",
    sop: "2",
    title: "Reconcile sales with Great Plains invoices",
    anchor: "reconcile",
    at: (s) =>
      s === 0
        ? todo
        : { state: "done", time: "10:48", detail: "7 of 9 matched · invoice numbers applied" },
  },
  {
    key: "exceptions",
    sop: "3",
    title: "Build the exception report",
    anchor: "exceptions",
    at: (s) =>
      s === 0 ? todo : { state: "done", time: "10:48", detail: "4 exceptions in 3 groups" },
  },
  {
    key: "send-exceptions",
    sop: "4",
    title: "Send the exception report to accounting",
    anchor: "send-exceptions",
    at: (s) =>
      s === 0
        ? todo
        : { state: "done", time: "10:49", detail: "To Priya Shah and the accounting team" },
  },
  {
    key: "match",
    sop: "5.1",
    title: "Match each sale to a Zoho CRM deal",
    anchor: "match",
    at: (s) =>
      s === 0 ? todo : { state: "done", time: "10:52", detail: "6 of 7 matched · 1 not found" },
  },
  {
    key: "ask",
    sop: "5.2 B1",
    title: "Sales ops finds the deal",
    anchor: "ask",
    at: (s) =>
      s === 0
        ? todo
        : s === 1
          ? {
              state: "person",
              time: "10:53",
              detail: "1 sale sent to Tom Guerra · due 3:00 PM",
            }
          : { state: "done", time: "11:40", detail: "6 deals found · 2 have no deal yet" },
  },
  {
    key: "update",
    sop: "6",
    title: "Mark each deal Closed Won and add its invoice number",
    anchor: "update",
    at: (s) =>
      s < 2
        ? todo
        : s === 2
          ? { state: "waiting", time: "11:41", detail: "6 changes waiting on Renee Park to sign" }
          : { state: "done", time: "12:15", detail: "6 deals updated in Zoho CRM" },
  },
  {
    key: "summary",
    sop: "7",
    title: "Send the day's summary",
    anchor: "summary",
    at: (s) =>
      s < 3
        ? todo
        : { state: "done", time: "12:16", detail: "To Renee Park, Priya Shah and Dana Whitfield" },
  },
];

export function InvoiceRun() {
  const { step = "collect" } = useParams();
  const { state } = useDemo();
  const stage = state.inv;
  const key = STEPS.some((s) => s.key === step) ? step : "collect";
  return (
    <RunFrame
      agent={{ id: INVOICE_ID, name: "Invoice CRM update" }}
      runId={INVOICE_RUN_ID}
      title="Thursday, November 6"
      started="started 7:00 AM, for the business day before (Wed Nov 5)"
      chip={invoiceChip(stage)}
      steps={STEPS.map((s) => ({
        key: s.key,
        sop: s.sop,
        title: s.title,
        anchor: s.anchor,
        ...s.at(stage),
      }))}
      current={key}
      runPath={INV_RUN}
      output={<Output step={key} stage={stage} />}
    />
  );
}

function Output({ step, stage }: { step: string; stage: Stage }) {
  if (step === "collect") return <Collect stage={stage} />;
  if (stage === 0) {
    return <p className="text-sm text-ink-muted">Starts when both reports are in (1 of 2 now).</p>;
  }
  switch (step) {
    case "reconcile":
      return <Reconcile />;
    case "exceptions":
      return <Exceptions />;
    case "send-exceptions":
      return <SendExceptions />;
    case "match":
      return <Match />;
    case "ask":
      return <Ask stage={stage} />;
    case "update":
      return <Update stage={stage} />;
    default:
      return <Summary stage={stage} />;
  }
}

function Collect({ stage }: { stage: Stage }) {
  return (
    <>
      <div className="mb-4 flex items-center gap-3">
        <span className="type-heading">{stage === 0 ? "1 of 2 in" : "2 of 2 in"}</span>
        <span className="flex-1">
          <ProgressBar
            value={stage === 0 ? 1 : 2}
            max={2}
            label="Reports in"
            tone={stage === 0 ? "waiting" : "accent"}
          />
        </span>
      </div>
      <How>
        Collect reports · both are emailed in each morning by their owners · each file is checked in
        code, never by a model · the run goes on only when both are in.
      </How>
      <div className="mt-4">
        <ReportCards stage={stage} />
      </div>
      {stage === 0 ? (
        <NextLink to="/mail/followup">See the follow-up Priya got</NextLink>
      ) : (
        <NextLink to={INV_RUN("reconcile")}>Next: reconcile</NextLink>
      )}
    </>
  );
}

function Reconcile() {
  return (
    <>
      <KpiStrip>
        <StatTile label="Sales" value={String(RECON.sales)} note="unit sales report" />
        <StatTile
          label="Invoices"
          value={String(RECON.invoices)}
          note="Great Plains, equipment only"
        />
        <StatTile
          label="Reconciled"
          value={String(RECON.matched)}
          note={`${RECON.bySerial} on serial · ${RECON.byCustomerAmount} on customer and amount`}
          tone="positive"
        />
        <StatTile
          label="Exceptions"
          value={String(RECON.exceptions)}
          note="for accounting"
          tone="copper"
        />
      </KpiStrip>
      <How>
        Rules first: serial number, then customer and amount where only one invoice fits.{" "}
        <b>Claude Sonnet 5.5</b> reads only customer names written differently. Amounts must match
        to the cent.
      </How>
      <p className="eyebrow mt-5 mb-2 text-ink-muted">
        Sales with their Great Plains invoice number
      </p>
      <div className="dt dt-ana">
        <div className="dt-scroll">
          <table>
            <thead>
              <tr className="dt-cols">
                <th>Sale</th>
                <th>Customer</th>
                <th className="n">Amount</th>
                <th>Invoice # applied</th>
                <th>Matched on</th>
              </tr>
            </thead>
            <tbody>
              {RECONCILED.map((r) => (
                <tr key={r.stock}>
                  <td className="dt-who">
                    <b className="font-mono">{r.stock}</b>
                    <span>
                      {r.machine} · {r.branch}
                    </span>
                  </td>
                  <td>{r.customer}</td>
                  <td className="n">{r.amount}</td>
                  <td className="dt-who">
                    <b className="font-mono">{r.invoice}</b>
                    <span>{r.invoiceDate}</span>
                  </td>
                  <td className="text-sm">
                    {r.basis}
                    {r.serial !== "—" ? (
                      <span className="block font-mono text-xs text-ink-muted">{r.serial}</span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p className="mt-2 text-sm text-ink-muted">All 7.</p>
      <NextLink to={INV_RUN("exceptions")}>Next: the exceptions</NextLink>
    </>
  );
}

export function ExceptionTable({ group }: { group: ExceptionGroup | "all" }) {
  const rows = EXCEPTIONS.filter((e) => group === "all" || e.group === group);
  return (
    <div className="dt dt-ana">
      <div className="dt-scroll">
        <table>
          <thead>
            <tr className="dt-cols">
              <th>Reference</th>
              <th>Customer</th>
              <th className="n">Sales report</th>
              <th className="n">Great Plains</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.ref}>
                <td className="dt-who">
                  <b className="font-mono">{e.ref}</b>
                  <span>{EXCEPTION_GROUPS.find((g) => g.key === e.group)?.name}</span>
                </td>
                <td className="dt-who">
                  <b>{e.customer}</b>
                  <span>{e.detail}</span>
                </td>
                <td className="n">{e.sale}</td>
                <td className="n">{e.invoice}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Exceptions() {
  const [group, setGroup] = useState<ExceptionGroup | "all">("all");
  return (
    <>
      <div className="ui-cols ui-cols--3">
        {EXCEPTION_GROUPS.map((g) => (
          <button
            key={g.key}
            type="button"
            className="demo-pick"
            aria-pressed={group === g.key}
            onClick={() => setGroup(group === g.key ? "all" : g.key)}
          >
            <span className="type-heading">{g.count}</span>
            <b className="text-ink">{g.name}</b>
            <span className="text-sm text-ink-muted">{g.what}</span>
          </button>
        ))}
      </div>
      <How>Rules · everything that didn't reconcile in step 2, nothing left out.</How>
      <div className="mt-4">
        <ExceptionTable group={group} />
      </div>
      <NextLink to={INV_RUN("send-exceptions")}>Next: send it to accounting</NextLink>
    </>
  );
}

function SendExceptions() {
  return (
    <>
      <Facts
        rows={[
          ["Sent", "10:49 AM"],
          ["To", "Priya Shah; the accounting team (accounting@romco.example)"],
          ["Copied", "Renee Park"],
          ["Attached", "ROMCO exceptions – Nov 5, 2026.xlsx · 4 rows"],
        ]}
      />
      <How>
        Tells people · an email from Mezonas to ROMCO's own team; nothing changes in Great Plains.
      </How>
      <NextLink to="/mail/exceptions">See the email</NextLink>
    </>
  );
}

function Match() {
  return (
    <>
      <KpiStrip>
        <StatTile label="Invoiced sales" value={String(ZOHO.sales)} />
        <StatTile
          label="Matched"
          value={String(ZOHO.matched)}
          note={`${ZOHO.byRules} by rules · ${ZOHO.byAi} names read by AI`}
          tone="positive"
        />
        <StatTile
          label="Not found"
          value={String(ZOHO.notFound)}
          note="sent to sales ops"
          tone="copper"
        />
      </KpiStrip>
      <How>
        Zoho CRM, read only · the account by name and address, then its one open deal for that
        machine. <b>Claude Sonnet 5.5</b> reads only names that differ. Anything else goes to a
        person.
      </How>
      <p className="eyebrow mt-5 mb-2 text-ink-muted">Matched</p>
      <div className="dt dt-ana">
        <div className="dt-scroll">
          <table>
            <thead>
              <tr className="dt-cols">
                <th>Sale</th>
                <th>Zoho CRM deal</th>
                <th>Stage now</th>
                <th>Matched on</th>
                <th className="n">Sure</th>
              </tr>
            </thead>
            <tbody>
              {MATCHED.map((m) => (
                <tr key={m.deal}>
                  <td className="dt-who">
                    <b>{m.customer}</b>
                    <span>
                      {m.machine} · <span className="font-mono">{m.invoice}</span>
                    </span>
                  </td>
                  <td className="dt-who">
                    <b>
                      <span className="font-mono">{m.deal}</span> {m.dealName}
                    </b>
                    <span>{m.owner}</span>
                  </td>
                  <td>
                    <Badge>{m.stage}</Badge>
                  </td>
                  <td className="text-sm">{m.basis}</td>
                  <td className="n">{m.sure}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p className="mt-2 text-sm text-ink-muted">
        5 deals for 6 sales (Montgomery County Site Works bought two).
      </p>
      <p className="eyebrow mt-5 mb-2 text-ink-muted">Not found: 1, sent to sales ops</p>
      <NotFoundTable />
      <NextLink to="/mail/deals">See the email to sales ops</NextLink>
    </>
  );
}

function NotFoundTable({ answered }: { answered?: boolean }) {
  return (
    <div className="dt dt-ana">
      <div className="dt-scroll">
        <table>
          <thead>
            <tr className="dt-cols">
              <th>Sale</th>
              <th>Why not</th>
              <th>{answered ? "Tom Guerra's answer" : "Deals it considered"}</th>
            </tr>
          </thead>
          <tbody>
            {NOT_FOUND.map((n) => {
              const pick = EXAMPLE_PICKS[n.id];
              const deal = n.candidates.find((c) => c.deal === pick?.pick);
              return (
                <tr key={n.id}>
                  <td className="dt-who">
                    <b>{n.customer}</b>
                    <span>
                      {n.machine} · {n.city} · <span className="font-mono">{n.invoice}</span> ·{" "}
                      {n.amount}
                    </span>
                  </td>
                  <td className="text-sm">{n.why}</td>
                  <td className="text-sm">
                    {answered ? (
                      deal ? (
                        <>
                          <span className="font-mono text-xs">{deal.deal}</span> {deal.name}
                          <span className="block text-xs text-ink-muted">{pick?.note}</span>
                        </>
                      ) : (
                        <>
                          <Badge tone="warning">No deal in Zoho</Badge>
                          <span className="block text-xs text-ink-muted">{pick?.note}</span>
                        </>
                      )
                    ) : n.candidates.length > 0 ? (
                      n.candidates.map((c) => (
                        <span key={c.deal} className="block">
                          <span className="font-mono text-xs">{c.deal}</span> {c.name}
                        </span>
                      ))
                    ) : (
                      <span className="text-ink-muted">None</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Ask({ stage }: { stage: Stage }) {
  return (
    <>
      <Facts
        rows={[
          ["Sent to", "Tom Guerra, Sales operations analyst"],
          ["Sent", "10:53 AM, by email with a link"],
          ["Due", "3:00 PM today; then Renee Park is asked"],
          [
            "Status",
            stage === 1 ? (
              <StatusChip key="s" state="person">
                Waiting on Tom Guerra
              </StatusChip>
            ) : (
              <StatusChip key="s" state="done">
                Answered 11:40 AM
              </StatusChip>
            ),
          ],
        ]}
      />
      <How>A person · picks the deal for each sale, or says there isn't one.</How>
      <div className="mt-4">
        <NotFoundTable answered={stage >= 2} />
      </div>
      {stage === 1 ? (
        <NextLink to="/f/deals">Open Tom's form</NextLink>
      ) : (
        <NextLink to={INV_RUN("update")}>Next: the Zoho updates</NextLink>
      )}
    </>
  );
}

const UPDATES: { deal: string; name: string; invoice: string; was: string }[] = [
  {
    deal: "D-2291",
    name: "MCSW – two 30-ton excavators",
    invoice: "INV-245811, INV-245812",
    was: "Negotiation",
  },
  { deal: "D-2302", name: "GTD – high-reach excavator", invoice: "INV-245866", was: "Proposal" },
  { deal: "D-2296", name: "Red River – dozer", invoice: "INV-245893", was: "Negotiation" },
  { deal: "D-2316", name: "BSD – breaker", invoice: "INV-245905", was: "Negotiation" },
  { deal: "D-2318", name: "CAG – 14 ft grader", invoice: "INV-245921", was: "Proposal" },
  { deal: "D-2311", name: "BCE – articulated truck", invoice: "INV-245944", was: "Proposal" },
];

function Update({ stage }: { stage: Stage }) {
  return (
    <>
      {stage === 2 ? (
        <div className="demo-wait mb-4">
          <Badge tone="warning">Waiting on you</Badge>
          <p className="text-sm text-ink">6 changes in Zoho CRM wait on Renee Park's sign-off.</p>
          <Link to="/inbox" className={buttonClass("primary")}>
            Open in Inbox
          </Link>
        </div>
      ) : (
        <KpiStrip>
          <StatTile
            label="Deals updated"
            value={String(ZOHO.updated)}
            note="5 matched · 1 found by sales ops"
            tone="positive"
          />
          <StatTile label="Sales covered" value="7" note="Montgomery County bought two" />
          <StatTile label="Signed" value="12:15 PM" note="Renee Park" />
        </KpiStrip>
      )}
      <How>
        Zoho CRM · Change, after a person approves · only Stage, Closing date and Invoice number ·
        once each, with its before and after kept.
      </How>
      <div className="dt dt-ana mt-4">
        <div className="dt-scroll">
          <table>
            <thead>
              <tr className="dt-cols">
                <th>Zoho CRM deal</th>
                <th>Stage</th>
                <th>Closing date</th>
                <th>Invoice number</th>
              </tr>
            </thead>
            <tbody>
              {UPDATES.map((u) => (
                <tr key={u.deal}>
                  <td className="dt-who">
                    <b className="font-mono">{u.deal}</b>
                    <span>{u.name}</span>
                  </td>
                  <td className="text-sm">
                    <span className="text-ink-muted line-through">{u.was}</span>{" "}
                    <Badge tone={stage === 3 ? "positive" : "neutral"}>Closed Won</Badge>
                  </td>
                  <td className="text-sm">
                    <span className="text-ink-muted line-through">Nov 28</span> Nov 5
                  </td>
                  <td className="text-sm">
                    <span className="text-ink-muted">empty</span>{" "}
                    <span className="font-mono">{u.invoice}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p className="mt-2 text-sm text-ink-muted">All 6. Before, then after.</p>
      {stage === 3 ? <NextLink to={`${INV_AGENT}/report`}>Next: the report</NextLink> : null}
    </>
  );
}

function Summary({ stage }: { stage: Stage }) {
  if (stage < 3) return <p className="text-sm text-ink-muted">After the Zoho updates.</p>;
  return (
    <>
      <Facts
        rows={[
          ["Sent", "12:16 PM"],
          ["To", "Renee Park; copy Priya Shah, Dana Whitfield"],
        ]}
      />
      <NextLink to="/mail/summary">See the email</NextLink>
    </>
  );
}
