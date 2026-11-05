// One monthly statement in the back office (docs/plan.md §1.32): its lines, and while it is a draft
// that hasn't gone to Stripe, adjustments to add or remove, Send and Void. Once Stripe has it, the
// lines are fixed; a send that stopped says why and Send resumes it. Used on /ops/billing and the
// client page.
import type { OpsStatement } from "@countersign/core";
import { useState } from "react";
import { Link } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { daysIn, price, STATEMENT_STATUS, StatementLines } from "../../billing/parts";
import { EN } from "../../i18n/i18n";
import { Badge, Button, Card, ErrorNotice } from "../../ui/primitives";
import { dayLabel } from "../../usage/format";
import { Field, Notice, TextInput, useAction } from "../agents/ui";

const monthOf = (start: string) =>
  new Date(`${start}T00:00:00.000Z`).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

/** An adjustment as typed: a dollar amount in whole cents, plus or minus, never zero. */
export function adjustmentFromDraft(
  description: string,
  amount: string,
): { description: string; amount: string } | { problem: string } {
  const d = description.trim();
  const a = amount.trim().replace(/^\$/, "").replace(/^-\$/, "-");
  if (!d) return { problem: "Say what the adjustment is for." };
  if (d.length > 200) return { problem: "Keep the description under 200 characters." };
  if (!/^-?\d{1,8}(\.\d{1,2})?$/.test(a) || /^-?0+(\.0+)?$/.test(a)) {
    return { problem: "The amount is dollars and cents, like 25.00 or -15.00, and not zero." };
  }
  return { description: d, amount: a };
}

export function OpsStatementCard({
  statement: s,
  showClient = false,
  stripeConfigured,
  onChanged,
}: {
  statement: OpsStatement;
  /** On /ops/billing, the client's name links to its page. */
  showClient?: boolean;
  stripeConfigured: boolean;
  onChanged: () => void;
}) {
  const action = useAction();
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const status = STATEMENT_STATUS[s.status];
  const testId = `ops-statement-${s.id}`;

  async function addAdjustment() {
    const out = adjustmentFromDraft(description, amount);
    if ("problem" in out) {
      setProblem(out.problem);
      return;
    }
    setProblem(null);
    const res = await action.call(apiRoutes.opsAddAdjustment, { params: { id: s.id }, body: out });
    if (res.ok) {
      setDescription("");
      setAmount("");
      onChanged();
    }
  }
  async function run(route: typeof apiRoutes.opsSendStatement | typeof apiRoutes.opsVoidStatement) {
    const res = await action.call(route, { params: { id: s.id } });
    if (res.ok) onChanged();
  }

  return (
    <Card className="flex flex-col gap-4 p-5" testId={testId}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col">
          <span className="font-medium text-ink">
            {showClient ? (
              <>
                <Link to={`/ops/clients/${s.clientId}`} className="hover:underline">
                  {s.clientName}
                </Link>
                {" · "}
              </>
            ) : null}
            {monthOf(s.period.start)}
          </span>
          <span className="text-sm text-ink-muted">
            {[
              s.invoiceNumber ? `Invoice ${s.invoiceNumber}` : null,
              s.sentAt ? `sent ${dayLabel(s.sentAt.slice(0, 10))}` : null,
              s.dueAt && s.status !== "paid" ? `due ${dayLabel(s.dueAt.slice(0, 10))}` : null,
              s.paidAt ? `paid ${dayLabel(s.paidAt.slice(0, 10))}` : null,
            ]
              .filter(Boolean)
              .join(" · ") || "Not sent"}
          </span>
        </div>
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-ink figures" data-testid={`${testId}-total`}>
            {price(s.total)}
          </span>
          <Badge tone={status.tone}>{EN.t(status.label)}</Badge>
          {s.hostedInvoiceUrl ? (
            <a
              className="ds-btn ds-btn--link text-sm"
              href={s.hostedInvoiceUrl}
              target="_blank"
              rel="noreferrer"
            >
              Stripe's page
            </a>
          ) : null}
          {s.pdfUrl ? (
            <a
              className="ds-btn ds-btn--link text-sm"
              href={s.pdfUrl}
              target="_blank"
              rel="noreferrer"
            >
              PDF
            </a>
          ) : null}
        </span>
      </div>

      {s.sendError ? (
        <Notice tone="warning" testId={`${testId}-error`}>
          The send stopped: {s.sendError}. Send it again to carry on from where it stopped.
        </Notice>
      ) : null}

      <StatementLines
        lines={s.lines}
        daysInMonth={daysIn(s.period.start)}
        summary={s}
        total={s.total}
        totalLabel="Total"
        testId={`${testId}-lines`}
        {...(s.editable
          ? {
              action: (line) =>
                line.kind === "adjustment" && line.id ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={action.busy}
                    onClick={async () => {
                      const res = await action.call(apiRoutes.opsRemoveAdjustment, {
                        params: { id: s.id, lineId: line.id as string },
                      });
                      if (res.ok) onChanged();
                    }}
                  >
                    Remove
                  </Button>
                ) : null,
            }
          : {})}
      />

      {s.editable ? (
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Adjustment" className="min-w-64 flex-1">
            <TextInput
              data-testid={`${testId}-adjust-description`}
              placeholder="What it's for, as the client will read it"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          <Field label="Amount (USD)" hint="Minus for a credit" className="w-40">
            <TextInput
              data-testid={`${testId}-adjust-amount`}
              inputMode="decimal"
              placeholder="-15.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>
          <Button
            disabled={action.busy}
            data-testid={`${testId}-adjust`}
            onClick={() => void addAdjustment()}
          >
            Add adjustment
          </Button>
        </div>
      ) : null}
      {problem ? <Notice tone="warning">{problem}</Notice> : null}
      {action.error ? <ErrorNotice error={action.error} /> : null}

      {s.status === "draft" ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            data-testid={`${testId}-send`}
            disabled={action.busy || !stripeConfigured}
            title={stripeConfigured ? undefined : "Connect Stripe first"}
            onClick={() => void run(apiRoutes.opsSendStatement)}
          >
            {s.sendStarted ? "Send again" : "Send to Stripe"}
          </Button>
          {s.editable ? (
            <Button
              variant="ghost"
              data-testid={`${testId}-void`}
              disabled={action.busy}
              onClick={() => void run(apiRoutes.opsVoidStatement)}
            >
              Void
            </Button>
          ) : null}
          <span className="text-sm text-ink-muted">
            {s.editable
              ? "Stripe emails the invoice with a link to pay. The lines can't change after that."
              : "Stripe has the invoice. Void it in Stripe if it shouldn't go."}
          </span>
        </div>
      ) : null}
    </Card>
  );
}
