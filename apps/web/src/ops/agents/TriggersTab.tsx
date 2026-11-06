// The agent page's Triggers tab, until UI-2c's Triggers screen (O7) takes its place: how a client
// agent starts, read from GET /api/ops/agents/:id/triggers (the live version's, else the latest's).
// Triggers change in the workflow builder, as part of a new version.
import type { TriggerListItem } from "@countersign/core";
import { Link } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { shortTime } from "../../runs/format";
import { Loaded } from "../../ui/page";
import { Card, EmptyState, Tag } from "../../ui/primitives";
import { StatusChip } from "../../ui/status";

const TYPE_LABEL: Record<string, string> = {
  event: "Event",
  schedule: "Schedule",
  manual: "Manual",
  command: "Command",
  webhook: "Webhook",
  message: "Message",
  handoff: "Another agent",
};

function guardsText(t: TriggerListItem): string {
  const keys = Object.keys(t.guards);
  return keys.length === 0 ? "—" : keys.join(", ");
}

export function TriggersTab({ agentId, base }: { agentId: string; base: string }) {
  const triggers = useApi(apiRoutes.opsAgentTriggers, { params: { id: agentId } });
  return (
    <Loaded state={triggers}>
      {(data) => (
        <Card
          title="How it starts"
          testId="agent-triggers"
          meta={
            <span className="text-sm text-ink-muted">
              {data.live ? "Live version" : "Latest version"}
              {data.commandName ? ` · /${data.commandName}` : ""}
              {data.address ? ` · ${data.address}` : ""}
            </span>
          }
        >
          {data.triggers.length === 0 ? (
            <div className="p-6">
              <EmptyState>No triggers yet. Add one in the workflow builder.</EmptyState>
            </div>
          ) : (
            <div className="dt dt-ana overflow-x-auto rounded-none border-x-0 border-b-0">
              <table>
                <thead>
                  <tr className="dt-cols">
                    <th>Type</th>
                    <th>When</th>
                    <th>Starts workflow</th>
                    <th>Guards</th>
                    <th>Last fired</th>
                    <th>On</th>
                  </tr>
                </thead>
                <tbody>
                  {data.triggers.map((t) => (
                    <tr
                      key={`${t.workflow}:${t.triggerId}`}
                      data-testid={`agent-trigger-${t.triggerId}`}
                    >
                      <td>
                        <Tag>{TYPE_LABEL[t.type] ?? t.type}</Tag>
                      </td>
                      <td className="text-ink">{t.summary}</td>
                      <td>
                        <Link
                          to={`${base}/workflows/${t.workflow}`}
                          className="text-link hover:underline"
                        >
                          {t.workflowName}
                        </Link>
                      </td>
                      <td className="text-sm text-ink-muted">{guardsText(t)}</td>
                      <td className="text-sm">
                        {t.lastFired ? (
                          <Link
                            to={`/ops/runs/${t.lastFired.runId}`}
                            className="figures text-link hover:underline"
                          >
                            {t.lastFired.mode === "test" ? "Test · " : ""}
                            {shortTime(t.lastFired.at)}
                          </Link>
                        ) : (
                          <span className="text-ink-muted">Never</span>
                        )}
                      </td>
                      <td>
                        <StatusChip state={t.enabled ? "done" : "idle"}>
                          {t.enabled ? "On" : "Off"}
                        </StatusChip>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </Loaded>
  );
}
