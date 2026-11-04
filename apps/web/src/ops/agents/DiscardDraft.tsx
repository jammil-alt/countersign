// Discarding a draft that was never published (a Builder draft you don't want, or any unpublished
// agent), and restoring it. A discarded draft leaves the lists, can't be published or activated,
// and keeps its versions; it still opens by its address, where Restore brings it back.
import { useState } from "react";
import type { AgentSummary } from "../../api/routes";
import { apiRoutes } from "../../api/routes";
import { Button } from "../../ui/primitives";
import { errorText, Notice, notifyAgentsChanged, useAction } from "./ui";

/** Whether an agent can be discarded: never published, not a test copy, not discarded already. */
export function canDiscard(agent: Pick<AgentSummary, "liveVersionId" | "testCopy" | "status">) {
  return !agent.liveVersionId && !agent.testCopy && agent.status === "active";
}

/** "Discard draft", with a confirmation in place. */
export function DiscardButton({
  agent,
  label = "Discard draft",
  onDiscarded,
}: {
  agent: Pick<AgentSummary, "id" | "name">;
  label?: string;
  onDiscarded(agent: AgentSummary): void;
}) {
  const [confirming, setConfirming] = useState(false);
  const action = useAction();

  async function discard() {
    const res = await action.call(apiRoutes.opsDiscardAgent, { params: { id: agent.id } });
    if (res.ok) {
      setConfirming(false);
      notifyAgentsChanged();
      onDiscarded(res.data.agent);
    }
  }

  if (!confirming) {
    return (
      <Button variant="ghost" data-testid="agent-discard" onClick={() => setConfirming(true)}>
        {label}
      </Button>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-2" data-testid="agent-discard-confirm">
      <span className="text-sm text-ink">Discard {agent.name}? You can restore it later.</span>
      <Button
        variant="primary"
        size="sm"
        data-testid="agent-discard-yes"
        disabled={action.busy}
        onClick={discard}
      >
        {action.busy ? "Discarding…" : "Discard"}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
        Keep it
      </Button>
      {action.error ? <span className="ds-error text-sm">{errorText(action.error)}</span> : null}
    </span>
  );
}

/** What a discarded agent's page says, with Restore. */
export function DiscardedNotice({
  agent,
  onRestored,
}: {
  agent: Pick<AgentSummary, "id">;
  onRestored(): void;
}) {
  const action = useAction();
  async function restore() {
    const res = await action.call(apiRoutes.opsRestoreAgent, { params: { id: agent.id } });
    if (res.ok) {
      notifyAgentsChanged();
      onRestored();
    }
  }
  return (
    <Notice tone="neutral" testId="agent-discarded">
      <span className="flex flex-wrap items-center justify-between gap-3">
        <span>
          This draft was discarded. It doesn't show in lists and can't be published or activated.
          Its versions are kept.
        </span>
        <Button size="sm" data-testid="agent-restore" disabled={action.busy} onClick={restore}>
          {action.busy ? "Restoring…" : "Restore"}
        </Button>
      </span>
      {action.error ? (
        <span className="ds-error mt-2 block text-sm">{errorText(action.error)}</span>
      ) : null}
    </Notice>
  );
}
