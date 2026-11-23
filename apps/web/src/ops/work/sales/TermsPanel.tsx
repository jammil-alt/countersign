// A deal's terms (docs/design/pipelines.html `termsPanel`): what the client pays now, what is
// proposed, the signed copy, and Record agreed terms. Contracts stay by hand (owner, 2026-11-17):
// nothing here is posted to the client.
import { DECIMAL_RE, type DealDetail, SALES_WORDS, wholeMoney } from "@countersign/core";
import { useState } from "react";
import { apiRoutes } from "../../../api/routes";
import { useApiClient } from "../../../api/useApi";
import { ErrorNotice } from "../../../ui/ErrorState";
import { Field, TextInput } from "../../../ui/forms";
import { Button } from "../../../ui/primitives";
import { shortDate } from "../parts";
import { monthValue, plainAmount } from "./parts";
import { uploadSignedCopy } from "./upload";

export function TermsPanel({ detail, onChanged }: { detail: DealDetail; onChanged(): void }) {
  const d = detail.deal;
  const api = useApiClient();
  const [recording, setRecording] = useState(false);
  const [amount, setAmount] = useState(plainAmount(d.agreedMrr ?? d.mrr));
  const [from, setFrom] = useState(d.agreedFrom ?? "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const clean = amount.replace(/[$,\s]/g, "");
  const valid =
    DECIMAL_RE.test(clean) && !clean.startsWith("-") && /^\d{4}-\d{2}-\d{2}$/.test(from);

  async function record() {
    setBusy(true);
    setError(null);
    try {
      await api.call(apiRoutes.opsDealTerms, {
        params: { id: d.id },
        body: { agreedMrr: clean, from, ...(note.trim() ? { note: note.trim() } : {}) },
      });
      setRecording(false);
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function attach(file: File) {
    setError(null);
    try {
      await uploadSignedCopy(d.id, file);
      onChanged();
    } catch (e) {
      setError(e);
    }
  }

  async function open() {
    setError(null);
    try {
      const link = await api.call(apiRoutes.opsDealSignedCopy, { params: { id: d.id } });
      window.open(link.url, "_blank", "noopener");
    } catch (e) {
      setError(e);
    }
  }

  return (
    <section className="ds-card" data-testid="deal-terms">
      <div className="ui-card__head">
        <h3 className="type-subheading text-ink">{SALES_WORDS.termsHead}</h3>
        <span className="text-xs text-ink-muted">{SALES_WORDS.termsByHand}</span>
      </div>
      <div className="ui-card__body flex flex-col gap-3 text-sm">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
          {detail.now ? (
            <>
              <dt className="text-ink-muted">Now</dt>
              <dd>{wholeMoney(detail.now.mrr, detail.now.currency)} a month</dd>
            </>
          ) : null}
          <dt className="text-ink-muted">Proposed</dt>
          <dd>{monthValue(d)} a month</dd>
          {d.agreedMrr ? (
            <>
              <dt className="text-ink-muted">Agreed</dt>
              <dd data-testid="deal-terms-agreed">
                {wholeMoney(d.agreedMrr, d.currency)} a month
                {d.agreedFrom ? ` from ${shortDate(d.agreedFrom)}` : ""}
              </dd>
            </>
          ) : null}
          <dt className="text-ink-muted">Signed copy</dt>
          <dd>
            {d.signedCopy ? (
              <button
                type="button"
                className="ds-btn ds-btn--link"
                onClick={() => void open()}
                data-testid="deal-terms-copy"
              >
                {d.signedCopy.name}
              </button>
            ) : (
              <span className="text-ink-muted">Not yet</span>
            )}
          </dd>
        </dl>
        {recording ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (valid) void record();
            }}
          >
            <div className="flex flex-wrap gap-3">
              <Field label="A month">
                <TextInput
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  inputMode="decimal"
                  className="w-32"
                  data-testid="deal-terms-amount"
                />
              </Field>
              <Field label="From">
                <TextInput
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  data-testid="deal-terms-from"
                />
              </Field>
            </div>
            <Field label="Note">
              <TextInput value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
            <div className="flex gap-2">
              <Button
                type="submit"
                size="sm"
                variant="primary"
                disabled={busy || !valid}
                data-testid="deal-terms-save"
              >
                Record
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setRecording(false)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() => setRecording(true)}
              disabled={d.outcome !== "open"}
              data-testid="deal-terms-record"
            >
              {SALES_WORDS.recordTerms}
            </Button>
            <label className="ds-btn ds-btn--ghost ds-btn--sm cursor-pointer">
              Add the signed copy
              <input
                type="file"
                accept="application/pdf"
                className="sr-only"
                data-testid="deal-terms-upload"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void attach(f);
                  e.target.value = "";
                }}
              />
            </label>
          </div>
        )}
        {error ? <ErrorNotice error={error} /> : null}
        <p className="m-0 text-xs text-ink-muted">{SALES_WORDS.termsLater}</p>
      </div>
    </section>
  );
}
