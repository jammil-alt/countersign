// The client page's billing section (docs/plan.md §1.32): set the client up (its Stripe customer),
// each agent's price and where it comes from, the month so far with what it cost us, and the
// statements with Stripe's links. Prices are changed on each agent's Settings tab.
import { useState } from "react";
import { Link } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { CreditMeter, price, StatementLines } from "../../billing/parts";
import { Field, TextInput } from "../../ui/forms";
import { Button, Card, ErrorNotice, SectionLabel } from "../../ui/primitives";
import { cost, count, periodLabel } from "../../usage/format";
import { Notice, useAction } from "../agents/ui";
import { SOURCE_LABEL } from "./Billing";
import { OpsStatementCard } from "./BillingStatement";

export function ClientBillingSection({ clientId }: { clientId: string }) {
  const { data, error, reload } = useApi(apiRoutes.opsBillingClient, { params: { id: clientId } });
  const action = useAction();
  const [email, setEmail] = useState("");

  if (error) {
    return (
      <section className="mt-8">
        <SectionLabel>Billing</SectionLabel>
        <ErrorNotice error={error} onRetry={reload} />
      </section>
    );
  }
  if (!data) return null;
  const c = data.client;
  const m = c.monthSoFar;

  async function setUp() {
    const out = await action.call(apiRoutes.opsBillingSetup, {
      params: { id: clientId },
      body: email.trim() ? { email: email.trim() } : {},
    });
    if (out.ok) reload();
  }

  return (
    <section className="mt-8" data-testid="ops-client-billing">
      <SectionLabel
        action={
          <Link to="/ops/billing" className="ds-btn ds-btn--link text-sm">
            Billing settings
          </Link>
        }
      >
        Billing
      </SectionLabel>
      <div className="flex flex-col gap-4">
        <Card className="flex flex-col gap-4 p-5">
          {c.setUp ? (
            <p className="text-ink" data-testid="ops-client-billing-setup-done">
              Billed through Stripe
              {c.email
                ? `; invoices go to ${c.email}`
                : "; no billing email, so Stripe can't email invoices yet"}
              .
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-ink">
                Not billed yet. Setting up makes this client a Stripe customer; from then on we
                record its active agents each day and build its statement on the 1st of each month.
              </p>
              <div className="flex flex-wrap items-end gap-3">
                <Field
                  label="Billing email"
                  hint="Where Stripe sends invoices"
                  className="min-w-64 flex-1"
                >
                  <TextInput
                    type="email"
                    data-testid="ops-client-billing-email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </Field>
                <Button
                  variant="primary"
                  data-testid="ops-client-billing-setup"
                  disabled={action.busy || !data.stripeConfigured}
                  onClick={() => void setUp()}
                >
                  Set up billing
                </Button>
              </div>
              {data.stripeConfigured ? null : (
                <Notice tone="neutral">Stripe is not connected yet.</Notice>
              )}
            </div>
          )}
          {action.error ? <ErrorNotice error={action.error} /> : null}

          <div>
            <h3 className="mb-2 font-medium text-ink">Agents' prices</h3>
            {data.agents.length === 0 ? (
              <p className="text-sm text-ink-muted">No agents yet.</p>
            ) : (
              <div className="dt dt-ana overflow-x-auto">
                <table data-testid="ops-client-billing-agents">
                  <thead>
                    <tr className="dt-cols">
                      <th>Agent</th>
                      <th className="n">A month</th>
                      <th className="n">Credits</th>
                      <th>From</th>
                      <th>
                        <span className="sr-only">Change</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.agents.map((a) => (
                      <tr key={a.agentId} data-testid={`ops-client-billing-agent-${a.agentId}`}>
                        <td>
                          <span className="flex flex-col py-1">
                            <span className="text-ink">{a.name}</span>
                            <span className="text-sm text-ink-muted">
                              {a.runStatus === "active" ? "Active" : (a.runStatus ?? "Draft")}
                            </span>
                          </span>
                        </td>
                        <td className="n text-ink">{price(a.price.monthlyPrice)}</td>
                        <td className="n">{count(a.price.includedCredits)}</td>
                        <td className="text-sm text-ink-muted">
                          {a.price.source === "template" && a.template
                            ? `${a.template.name}'s price`
                            : SOURCE_LABEL[a.price.source]}
                          {a.override ? ` · ${a.override.note}` : ""}
                        </td>
                        <td>
                          <Link
                            to={`/ops/clients/${clientId}/agents/${a.slug}/settings`}
                            className="ds-btn ds-btn--link text-sm"
                          >
                            Change
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {c.setUp ? (
            <div className="flex flex-col gap-3">
              <h3 className="font-medium text-ink">This month so far</h3>
              <p className="text-sm text-ink-muted">
                {periodLabel(m.period.start, m.period.through)} · our cost so far{" "}
                <span className="text-ink" data-testid="ops-client-billing-cost">
                  {cost(c.costUsd)}
                </span>
              </p>
              <CreditMeter
                used={m.creditsUsed}
                allowance={m.creditsIncluded}
                testId="ops-client-billing-meter"
              />
              <StatementLines
                lines={m.lines}
                daysInMonth={m.daysInMonth}
                summary={m}
                total={m.total}
                totalLabel="Total so far"
                testId="ops-client-billing-month"
              />
            </div>
          ) : null}
        </Card>

        {data.statements.length > 0 ? (
          <div className="flex flex-col gap-3" data-testid="ops-client-billing-statements">
            <h3 className="font-medium text-ink">Statements</h3>
            {data.statements.map((s) => (
              <OpsStatementCard
                key={s.id}
                statement={s}
                stripeConfigured={data.stripeConfigured}
                onChanged={reload}
              />
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
