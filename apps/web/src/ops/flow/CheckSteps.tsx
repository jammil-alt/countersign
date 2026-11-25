// Check the steps (docs/builder-plan.md §12.5 F5, docs/plan.md §1.170 "Check the steps"; design:
// docs/design/builder.html `stepsHTML`, `rowsHTML`, `pathHTML`): a new build's draft as a list of
// lines before the chart. The draft is made as today ("Draft it now", saved); this list is shown
// over that saved version and edits it (ids made once, never regenerated). How it starts maps onto
// the triggers; each top-level step is a line; a decision is a block with its paths. Build it saves
// the edited bundle as a new version and asks the Builder once to fill the lines typed by hand,
// then opens the agent's workflow. A build with no draft yet (List the steps myself) is drafted
// from the lines' words on Build it.
//
// The step model (docs/step-model-plan.md; stream Q): the list is in the step model
// (./CheckSteps5, ./checkModel5) and renders the parts in ./checkParts.

import { useLocation, useParams } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { ErrorNotice } from "../../ui/ErrorState";
import { Page } from "../../ui/page";
import { Loading } from "../../ui/primitives";
import type { NewId } from "../builder/model";
import { CheckBody5 } from "./CheckSteps5";
import type { CheckStepsState } from "./DescribeScreen";

/** The route's screen: `/ops/lab/check/:id`, with the words Describe passed in its state. */
export function CheckStepsScreen() {
  const { id = "" } = useParams();
  const location = useLocation();
  const words = (location.state as Partial<CheckStepsState> | null)?.words;
  return (
    <Page width="narrow" testId="flow-check-page">
      <CheckSteps buildId={id} words={words} />
    </Page>
  );
}

export interface CheckStepsProps {
  buildId: string;
  /** The words the draft was made from; else the build's first message, else its goal. */
  words?: string | undefined;
  /** New ids (tests pass a counter); core's uuidv7 by default. */
  newId?: NewId | undefined;
}

/** Loads the build and its draft's latest version, then the list over it. */
export function CheckSteps({ buildId, words, newId }: CheckStepsProps) {
  const build = useApi(apiRoutes.opsBuild, { params: { id: buildId } });
  const agentId = build.data?.build.agentId ?? null;
  const agent = useApi(apiRoutes.opsAgent, agentId ? { params: { id: agentId } } : null);
  if (build.error) return <ErrorNotice error={build.error} onRetry={build.reload} />;
  if (!build.data) return <Loading />;
  if (agentId && agent.error) return <ErrorNotice error={agent.error} onRetry={agent.reload} />;
  if (agentId && !agent.data) return <Loading />;
  const detail = build.data;
  const said =
    words ??
    detail.messages.find((m) => m.role === "operator")?.text ??
    detail.build.brief.goal?.text ??
    "";
  const data = agent.data ?? null;
  return (
    <CheckBody5
      // Read once: a refresh after Build it saves must not reset the lines under way.
      key={agentId ?? "none"}
      detail={detail}
      agent={data}
      words={said}
      newId={newId}
    />
  );
}
