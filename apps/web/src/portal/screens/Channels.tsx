// `/settings/channels`, Channels (R8, docs/plan.md §1.86; ARCHITECTURE §10.14 "Communications"):
// the account's number and email address, and each agent's own where it has one (an agent's own is
// used first, else the account's). Everyone on the team reads them (`GET /api/settings/channels`).
// We set them up: the account's are the operator's (`PUT /api/ops/clients/:id/channels`) and an
// agent's own too, so nothing here changes them; the page says how to ask.
import { Link } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { ChannelLines } from "../../channels/ChannelLines";
import { useI18n } from "../../i18n/i18n";
import { AgentBadge } from "../../ui/badges";
import { Loaded } from "../../ui/page";
import { Card, EmptyState } from "../../ui/primitives";
import { askSloan } from "../paths";

// DECISION (R8): read-only for the client admin too: the channels routes give the portal nothing
// to change (the account's and each agent's are bound by the operator), so the page asks Sloan.
export function PortalChannels() {
  const { t } = useI18n();
  const state = useApi(apiRoutes.portalChannels);
  return (
    <Loaded state={state}>
      {(data) => (
        <div className="flex flex-col gap-6" data-testid="portal-channels">
          <Card title={t("channels.account")} testId="portal-channels-account">
            <p className="ui-card__body text-sm text-ink-muted">{t("channels.accountHelp")}</p>
            {data.account.length === 0 ? (
              <p
                className="border-t border-line px-6 py-4 text-sm text-ink-muted"
                data-testid="portal-channels-account-none"
              >
                {t("channels.accountNone")}
              </p>
            ) : (
              <div className="border-t border-line">
                <ChannelLines lines={data.account} testId="portal-channels-account-lines" />
              </div>
            )}
          </Card>
          <Card title={t("channels.agents")} testId="portal-channels-agents">
            {data.agents.length === 0 ? (
              <EmptyState>{t("channels.agentsNone")}</EmptyState>
            ) : (
              <ul>
                {data.agents.map((a) => {
                  const hasOwn = a.channels.some((c) => c.source === "agent");
                  return (
                    <li
                      key={a.agentId}
                      data-testid={`portal-channels-agent-${a.agentId}`}
                      className="border-b border-line py-3 last:border-b-0"
                    >
                      <div className="flex items-center gap-3 px-6 max-sm:px-4">
                        <AgentBadge name={a.name} size="sm" />
                        <span className="font-medium text-ink">{a.name}</span>
                      </div>
                      {hasOwn ? (
                        <ChannelLines
                          lines={a.channels}
                          sourceText={(line) =>
                            line.source === "agent" ? t("channels.own") : t("channels.fromAccount")
                          }
                          testId={`portal-channels-agent-${a.agentId}-lines`}
                        />
                      ) : (
                        <p className="px-6 pt-1 text-sm text-ink-muted max-sm:px-4">
                          {t("channels.agentUsesAccount")}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
          <p className="text-sm text-ink-muted" data-testid="portal-channels-change">
            {t("channels.change")}{" "}
            <Link to={askSloan(t("channels.changePrompt"))} className="text-link hover:underline">
              {t("channels.changeLink")}
            </Link>
          </p>
        </div>
      )}
    </Loaded>
  );
}
