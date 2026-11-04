// `/ops/billing` (docs/plan.md §1.24): Mezonas' billing settings (unit costs per usage measure, the
// allowance per agent, the Stripe prices) and each client's period so far: base fee, allowance,
// credits used, overage, and what the work cost us (operator only; the portal never sees cost).
import type { BillingSettings, OpsBilling, UnitCost } from "@countersign/core";
import { type ReactNode, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { credits, price } from "../../billing/parts";
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

export function OpsBillingScreen() {
  const { data, error, loading, reload } = useApi(apiRoutes.opsBilling);
  return (
    <div>
      <PageHeader
        title="Billing"
        subtitle="What each client pays: a base fee per active agent with an allowance of credits, then extra credits. One credit is one cent of what the work cost us."
      />
      {loading && !data ? <Loading /> : null}
      {error ? <ErrorNotice error={error} onRetry={reload} /> : null}
      {data ? (
        <>
          <StripeStatus data={data} />
          <ClientsTable data={data} onChange={reload} />
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
          : "Stripe is not connected yet: set STRIPE_SECRET_KEY to set clients up and report usage."}
      </Notice>
    </div>
  );
}

function ClientsTable({ data, onChange }: { data: OpsBilling; onChange: () => void }) {
  const action = useAction();
  const [settingUp, setSettingUp] = useState<string | null>(null);
  const ready =
    data.stripeConfigured && data.settings.basePriceId !== null && data.settings.overagePriceId;

  async function setUp(id: string) {
    setSettingUp(id);
    const out = await action.call(apiRoutes.opsBillingSetup, { params: { id }, body: {} });
    setSettingUp(null);
    if (out.ok) onChange();
  }

  return (
    <section className="mb-8">
      <SectionLabel>Clients this period</SectionLabel>
      {action.error ? (
        <div className="mb-3">
          <ErrorNotice error={action.error} />
        </div>
      ) : null}
      {data.clients.length === 0 ? (
        <EmptyState>No clients yet.</EmptyState>
      ) : (
        <div className="dt overflow-x-auto">
          <table data-testid="ops-billing-clients">
            <thead>
              <tr className="dt-cols">
                <th>Client</th>
                <th className="n">Agents</th>
                <th className="n">Base</th>
                <th className="n">Credits used</th>
                <th className="n">Allowance</th>
                <th className="n">Extra</th>
                <th className="n">Our cost</th>
                <th>Billing</th>
              </tr>
            </thead>
            <tbody>
              {data.clients.map((c) => (
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
                        {periodLabel(c.period.start, c.period.through)}
                      </span>
                    </span>
                  </td>
                  <td className="n">{count(c.activeAgents)}</td>
                  <td className="n">{c.base ? price(c.base) : "–"}</td>
                  <td className="n text-ink">{count(c.creditsUsed)}</td>
                  <td className="n">{count(c.allowance)}</td>
                  <td className="n">{count(c.overageCredits)}</td>
                  <td className="n">{cost(c.costUsd)}</td>
                  <td>
                    {c.setUp ? (
                      <span className="flex items-center gap-2">
                        <Badge
                          tone={c.lastInvoice?.status === "payment_failed" ? "risk" : "positive"}
                        >
                          {c.lastInvoice?.status === "payment_failed" ? "Payment failed" : "Billed"}
                        </Badge>
                      </span>
                    ) : (
                      <Button
                        size="sm"
                        variant="secondary"
                        data-testid={`ops-billing-setup-${c.id}`}
                        disabled={!ready || action.busy}
                        title={ready ? undefined : "Connect Stripe and save both prices first"}
                        onClick={() => void setUp(c.id)}
                      >
                        {settingUp === c.id ? "Setting up…" : "Set up billing"}
                      </Button>
                    )}
                  </td>
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
  allowance: string;
  basePriceId: string;
  overagePriceId: string;
  meterEventName: string;
  daysUntilDue: string;
  unitCosts: { measure: string; unitCost: string; perUnits: string }[];
}

function draftOf(s: OpsBilling["settings"]): Draft {
  return {
    allowance: String(s.allowanceCreditsPerAgent),
    basePriceId: s.basePriceId ?? "",
    overagePriceId: s.overagePriceId ?? "",
    meterEventName: s.meterEventName,
    daysUntilDue: String(s.daysUntilDue),
    unitCosts: s.unitCosts.map((u) => ({ ...u, perUnits: String(u.perUnits) })),
  };
}

const WHOLE = /^\d{1,9}$/;

/** The settings from the form, or what is wrong with them. */
export function settingsFromDraft(d: Draft): { settings: BillingSettings } | { problem: string } {
  if (!WHOLE.test(d.allowance)) return { problem: "The allowance is a whole number of credits." };
  if (!WHOLE.test(d.daysUntilDue) || Number(d.daysUntilDue) < 1 || Number(d.daysUntilDue) > 365) {
    return { problem: "Days until due is a whole number from 1 to 365." };
  }
  const unitCosts: UnitCost[] = [];
  for (const u of d.unitCosts) {
    if (!/^\d{1,10}(\.\d{1,4})?$/.test(u.unitCost.trim())) {
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
      allowanceCreditsPerAgent: Number(d.allowance),
      basePriceId: d.basePriceId.trim() || null,
      overagePriceId: d.overagePriceId.trim() || null,
      meterEventName: d.meterEventName.trim(),
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
  // after another client's set-up or sync returns equal settings and must keep unsaved edits. This
  // is done while rendering, not in an effect: an effect also ran after the first render, and when
  // the operator's first keystroke came before React ran it, the re-fill landed on top of the edit.
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

  const s = data.settings;
  return (
    <section data-testid="ops-billing-settings">
      <SectionLabel>Settings</SectionLabel>
      <Card className="flex flex-col gap-6 p-5">
        <p className="text-sm text-ink-muted">
          These are placeholders until prices are set. Prices live in Stripe; we keep their ids and
          check them when you save.
          {s.baseFee ? (
            <>
              {" "}
              Now: <span className="text-ink">{price(s.baseFee)}</span> a month per active agent
              {s.overagePrice ? (
                <>
                  , extra credits <span className="text-ink">{price(s.overagePrice)}</span> each
                </>
              ) : null}
              .
            </>
          ) : null}
        </p>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field
            label="Credits included per active agent, each month"
            hint="Pooled across a client's agents"
          >
            <TextInput
              data-testid="ops-billing-allowance"
              inputMode="numeric"
              value={draft.allowance}
              onChange={(e) => set({ allowance: e.target.value })}
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
          <Field label="Base fee price" hint="A monthly licensed price in Stripe (price_…)">
            <TextInput
              data-testid="ops-billing-base-price"
              value={draft.basePriceId}
              onChange={(e) => set({ basePriceId: e.target.value })}
            />
          </Field>
          <Field label="Extra credit price" hint="A monthly metered price on the credits meter">
            <TextInput
              data-testid="ops-billing-overage-price"
              value={draft.overagePriceId}
              onChange={(e) => set({ overagePriceId: e.target.value })}
            />
          </Field>
          <Field label="Meter event name" hint="The Stripe billing meter's event name">
            <TextInput
              data-testid="ops-billing-meter"
              value={draft.meterEventName}
              onChange={(e) => set({ meterEventName: e.target.value })}
            />
          </Field>
        </div>

        <div>
          <h3 className="mb-1 font-medium text-ink">Unit costs</h3>
          <p className="mb-3 text-sm text-ink-muted">
            What one unit of each usage measure costs us, in dollars. A measure without a unit cost
            is not billed.
          </p>
          <div className="dt overflow-x-auto">
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

/** Words for a client's period, shared with the client page. */
export function periodWords(c: { creditsUsed: number; allowance: number; overageCredits: number }) {
  return c.overageCredits > 0
    ? `${credits(c.creditsUsed)} used, ${credits(c.overageCredits)} over the allowance`
    : `${credits(c.creditsUsed)} used of ${credits(c.allowance)}`;
}
