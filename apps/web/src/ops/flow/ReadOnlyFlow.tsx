// A workflow of a saved version as the chart, read only (docs/builder-plan.md §12, F6): the agent
// page's Workflow tab on an older version (`workflow?version=N`). No +, no dragging, nothing to
// settle: the boxes and arrows as that version had them, with zoom, Fit and each box's details on
// hover. A step-model workflow is drawn as the steps builder draws it.
import { type AgentBundle, steps } from "@countersign/core";
import { useCallback, useMemo, useState } from "react";
import { useStepsCatalog } from "../builder/steps/catalog";
import { type BoxWords, boxWords, displayProcess } from "../builder/steps/display";
import type { Workflow } from "../builder/steps/types";
import { triggerTitle } from "../workflow/describe";
import { Chart } from "./Chart";
import { FlowDndContext } from "./dnd";
import type { FlowEnds, StatusMap } from "./types";

const NO_STATUS: StatusMap = new Map();
const NOTHING = () => {};
/** Read only: nothing can be dropped, so nothing is ever moved, added or connected. */
const NO_EVENTS = { onMove: NOTHING, onInsert: NOTHING, onConnect: NOTHING };

export default function ReadOnlyFlow({
  agentId,
  workflow,
}: {
  agentId: string;
  workflow: AgentBundle["workflows"][number];
}) {
  const catalog = useStepsCatalog(agentId);
  const flow = workflow.workflow as Workflow;
  const process = useMemo(() => displayProcess(flow, catalog.uses), [flow, catalog.uses]);
  const label = useCallback(
    (s: { id: string }): BoxWords => {
      const real = steps.findStep(flow.steps, s.id);
      return real ? boxWords(real, catalog.uses, flow) : { title: "", kind: "", detail: null };
    },
    [flow, catalog.uses],
  );
  const ends = useMemo<FlowEnds>(
    () => ({
      start: { title: "Starts when", lines: flow.triggers.map((t) => triggerTitle(t as never)) },
      givesBack: null,
    }),
    [flow.triggers],
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  return (
    <div className="flow-readonly" data-testid={`flow-readonly-${workflow.slug}`}>
      <FlowDndContext events={NO_EVENTS}>
        <Chart
          readOnly
          process={process}
          ends={ends}
          statuses={NO_STATUS}
          selected={selected}
          onSelect={setSelected}
          folded={folded}
          onFold={(id, fold) =>
            setFolded((f) => {
              const next = new Set(f);
              if (fold) next.add(id);
              else next.delete(id);
              return next;
            })
          }
          label={label as never}
          {...NO_EVENTS}
        />
      </FlowDndContext>
    </div>
  );
}
