// The client page's Settings, Business hours and Channels (R8, docs/plan.md §1.86; ARCHITECTURE
// §10.14 "The Library and the client's settings"): what the portal shows the client, from the back
// office. Business hours and each person's hours are the client's own, so they are read-only here
// (`GET /api/ops/clients/:id/hours`); the client admin sets them in the portal. The account's
// channels are ours to set (`PUT /api/ops/clients/:id/channels`); an agent's own stay on the
// agent's page. Back-office words are English.
import type { ChannelLine } from "@countersign/core";
import { Link } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { ChannelLines } from "../../channels/ChannelLines";
import { BusinessHoursCard, PersonHoursLine, PersonHoursSummary } from "../../hours/HoursParts";
import { ChannelsEditor } from "../../people/PeoplePanel";
import { AgentBadge, PersonBadge } from "../../ui/badges";
import { Loaded, Section } from "../../ui/page";
import { Card, Tag } from "../../ui/primitives";

/** Business hours and people's hours, read-only: the client admin changes them in the portal. */
export function ClientHoursSection({ clientId }: { clientId: string }) {
  const state = useApi(apiRoutes.opsClientHours, { params: { id: clientId } });
  return (
    <Section title="Business hours" testId="ops-client-settings-hours">
      <p className="text-sm text-ink-muted">
        Their admin sets these in the portal. Deadlines in business hours run on them.
      </p>
      <Loaded state={state}>
        {(data) => {
          // DECISION: only people with hours or away dates of their own are listed: everyone
          // else works the business's hours, and a client's contacts can run to thousands.
          const own = data.people.filter((p) => p.hours !== null);
          return (
            <div className="flex flex-col gap-6">
              <BusinessHoursCard
                data={data.business}
                title="Their week"
                zoneNote="The zone is the client's timezone, set under General."
                testId="ops-client-business-hours"
              />
              <Card
                title="People's own hours"
                meta={`${own.length} of ${data.people.length}`}
                testId="ops-client-people-hours"
              >
                {own.length === 0 ? (
                  <p className="ui-card__body text-sm text-ink-muted">
                    Everyone works the business's hours, and nobody is away.
                  </p>
                ) : (
                  <ul>
                    {own.map((p) => (
                      <li
                        key={`${p.kind}:${p.id}`}
                        data-testid={`ops-client-person-hours-${p.id}`}
                        className="flex flex-col gap-3 border-b border-line px-6 py-4 last:border-b-0"
                      >
                        <div className="flex flex-wrap items-center gap-3">
                          <PersonBadge name={p.name} plain size="sm" />
                          <span className="font-medium text-ink">{p.name}</span>
                          <Tag>{p.kind === "user" ? "Team" : "Contact"}</Tag>
                          <PersonHoursLine hours={p.hours} />
                        </div>
                        <PersonHoursSummary hours={p.hours} />
                      </li>
                    ))}
                  </ul>
                )}
                {own.length > 0 && own.length < data.people.length ? (
                  <p className="border-t border-line px-6 py-3 text-sm text-ink-muted">
                    Everyone else works the business's hours.
                  </p>
                ) : null}
              </Card>
            </div>
          );
        }}
      </Loaded>
    </Section>
  );
}

const SOURCE: Record<ChannelLine["source"], string> = {
  agent: "Its own",
  account: "The account's",
  default: "The default",
};

/** The account's number and email (ours to bind), and what each agent sends on. */
export function ClientChannelsSection({ clientId }: { clientId: string }) {
  const api = useApiClient();
  const state = useApi(apiRoutes.opsClientChannels, { params: { id: clientId } });
  return (
    <Section title="Channels" testId="ops-client-settings-channels">
      <Loaded state={state}>
        {(data) => (
          <div className="flex flex-col gap-6">
            <ChannelsEditor
              bindings={data.bindings}
              options={data.options}
              title="The account's channels"
              help="Every agent of theirs sends on these unless it has its own. A channel left on the default uses our number or sending for the client (Twilio, Resend), never a person's own mailbox."
              unbound="The default"
              testIdPrefix="ops-client"
              save={async (channels) => {
                const next = await api.call(apiRoutes.opsSetClientChannels, {
                  params: { id: clientId },
                  body: { channels },
                });
                state.reload();
                return next.bindings;
              }}
            />
            <Card title="In use" testId="ops-client-channels-account">
              {data.account.length === 0 ? (
                <p className="ui-card__body text-sm text-ink-muted">
                  No connection of theirs can carry a channel yet.
                </p>
              ) : (
                <ChannelLines
                  lines={data.account}
                  sourceText={(line) => SOURCE[line.source]}
                  testId="ops-client-channels-account-lines"
                />
              )}
            </Card>
            <Card title="Each agent" testId="ops-client-channels-agents">
              {data.agents.length === 0 ? (
                <p className="ui-card__body text-sm text-ink-muted">No agents yet.</p>
              ) : (
                <ul>
                  {data.agents.map((a) => (
                    <li
                      key={a.agentId}
                      data-testid={`ops-client-channels-agent-${a.agentId}`}
                      className="border-b border-line py-3 last:border-b-0"
                    >
                      <div className="flex flex-wrap items-center gap-3 px-6">
                        <AgentBadge name={a.name} size="sm" />
                        <span className="font-medium text-ink">{a.name}</span>
                        <Link
                          to={`/ops/agents/${a.agentId}`}
                          className="text-sm text-link hover:underline"
                        >
                          Its own channels are on its page
                        </Link>
                      </div>
                      <ChannelLines
                        lines={a.channels}
                        sourceText={(line) => SOURCE[line.source]}
                        testId={`ops-client-channels-agent-${a.agentId}-lines`}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        )}
      </Loaded>
    </Section>
  );
}
