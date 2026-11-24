// The Inbox: what waits on Dana Whitfield. Each write to ROMCO's Gmail is a sign card (the design
// system's SignCard): what will happen, before and after, its receipts, and Sign.
import { Link, useNavigate } from "react-router-dom";
import { Page } from "../../ui/page";
import { Badge, buttonClass, Card, EmptyState, PageHeader } from "../../ui/primitives";
import { REPS } from "./people";
import { RUN, useDemo } from "./state";

function SignCard({
  title,
  body,
  before,
  after,
  receipts,
  onSign,
  from = "UCC filings review · R-1042",
  lead = "Checked by Ana, your lead",
}: {
  title: string;
  body: string;
  before: string;
  after: string;
  receipts: { label: string; to: string }[];
  onSign: () => void;
  from?: string;
  lead?: string;
}) {
  return (
    <article className="mz-sign">
      <div className="ds-row" style={{ justifyContent: "space-between" }}>
        <Badge tone="warning">Waiting on you</Badge>
        <span className="ds-eyebrow">{from}</span>
      </div>
      <h3 className="mz-sign__title">{title}</h3>
      <p className="mz-sign__body">{body}</p>
      <div className="mz-sign__change">
        <div className="mz-sign__side">
          <span className="ds-eyebrow">Before</span>
          {before}
        </div>
        <div className="mz-sign__side">
          <span className="ds-eyebrow">After</span>
          {after}
        </div>
      </div>
      <div className="mz-sign__receipts">
        {receipts.map((r) => (
          <Link key={r.label} to={r.to} className="mz-receipt">
            <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden className="ds-icon">
              <use href="#mz-document" />
            </svg>
            {r.label}
          </Link>
        ))}
      </div>
      <div className="mz-sign__foot">
        <span className="mz-person mz-person--lead">
          <span className="ds-avatar ds-avatar--sm mz-lead">AT</span>
          {lead}
        </span>
        <span className="ds-row">
          <Link
            to={`/sloan?ask=${encodeURIComponent(`About "${title}"`)}`}
            className={buttonClass("secondary")}
          >
            Ask a question
          </Link>
          <button type="button" className={buttonClass("primary")} onClick={onSign}>
            Sign
          </button>
        </span>
      </div>
    </article>
  );
}

export function Inbox() {
  const { state, set } = useDemo();
  const navigate = useNavigate();
  const formsWaiting = !state.formsSent;
  const reportWaiting = state.marcusDone && !state.reportSent;
  return (
    <Page width="narrow">
      <PageHeader
        eyebrow={state.marcusDone ? "Friday, November 7" : "Monday, November 3"}
        title="Inbox"
        subtitle="What waits on you, newest first."
      />
      <div className="flex flex-col gap-5">
        {state.inv === 2 ? (
          <SignCard
            from="Invoice CRM update · R-1051 · for Renee Park"
            title="Mark 95 Zoho deals Closed Won and add their invoice numbers."
            body="October's invoiced sales: 89 the agent matched and 6 Tom Guerra found. Only Stage, Closing date and Invoice number change. Sign and they change now."
            before="95 deals open in Zoho CRM (Proposal, Negotiation, 1 Closed Lost), no invoice numbers."
            after="95 deals Closed Won, each closing on its invoice date with its Great Plains invoice number."
            receipts={[
              { label: "The 95 changes", to: "/runs/R-1051/update" },
              { label: "The reconciliation", to: "/runs/R-1051/reconcile" },
              { label: "Tom's answers", to: "/runs/R-1051/ask" },
            ]}
            lead="Checked by Sol and Ana, your lead"
            onSign={() => {
              set({ inv: 3 });
              navigate("/runs/R-1051/update");
            }}
          />
        ) : null}
        {reportWaiting ? (
          <SignCard
            title="Email October's UCC report for review."
            body="The workbook goes to you, copying Ray Delgado, Jenna Holt and Paul Reyes. Sign and it goes now."
            before="No report sent for October."
            after="1 email from sales-ops@romco.example with ROMCO UCC review – October 2026.xlsx."
            receipts={[
              { label: "The workbook", to: RUN("report") },
              { label: "The dashboard", to: "/agents/0e5c0c00-0000-4000-8000-000000000001/report" },
            ]}
            onSign={() => {
              set({ reportSent: true });
              navigate("/mail/report");
            }}
          />
        ) : null}
        {formsWaiting ? (
          <SignCard
            title="Send 6 UCC review forms to the sales managers."
            body={`138 filings from October, one form per territory, each copied to the regional manager. Sign and they go out now; they're due Mon Nov 10.`}
            before="No forms sent for October."
            after={`6 emails from sales-ops@romco.example: ${REPS.map((r) => r.name.split(" ")[0]).join(", ")}.`}
            receipts={[
              { label: "Marcus Bell's form", to: "/f/marcus" },
              { label: "6 forms", to: RUN("forms") },
              { label: "The matches", to: RUN("match") },
            ]}
            onSign={() => {
              set({ formsSent: true });
              navigate("/mail/form");
            }}
          />
        ) : null}
        {!formsWaiting && !reportWaiting && state.inv !== 2 ? (
          <Card pad>
            <EmptyState compact icon="check" line="Nothing waits on you." />
          </Card>
        ) : null}
        <Card title="Done recently">
          <div>
            {state.inv === 3 ? (
              <DoneRow
                line="Marked 95 Zoho deals Closed Won"
                when="Fri Nov 7"
                to="/runs/R-1051/update"
              />
            ) : null}
            {state.reportSent ? (
              <DoneRow line="Sent October's UCC report" when="Fri Nov 7" to="/mail/report" />
            ) : null}
            {state.formsSent ? (
              <DoneRow line="Sent 6 UCC review forms" when="Mon Nov 3" to="/mail/form" />
            ) : null}
            <DoneRow
              line="Approved the UCC filings review for its trial"
              when="Fri Oct 31"
              to="/agents/0e5c0c00-0000-4000-8000-000000000001/sop"
            />
          </div>
        </Card>
      </div>
    </Page>
  );
}

function DoneRow({ line, when, to }: { line: string; when: string; to: string }) {
  return (
    <Link to={to} className="ops-row ops-row--link">
      <span className="ops-row__text">
        <span className="block text-ink">{line}</span>
      </span>
      <span className="ops-row__end text-sm text-ink-muted">{when}</span>
    </Link>
  );
}
