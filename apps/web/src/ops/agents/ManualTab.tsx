// The agent page's Manual tab (docs/builder-plan.md §5, B3): the manual of the version shown (what
// it does, how it works, its decisions, decision points and known risks, with how often a client
// agent's runs hit each), with a client agent's notes for its client read live. A build writes it
// into the draft; it changes with the agent's versions. A learned note can be deleted here (G5):
// it is the client's record, not the version's, so that makes no version.

import { manualRoutes } from "@countersign/core";
import { useState } from "react";
import { useApi, useApiClient } from "../../api/useApi";
import { ManualSections, OPS_MANUAL_TEXT } from "../../manual/ManualSections";
import { Loaded } from "../../ui/page";
import { ErrorNotice } from "../../ui/primitives";
import { SkeletonRows } from "../../ui/skeleton";

export function OpsManualTab({ agentId, version }: { agentId: string; version: number | null }) {
  const api = useApiClient();
  const manual = useApi(manualRoutes.opsAgentManual, {
    params: { id: agentId },
    query: version === null ? {} : { version },
  });
  const [error, setError] = useState<unknown>(null);
  const forget = async (noteId: string) => {
    setError(null);
    try {
      await api.call(manualRoutes.opsAgentForgetNote, { params: { id: agentId, noteId } });
      manual.reload();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <div data-testid="agent-manual">
      {error ? <ErrorNotice error={error} /> : null}
      <Loaded state={manual} skeleton={<SkeletonRows rows={6} columns={1} />}>
        {(view) => (
          <ManualSections view={view} text={OPS_MANUAL_TEXT} onForget={(id) => void forget(id)} />
        )}
      </Loaded>
    </div>
  );
}
