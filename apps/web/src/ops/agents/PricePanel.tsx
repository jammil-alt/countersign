// An agent's monthly price and included credits on its Settings tab (docs/plan.md §1.32). A
// template's price is the default for its client agents; a client agent's own price overrides it,
// with a note saying why. Every change is kept in the agent's log, listed here. Changes apply from
// the next day recorded; a month's statement keeps the prices each day had.
import type { AgentSummary } from "@countersign/core";
import { useState } from "react";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { price } from "../../billing/parts";
import { Button, Card, ErrorNotice, Loading, SectionLabel } from "../../ui/primitives";
import { count, dayLabel } from "../../usage/format";
import { SOURCE_LABEL } from "../screens/Billing";
import { Field, Notice, TextInput, useAction } from "./ui";

/** The price as typed, or what is wrong with it. */
export function priceFromDraft(
  monthlyPrice: string,
  includedCredits: string,
): { monthlyPrice: string; includedCredits: number } | { problem: string } {
  const p = monthlyPrice.trim().replace(/^\$/, "");
  if (!/^\d{1,10}(\.\d{1,4})?$/.test(p)) {
    return { problem: "The monthly price is a dollar amount, like 250 or 249.50." };
  }
  if (!/^\d{1,9}$/.test(includedCredits.trim())) {
    return { problem: "The credits included are a whole number." };
  }
  return { monthlyPrice: p, includedCredits: Number(includedCredits.trim()) };
}

export function PricePanel({ agent }: { agent: AgentSummary }) {
  const { data, error, reload } = useApi(apiRoutes.opsAgentPrice, { params: { id: agent.id } });
  const action = useAction();
  const [editing, setEditing] = useState(false);
  const [monthly, setMonthly] = useState("");
  const [creditsText, setCreditsText] = useState("");
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const client = agent.kind === "client";

  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!data) {
    return (
      <Card className="p-5">
        <Loading label="Loading the price…" />
      </Card>
    );
  }

  function edit() {
    if (!data) return;
    setMonthly(data.price.monthlyPrice.amount.replace(/\.?0+$/, "") || "0");
    setCreditsText(String(data.price.includedCredits));
    setNote(data.own?.note ?? "");
    setProblem(null);
    setEditing(true);
  }

  async function save(clear: boolean) {
    const p = clear ? null : priceFromDraft(monthly, creditsText);
    if (p && "problem" in p) {
      setProblem(p.problem);
      return;
    }
    if (client && !note.trim()) {
      setProblem("Say why this agent's price differs; it goes in the agent's log.");
      return;
    }
    setProblem(null);
    const res = await action.call(apiRoutes.opsSetAgentPrice, {
      params: { id: agent.id },
      body: { price: p, ...(note.trim() ? { note: note.trim() } : {}) },
    });
    if (res.ok) {
      setEditing(false);
      reload();
    }
  }

  const fallback = client
    ? data.template?.price
      ? `${data.template.name}'s price`
      : "the default"
    : "the default";
  const noOwn = client ? "No price of its own" : "The default";

  return (
    <Card className="flex flex-col gap-4 p-5" testId="agent-price">
      <div>
        <h2 className="mb-1 type-subheading text-ink">Price</h2>
        <p className="text-sm text-ink-muted">
          {client
            ? "What this client pays for this agent each month, prorated by the days it is active, and the credits it brings to the client's pool."
            : "What each client agent forked from this template pays each month, unless it has a price of its own."}
        </p>
      </div>
      <p className="text-ink" data-testid="agent-price-current">
        {price(data.price.monthlyPrice)} a month, {count(data.price.includedCredits)} credits
        included
        <span className="text-ink-muted"> · {SOURCE_LABEL[data.price.source]}</span>
      </p>
      {data.own?.note ? (
        <p className="text-sm text-ink-muted">
          Why: {data.own.note}
          {data.own.setBy ? ` (${data.own.setBy}, ${dayLabel(data.own.setAt.slice(0, 10))})` : ""}
        </p>
      ) : null}

      {editing ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="A month (USD)" className="w-40">
              <TextInput
                data-testid="agent-price-monthly"
                inputMode="decimal"
                value={monthly}
                onChange={(e) => setMonthly(e.target.value)}
              />
            </Field>
            <Field label="Credits included" className="w-40">
              <TextInput
                data-testid="agent-price-credits"
                inputMode="numeric"
                value={creditsText}
                onChange={(e) => setCreditsText(e.target.value)}
              />
            </Field>
            {client ? (
              <Field
                label="Why"
                hint="Required; kept in the agent's log"
                className="min-w-64 flex-1"
              >
                <TextInput
                  data-testid="agent-price-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </Field>
            ) : null}
          </div>
          {problem ? <Notice tone="warning">{problem}</Notice> : null}
          {action.error ? <ErrorNotice error={action.error} /> : null}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="primary"
              data-testid="agent-price-save"
              disabled={action.busy}
              onClick={() => void save(false)}
            >
              Save price
            </Button>
            {data.own ? (
              <Button
                variant="ghost"
                data-testid="agent-price-clear"
                disabled={action.busy}
                onClick={() => void save(true)}
              >
                Use {fallback} instead
              </Button>
            ) : null}
            <Button variant="ghost" disabled={action.busy} onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <Button data-testid="agent-price-edit" onClick={edit}>
            {data.own ? "Change price" : "Set a price"}
          </Button>
        </div>
      )}

      {data.history.length > 0 ? (
        <div>
          <SectionLabel>Price changes</SectionLabel>
          <ul className="flex flex-col divide-y divide-line" data-testid="agent-price-history">
            {data.history.map((h) => (
              <li key={h.at} className="flex flex-col gap-0.5 py-2 text-sm">
                <span className="text-ink">
                  {h.from
                    ? `${price(h.from.monthlyPrice)}, ${count(h.from.includedCredits)} credits`
                    : noOwn}
                  {" → "}
                  {h.to
                    ? `${price(h.to.monthlyPrice)}, ${count(h.to.includedCredits)} credits`
                    : noOwn}
                </span>
                <span className="text-ink-muted">
                  {[dayLabel(h.at.slice(0, 10)), h.by, h.note].filter(Boolean).join(" · ")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}
