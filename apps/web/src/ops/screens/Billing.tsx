// `/ops/billing` (docs/plan.md §1.32): we work out each client's bill and Stripe sends it. The
// statements to review (adjust, send, void, or send every draft), each client's month so far with
// what it cost us (operator only; the portal never sees cost), template prices, and the settings:
// the default price and credits, the price of an extra credit, auto-send, days until due and the
// unit costs that turn usage into credits.
import type { BillingSettings, OpsBilling, UnitCost } from "@countersign/core";
import { type ReactNode, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { price } from "../../billing/parts";
import { Field, TextInput } from "../../ui/forms";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  SectionLabel,
} from "../../ui/primitives";
import { cost, count, periodLabel } from "../../usage/format";
import { Notice, Select, useAction } from "../agents/ui";
import { OpsStatementCard } from "./BillingStatement";

export const SOURCE_LABEL = {
  override: "Own price",
  template: "Template's price",
  platform: "Platform agent, free",
  default: "Default price",
} as const;

export function OpsBillingScreen() {
  const { data, error, loading, reload } = useApi(apiRoutes.opsBilling);
  return (
    <div>
      <PageHeader
        title="Billing"
        subtitle="We work out each client's bill: a monthly price per agent with credits included, then extra credits. Stripe sends the invoice and takes payment. One credit is one cent of what the work cost us."
      />
      {loading && !data ? <Loading /> : null}
      {error ? <ErrorNotice error={error} onRetry={reload} /> : null}
      {data ? (
        <>
          <StripeStatus data={data} />
          <ToReview data={data} onChange={reload} />
          <ClientsTable data={data} />
          <TemplatePrices data={data} />
          <SettingsForm data={data} onSaved={reload} />
        </>
      ) : null}
    </div>
  );
}

function StripeStatus({ data }: { data: OpsBilling }) {
  if (data.stripeConfigured && data.webhookConfigured) return null;
  return (
    <div className="mb-6">
      <Notice tone="neutral" testId="ops-billing-stripe-status">
        {data.stripeConfigured
          ? "Stripe's webhook secret is not set, so paid and failed invoices won't show here yet."
          : "Stripe is not connected yet: set STRIPE_SECRET_KEY to set clients up and send statements."}
      </Notice>
    </div>
  );
}

function ToReview({ data, onChange }: { data: OpsBilling; onChange: () => void }) {
  const action = useAction();
  const [result, setResult] = useState<string | null>(null);
  const drafts = data.toReview.filter((s) => s.status === "draft");

  async function sendAll() {
    setResult(null);
    const out = await action.call(apiRoutes.opsSendDrafts);
    if (!out.ok) return;
    const sent = out.data.results.filter((r) => !r.error).length;
    const failed = out.data.results.length - sent;
    setResult(
      failed > 0
        ? `${sent} sent, ${failed} stopped. Each says why below.`
        : `${sent} ${sent === 1 ? "statement" : "statements"} sent.`,
    );
    onChange();
  }

  return (
    <section className="mb-8" data-testid="ops-billing-review">
      <SectionLabel
        action={
          drafts.length > 0 ? (
            <Button
              size="sm"
              variant="primary"
              data-testid="ops-billing-send-all"
              disabled={action.busy || !data.stripeConfigured}
              onClick={() => void sendAll()}
            >
              {action.busy ? "Sending…" : `Send all drafts (${drafts.length})`}
            </Button>
          ) : null
        }
      >
        Statements to review
      </SectionLabel>
      {result ? (
        <div className="mb-3">
          <Notice tone="positive" testId="ops-billing-send-all-result">
            {result}
          </Notice>
        </div>
      ) : null}
      {action.error ? (
        <div className="mb-3">
          <ErrorNotice error={action.error} />
        </div>
      ) : null}
      {data.toReview.length === 0 ? (
        <EmptyState>
          Nothing to review. Each client's statement for a month is built on the 1st of the next.
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-3">
          {data.toReview.map((s) => (
            <OpsStatementCard
              key={s.id}
              statement={s}
              showClient
              stripeConfigured={data.stripeConfigured}
              onChanged={onChange}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ClientsTable({ data }: { data: OpsBilling }) {
  return (
    <section className="mb-8">
      <SectionLabel>This month so far</SectionLabel>
      {data.clients.length === 0 ? (
        <EmptyState>No clients yet.</EmptyState>
      ) : (
        <div className="dt dt-ana overflow-x-auto">
          <table data-testid="ops-billing-clients">
            <thead>
              <tr className="dt-cols">
                <th>Client</th>
                <th className="n">Agents</th>
                <th className="n">So far</th>
                <th className="n">Credits used</th>
                <th className="n">Included</th>
                <th className="n">Extra</th>
                <th className="n">Our cost</th>
                <th>Billing</th>
              </tr>
            </thead>
            <tbody>
              {data.clients.map((c) => {
                const m = c.monthSoFar;
                return (
                  <tr key={c.id} data-testid={`ops-billing-row-${c.id}`}>
                    <td>
                      <span className="flex flex-col py-1">
                        <Link
                          to={`/ops/clients/${c.id}`}
                          className="font-medium text-ink hover:underline"
                        >
                          {c.name}
                        </Link>
                        <span className="text-sm text-ink-muted">
                          {periodLabel(m.period.start, m.period.through)}
                        </span>
                      </span>
                    </td>
                    <td className="n">{count(c.activeAgents)}</td>
                    <td className="n text-ink">{price(m.total)}</td>
                    <td className="n">{count(m.creditsUsed)}</td>
                    <td className="n">{count(m.creditsIncluded)}</td>
                    <td className="n">{count(m.extraCredits)}</td>
                    <td className="n">{cost(c.costUsd)}</td>
                    <td>
                      {c.setUp ? (
                        c.latestStatement?.status === "payment_failed" ? (
                          <Badge tone="risk">Payment failed</Badge>
                        ) : (
                          <Badge tone="positive">Billed</Badge>
                        )
                      ) : (
                        <Link
                          to={`/ops/clients/${c.id}`}
                          className="ds-btn ds-btn--link text-sm"
                          data-testid={`ops-billing-setup-${c.id}`}
                        >
                          Set up on its page
                        </Link>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function TemplatePrices({ data }: { data: OpsBilling }) {
  return (
    <section className="mb-8">
      <SectionLabel>Template prices</SectionLabel>
      <p className="mb-3 text-sm text-ink-muted">
        A client agent takes its own price if it has one, else its template's, else the default.
        Change a template's price on its Settings tab; it applies from the next day recorded.
      </p>
      {data.templates.length === 0 ? (
        <EmptyState>No templates yet.</EmptyState>
      ) : (
        <div className="dt dt-ana overflow-x-auto">
          <table data-testid="ops-billing-templates">
            <thead>
              <tr className="dt-cols">
                <th>Template</th>
                <th className="n">A month</th>
                <th className="n">Credits included</th>
                <th>From</th>
              </tr>
            </thead>
            <tbody>
              {data.templates.map((t) => (
                <tr key={t.id} data-testid={`ops-billing-template-${t.slug}`}>
                  <td>
                    <Link
                      to={`/ops/templates/${t.slug}/settings`}
                      className="font-medium text-ink hover:underline"
                    >
                      {t.name}
                    </Link>
                  </td>
                  <td className="n text-ink">{price(t.effective.monthlyPrice)}</td>
                  <td className="n">{count(t.effective.includedCredits)}</td>
                  <td className="text-sm text-ink-muted">{SOURCE_LABEL[t.effective.source]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** The form's own copy of the settings: numbers as typed, checked when saved. */
interface Draft {
  defaultAgentPrice: string;
  defaultIncludedCredits: string;
  creditPrice: string;
  autoSend: boolean;
  daysUntilDue: string;
  unitCosts: { measure: string; unitCost: string; perUnits: string }[];
}

function draftOf(s: OpsBilling["settings"]): Draft {
  return {
    defaultAgentPrice: s.defaultAgentPrice,
    defaultIncludedCredits: String(s.defaultIncludedCredits),
    creditPrice: s.creditPrice,
    autoSend: s.autoSend,
    daysUntilDue: String(s.daysUntilDue),
    unitCosts: s.unitCosts.map((u) => ({ ...u, perUnits: String(u.perUnits) })),
  };
}

const WHOLE = /^\d{1,9}$/;
const DOLLARS = /^\d{1,10}(\.\d{1,4})?$/;

/** The settings from the form, or what is wrong with them. */
export function settingsFromDraft(d: Draft): { settings: BillingSettings } | { problem: string } {
  const agentPrice = d.defaultAgentPrice.trim().replace(/^\$/, "");
  const creditPrice = d.creditPrice.trim().replace(/^\$/, "");
  if (!DOLLARS.test(agentPrice)) {
    return { problem: "The default agent price is a dollar amount with up to 4 places." };
  }
  if (!WHOLE.test(d.defaultIncludedCredits)) {
    return { problem: "The credits included are a whole number." };
  }
  if (!DOLLARS.test(creditPrice)) {
    return { problem: "The price of an extra credit is a dollar amount with up to 4 places." };
  }
  if (!WHOLE.test(d.daysUntilDue) || Number(d.daysUntilDue) < 1 || Number(d.daysUntilDue) > 365) {
    return { problem: "Days until due is a whole number from 1 to 365." };
  }
  const unitCosts: UnitCost[] = [];
  for (const u of d.unitCosts) {
    if (!DOLLARS.test(u.unitCost.trim())) {
      return { problem: `The unit cost of ${u.measure} is a dollar amount with up to 4 places.` };
    }
    if (!WHOLE.test(u.perUnits) || Number(u.perUnits) < 1) {
      return { problem: `${u.measure} is priced per a whole number of units.` };
    }
    unitCosts.push({
      measure: u.measure,
      unitCost: u.unitCost.trim(),
      perUnits: Number(u.perUnits),
    });
  }
  return {
    settings: {
      defaultAgentPrice: agentPrice,
      defaultIncludedCredits: Number(d.defaultIncludedCredits),
      creditPrice,
      autoSend: d.autoSend,
      daysUntilDue: Number(d.daysUntilDue),
      unitCosts,
    },
  };
}

function SettingsForm({ data, onSaved }: { data: OpsBilling; onSaved: () => void }) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(data.settings));
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const action = useAction();
  // Re-fill the form only when the saved settings change by value, not on every reload: a refresh
  // after a statement is sent returns equal settings and must keep unsaved edits. Done while
  // rendering, not in an effect, so a first keystroke never races the re-fill.
  const savedSettings = JSON.stringify(data.settings);
  const [filledFrom, setFilledFrom] = useState(savedSettings);
  if (filledFrom !== savedSettings) {
    setFilledFrom(savedSettings);
    setDraft(draftOf(data.settings));
  }
  const set = (patch: Partial<Draft>) => {
    setSaved(false);
    setDraft((d) => ({ ...d, ...patch }));
  };
  const setCost = (i: number, patch: Partial<Draft["unitCosts"][number]>) =>
    set({ unitCosts: draft.unitCosts.map((u, j) => (j === i ? { ...u, ...patch } : u)) });
  const unpriced = data.measures.filter(
    (m) => !draft.unitCosts.some((u) => u.measure === m.measure),
  );
  const available = new Set(data.measures.filter((m) => m.available).map((m) => m.measure));

  async function save() {
    const out = settingsFromDraft(draft);
    if ("problem" in out) {
      setProblem(out.problem);
      return;
    }
    setProblem(null);
    const res = await action.call(apiRoutes.opsBillingSettings, { body: out.settings });
    if (res.ok) {
      setSaved(true);
      onSaved();
    }
  }

  return (
    <section data-testid="ops-billing-settings">
      <SectionLabel>Settings</SectionLabel>
      <Card className="flex flex-col gap-6 p-5">
        <p className="text-sm text-ink-muted">
          These are placeholders until prices are set. Prices apply from the next day recorded; a
          month's statement keeps the prices each day had.
        </p>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field
            label="Default agent price, a month (USD)"
            hint="For an agent with no price of its own or from its template"
          >
            <TextInput
              data-testid="ops-billing-agent-price"
              inputMode="decimal"
              value={draft.defaultAgentPrice}
              onChange={(e) => set({ defaultAgentPrice: e.target.value })}
            />
          </Field>
          <Field label="Default credits included, a month" hint="Pooled across a client's agents">
            <TextInput
              data-testid="ops-billing-allowance"
              inputMode="numeric"
              value={draft.defaultIncludedCredits}
              onChange={(e) => set({ defaultIncludedCredits: e.target.value })}
            />
          </Field>
          <Field
            label="Price of an extra credit (USD)"
            hint="For each credit past what a client's agents include"
          >
            <TextInput
              data-testid="ops-billing-credit-price"
              inputMode="decimal"
              value={draft.creditPrice}
              onChange={(e) => set({ creditPrice: e.target.value })}
            />
          </Field>
          <Field
            label="Days until an invoice is due"
            hint="Stripe emails the invoice with a link to pay"
          >
            <TextInput
              data-testid="ops-billing-due"
              inputMode="numeric"
              value={draft.daysUntilDue}
              onChange={(e) => set({ daysUntilDue: e.target.value })}
            />
          </Field>
        </div>
        <label className="flex items-start gap-2 text-sm text-ink">
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-slate"
            data-testid="ops-billing-auto-send"
            checked={draft.autoSend}
            onChange={(e) => set({ autoSend: e.target.checked })}
          />
          <span>
            Send each month's statements as soon as they are built
            <span className="block text-ink-muted">
              Off: they wait here as drafts for you to check, adjust and send.
            </span>
          </span>
        </label>

        <div>
          <h3 className="mb-1 font-medium text-ink">Unit costs</h3>
          <p className="mb-3 text-sm text-ink-muted">
            What one unit of each usage measure costs us, in dollars. A measure without a unit cost
            is not billed.
          </p>
          <div className="dt dt-ana overflow-x-auto">
            <table data-testid="ops-billing-unit-costs">
              <thead>
                <tr className="dt-cols">
                  <th>Measure</th>
                  <th>Cost (USD)</th>
                  <th>Per units</th>
                  <th>
                    <span className="sr-only">Remove</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {draft.unitCosts.map((u, i) => (
                  <tr key={u.measure} data-testid={`ops-billing-cost-${u.measure}`}>
                    <td>
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="reference text-ink">{u.measure}</span>
                        {available.has(u.measure) ? null : <Badge>Counts once usage has it</Badge>}
                      </span>
                    </td>
                    <td>
                      <TextInput
                        aria-label={`Cost of ${u.measure}`}
                        className="w-28"
                        inputMode="decimal"
                        value={u.unitCost}
                        onChange={(e) => setCost(i, { unitCost: e.target.value })}
                      />
                    </td>
                    <td>
                      <TextInput
                        aria-label={`Units of ${u.measure} per cost`}
                        className="w-24"
                        inputMode="numeric"
                        value={u.perUnits}
                        onChange={(e) => setCost(i, { perUnits: e.target.value })}
                      />
                    </td>
                    <td>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          set({ unitCosts: draft.unitCosts.filter((_, j) => j !== i) })
                        }
                      >
                        Remove
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {unpriced.length > 0 ? (
            <AddMeasure
              options={unpriced.map((m) => m.measure)}
              onAdd={(measure) =>
                set({
                  unitCosts: [...draft.unitCosts, { measure, unitCost: "0.0000", perUnits: "1" }],
                })
              }
            />
          ) : null}
        </div>

        {problem ? <Notice tone="warning">{problem}</Notice> : null}
        {action.error ? <ErrorNotice error={action.error} /> : null}
        <div className="flex items-center gap-3">
          <Button
            variant="primary"
            data-testid="ops-billing-save"
            disabled={action.busy}
            onClick={() => void save()}
          >
            {action.busy ? "Saving…" : "Save settings"}
          </Button>
          {saved ? (
            <span role="status" className="text-sm text-positive">
              Saved.
            </span>
          ) : null}
        </div>
      </Card>
    </section>
  );
}

function AddMeasure({
  options,
  onAdd,
}: {
  options: string[];
  onAdd: (m: string) => void;
}): ReactNode {
  const [pick, setPick] = useState(options[0] ?? "");
  useEffect(() => {
    if (!options.includes(pick)) setPick(options[0] ?? "");
  }, [options, pick]);
  return (
    <div className="mt-3 flex items-center gap-2">
      <Select
        aria-label="Measure to price"
        data-testid="ops-billing-add-measure"
        className="h-8 w-48 text-sm"
        value={pick}
        onChange={(e) => setPick(e.target.value)}
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </Select>
      <Button size="sm" onClick={() => pick && onAdd(pick)}>
        Price this measure
      </Button>
    </div>
  );
}
