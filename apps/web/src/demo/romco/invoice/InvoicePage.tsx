// The Invoice CRM update's page as ROMCO sees it in the portal, on the shared agent frame: its
// figures for October, the two reports it waits for, its runs, its report and its settings.
import { Link } from "react-router-dom";
import { KpiStrip, StatTile } from "../../../ui/figures";
import { PageGrid } from "../../../ui/page";
import { Badge, buttonClass, Card } from "../../../ui/primitives";
import { StatusChip } from "../../../ui/status";
import { AgentFrame, type AgentTab, HowItWorks, RunRow } from "../AgentFrame";
import { INVOICE_ID, INVOICE_RUN_ID } from "../people";
import { INV_AGENT, INV_RUN, useDemo } from "../state";
import { EXCEPTION_GROUPS, RECON, REPORTS, ZOHO } from "./data";
import { ReportCards } from "./Reports";
import { INVOICE_SOP } from "./sop";

type Stage = 0 | 1 | 2 | 3;

export function invoiceChip(stage: Stage) {
  if (stage === 0) return { state: "person" as const, label: "Waiting on 1 report" };
  if (stage === 1) return { state: "person" as const, label: "Waiting on sales ops" };
  if (stage === 2) return { state: "waiting" as const, label: "Waiting on you" };
  return { state: "done" as const, label: "Done" };
}

export function InvoicePage({ tab }: { tab: AgentTab }) {
  const { state } = useDemo();
  const stage = state.inv;
  return (
    <AgentFrame
      tab={tab}
      agent={{
        id: INVOICE_ID,
        name: "Invoice CRM update",
        subtitle:
          "Each month, waits for the unit sales report and the Great Plains invoice register, reconciles them, and marks each invoiced sale's deal Closed Won in Zoho CRM.",
        stage: "Trial",
        chip: invoiceChip(stage),
        actions: (
          <button type="button" className={buttonClass("secondary")}>
            Pause
          </button>
        ),
        kpis: (
          <KpiStrip>
            <StatTile
              label="Reports in"
              value={`${stage === 0 ? 1 : 2} of 2`}
              note={stage === 0 ? "Invoice register 1 day late" : "Both in by Thu Nov 6"}
              {...(stage === 0 ? { tone: "signal" as const, noteTone: "signal" as const } : {})}
            />
            <StatTile
              label="Sales reconciled"
              value={stage === 0 ? "–" : `${RECON.matched} of ${RECON.sales}`}
              note={stage === 0 ? "When both reports are in" : "Invoice numbers applied"}
            />
            <StatTile
              label="Exceptions"
              value={stage === 0 ? "–" : String(RECON.exceptions)}
              note={stage === 0 ? "–" : "Sent to accounting"}
              tone="copper"
            />
            <StatTile
              label="Deals closed in Zoho"
              value={stage === 3 ? String(ZOHO.updated) : "0"}
              note={
                stage === 3
                  ? "Closed Won, invoice numbers added"
                  : stage === 2
                    ? "95 waiting on your sign-off"
                    : "After matching and sign-off"
              }
              tone="positive"
            />
          </KpiStrip>
        ),
        sop: INVOICE_SOP,
        overview: <Overview stage={stage} />,
        runs: <Runs stage={stage} />,
        report: <InvoiceReport stage={stage} />,
        settings: {
          rail: (
            <Card title="When it runs" pad>
              <dl className="demo-dl">
                <dt>Starts</dt>
                <dd>The first business day of each month, 8:00 AM</dd>
                <dt>Next</dt>
                <dd>Mon Dec 1, for November</dd>
                <dt>Late reports</dt>
                <dd>Grace Lin, Controller</dd>
              </dl>
            </Card>
          ),
          below: <Owners />,
        },
      }}
    />
  );
}

function Runs({ stage }: { stage: Stage }) {
  const chip = invoiceChip(stage);
  return (
    <>
      <RunRow
        to={INV_RUN(stage === 0 ? "collect" : stage === 1 ? "match" : "update")}
        title={`${INVOICE_RUN_ID} · October 2026 close`}
        line="Started Mon Nov 3, 8:00 AM · 2 reports to collect"
        chip={<StatusChip state={chip.state}>{chip.label}</StatusChip>}
      />
      <RunRow
        to={INV_RUN("collect")}
        title="R-0991 · September 2026 close (test run)"
        line="Fri Oct 31 · 91 of 96 sales reconciled · nothing changed in Zoho"
        chip={<StatusChip state="checked">Test run</StatusChip>}
      />
    </>
  );
}

function Overview({ stage }: { stage: Stage }) {
  return (
    <PageGrid
      rail={
        <>
          <Card title="Waiting on" pad>
            {stage === 0 ? (
              <div className="flex flex-col gap-3">
                <Badge tone="person">Priya Shah</Badge>
                <p className="text-sm text-ink">
                  October's invoice register, due Wed Nov 5. Followed up Thu 8:00 AM; next Fri.
                </p>
                <Link to={INV_RUN("collect")} className={buttonClass("secondary", "self-start")}>
                  See the reports
                </Link>
              </div>
            ) : stage === 1 ? (
              <div className="flex flex-col gap-3">
                <Badge tone="person">Tom Guerra</Badge>
                <p className="text-sm text-ink">8 sales to match to a Zoho deal, due Mon Nov 10.</p>
                <Link to={INV_RUN("ask")} className={buttonClass("secondary", "self-start")}>
                  See them
                </Link>
              </div>
            ) : stage === 2 ? (
              <div className="flex flex-col gap-3">
                <Badge tone="warning">Sign</Badge>
                <p className="text-sm text-ink">
                  Mark 95 Zoho deals Closed Won with their invoice numbers.
                </p>
                <Link to="/inbox" className={buttonClass("primary", "self-start")}>
                  Open in Inbox
                </Link>
              </div>
            ) : (
              <p className="text-sm text-ink-muted">Nothing. November's close starts Mon Dec 1.</p>
            )}
          </Card>
        </>
      }
    >
      <Card
        title="October's reports"
        meta={<span className="text-sm text-ink-muted">The trigger: both must be in</span>}
        pad
      >
        <ReportCards stage={stage} compact />
      </Card>
      <div className="mt-5" />
      <Card title="Recent runs">
        <Runs stage={stage} />
      </Card>
      <div className="mt-5" />
      <HowItWorks
        base={INV_AGENT}
        steps={[
          [
            "Collects two reports",
            "The unit sales report and the Great Plains invoice register, each from its owner.",
          ],
          ["Reconciles them", "Each sale gets its Great Plains invoice number."],
          ["Sends the exceptions", "What didn't reconcile goes back to accounting."],
          [
            "Matches Zoho deals",
            "By account name and address, then the machine; sales ops finds the rest.",
          ],
          ["Closes the deals", "Closed Won with the invoice number, after Renee Park signs."],
        ]}
      />
    </PageGrid>
  );
}

function Owners() {
  return (
    <>
      <Card titleAbove title="Reports it collects">
        <div className="dt dt-ana">
          <div className="dt-scroll">
            <table>
              <thead>
                <tr className="dt-cols">
                  <th>Report</th>
                  <th>Owner</th>
                  <th>Due</th>
                  <th>Follow-ups</th>
                </tr>
              </thead>
              <tbody>
                {REPORTS.map((r) => (
                  <tr key={r.key}>
                    <td className="dt-who">
                      <b>{r.name}</b>
                      <span>{r.from}</span>
                    </td>
                    <td className="dt-who">
                      <b>{r.owner}</b>
                      <span>{r.email}</span>
                    </td>
                    <td className="text-sm">{r.dueRule}</td>
                    <td className="text-sm">{r.followUp}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </Card>
      <p className="mt-2 text-sm text-ink-muted">
        Each owner gets their own link. A report 2 business days late goes to Grace Lin, Controller.
      </p>
    </>
  );
}

function InvoiceReport({ stage }: { stage: Stage }) {
  if (stage === 0) {
    return (
      <Card pad>
        <p className="text-ink">October's report fills in once both reports are in.</p>
        <p className="mt-1 text-sm text-ink-muted">
          Waiting on the invoice register from Priya Shah.
        </p>
      </Card>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <span className="type-heading">October 2026 close</span>
        <span className="text-sm text-ink-muted">From R-1051</span>
      </div>
      <KpiStrip>
        <StatTile label="Units sold" value={String(RECON.sales)} note="on the unit sales report" />
        <StatTile
          label="Reconciled"
          value={`${RECON.matched}`}
          note="93% · invoice numbers applied"
          tone="positive"
        />
        <StatTile
          label="Exceptions"
          value={String(RECON.exceptions)}
          note="with accounting"
          tone="copper"
        />
        <StatTile
          label="Deals closed in Zoho"
          value={stage === 3 ? String(ZOHO.updated) : "0"}
          note={stage === 3 ? "2 more need a deal created" : "Waiting on sign-off"}
          tone="slate"
        />
      </KpiStrip>
      <div className="ui-cols ui-cols--2">
        <Card titleAbove title="Reports">
          <div className="dt dt-ana">
            <div className="dt-scroll">
              <table>
                <thead>
                  <tr className="dt-cols">
                    <th>Report</th>
                    <th>Due</th>
                    <th>In</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="dt-who">
                      <b>Unit sales report</b>
                      <span>Tom Guerra</span>
                    </td>
                    <td>Tue Nov 4</td>
                    <td>Tue Nov 4</td>
                    <td>
                      <Badge tone="positive">On time</Badge>
                    </td>
                  </tr>
                  <tr>
                    <td className="dt-who">
                      <b>Invoice register</b>
                      <span>Priya Shah</span>
                    </td>
                    <td>Wed Nov 5</td>
                    <td>Thu Nov 6</td>
                    <td>
                      <Badge tone="warning">1 day late · 1 follow-up</Badge>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </Card>
        <Card titleAbove title="Exceptions with accounting">
          <div className="ui-card__body">
            <ul className="demo-bars">
              {EXCEPTION_GROUPS.map((g) => (
                <li key={g.key}>
                  <span className="demo-bars__label">{g.name}</span>
                  <span className="demo-bars__bar">
                    <span className="dt-track">
                      <i style={{ width: `${(g.count / 6) * 100}%` }} />
                    </span>
                  </span>
                  <span className="figures text-sm">{g.count}</span>
                </li>
              ))}
            </ul>
          </div>
        </Card>
      </div>
      <ZohoShare stage={stage} />
    </div>
  );
}

function ZohoShare({ stage }: { stage: Stage }) {
  const done = stage >= 2;
  const parts: [string, number, string][] = done
    ? [
        ["is-won", 82, "Matched by rules"],
        ["is-lost", 7, "Matched, names read by AI"],
        ["is-existing", 6, "Found by sales ops"],
        ["is-new", 2, "No deal in Zoho yet"],
      ]
    : [
        ["is-won", 82, "Matched by rules"],
        ["is-lost", 7, "Matched, names read by AI"],
        ["is-new", 8, "With sales ops"],
      ];
  return (
    <Card titleAbove title="Where the 97 invoiced sales went in Zoho CRM">
      <div className="ui-card__body flex flex-col gap-2">
        <span className="demo-share demo-share--big">
          {parts.map(([cls, n, label]) => (
            <i
              key={label}
              className={cls}
              style={{ width: `${(n / 97) * 100}%` }}
              title={`${label}: ${n}`}
            />
          ))}
        </span>
        <span className="demo-legend">
          {parts.map(([cls, n, label]) => (
            <span key={label}>
              <i className={cls} />
              {label} · {n}
            </span>
          ))}
        </span>
      </div>
    </Card>
  );
}
