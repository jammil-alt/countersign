// The agent's page as ROMCO sees it in the portal (portal/screens/Agent.tsx): header, this month's
// figures, then the tabs. Workflow and SOP are the real tabs' components on the demo's SOP view.
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ConnectorMark } from "../../connections/ConnectorMark";
import { WorkflowView } from "../../portal/screens/AgentWorkflow";
import { WrongForm } from "../../portal/screens/LineFeedback";
import { SopDocument } from "../../sop/SopDocument";
import { AgentBadge } from "../../ui/badges";
import { KpiStrip, StatTile } from "../../ui/figures";
import { Page, PageGrid } from "../../ui/page";
import { Badge, buttonClass, Card, PageHeader, Tabs, Tag } from "../../ui/primitives";
import { StatusChip } from "../../ui/status";
import { INVOICE_ID, REPS, RUN_ID, UCC_ID } from "./people";
import { Report } from "./Report";
import { UCC_SOP } from "./sop";
import { AGENT, RUN, useDemo } from "./state";

export type AgentTab = "overview" | "runs" | "flow" | "sop" | "report" | "settings";

export function runChip(s: ReturnType<typeof useDemo>["state"]) {
  if (!s.formsSent) return { state: "waiting" as const, label: "Waiting on you" };
  if (!s.marcusDone) return { state: "person" as const, label: "Waiting on 1 sales manager" };
  if (!s.reportSent) return { state: "waiting" as const, label: "Waiting on you" };
  return { state: "done" as const, label: "Done" };
}

export function AgentPage({ tab }: { tab: AgentTab }) {
  const { state } = useDemo();
  const chip = runChip(state);
  const back = state.marcusDone ? 6 : state.formsSent ? 5 : 0;
  return (
    <Page testId="portal-agent">
      <PageHeader
        eyebrow={<Link to="/home">Home</Link>}
        leading={<AgentBadge name="UCC filings review" seed={UCC_ID} size="lg" />}
        title="UCC filings review"
        badge={
          <span className="flex items-center gap-2">
            <StatusChip state={chip.state}>{chip.label}</StatusChip>
            <Tag>Trial</Tag>
          </span>
        }
        subtitle="Finds every equipment sale in ROMCO's territories from the UCC filings and asks each sales manager about the ones ROMCO missed."
        actions={
          <>
            <Link to={RUN("receive")} className={buttonClass("secondary")}>
              Upload a UCC file
            </Link>
            <button type="button" className={buttonClass("secondary")}>
              Pause
            </button>
          </>
        }
      />
      <KpiStrip>
        <StatTile label="Filings reviewed" value="138" note="of 412 in October's file" />
        <StatTile
          label="Share ROMCO saw"
          value="30%"
          note="41 of 138 were on a deal"
          tone="slate"
        />
        <StatTile label="Won" value="17" note="41% of the deals it saw" tone="positive" />
        <StatTile
          label="Forms back"
          value={`${back} of 6`}
          note={back === 6 ? "All in" : back === 0 ? "Not sent yet" : "Due Mon Nov 10"}
          {...(back < 6 ? { tone: "signal" as const, noteTone: "signal" as const } : {})}
        />
      </KpiStrip>
      <Tabs
        items={[
          { to: AGENT, label: "Overview", end: true },
          { to: `${AGENT}/runs`, label: "Runs" },
          { to: `${AGENT}/flow`, label: "Workflow" },
          { to: `${AGENT}/sop`, label: "SOP" },
          { to: `${AGENT}/report`, label: "Report" },
          { to: `${AGENT}/settings`, label: "Agent settings" },
        ]}
      />
      <div className="mt-5">
        {tab === "overview" ? (
          <Overview />
        ) : tab === "runs" ? (
          <RunsTab />
        ) : tab === "flow" ? (
          <WorkflowView id={UCC_ID} view={UCC_SOP} />
        ) : tab === "sop" ? (
          <SopDocument
            view={UCC_SOP}
            askHref={(line) =>
              `/sloan?ask=${encodeURIComponent(`About the UCC filings review: ${line}`)}`
            }
            wrong={(line, close) => <WrongForm agentId={UCC_ID} line={line} onClose={close} />}
          />
        ) : tab === "report" ? (
          <Report />
        ) : (
          <Settings />
        )}
      </div>
    </Page>
  );
}

function RunRow({
  to,
  title,
  line,
  chip,
}: {
  to: string;
  title: string;
  line: string;
  chip: ReactNode;
}) {
  return (
    <Link to={to} className="ops-row ops-row--link">
      <span className="ops-row__text">
        <span className="block font-medium text-ink">{title}</span>
        <span className="block text-sm text-ink-muted">{line}</span>
      </span>
      <span className="ops-row__end">{chip}</span>
    </Link>
  );
}

function Runs() {
  const { state } = useDemo();
  const chip = runChip(state);
  return (
    <>
      <RunRow
        to={RUN(state.formsSent ? (state.marcusDone ? "report" : "answers") : "forms")}
        title={`${RUN_ID} · October 2026 UCC file`}
        line="Started Mon Nov 3, 8:02 AM · 412 filings read, 138 kept"
        chip={<StatusChip state={chip.state}>{chip.label}</StatusChip>}
      />
      <RunRow
        to={RUN("receive")}
        title="R-0987 · September 2026 UCC file (test run)"
        line="Fri Oct 31 · 389 filings read, 121 kept · nothing sent"
        chip={<StatusChip state="checked">Test run</StatusChip>}
      />
    </>
  );
}

function Overview() {
  const { state } = useDemo();
  return (
    <PageGrid
      rail={
        <>
          <Card title="Waiting on you" pad>
            {!state.formsSent ? (
              <div className="flex flex-col gap-3">
                <Badge tone="warning">Sign</Badge>
                <p className="text-sm text-ink">Send 6 review forms to the sales managers.</p>
                <Link to="/inbox" className={buttonClass("primary", "self-start")}>
                  Open in Inbox
                </Link>
              </div>
            ) : state.marcusDone && !state.reportSent ? (
              <div className="flex flex-col gap-3">
                <Badge tone="warning">Sign</Badge>
                <p className="text-sm text-ink">Email October's UCC report for review.</p>
                <Link to="/inbox" className={buttonClass("primary", "self-start")}>
                  Open in Inbox
                </Link>
              </div>
            ) : (
              <p className="text-sm text-ink-muted">Nothing waits on you.</p>
            )}
          </Card>
          <div className="mt-5" />
          <Card title="Run now" pad>
            <div className="demo-drop">
              <Icon16 />
              <p className="text-sm text-ink">Drop a UCC file here</p>
              <p className="text-xs text-ink-muted">
                Or forward it to ucc@romco.in.mezonas.com. CSV or Excel.
              </p>
            </div>
          </Card>
        </>
      }
    >
      <Card title="Recent runs">
        <Runs />
      </Card>
      <div className="mt-5" />
      <Card title="How it works" pad>
        <ol className="demo-how">
          {[
            ["Reads the file", "The month's UCC filings become records."],
            ["Keeps what matters", "Rules, then AI, remove what isn't ROMCO's kind of sale."],
            ["Matches", "Deals first, then existing clients; the rest are new to ROMCO."],
            ["Asks the sales managers", "A form each, by territory, copied to their manager."],
            ["Reports", "A dashboard here and an Excel report by email."],
          ].map(([t, d], i) => (
            <li key={t}>
              <span className="demo-how__n">{i + 1}</span>
              <span>
                <b className="block text-ink">{t}</b>
                <span className="text-sm text-ink-muted">{d}</span>
              </span>
            </li>
          ))}
        </ol>
        <p className="mt-4 text-sm">
          <Link to={`${AGENT}/flow`} className="text-link hover:underline">
            See the workflow
          </Link>{" "}
          ·{" "}
          <Link to={`${AGENT}/sop`} className="text-link hover:underline">
            Read the SOP
          </Link>
        </p>
      </Card>
    </PageGrid>
  );
}

function Icon16() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden className="text-ink-muted">
      <use href="#mz-upload" />
    </svg>
  );
}

function RunsTab() {
  return (
    <Card>
      <Runs />
    </Card>
  );
}

const LEVEL: Record<string, ReactNode> = {
  auto: <Badge tone="positive">On</Badge>,
  ask: <Badge tone="warning">Ask me first</Badge>,
  off: <Badge>Off</Badge>,
};

function Settings() {
  return (
    <PageGrid
      rail={
        <Card title="How to reach it" pad>
          <dl className="demo-dl">
            <dt>Email a file to</dt>
            <dd className="font-mono text-xs">ucc@romco.in.mezonas.com</dd>
            <dt>In a thread</dt>
            <dd className="font-mono text-xs">/ucc</dd>
            <dt>When it runs</dt>
            <dd>
              When the monthly file arrives; forms and reports go out Monday to Friday, 8 to 5.
            </dd>
          </dl>
        </Card>
      }
    >
      <Card titleAbove title="What it may do in your tools">
        <div className="dt dt-ana">
          <div className="dt-scroll">
            <table>
              <thead>
                <tr className="dt-cols">
                  <th>Tool</th>
                  <th>Account</th>
                  <th>Read</th>
                  <th>Create</th>
                  <th>Change</th>
                  <th>Delete</th>
                </tr>
              </thead>
              <tbody>
                {UCC_SOP.systems.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <span className="flex items-center gap-3">
                        <ConnectorMark name={s.name} connector={s.key} size="sm" />
                        <span className="dt-who">
                          <b>{s.name}</b>
                          <span>Steps {s.steps.join(", ")}</span>
                        </span>
                      </span>
                    </td>
                    <td className="text-sm">{s.account}</td>
                    <td>{s.read ? LEVEL[s.read] : "–"}</td>
                    <td>
                      {s.create ? (
                        s.key === "gmail" ? (
                          <>
                            {LEVEL[s.create]} <span className="text-xs text-ink-muted">Send</span>
                          </>
                        ) : (
                          LEVEL[s.create]
                        )
                      ) : (
                        "–"
                      )}
                    </td>
                    <td>{s.update ? LEVEL[s.update] : "–"}</td>
                    <td>{s.delete ? LEVEL[s.delete] : "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </Card>
      <p className="mt-2 text-sm text-ink-muted">
        You can tighten any of these on Connectors; it takes effect at once. Only we can propose
        loosening one, and only you can accept it.
      </p>
      <div className="mt-6" />
      <Card titleAbove title="Who it contacts">
        <div className="dt dt-ana">
          <div className="dt-scroll">
            <table>
              <thead>
                <tr className="dt-cols">
                  <th>Sales manager</th>
                  <th>Territory</th>
                  <th>ZIP codes</th>
                  <th>Copied</th>
                </tr>
              </thead>
              <tbody>
                {REPS.map((r) => (
                  <tr key={r.key}>
                    <td className="dt-who">
                      <b>{r.name}</b>
                      <span>{r.email}</span>
                    </td>
                    <td>{r.territory}</td>
                    <td className="font-mono text-xs">{r.zips}</td>
                    <td>{r.manager}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </Card>
      <p className="mt-2 text-sm text-ink-muted">
        From the "Territories by ZIP" sheet in Google Sheets. Only ROMCO addresses on it can receive
        a form or a report.
      </p>
    </PageGrid>
  );
}

/** The second ROMCO agent: set up next. */
export function InvoicePage() {
  return (
    <Page>
      <PageHeader
        eyebrow={<Link to="/home">Home</Link>}
        leading={<AgentBadge name="Invoice CRM update" seed={INVOICE_ID} size="lg" />}
        title="Invoice CRM update"
        badge={<StatusChip state="setup">Setting up</StatusChip>}
        subtitle="Reads ROMCO's invoices and keeps each account's purchases in Zoho CRM up to date."
      />
      <Card pad>
        <p className="text-ink">
          We're setting this one up next. Its workflow and SOP come with it.
        </p>
        <p className="mt-2 text-sm text-ink-muted">
          New buyers the UCC review finds will be handed to it as leads.
        </p>
      </Card>
    </Page>
  );
}
