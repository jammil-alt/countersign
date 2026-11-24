// The UCC filings review's page as ROMCO sees it in the portal, on the shared agent frame.
import { Link } from "react-router-dom";
import { KpiStrip, StatTile } from "../../ui/figures";
import { PageGrid } from "../../ui/page";
import { Badge, buttonClass, Card } from "../../ui/primitives";
import { AgentFrame, type AgentTab, HowItWorks } from "./AgentFrame";
import { REPS, UCC_ID } from "./people";
import { Report } from "./Report";
import { AgentRunRows } from "./Runs";
import { UCC_SOP } from "./sop";
import { AGENT, RUN, useDemo } from "./state";

export type { AgentTab };

export function runChip(s: ReturnType<typeof useDemo>["state"]) {
  if (!s.formsSent) return { state: "waiting" as const, label: "Waiting on you" };
  if (!s.marcusDone) return { state: "person" as const, label: "Waiting on 1 sales manager" };
  if (!s.reportSent) return { state: "waiting" as const, label: "Waiting on you" };
  return { state: "done" as const, label: "Done" };
}

export function AgentPage({ tab }: { tab: AgentTab }) {
  const { state } = useDemo();
  const back = state.marcusDone ? 6 : state.formsSent ? 5 : 0;
  return (
    <AgentFrame
      tab={tab}
      agent={{
        id: UCC_ID,
        name: "UCC filings review",
        subtitle:
          "Finds every equipment sale in ROMCO's territories from the UCC filings and asks each sales manager about the ones ROMCO missed.",
        stage: "Trial",
        chip: runChip(state),
        actions: (
          <>
            <Link to={RUN("receive")} className={buttonClass("secondary")}>
              Upload a UCC file
            </Link>
            <button type="button" className={buttonClass("secondary")}>
              Pause
            </button>
          </>
        ),
        kpis: (
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
        ),
        sop: UCC_SOP,
        overview: <Overview />,
        runs: <AgentRunRows agent="ucc" />,
        report: <Report />,
        settings: {
          rail: (
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
          ),
          below: <Contacts />,
        },
      }}
    />
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
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                aria-hidden
                className="text-ink-muted"
              >
                <use href="#mz-upload" />
              </svg>
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
        <AgentRunRows agent="ucc" limit={3} />
      </Card>
      <div className="mt-5" />
      <HowItWorks
        base={AGENT}
        steps={[
          ["Reads the file", "The month's UCC filings become records."],
          ["Keeps what matters", "Rules, then AI, remove what isn't ROMCO's kind of sale."],
          ["Matches", "Deals first, then existing clients; the rest are new to ROMCO."],
          ["Asks the sales managers", "A form each, by territory, copied to their manager."],
          ["Reports", "A dashboard here and an Excel report by email."],
        ]}
      />
    </PageGrid>
  );
}

function Contacts() {
  return (
    <>
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
    </>
  );
}
