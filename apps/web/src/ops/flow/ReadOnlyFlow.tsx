// A workflow of a saved version as the chart, read only (docs/builder-plan.md §12, F6): the agent
// page's Workflow tab on an older version (`workflow?version=N`). No +, no dragging, nothing to
// settle: the boxes and arrows as that version had them, with zoom, Fit and each box's details on
// hover. A stored v3 workflow is read as a process first (every id kept; nothing stored changes).
import type { AgentBundle } from "@countersign/core";
import { useMemo, useState } from "react";
import { readProcessBundle } from "../builder/model";
import { Chart } from "./Chart";
import { FlowDndContext } from "./dnd";
import { agentEnds } from "./frame";
import type { StatusMap } from "./types";

const NO_STATUS: StatusMap = new Map();
const NOTHING = () => {};
/** Read only: nothing can be dropped, so nothing is ever moved, added or connected. */
const NO_EVENTS = { onMove: NOTHING, onInsert: NOTHING, onConnect: NOTHING };

export default function ReadOnlyFlow({
  workflow,
}: {
  workflow: AgentBundle["workflows"][number];
}) {
  // DECISION (F6): an older version is read without the catalog (the tab has none), so a v3 skill
  // that wrapped a tool reads as a skill step here; the builder, which has it, reads it as a write.
  const process = useMemo(
    () =>
      readProcessBundle({ workflows: [workflow] } as unknown as AgentBundle, {}).workflows[0]
        ?.workflow,
    [workflow],
  );
  const ends = useMemo(
    () => (process ? agentEnds(process) : { start: null, givesBack: null }),
    [process],
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  if (!process) return null;
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
          {...NO_EVENTS}
        />
      </FlowDndContext>
    </div>
  );
}
