// The Invoice CRM update's emails as each person receives them: the follow-up to Priya Shah for a
// late report, the exception report to accounting, the request to sales ops for the deals it
// couldn't match, and the day's summary.
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
      subject="Reminder: yesterday's invoice register isn't in yet"
      when="Thu Nov 6, 10:00 AM"
    >
      <p>Priya,</p>
      <p>
        The Great Plains invoice register for Wednesday, November 5 was due at 9:00 AM and hasn't
        come in. The unit sales report is already in, so today's reconciliation is waiting on it.
      </p>
      <p>Reply to this email with the file attached, or send it here:</p>
      <p>
        <Link to="/r/register" className={buttonClass("primary")}>
          Send the invoice register
        </Link>
      </p>
      <p className="text-sm text-ink-muted">
        This is follow-up 1 of 2; the next is at noon. If it isn't in by 1:00 PM, Grace Lin will be
        asked whether to wait, go on without it, or stop today's run.
      </p>
      <p className="demo-mail__foot">{FOOT} The file is checked before it's taken.</p>
    </Email>
  );
}

export function ExceptionsMail() {
  return (
    <Email
      from={FROM}
      to="Priya Shah <pshah@romco.example>; Accounting <accounting@romco.example>"
      cc="Renee Park"
      subject="Nov 5 reconciliation: 7 of 9 sales matched, 4 exceptions"
      when="Thu Nov 6, 10:49 AM"
    >
      <p>Wednesday's unit sales report and invoice register are reconciled.</p>
      <ul>
        <li>
          <b>7 of 9 sales</b> matched a Great Plains invoice; their invoice numbers are applied.
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
          ROMCO exceptions – Nov 5, 2026.xlsx · 4 rows
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
      subject="1 sale from yesterday we couldn't match to a Zoho deal, due 3:00 PM"
      when="Thu Nov 6, 10:53 AM"
    >
      <p>Tom,</p>
      <p>
        6 of yesterday's 7 invoiced sales matched a deal in Zoho CRM. We couldn't match this one.
        Pick the deal it closes, or tell us there isn't one:
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
          Find the deal
        </Link>
      </p>
      <p className="text-sm text-ink-muted">
        Due by 3:00 PM today. Nothing changes in Zoho until Renee Park signs.
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
      subject="Nov 5: 6 deals marked Closed Won in Zoho CRM"
      when="Thu Nov 6, 12:16 PM"
    >
      <p>Wednesday's sales are done in Zoho CRM.</p>
      <ul>
        <li>
          <b>Both reports in</b>: the unit sales report at 6:32 AM; the invoice register at 10:47
          AM, after 1 follow-up.
        </li>
        <li>
          <b>7 of 9 sales reconciled</b> with Great Plains; invoice numbers applied.
        </li>
        <li>
          <b>6 deals marked Closed Won</b>, each with its invoice number and closing date: 5 matched
          by the agent, 1 found by Tom Guerra.
        </li>
        <li>
          <b>4 exceptions</b> are with accounting.
        </li>
      </ul>
      <p className="flex flex-wrap gap-2">
        <Link to={`${INV_AGENT}/report`} className={buttonClass("secondary")}>
          Open the report
        </Link>
        <Link to={INV_RUN("update")} className={buttonClass("secondary")}>
          See the 6 changes
        </Link>
      </p>
      <p className="demo-mail__foot">{FOOT} Every change links to its invoice in run R-1051.</p>
    </Email>
  );
}
