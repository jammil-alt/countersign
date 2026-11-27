// The Sandbox's sample company (packages/core `sampleCompanyRoutes`): on the Sandbox's Records
// page, one button fills the Sandbox with an invented business, Ridgeline Builders, so a
// workflow's lookups and Match steps find records. The operator may add themselves as one of its
// employees, so their own email and texts arrive as an employee's. Pressing it again adds only
// what is missing. Shown in the Sandbox client only (the API refuses it anywhere else).
import type { SampleCompanyCounts, SampleCompanyResult } from "@countersign/core";
import { useState } from "react";
import { apiRoutes } from "../../api/routes";
import { useApiClient } from "../../api/useApi";
import { Field, TextInput } from "../../ui/forms";
import { Button, Card, ErrorNotice } from "../../ui/primitives";
import { plural } from "../../usage/format";

const COUNT_WORDS: [keyof SampleCompanyCounts, string, string][] = [
  ["vendors", "vendor", "vendors"],
  ["organizations", "organization", "organizations"],
  ["contacts", "person", "people"],
  ["ledgerAccounts", "account", "accounts"],
  ["ledgerNotes", "account note", "account notes"],
  ["masterItems", "master item", "master items"],
  ["vendorItems", "vendor item", "vendor items"],
  ["transactions", "bill or purchase", "bills and purchases"],
];

/** "8 vendors · 12 organizations · …", leaving out kinds with none. */
export function sampleCounts(counts: SampleCompanyCounts): string {
  return COUNT_WORDS.filter(([k]) => counts[k] > 0)
    .map(([k, one, many]) => plural(counts[k], one, many))
    .join(" · ");
}

export function SampleCompanySetup({
  clientId,
  onDone,
}: {
  clientId: string;
  /** After it ran: read the page's records again. */
  onDone?: () => void;
}) {
  const api = useApiClient();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  const [result, setResult] = useState<SampleCompanyResult | null>(null);
  // Your email or phone needs your name with it.
  const needsName = !name.trim() && (email.trim() !== "" || phone.trim() !== "");

  async function run() {
    setBusy(true);
    setProblem(null);
    try {
      const you = name.trim()
        ? {
            name: name.trim(),
            ...(email.trim() ? { email: email.trim() } : {}),
            ...(phone.trim() ? { phone: phone.trim() } : {}),
          }
        : undefined;
      const res = await api.call(apiRoutes.opsSandboxSampleCompany, {
        params: { id: clientId },
        body: you ? { you } : {},
      });
      setResult(res);
      onDone?.();
    } catch (e) {
      setProblem(e);
    } finally {
      setBusy(false);
    }
  }

  const added = result ? Object.values(result.added).reduce((a, b) => a + b, 0) : 0;
  return (
    <Card title="Sample company" pad testId="ops-sample-company" className="mb-6 max-w-3xl">
      <p className="text-sm text-ink-muted">
        Fills the Sandbox with Ridgeline Builders, an invented contractor: 8 vendors with their reps
        and email domains, 4 employees, 3 customers and their projects, a chart of accounts, 15
        master items with the vendors' SKUs and prices, and 10 bills and purchases. Every name,
        address and number is made up, and it is added to the Sandbox only. Running it again adds
        only what is missing.
      </p>
      <p className="mt-2 text-sm text-ink-muted">
        Add yourself as one of its employees to send it real email or texts as staff.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <Field
          label="Your name"
          error={needsName ? "Add your name to be added as an employee" : undefined}
          testId="ops-sample-company-name"
        >
          <TextInput
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
            invalid={needsName}
            data-testid="ops-sample-company-name"
          />
        </Field>
        <Field label="Your email">
          <TextInput
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            data-testid="ops-sample-company-email"
          />
        </Field>
        <Field label="Your phone" hint="+15551234567, or a 10-digit US number">
          <TextInput
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            autoComplete="tel"
            data-testid="ops-sample-company-phone"
          />
        </Field>
      </div>
      <div className="mt-4">
        <Button
          variant="primary"
          working={busy}
          disabled={needsName}
          onClick={() => void run()}
          data-testid="ops-sample-company-run"
        >
          Set up the sample company
        </Button>
      </div>
      {problem ? (
        <div className="mt-3">
          <ErrorNotice error={problem} />
        </div>
      ) : null}
      {result ? (
        <div className="mt-4" data-testid="ops-sample-company-result">
          <p role="status" className="text-ink figures" data-testid="ops-sample-company-counts">
            {added === 0
              ? `Already set up: ${sampleCounts(result.counts)}.`
              : `${result.company.name} is in the Sandbox: ${sampleCounts(result.counts)}.`}
          </p>
          <h3 className="mt-4 text-sm font-medium text-ink">Employees</h3>
          <ul
            className="mt-1 flex flex-col gap-1 text-sm"
            data-testid="ops-sample-company-employees"
          >
            {result.employees.map((p) => (
              <li key={p.contactId} className="text-ink">
                {p.name}
                {p.you ? " (you)" : p.title ? `, ${p.title}` : ""}
                <span className="text-ink-muted figures">
                  {[p.email, p.phone].filter(Boolean).length > 0
                    ? ` · ${[p.email, p.phone].filter(Boolean).join(" · ")}`
                    : ""}
                </span>
              </li>
            ))}
          </ul>
          {result.examples.length > 0 ? (
            <>
              <h3 className="mt-4 text-sm font-medium text-ink">To try a step with</h3>
              <ul
                className="mt-1 flex flex-col gap-1 text-sm"
                data-testid="ops-sample-company-examples"
              >
                {result.examples.map((x) => (
                  <li key={x.what} className="text-ink-muted">
                    {x.what}: <span className="text-ink">{x.value}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
