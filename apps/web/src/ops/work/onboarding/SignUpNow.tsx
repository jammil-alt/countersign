// Sign up now (docs/cases-plan.md §4.3; docs/plan.md §1.149): the quick path for someone ready to
// start. One small form (company, person and email, a saved start, the agreed price if known),
// then one confirm with the same words as Invite's, from the preview route. "Review first" opens
// the full Invite at step 3 (the questions) with the start's defaults. In Sales next to New, and on
// a lead record.
import {
  DECIMAL_RE,
  type InvitePreview,
  type InviteSent,
  inviteRoutes,
  type SalesStartView,
  type SignUpNowDraftInput,
  startRoutes,
} from "@countersign/core";
import { useState } from "react";
import { useApi, useApiClient } from "../../../api/useApi";
import { EN } from "../../../i18n/i18n";
import { ErrorNotice } from "../../../ui/ErrorState";
import { Field, Select, TextInput } from "../../../ui/forms";
import { Button } from "../../../ui/primitives";
import { SheetSection, SideSheet } from "../../../ui/sheet";
import { type InviteSetup, InviteSheet, type InviteTarget, personRow } from "./InviteSheet";
import { coversLine, START_MODE_WORDS } from "./words";

export interface SignUpPrefill extends InviteTarget {
  /** The company's name as the form shows it (a lead's company, a file's name). */
  companyName?: string;
  person?: { name: string; email: string } | null;
}

/** "$2,400.50" → "2400.50"; null when it isn't an amount. */
function amountOf(text: string): string | null {
  const clean = text.replace(/[$,\s]/g, "");
  return clean && DECIMAL_RE.test(clean) && !clean.startsWith("-") ? clean : null;
}

export function SignUpNowSheet({
  prefill = {},
  onClose,
  onSent,
}: {
  prefill?: SignUpPrefill;
  onClose(): void;
  onSent?(sent: InviteSent): void;
}) {
  const api = useApiClient();
  const starts = useApi(startRoutes.opsStarts, { query: { archived: "false" } });
  const fixed = Boolean(prefill.fileId || prefill.clientId);
  const [company, setCompany] = useState(prefill.companyName ?? prefill.company ?? "");
  const [name, setName] = useState(prefill.person?.name ?? "");
  const [email, setEmail] = useState(prefill.person?.email ?? "");
  const [startId, setStartId] = useState("");
  const [price, setPrice] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [confirming, setConfirming] = useState<InvitePreview | null>(null);
  const [review, setReview] = useState<InviteSetup | null>(null);
  const [sent, setSent] = useState<InviteSent | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const list = starts.data?.starts ?? [];
  const start: SalesStartView | undefined = list.find((s) => s.id === startId);
  const amount = price.trim() ? amountOf(price) : null;
  const priceBad = price.trim() !== "" && amount === null;
  const ready =
    (fixed || company.trim() !== "") &&
    name.trim() !== "" &&
    /^\S+@\S+\.\S+$/.test(email.trim()) &&
    start !== undefined &&
    !priceBad;

  const target: InviteTarget = {
    ...(prefill.fileId ? { fileId: prefill.fileId } : {}),
    ...(prefill.clientId ? { clientId: prefill.clientId } : {}),
    ...(!fixed ? { company: company.trim() } : {}),
    ...(prefill.website && !prefill.clientId ? { website: prefill.website } : {}),
    ...(prefill.dealId ? { dealId: prefill.dealId } : {}),
  };
  const draft = (): SignUpNowDraftInput => ({
    ...target,
    person: { name: name.trim(), email: email.trim().toLowerCase() },
    startId,
    ...(amount ? { agreedMrr: amount, currency } : {}),
  });

  async function run<T>(fn: () => Promise<T>): Promise<T | null> {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e);
      return null;
    } finally {
      setBusy(false);
    }
  }

  if (review) {
    return <InviteSheet setup={review} onClose={onClose} {...(onSent ? { onSent } : {})} />;
  }

  const who = company.trim() || prefill.companyName || "them";

  const footer = sent ? (
    <Button variant="primary" onClick={onClose} data-testid="signup-done">
      Done
    </Button>
  ) : confirming ? (
    <div className="flex w-full flex-wrap items-center justify-between gap-2">
      <Button variant="ghost" onClick={() => setConfirming(null)}>
        Back
      </Button>
      <Button
        variant="primary"
        disabled={busy || confirming.problems.length > 0}
        onClick={() =>
          void run(async () => {
            const out = await api.call(inviteRoutes.opsSignUp, { body: draft() });
            setSent(out);
            onSent?.(out);
          })
        }
        data-testid="signup-go"
      >
        {busy ? "Signing up…" : `Sign up ${who}`}
      </Button>
    </div>
  ) : (
    <div className="flex w-full flex-wrap items-center justify-between gap-2">
      <Button variant="ghost" onClick={onClose}>
        Cancel
      </Button>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={!ready}
          onClick={() => {
            if (!start) return;
            setReview({
              target,
              name: who,
              people: [{ name: name.trim(), email: email.trim().toLowerCase() }],
              existingClient: Boolean(prefill.clientId),
              step: 2,
              state: {
                people: [
                  personRow({
                    name: name.trim(),
                    email: email.trim().toLowerCase(),
                    isAdmin: !prefill.clientId,
                  }),
                ],
                covers: start.covers,
                startId: start.id,
                startMode: start.startMode,
                note: start.note,
                agreedMrr: amount,
                currency: amount ? currency : null,
              },
            });
          }}
          data-testid="signup-review"
        >
          Review first
        </Button>
        <Button
          variant="primary"
          disabled={!ready || busy}
          onClick={() =>
            void run(async () => {
              setConfirming(await api.call(inviteRoutes.opsSignUpPreview, { body: draft() }));
            })
          }
          data-testid="signup-continue"
        >
          Continue
        </Button>
      </div>
    </div>
  );

  return (
    <SideSheet title="Sign up now" onClose={onClose} footer={footer} testId="signup">
      {sent ? (
        <div className="flex flex-col gap-2 text-sm" data-testid="signup-sent">
          <p className="m-0 text-ink">
            {!sent.dealId
              ? `Done. ${who}'s people are invited.`
              : prefill.clientId
                ? `Done. ${who}'s deal is updated in Sales.`
                : `Done. ${who} is a client, and the deal is at Set up the account.`}
          </p>
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-ink-muted">
            {sent.emails.map((e) => (
              <li key={e.to}>
                {e.to}:{" "}
                {e.status === "queued"
                  ? "sending"
                  : e.status === "scheduled"
                    ? "scheduled"
                    : "not sent (no mailer here)"}
              </li>
            ))}
          </ul>
        </div>
      ) : confirming ? (
        <div className="flex flex-col gap-5" data-testid="signup-confirm">
          <SheetSection label="Signing up">
            <ul
              className="m-0 flex list-disc flex-col gap-1.5 pl-5 text-sm text-ink"
              data-testid="signup-confirm-lines"
            >
              {confirming.confirm.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </SheetSection>
          {confirming.todos.length > 0 ? (
            <SheetSection label="Adds to Your call">
              <ul
                className="m-0 flex list-none flex-col gap-1 p-0 text-sm"
                data-testid="signup-todos"
              >
                {confirming.todos.map((t) => (
                  <li key={t.title} className="text-ink">
                    {t.title}
                    <span className="ml-2 text-xs text-ink-muted">due {EN.fmt.date(t.dueOn)}</span>
                  </li>
                ))}
              </ul>
            </SheetSection>
          ) : null}
          {confirming.problems.length > 0 ? (
            <div
              className="ds-banner flex flex-col gap-1 text-sm"
              role="alert"
              data-testid="signup-problems"
            >
              <b>It can't go yet.</b>
              {confirming.problems.map((x) => (
                <span key={`${x.code}:${x.email ?? ""}`}>{x.message}</span>
              ))}
            </div>
          ) : null}
          {error ? <ErrorNotice error={error} /> : null}
        </div>
      ) : (
        <form
          className="flex flex-col gap-4"
          data-testid="signup-form"
          onSubmit={(e) => e.preventDefault()}
        >
          <Field label="Company">
            <TextInput
              value={company}
              disabled={fixed}
              onChange={(e) => setCompany(e.target.value)}
              data-testid="signup-company"
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Person">
              <TextInput
                value={name}
                onChange={(e) => setName(e.target.value)}
                data-testid="signup-name"
              />
            </Field>
            <Field label="Email">
              <TextInput
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                data-testid="signup-email"
              />
            </Field>
          </div>
          <Field
            label="What to start with"
            hint={
              start
                ? `${coversLine(start.covers)} · ${START_MODE_WORDS[start.startMode]}`
                : "A saved start: what it covers, the note and how they start."
            }
          >
            <Select
              value={startId}
              onChange={(e) => setStartId(e.target.value)}
              data-testid="signup-start"
            >
              <option value="">Choose a start</option>
              {list.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          {starts.error ? <ErrorNotice error={starts.error} onRetry={starts.reload} /> : null}
          <div className="flex flex-wrap items-end gap-3">
            <Field
              label="Agreed price a month (optional)"
              error={priceBad ? "An amount such as 2400 or 2400.50" : undefined}
            >
              <TextInput
                value={price}
                inputMode="decimal"
                invalid={priceBad}
                onChange={(e) => setPrice(e.target.value)}
                className="w-40"
                data-testid="signup-price"
              />
            </Field>
            <Field label="Currency">
              <Select
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                className="w-28"
                data-testid="signup-currency"
              >
                {["USD", "CAD", "EUR", "GBP", "MXN"].map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <p className="m-0 text-xs text-ink-muted">
            The rest comes from the start: its note from you, get to the point, the questions filled
            from the file, sent now. Without a price, recording it becomes a to-do on Your call.
          </p>
          {error ? <ErrorNotice error={error} /> : null}
        </form>
      )}
    </SideSheet>
  );
}
