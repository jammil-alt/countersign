// The Data tab (docs/step-model-plan.md §5): next to every step's settings, three parts, each as
// JSON: Coming in (what the step before hands over), Changed (what the incoming side translated and
// what the step did) and Going out (its output). From the step's last test run, otherwise sample data
// made from the fields' types. For understanding only: nothing here is checked.

import { changed, comingIn, goingOut, type LastRun } from "./data";
import type { StepFormEnv } from "./form-kit";
import type { Step } from "./types";

export type { LastRun } from "./data";

export interface DataTabProps {
  step: Step;
  env: StepFormEnv;
  /** The step's last test run, if any; otherwise sample data made from the fields' types. */
  lastRun?: LastRun | undefined;
  /** The earlier steps' last runs, by step id, so Coming in is what the step before handed over. */
  runs?: Readonly<Record<string, LastRun>> | undefined;
}

const SAMPLE = "Sample data from the fields' types";
const RAN = "From the last test run";

function Block({
  title,
  source,
  children,
  testId,
}: {
  title: string;
  source: string;
  children: React.ReactNode;
  testId: string;
}) {
  return (
    <section className="flex flex-col gap-1" data-testid={testId}>
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="text-sm font-medium text-ink">{title}</h4>
        <span className="text-xs text-ink-muted">{source}</span>
      </div>
      {children}
    </section>
  );
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

export function DataTab({ step, env, lastRun, runs }: DataTabProps) {
  const incoming = comingIn(step, env.workflow, env.uses, runs, lastRun, env.trigger);
  const outgoing = goingOut(step, env.uses, runs, lastRun);
  const did = changed(step, env.uses);
  return (
    <div className="flex flex-col gap-4" data-testid="data-tab">
      <p className="text-xs text-ink-muted">For understanding only: nothing here is checked.</p>
      <Block title="Coming in" source={incoming.sample ? SAMPLE : RAN} testId="data-in">
        <pre className="overflow-x-auto border border-line bg-surface-subtle p-2 font-mono text-xs text-ink">
          {json(incoming.value)}
        </pre>
      </Block>
      <Block title="Changed" source="What this step did" testId="data-changed">
        {did.translated.length > 0 ? (
          <ul className="font-mono text-xs text-ink">
            {did.translated.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-ink-muted">Nothing changed on the way in.</p>
        )}
        <p className="text-sm text-ink">{did.did}</p>
      </Block>
      <Block title="Going out" source={outgoing.sample ? SAMPLE : RAN} testId="data-out">
        <pre className="overflow-x-auto border border-line bg-surface-subtle p-2 font-mono text-xs text-ink">
          {json(outgoing.value)}
        </pre>
      </Block>
    </div>
  );
}
