// The Invoice CRM update's emails as each person receives them: the follow-up to Priya Shah for a
// late report, the exception report to accounting, the request to sales ops for the deals it
// couldn't match, and the month's summary.
import { Link } from "react-router-dom";
import { buttonClass } from "../../../ui/primitives";
import { Email } from "../Mail";
import { INV_AGENT, INV_RUN } from "../state";
import { EXCEPTION_GROUPS, NOT_FOUND } from "./data";
import { ExceptionTable } from "./InvoiceRun";

const FROM = "ROMCO Invoice CRM update (Mezonas) <invoices@romco.in.mezonas.com>";
const FOOT = "Sent for ROMCO by its Invoice CRM update agent (Mezonas).";

export function FollowUpMail() {
  return (
    <Email
      from={FROM}
      to="Priya Shah <pshah@romco.example>"
      cc="—"
      subject="Reminder: October's invoice register was due yesterday"
      when="Thu Nov 6, 8:00 AM"
    >
      <p>Priya,</p>
      <p>
        October's invoice register from Great Plains was due Wednesday, November 5. The unit sales
        report is already in, so the month's reconciliation is waiting on it.
      </p>
      <p>
        <Link to="/r/register" className={buttonClass("primary")}>
          Send the invoice register
        </Link>
      </p>
      <p className="text-sm text-ink-muted">
        This is follow-up 1 of 2. If it isn't in by Monday, November 10, Grace Lin will be asked
        whether to keep waiting.
      </p>
      <p className="demo-mail__foot">{FOOT} The link checks the file before it's taken.</p>
    </Email>
  );
}

export function ExceptionsMail() {
  return (
    <Email
      from={FROM}
      to="Priya Shah <pshah@romco.example>; Accounting <accounting@romco.example>"
      cc="Renee Park"
      subject="October reconciliation: 97 of 104 sales matched, 13 exceptions"
      when="Thu Nov 6, 11:23 AM"
    >
      <p>October's unit sales report and invoice register are reconciled.</p>
      <ul>
        <li>
          <b>97 of 104 sales</b> matched a Great Plains invoice; their invoice numbers are applied.
        </li>
        {EXCEPTION_GROUPS.map((g) => (
          <li key={g.key}>
            <b>
              {g.count} {g.name.toLowerCase()}.
            </b>{" "}
            {g.what}
          </li>
        ))}
      </ul>
      <ExceptionTable group="all" />
      <p className="flex flex-wrap gap-2">
        <Link to={INV_RUN("exceptions")} className="demo-attach">
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
            <use href="#mz-worksheet" />
          </svg>
          ROMCO exceptions – October 2026.xlsx · 13 rows
        </Link>
      </p>
      <p className="demo-mail__foot">{FOOT} Reply to this email with anything we should know.</p>
    </Email>
  );
}

export function DealsMail() {
  return (
    <Email
      from={FROM}
      to="Tom Guerra <tguerra@romco.example>"
      cc="—"
      subject="8 October sales we couldn't match to a Zoho deal, due Mon Nov 10"
      when="Thu Nov 6, 11:27 AM"
    >
      <p>Tom,</p>
      <p>
        89 of October's 97 invoiced sales matched a deal in Zoho CRM. We couldn't match these 8. For
        each, pick the deal it closes, or tell us there isn't one:
      </p>
      <ul>
        {NOT_FOUND.map((n) => (
          <li key={n.id}>
            <b>{n.customer}</b>, {n.machine.toLowerCase()} ({n.invoice}): {n.why.toLowerCase()}.
          </li>
        ))}
      </ul>
      <p>
        <Link to="/f/deals" className={buttonClass("primary")}>
          Find the deals
        </Link>
      </p>
      <p className="text-sm text-ink-muted">
        Due Monday, November 10. Nothing changes in Zoho until Renee Park signs.
      </p>
      <p className="demo-mail__foot">{FOOT}</p>
    </Email>
  );
}

export function SummaryMail() {
  return (
    <Email
      from={FROM}
      to="Renee Park <rpark@romco.example>"
      cc="Priya Shah, Dana Whitfield"
      subject="October close: 95 deals marked Closed Won in Zoho CRM"
      when="Fri Nov 7, 3:41 PM"
    >
      <p>October's close is done in Zoho CRM.</p>
      <ul>
        <li>
          <b>Both reports in</b>: the unit sales report on time, the invoice register 1 day late
          after 1 follow-up.
        </li>
        <li>
          <b>97 of 104 sales reconciled</b> with Great Plains; invoice numbers applied.
        </li>
        <li>
          <b>95 deals marked Closed Won</b>, each with its invoice number and closing date: 89
          matched by the agent, 6 found by Tom Guerra.
        </li>
        <li>
          <b>2 sales have no deal in Zoho</b>: Nacogdoches Land Clearing and Tyler Pipe & Bore. They
          need an account and a deal created.
        </li>
        <li>
          <b>13 exceptions</b> are with accounting.
        </li>
      </ul>
      <p className="flex flex-wrap gap-2">
        <Link to={`${INV_AGENT}/report`} className={buttonClass("secondary")}>
          Open the report
        </Link>
        <Link to={INV_RUN("update")} className={buttonClass("secondary")}>
          See the 95 changes
        </Link>
      </p>
      <p className="demo-mail__foot">{FOOT} Every change links to its invoice in run R-1051.</p>
    </Email>
  );
}
