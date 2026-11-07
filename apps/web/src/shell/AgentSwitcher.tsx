// From one agent's page to another of the same client's: a plain select over the client's agents
// (the portal's services, or a client's agents in the back office). Picking one opens its page.
import { useNavigate } from "react-router-dom";
import { useI18n } from "../i18n/i18n";
import { Icon } from "../ui/icons";

export interface SwitchAgent {
  key: string;
  name: string;
  href: string;
}

/** Whether there is another agent to switch to from `current`'s page. */
export function canSwitch(current: string | undefined, agents: readonly SwitchAgent[]): boolean {
  return agents.length >= 2 && agents.some((a) => a.key === current);
}

export function AgentSwitcher({
  current,
  agents,
}: {
  /** The `key` of the agent whose page this is. */
  current: string;
  agents: readonly SwitchAgent[];
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  if (!canSwitch(current, agents)) return null;
  return (
    <label className="ds-selectwrap ui-agentswitch">
      <span className="sr-only">{t("shell.switchAgent")}</span>
      <select
        data-testid="agent-switcher"
        value={current}
        onChange={(e) => {
          const next = agents.find((a) => a.key === e.target.value);
          if (next) navigate(next.href);
        }}
        className="ds-select"
      >
        {agents.map((a) => (
          <option key={a.key} value={a.key}>
            {a.name}
          </option>
        ))}
      </select>
      <Icon name="chevron-down" className="ui-agentswitch__chev" />
    </label>
  );
}
