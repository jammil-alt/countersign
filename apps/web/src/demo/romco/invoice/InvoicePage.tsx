// The Invoice CRM update's page as ROMCO sees it in the portal, on the shared agent frame: its
// figures for today, the two reports it waits for, its runs, its report and its settings.
import { Link } from "react-router-dom";
import { KpiStrip, StatTile } from "../../../ui/figures";
import { PageGrid } from "../../../ui/page";
import { Badge, buttonClass, Card } from "../../../ui/primitives";
import { StatusChip } from "../../../ui/status";
import { AgentFrame, type AgentTab, HowItWorks, RunRow } from "../AgentFrame";
import { INVOICE_ID, INVOICE_RUN_ID } from "../people";
import { INV_AGENT, INV_RUN, useDemo } from "../state";
import { DAYS, EXCEPTION_GROUPS, RECON, REPORTS, ZOHO } from "./data";
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
          "Every business day, waits for the unit sales report and the Great Plains invoice register to be emailed in, reconciles them, and marks each invoiced sale's deal Closed Won in Zoho CRM.",
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
              note={
                stage === 0 ? "Invoice register due 9:00 AM, followed up" : "Both in by 10:47 AM"
              }
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
                    ? "6 waiting on your sign-off"
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
                <dd>Every business day at 7:00 AM</dd>
                <dt>Next</dt>
                <dd>Fri Nov 7, for Thu Nov 6</dd>
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
        title={`${INVOICE_RUN_ID} · Thu Nov 6, for Wed Nov 5`}
        line="Started 7:00 AM · 2 reports to collect"
        chip={<StatusChip state={chip.state}>{chip.label}</StatusChip>}
      />
      <RunRow
        to={INV_RUN("collect")}
        title="R-1047 · Wed Nov 5, for Tue Nov 4"
        line="10 of 11 sales reconciled · 9 deals closed in Zoho CRM"
        chip={<StatusChip state="checked">Test run</StatusChip>}
      />
    </>
  );
}

function Overview({ stage }: { stage: Stage }) {
  return (
    <PageGrid
      rail={
        <Card title="Waiting on" pad>
          {stage === 0 ? (
            <div className="flex flex-col gap-3">
              <Badge tone="person">Priya Shah</Badge>
              <p className="text-sm text-ink">
                Yesterday's invoice register, due 9:00 AM. Followed up at 10:00 AM; next at noon.
              </p>
              <Link to={INV_RUN("collect")} className={buttonClass("secondary", "self-start")}>
                See the reports
              </Link>
            </div>
          ) : stage === 1 ? (
            <div className="flex flex-col gap-3">
              <Badge tone="person">Tom Guerra</Badge>
              <p className="text-sm text-ink">1 sale to match to a Zoho deal, due by 3:00 PM.</p>
              <Link to={INV_RUN("ask")} className={buttonClass("secondary", "self-start")}>
                See them
              </Link>
            </div>
          ) : stage === 2 ? (
            <div className="flex flex-col gap-3">
              <Badge tone="warning">Sign</Badge>
              <p className="text-sm text-ink">
                Mark 6 Zoho deals Closed Won with their invoice numbers.
              </p>
              <Link to="/inbox" className={buttonClass("primary", "self-start")}>
                Open in Inbox
              </Link>
            </div>
          ) : (
            <p className="text-sm text-ink-muted">Nothing. Tomorrow's run starts at 7:00 AM.</p>
          )}
        </Card>
      }
    >
      <Card
        title="Today's reports"
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
        Both are emailed in every morning. A report not in by 1:00 PM goes to Grace Lin, Controller.
      </p>
    </>
  );
}

function InvoiceReport({ stage }: { stage: Stage }) {
  if (stage === 0) {
    return (
      <Card pad>
        <p className="text-ink">Today's figures fill in once both reports are in.</p>
        <p className="mt-1 text-sm text-ink-muted">
          Waiting on the invoice register from Priya Shah.
        </p>
      </Card>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <span className="type-heading">Thursday, November 6</span>
        <span className="text-sm text-ink-muted">From R-1051</span>
      </div>
      <KpiStrip>
        <StatTile label="Units sold" value={String(RECON.sales)} note="on the unit sales report" />
        <StatTile
          label="Reconciled"
          value={`${RECON.matched} of ${RECON.sales}`}
          note="Invoice numbers applied"
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
          note={stage === 3 ? "Closed Won with invoice numbers" : "Waiting on sign-off"}
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
                    <td>9:00 AM</td>
                    <td>6:32 AM</td>
                    <td>
                      <Badge tone="positive">On time</Badge>
                    </td>
                  </tr>
                  <tr>
                    <td className="dt-who">
                      <b>Invoice register</b>
                      <span>Priya Shah</span>
                    </td>
                    <td>9:00 AM</td>
                    <td>10:47 AM</td>
                    <td>
                      <Badge tone="warning">1 hr 47 min late · 1 follow-up</Badge>
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
                      <i style={{ width: `${(g.count / 2) * 100}%` }} />
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
      <Card titleAbove title="The last 10 business days">
        <div className="dt dt-ana">
          <div className="dt-scroll">
            <table>
              <thead>
                <tr className="dt-cols">
                  <th>Day</th>
                  <th>Reports on time</th>
                  <th className="n">Sales</th>
                  <th className="n">Reconciled</th>
                  <th className="n">Exceptions</th>
                  <th className="n">Deals closed</th>
                </tr>
              </thead>
              <tbody>
                {DAYS.map((d, i) => (
                  <tr key={d.day}>
                    <td>{d.day}</td>
                    <td>
                      {d.onTime === "2 of 2" ? (
                        <Badge tone="positive">2 of 2</Badge>
                      ) : (
                        <Badge tone="warning">{d.onTime}</Badge>
                      )}
                    </td>
                    <td className="n">{d.sales}</td>
                    <td className="n">{d.reconciled}</td>
                    <td className="n">{d.exceptions}</td>
                    <td className="n">{i === 0 && stage < 3 ? "–" : d.closed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </Card>
    </div>
  );
}

function ZohoShare({ stage }: { stage: Stage }) {
  const done = stage >= 2;
  const parts: [string, number, string][] = done
    ? [
        ["is-won", 5, "Matched by rules"],
        ["is-lost", 1, "Matched, name read by AI"],
        ["is-existing", 1, "Found by sales ops"],
      ]
    : [
        ["is-won", 5, "Matched by rules"],
        ["is-lost", 1, "Matched, name read by AI"],
        ["is-new", 1, "With sales ops"],
      ];
  return (
    <Card titleAbove title="Where the 7 invoiced sales went in Zoho CRM">
      <div className="ui-card__body flex flex-col gap-2">
        <span className="demo-share demo-share--big">
          {parts.map(([cls, n, label]) => (
            <i
              key={label}
              className={cls}
              style={{ width: `${(n / 7) * 100}%` }}
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
