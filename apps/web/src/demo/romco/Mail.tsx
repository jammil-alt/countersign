// The two emails the run sends from ROMCO's Gmail, as the person receives them: the review form to
// a sales manager (copying their manager), and the report to Dana Whitfield and the regional
// managers with the workbook attached.
import type { ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { buttonClass } from "../../ui/primitives";
import { DemoShell } from "./DemoShell";
import { DealsMail, ExceptionsMail, FollowUpMail, SummaryMail } from "./invoice/Mails";
import { AGENT, RUN } from "./state";

export function Email({
  from,
  to,
  cc,
  subject,
  when,
  children,
}: {
  from: string;
  to: string;
  cc: string;
  subject: string;
  when: string;
  children: ReactNode;
}) {
  return (
    <div className="demo-mail">
      <p className="eyebrow mb-3 text-ink-muted">Email preview · as it arrives in Gmail</p>
      <div className="ds-card">
        <div className="demo-mail__head">
          <h1 className="type-heading text-ink">{subject}</h1>
          <dl className="demo-mail__meta">
            <dt>From</dt>
            <dd>{from}</dd>
            <dt>To</dt>
            <dd>{to}</dd>
            <dt>Cc</dt>
            <dd>{cc}</dd>
            <dt>Sent</dt>
            <dd>{when}</dd>
          </dl>
        </div>
        <div className="demo-mail__body">{children}</div>
      </div>
    </div>
  );
}

export function Mail() {
  const { which } = useParams();
  const mail =
    which === "report" ? (
      <ReportMail />
    ) : which === "form" ? (
      <FormMail />
    ) : which === "followup" ? (
      <FollowUpMail />
    ) : which === "exceptions" ? (
      <ExceptionsMail />
    ) : which === "deals" ? (
      <DealsMail />
    ) : (
      <SummaryMail />
    );
  return <DemoShell>{mail}</DemoShell>;
}

function FormMail() {
  return (
    <Email
      from="ROMCO Sales Ops <sales-ops@romco.example>"
      to="Marcus Bell <mbell@romco.example>"
      cc="Ray Delgado <rdelgado@romco.example>"
      subject="Your October UCC review: 12 sales in Houston North, due Mon Nov 10"
      when="Mon Nov 3, 8:47 AM"
    >
      <p>Marcus,</p>
      <p>
        12 equipment sales were filed in your territory in October. ROMCO was on 4 of them (won 2,
        lost 2). 5 were existing clients we didn't quote, and 3 buyers are new to ROMCO.
      </p>
      <p>Please take 10 minutes to:</p>
      <ol>
        <li>Confirm each one is yours, or tell us whose it is.</li>
        <li>Tell us why we didn't quote the 5 existing clients.</li>
        <li>Tell us whether the 3 new buyers were on your radar, and what's next.</li>
      </ol>
      <p>
        <Link to="/f/marcus" className={buttonClass("primary")}>
          Open your review form
        </Link>
      </p>
      <p className="text-sm text-ink-muted">
        Due Monday, November 10. Ray has a copy of this email and will see your answers.
      </p>
      <p>Dana Whitfield, VP of Sales</p>
      <p className="demo-mail__foot">
        Sent for ROMCO by its UCC filings review agent (Mezonas), with Dana Whitfield's sign-off.
      </p>
    </Email>
  );
}

function ReportMail() {
  return (
    <Email
      from="ROMCO Sales Ops <sales-ops@romco.example>"
      to="Dana Whitfield <dwhitfield@romco.example>"
      cc="Ray Delgado, Jenna Holt, Paul Reyes"
      subject="October UCC review: ROMCO saw 30% of 138 equipment sales, won 17"
      when="Fri Nov 7, 10:31 AM"
    >
      <p>October's UCC review is done. All six sales managers answered.</p>
      <ul>
        <li>
          <b>138 equipment sales</b> in ROMCO's territories (from 412 filings).
        </li>
        <li>
          <b>ROMCO saw 41 (30%)</b> and won 17: 41% of the deals it saw.
        </li>
        <li>
          <b>52 existing clients bought without a quote.</b> The top reason: we didn't know they
          were buying.
        </li>
        <li>
          <b>45 buyers are new to ROMCO</b>; 31 weren't on anyone's radar.
        </li>
        <li>
          Lowest share seen: Austin and Central Texas (23%). Highest win rate: Houston North (50%),
          then Dallas–Fort Worth (45%).
        </li>
      </ul>
      <p className="flex flex-wrap gap-2">
        <Link to={RUN("report")} className="demo-attach">
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
            <use href="#mz-worksheet" />
          </svg>
          ROMCO UCC review – October 2026.xlsx · 48 KB
        </Link>
        <Link to={`${AGENT}/report`} className={buttonClass("secondary")}>
          Open the dashboard
        </Link>
      </p>
      <p className="demo-mail__foot">
        Sent for ROMCO by its UCC filings review agent (Mezonas), with Dana Whitfield's sign-off.
        Every figure links to its filings in run R-1042.
      </p>
    </Email>
  );
}
