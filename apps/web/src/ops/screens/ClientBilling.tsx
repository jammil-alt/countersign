// The client page's billing section (docs/plan.md §1.24): set the client up in Stripe, its period so
// far (base, allowance, credits used, extra, our cost), the daily usage reports and its invoices.
import { useState } from "react";
import { Link } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { CreditMeter, InvoiceTable, price } from "../../billing/parts";
import { Field, TextInput } from "../../ui/forms";
import { Badge, Button, Card, ErrorNotice, SectionLabel } from "../../ui/primitives";
import { cost, count, dayLabel, periodLabel } from "../../usage/format";
import { Notice, useAction } from "../agents/ui";

const REPORT_STATUS = {
  sent: { label: "Sent", tone: "positive" },
  none: { label: "Within allowance", tone: "neutral" },
  pending: { label: "Sending", tone: "accent" },
  failed: { label: "Failed", tone: "risk" },
} as const;

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

  async function setUp() {
    const out = await action.call(apiRoutes.opsBillingSetup, {
      params: { id: clientId },
      body: email.trim() ? { email: email.trim() } : {},
    });
    if (out.ok) reload();
  }
  async function sync() {
    const out = await action.call(apiRoutes.opsBillingSync, { params: { id: clientId } });
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
      <Card className="flex flex-col gap-5 p-5">
        {c.setUp ? (
          <>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-ink" data-testid="ops-client-billing-plan">
                  {count(c.activeAgents)} active {c.activeAgents === 1 ? "agent" : "agents"}
                  {c.base ? ` · ${price(c.base)} a month` : ""}
                  {c.billedAgents !== c.activeAgents
                    ? ` · Stripe has ${count(c.billedAgents)}, updating`
                    : ""}
                </p>
                <p className="text-sm text-ink-muted">
                  {periodLabel(c.period.start, c.period.through)} · our cost so far{" "}
                  <span className="text-ink" data-testid="ops-client-billing-cost">
                    {cost(c.costUsd)}
                  </span>{" "}
                  · {count(c.reportedCredits)} extra credits reported
                </p>
              </div>
              <span className="flex items-center gap-2">
                {c.lastInvoice?.status === "payment_failed" ? (
                  <Badge tone="risk">Payment failed</Badge>
                ) : null}
                {c.subscriptionStatus ? <Badge>{c.subscriptionStatus}</Badge> : null}
                <Button
                  size="sm"
                  data-testid="ops-client-billing-sync"
                  disabled={action.busy || !data.stripeConfigured}
                  onClick={() => void sync()}
                >
                  Sync now
                </Button>
              </span>
            </div>
            <CreditMeter
              used={c.creditsUsed}
              allowance={c.allowance}
              testId="ops-client-billing-meter"
            />
          </>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-ink">
              Not billed yet. Setting up makes this client a Stripe customer with a subscription:
              {` ${count(c.activeAgents)} active ${c.activeAgents === 1 ? "agent" : "agents"}`}
              {c.base ? ` at ${price(c.base)} a month` : ""}, plus extra credits.
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <Field
                label="Billing email"
                hint="Where Stripe sends invoices (optional)"
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

        {data.reports.length > 0 ? (
          <div>
            <h3 className="mb-2 font-medium text-ink">Usage reported this period</h3>
            <div className="dt overflow-x-auto">
              <table data-testid="ops-client-billing-reports">
                <thead>
                  <tr className="dt-cols">
                    <th>Day</th>
                    <th className="n">Credits</th>
                    <th className="n">Allowance</th>
                    <th className="n">Extra</th>
                    <th className="n">Sent</th>
                    <th className="n">Our cost</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.reports.map((r) => {
                    const s = REPORT_STATUS[r.status];
                    return (
                      <tr key={r.id}>
                        <td className="text-ink">{dayLabel(r.day)}</td>
                        <td className="n">{count(r.credits)}</td>
                        <td className="n">{count(r.allowance)}</td>
                        <td className="n">{count(r.overage)}</td>
                        <td className="n">{count(r.quantity)}</td>
                        <td className="n">{cost(r.costUsd)}</td>
                        <td title={r.error ?? undefined}>
                          <Badge tone={s.tone}>{s.label}</Badge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}

        {c.setUp ? (
          <div>
            <h3 className="mb-2 font-medium text-ink">Invoices</h3>
            {data.invoicesUnavailable ? (
              <Notice tone="neutral">
                We couldn't reach Stripe for the invoices. Try again later.
              </Notice>
            ) : data.invoices.length === 0 ? (
              <p className="text-sm text-ink-muted">
                No invoices yet. The first comes at the end of the month.
              </p>
            ) : (
              <InvoiceTable invoices={data.invoices} testId="ops-client-billing-invoices" />
            )}
          </div>
        ) : null}
      </Card>
    </section>
  );
}
