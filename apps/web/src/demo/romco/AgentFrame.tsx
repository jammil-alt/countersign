// One agent's page as the client sees it in the portal (portal/screens/Agent.tsx), for any of the
// demo's agents: its header, this month's figures, then the tabs. Workflow and SOP are the real
// tabs' components on the agent's SOP view; Agent settings lists its tools from the same view.
import type { SopView } from "@countersign/core";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ConnectorMark } from "../../connections/ConnectorMark";
import { WorkflowView } from "../../portal/screens/AgentWorkflow";
import { WrongForm } from "../../portal/screens/LineFeedback";
import { SopDocument } from "../../sop/SopDocument";
import { AgentBadge } from "../../ui/badges";
import { Page, PageGrid } from "../../ui/page";
import { Badge, Card, PageHeader, Tabs, Tag } from "../../ui/primitives";
import { type ChipState, StatusChip } from "../../ui/status";

export type AgentTab = "overview" | "runs" | "flow" | "sop" | "report" | "settings";

export interface AgentConfig {
  id: string;
  name: string;
  subtitle: string;
  stage: string;
  chip: { state: ChipState; label: string };
  actions?: ReactNode;
  kpis: ReactNode;
  sop: SopView;
  overview: ReactNode;
  runs: ReactNode;
  report: ReactNode;
  /** Agent settings: what sits under the tools table, and the rail. */
  settings: { below: ReactNode; rail: ReactNode };
}

export function AgentFrame({ tab, agent }: { tab: AgentTab; agent: AgentConfig }) {
  const base = `/agents/${agent.id}`;
  return (
    <Page testId="portal-agent">
      <PageHeader
        eyebrow={<Link to="/home">Home</Link>}
        leading={<AgentBadge name={agent.name} seed={agent.id} size="lg" />}
        title={agent.name}
        badge={
          <span className="flex items-center gap-2">
            <StatusChip state={agent.chip.state}>{agent.chip.label}</StatusChip>
            <Tag>{agent.stage}</Tag>
          </span>
        }
        subtitle={agent.subtitle}
        actions={agent.actions}
      />
      {agent.kpis}
      <Tabs
        items={[
          { to: base, label: "Overview", end: true },
          { to: `${base}/runs`, label: "Runs" },
          { to: `${base}/flow`, label: "Workflow" },
          { to: `${base}/sop`, label: "SOP" },
          { to: `${base}/report`, label: "Report" },
          { to: `${base}/settings`, label: "Agent settings" },
        ]}
      />
      <div className="mt-5">
        {tab === "overview" ? (
          agent.overview
        ) : tab === "runs" ? (
          <Card>{agent.runs}</Card>
        ) : tab === "flow" ? (
          <WorkflowView id={agent.id} view={agent.sop} />
        ) : tab === "sop" ? (
          <SopDocument
            view={agent.sop}
            askHref={(line) =>
              `/sloan?ask=${encodeURIComponent(`About the ${agent.name}: ${line}`)}`
            }
            wrong={(line, close) => <WrongForm agentId={agent.id} line={line} onClose={close} />}
          />
        ) : tab === "report" ? (
          agent.report
        ) : (
          <PageGrid rail={agent.settings.rail}>
            <ToolsTable sop={agent.sop} />
            <p className="mt-2 text-sm text-ink-muted">
              You can tighten any of these on Connectors; it takes effect at once. Only we can
              propose loosening one, and only you can accept it.
            </p>
            <div className="mt-6" />
            {agent.settings.below}
          </PageGrid>
        )}
      </div>
    </Page>
  );
}

const LEVEL: Record<string, ReactNode> = {
  auto: <Badge tone="positive">On</Badge>,
  ask: <Badge tone="warning">Ask me first</Badge>,
  off: <Badge>Off</Badge>,
};

/** What the agent may do in each of the client's tools, verb by verb, with each tool's logo. */
function ToolsTable({ sop }: { sop: SopView }) {
  const level = (l: string | null, verb?: string) =>
    l ? (
      <>
        {LEVEL[l]}
        {verb ? <span className="ml-1 text-xs text-ink-muted">{verb}</span> : null}
      </>
    ) : (
      "–"
    );
  return (
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
              {sop.systems.map((s) => (
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
                  <td>{level(s.read)}</td>
                  <td>{level(s.create, s.key === "gmail" ? "Send" : undefined)}</td>
                  <td>{level(s.update, s.key === "zoho_crm" ? "Stage, Invoice #" : undefined)}</td>
                  <td>{level(s.delete)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Card>
  );
}

export function RunRow({
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

/** "How it works": the agent's stages in a few words each. */
export function HowItWorks({ base, steps }: { base: string; steps: [string, string][] }) {
  return (
    <Card title="How it works" pad>
      <ol className="demo-how">
        {steps.map(([t, d], i) => (
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
        <Link to={`${base}/flow`} className="text-link hover:underline">
          See the workflow
        </Link>{" "}
        ·{" "}
        <Link to={`${base}/sop`} className="text-link hover:underline">
          Read the SOP
        </Link>
      </p>
    </Card>
  );
}
