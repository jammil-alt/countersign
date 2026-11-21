// New deal (docs/plan.md §1.124.2): a company not yet a client, or more for a client. The value
// a month is typed as money and sent as a decimal string (invariant 6). From an enhancement Build
// decided to sell (`?from=enhancement:<id>`), the deal carries that origin.
import { DECIMAL_RE, type DealKind, type DealOrigin } from "@countersign/core";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiRoutes } from "../../../api/routes";
import { useApi, useApiClient } from "../../../api/useApi";
import { ErrorNotice } from "../../../ui/ErrorState";
import { Field, Select, TextArea, TextInput } from "../../../ui/forms";
import { Button, Card } from "../../../ui/primitives";
import { OPS_PATHS } from "../../paths";

/** `enhancement:<id>` (or another origin kind) as a deal's origin; null when it isn't one. */
export function originFrom(from: string | null): DealOrigin | null {
  const m = /^(deal|ask|enhancement|issue):([0-9a-f-]{36})$/i.exec(from ?? "");
  return m ? ({ kind: m[1], id: m[2] } as DealOrigin) : null;
}

export function NewDeal({
  kind: initial,
  from,
  onCancel,
}: {
  kind: DealKind;
  from: string | null;
  onCancel(): void;
}) {
  const api = useApiClient();
  const navigate = useNavigate();
  const clients = useApi(apiRoutes.opsClients, { query: { view: "names" } });
  const origin = originFrom(from);
  const [kind, setKind] = useState<DealKind>(initial);
  const [company, setCompany] = useState("");
  const [clientId, setClientId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [mrr, setMrr] = useState("");
  const [agents, setAgents] = useState("1");
  const [person, setPerson] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const amount = mrr.replace(/[$,\s]/g, "");
  const valid =
    title.trim() !== "" &&
    DECIMAL_RE.test(amount) &&
    !amount.startsWith("-") &&
    (kind === "expansion" ? clientId !== "" : company.trim() !== "" || clientId !== "");

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const out = await api.call(apiRoutes.opsCreateDeal, {
        body: {
          kind,
          title: title.trim(),
          mrr: amount,
          agentCount: Math.max(0, Number.parseInt(agents, 10) || 0),
          ...(description.trim() ? { description: description.trim() } : {}),
          ...(clientId ? { clientId } : {}),
          ...(!clientId && company.trim() ? { company: company.trim() } : {}),
          ...(person.trim()
            ? {
                people: [{ name: person.trim(), ...(email.trim() ? { email: email.trim() } : {}) }],
              }
            : {}),
          ...(origin ? { origin } : {}),
        },
      });
      navigate(OPS_PATHS.deal(out.deal.id));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card pad testId="sales-start" className="mb-4">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) void start();
        }}
      >
        <div className="flex flex-wrap items-end gap-4">
          <fieldset className="ds-seg" aria-label="What kind of deal">
            {(["new", "expansion"] as const).map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={kind === k}
                onClick={() => setKind(k)}
                data-testid={`sales-start-${k}`}
              >
                {k === "new" ? "A new account" : "More for a client"}
              </button>
            ))}
          </fieldset>
          {kind === "new" ? (
            <Field label="Company" className="min-w-0 flex-1">
              <TextInput
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                placeholder="Ridgeline Dental Group"
                data-testid="sales-start-company"
              />
            </Field>
          ) : null}
          <Field label={kind === "new" ? "Or a client" : "Client"}>
            <Select
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              data-testid="sales-start-client"
            >
              <option value="">{kind === "new" ? "Not a client yet" : "Choose a client"}</option>
              {(clients.data?.clients ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="flex flex-wrap gap-4">
          <Field label="What they'd buy" className="min-w-0 flex-1">
            <TextInput
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Purchasing and Bookkeeping"
              data-testid="sales-start-title"
            />
          </Field>
          <Field label="A month" hint="An estimate until the terms are agreed">
            <TextInput
              value={mrr}
              onChange={(e) => setMrr(e.target.value)}
              inputMode="decimal"
              placeholder="2400"
              data-testid="sales-start-mrr"
            />
          </Field>
          <Field label="Agents">
            <TextInput
              value={agents}
              onChange={(e) => setAgents(e.target.value)}
              inputMode="numeric"
              className="w-20"
              data-testid="sales-start-agents"
            />
          </Field>
        </div>
        <Field label="What we know">
          <TextArea
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="4 offices, about 300 supplier invoices a month. From the Hire page."
            data-testid="sales-start-description"
            assist={{
              field: "deal.description",
              context: clientId ? { clientId } : undefined,
            }}
          />
        </Field>
        <div className="flex flex-wrap gap-4">
          <Field label="Who we talk to" className="min-w-0 flex-1">
            <TextInput
              value={person}
              onChange={(e) => setPerson(e.target.value)}
              placeholder="Karen Lowe"
              data-testid="sales-start-person"
            />
          </Field>
          <Field label="Their email" className="min-w-0 flex-1">
            <TextInput
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              data-testid="sales-start-email"
            />
          </Field>
        </div>
        {origin ? (
          <p className="text-sm text-ink-muted" data-testid="sales-start-origin">
            {origin.kind === "enhancement"
              ? "From an enhancement we decided to sell."
              : `From the ${origin.kind} it came out of.`}
          </p>
        ) : null}
        {error ? <ErrorNotice error={error} /> : null}
        <div className="flex gap-2">
          <Button
            type="submit"
            variant="primary"
            disabled={busy || !valid}
            data-testid="sales-start-go"
          >
            {busy ? "Adding…" : "Add the deal"}
          </Button>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}
