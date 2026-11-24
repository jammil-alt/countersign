// One run as the portal's run page draws it, for any of the demo's agents: its steps on the left
// (the real `StepList`), the open step's output on the right, with a link to that step's line in
// the agent's SOP.
import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Page } from "../../ui/page";
import { buttonClass, Card, PageHeader } from "../../ui/primitives";
import { type ChipState, StatusChip } from "../../ui/status";
import { type StepItem, StepList } from "../../ui/steps";

export interface RunFrameStep {
  key: string;
  /** Its number in the SOP ("4", "5.2 B1"). */
  sop: string;
  title: string;
  time: string;
  detail: string;
  state: StepItem["state"];
  /** The step's id in the SOP, for the link to its line. */
  anchor: string;
}

export function RunFrame({
  agent,
  runId,
  title,
  started,
  chip,
  steps,
  current,
  runPath,
  output,
}: {
  agent: { id: string; name: string };
  runId: string;
  title: string;
  started: ReactNode;
  chip: { state: ChipState; label: string };
  steps: RunFrameStep[];
  current: string;
  runPath: (step: string) => string;
  output: ReactNode;
}) {
  const navigate = useNavigate();
  const base = `/agents/${agent.id}`;
  const open = steps.find((s) => s.key === current) ?? (steps[0] as RunFrameStep);
  const items: StepItem[] = steps.map((s) => ({
    key: s.key,
    title: `${s.sop}. ${s.title}`,
    detail: s.detail || undefined,
    time: s.time,
    state: s.state,
    selected: s.key === open.key,
    onOpen: () => navigate(runPath(s.key)),
  }));
  return (
    <Page>
      <PageHeader
        eyebrow={
          <>
            <Link to={`${base}/runs`}>Runs</Link> / {runId}
          </>
        }
        title={title}
        badge={<StatusChip state={chip.state}>{chip.label}</StatusChip>}
        subtitle={
          <>
            <Link to={base} className="text-link hover:underline">
              {agent.name}
            </Link>{" "}
            · {started}
          </>
        }
      />
      <div className="demo-run">
        <Card className="demo-run__steps">
          <div className="p-4">
            <StepList steps={items} />
          </div>
        </Card>
        <div className="demo-run__out">
          <Card
            title={`${open.sop}. ${open.title}`}
            meta={
              <Link
                to={`${base}/sop#sop-step-${open.anchor}`}
                className="text-sm text-link hover:underline"
              >
                Step {open.sop} in the SOP
              </Link>
            }
          >
            <div className="ui-card__body">{output}</div>
          </Card>
        </div>
      </div>
    </Page>
  );
}

export function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="demo-dl demo-dl--row">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** How the step did its work: rules, AI and its model, a person. */
export function How({ children }: { children: ReactNode }) {
  return <p className="demo-how-line">{children}</p>;
}

export function NextLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <div className="mt-5 flex justify-end">
      <Link to={to} className={buttonClass("primary")}>
        {children}
      </Link>
    </div>
  );
}
