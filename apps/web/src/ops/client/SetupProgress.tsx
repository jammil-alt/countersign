// The client page's Setup tab, Progress (docs/setup-plan.md §8; docs/plan.md §1.185, SU6): stream
// OPS. Each agent being set up by chapter with who it waits on, the people waiting (Nudge), the
// change asks from the walkthrough and tries, Do it on a call, the runbook and Start trial.
import { useParams } from "react-router-dom";
import { ClientFrame } from "./ClientFrame";

export function OpsSetupProgressScreen() {
  const { clientId = "" } = useParams();
  return (
    <ClientFrame clientId={clientId} intro="Where the client's setup stands, chapter by chapter.">
      <p className="text-ink-muted" data-testid="ops-setup-progress">
        The Progress board is on its way.
      </p>
    </ClientFrame>
  );
}
