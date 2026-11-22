// The agent page's Security tab (docs/agent-assurance-plan.md §5): a client agent's architecture and
// every security check with its evidence (counts and record ids, never contents) and the issue a
// check in review opened, with "Run the checks now". The checks also run every night.

import { assuranceRoutes } from "@countersign/core";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useApi, useApiClient } from "../../api/useApi";
import { AssuranceBody } from "../../assurance/AssuranceView";
import { Loaded } from "../../ui/page";
import { Button, ErrorNotice } from "../../ui/primitives";
import { SkeletonRows } from "../../ui/skeleton";
import { OPS_PATHS } from "../paths";
import { SECURITY_PATHS } from "../security/paths";

export function SecurityTab({ agentId }: { agentId: string }) {
  const api = useApiClient();
  const view = useApi(assuranceRoutes.opsAgentAssurance, { params: { id: agentId } });
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      await api.call(assuranceRoutes.opsAgentAssuranceRun, { params: { id: agentId }, body: {} });
      view.reload();
    } catch (e) {
      setError(e);
    } finally {
      setRunning(false);
    }
  };
  return (
    <div data-testid="agent-security">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={run} working={running} data-testid="assurance-run">
          {running ? "Running the checks…" : "Run the checks now"}
        </Button>
        <span className="text-xs text-ink-muted">
          They also run every night. Results are kept and never changed.
        </span>
        <Link
          to={`${SECURITY_PATHS.evidence}?agent=${agentId}`}
          className="ml-auto text-sm hover:underline"
          data-testid="assurance-evidence"
        >
          Evidence for an auditor
        </Link>
      </div>
      {error ? <ErrorNotice error={error} /> : null}
      <Loaded state={view} skeleton={<SkeletonRows rows={8} columns={1} />}>
        {(v) => <AssuranceBody view={v} audience="ops" issueHref={OPS_PATHS.issue} />}
      </Loaded>
    </div>
  );
}
