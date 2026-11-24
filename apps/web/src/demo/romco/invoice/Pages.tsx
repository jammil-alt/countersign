// The two pages people outside the portal open from an email: Priya Shah's link to send the
// invoice register (a Collect reports link: the file is checked in code before it's taken), and
// Tom Guerra's form to find the Zoho deals the agent couldn't match. Both on the public form
// page's frame (forms/FormPage.tsx).
import { type ReactNode, useState } from "react";
import { Link } from "react-router-dom";
import { Logo } from "../../../ui/brand";
import { Field, TextArea } from "../../../ui/forms";
import { Badge, Button, Card, cx } from "../../../ui/primitives";
import { TourBar } from "../DemoShell";
import { INV_RUN, useDemo } from "../state";
import { EXAMPLE_PICKS, NOT_FOUND, REPORTS } from "./data";

function Frame({ children, foot }: { children: ReactNode; foot: string }) {
  return (
    <>
      <div className="flex min-h-screen flex-col items-center gap-8 bg-paper px-4 py-10 pb-32">
        <Logo height={22} />
        <Card className="w-full max-w-3xl" pad>
          {children}
        </Card>
        <p className="text-xs text-ink-muted">{foot}</p>
      </div>
      <TourBar />
    </>
  );
}

const REGISTER =
  REPORTS.find((r) => r.key === "register") ?? (REPORTS[1] as (typeof REPORTS)[number]);

const CHECKS = [
  "A spreadsheet (.xlsx)",
  `Has every column: ${REGISTER.columns.join(", ")}`,
  "Every invoice dated Wednesday, November 5",
  "10 invoices",
];

/** The link in Priya Shah's follow-up, for yesterday's invoice register. */
export function RegisterUpload() {
  const { state, set } = useDemo();
  const [file, setFile] = useState(false);
  const [checked, setChecked] = useState(0);
  const sent = state.inv >= 1;

  const choose = () => {
    setFile(true);
    setChecked(0);
    CHECKS.forEach((_, i) => {
      window.setTimeout(() => setChecked(i + 1), 250 * (i + 1));
    });
  };

  if (sent) {
    return (
      <Frame foot="Sent by Mezonas for ROMCO.">
        <p className="eyebrow text-ink-muted">ROMCO asks · Invoice CRM update</p>
        <h1 className="type-heading text-ink">
          Thanks, Priya. Yesterday's invoice register is in.
        </h1>
        <p className="mt-2 text-ink">
          10 invoices, all checks passed. We'll send you the exception report once it's reconciled.
          Tomorrow's can come in from your scheduled email as usual.
        </p>
        <div className="mt-6">
          <Link to={INV_RUN("reconcile")} className="ds-btn ds-btn--primary">
            Back to the run
          </Link>
        </div>
      </Frame>
    );
  }
  return (
    <Frame foot="Sent by Mezonas for ROMCO. Only this file goes to ROMCO's Invoice CRM update agent.">
      <p className="eyebrow text-ink-muted">ROMCO asks · Invoice CRM update</p>
      <h1 className="type-heading text-ink">Send yesterday's invoice register</h1>
      <p className="mt-2 text-ink">{REGISTER.describe}</p>
      <p className="mt-2 text-sm text-ink-muted">
        Was due at 9:00 AM today · follow-up 1 of 2 · or reply to the follow-up email with the file
        attached
      </p>

      <section className="mt-6">
        <h2 className="type-subheading text-ink">What we check</h2>
        <ul className="demo-checks mt-2">
          {CHECKS.map((c, i) => (
            <li key={c} className={cx(file && checked > i && "is-ok")}>
              <span className="demo-checks__mark">{file && checked > i ? "✓" : "·"}</span>
              {c}
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-6">
        {file ? (
          <div className="demo-file">
            <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden>
              <use href="#mz-worksheet" />
            </svg>
            <span className="min-w-0 flex-1">
              <b className="block text-ink">{REGISTER.file}</b>
              <span className="text-sm text-ink-muted">12 KB · 10 rows</span>
            </span>
            {checked >= CHECKS.length ? (
              <Badge tone="positive">Checks passed</Badge>
            ) : (
              <Badge>Checking</Badge>
            )}
          </div>
        ) : (
          <div className="demo-drop">
            <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden className="text-ink-muted">
              <use href="#mz-upload" />
            </svg>
            <p className="text-sm text-ink">Drop the file here, or choose it</p>
            <p className="text-xs text-ink-muted">
              Export it from Great Plains: Sales › Reports › Invoice register.
            </p>
            <Button size="sm" onClick={choose}>
              Use the example file
            </Button>
          </div>
        )}
      </section>
      <div className="mt-6 flex gap-2">
        <Button
          variant="primary"
          disabled={!file || checked < CHECKS.length}
          onClick={() => {
            set({ inv: 1 });
            window.scrollTo(0, 0);
          }}
        >
          Send
        </Button>
        {file ? (
          <Button variant="secondary" onClick={() => setFile(false)}>
            Choose another file
          </Button>
        ) : null}
      </div>
    </Frame>
  );
}

/** Tom Guerra's form: the deal for each sale the agent couldn't match. */
export function DealsForm() {
  const { state, set } = useDemo();
  const [picks, setPicks] = useState<Record<string, { pick: string; note: string }>>({});
  const [missing, setMissing] = useState<string[]>([]);
  const sent = state.inv >= 2;
  const get = (id: string) => picks[id] ?? { pick: "", note: "" };
  const put = (id: string, patch: Partial<{ pick: string; note: string }>) =>
    setPicks((p) => ({ ...p, [id]: { ...get(id), ...patch } }));

  if (sent) {
    return (
      <Frame foot="Sent by Mezonas for ROMCO.">
        <p className="eyebrow text-ink-muted">ROMCO asks · Invoice CRM update</p>
        <h1 className="type-heading text-ink">Thanks, Tom. It's answered.</h1>
        <p className="mt-2 text-ink">
          Bell County Earthworks goes to Renee Park to sign with today's other 5 deals.
        </p>
        <div className="mt-6">
          <Link to="/inbox" className="ds-btn ds-btn--primary">
            Back to the portal
          </Link>
        </div>
      </Frame>
    );
  }

  const send = () => {
    const open = NOT_FOUND.filter((n) => !get(n.id).pick).map((n) => n.id);
    setMissing(open);
    if (open.length === 0) {
      set({ inv: 2 });
      window.scrollTo(0, 0);
    }
  };

  return (
    <Frame foot="Sent by Mezonas for ROMCO. Renee Park sees your answers.">
      <p className="eyebrow text-ink-muted">ROMCO asks · Invoice CRM update</p>
      <h1 className="type-heading text-ink">
        1 sale from yesterday we couldn't match to a Zoho deal
      </h1>
      <p className="mt-2 text-ink">
        It has its Great Plains invoice. Pick the deal it closes, or say there isn't one. We'll mark
        the deal Closed Won with the invoice number after Renee Park signs.
      </p>
      <p className="mt-2 text-sm text-ink-muted">Due by 3:00 PM today · about a minute</p>
      <div className="demo-formbar">
        <span className="text-sm text-ink-muted">For the demo:</span>
        <Button size="sm" onClick={() => setPicks({ ...EXAMPLE_PICKS })}>
          Fill example answers
        </Button>
      </div>
      <div className="mt-6 flex flex-col gap-3">
        {NOT_FOUND.map((n) => {
          const x = get(n.id);
          return (
            <div
              key={n.id}
              className={cx("demo-frow", missing.includes(n.id) && !x.pick && "demo-frow--bad")}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium text-ink">{n.customer}</p>
                  <p className="text-sm text-ink-muted">
                    {n.machine} · {n.city} · <span className="font-mono">{n.invoice}</span> ·{" "}
                    {n.amount}
                  </p>
                </div>
                <Badge tone="warning">{n.why}</Badge>
              </div>
              <fieldset className="mt-3 flex flex-col gap-2 text-sm">
                <legend className="mb-1 text-ink">Which deal does it close?</legend>
                {n.candidates.map((c) => (
                  <label key={c.deal} className="flex items-center gap-2 text-ink">
                    <input
                      type="radio"
                      className="accent-slate"
                      checked={x.pick === c.deal}
                      onChange={() => put(n.id, { pick: c.deal })}
                    />
                    <span className="font-mono text-xs">{c.deal}</span> {c.name}
                    <span className="text-ink-muted">
                      · {c.stage} · {c.owner}
                    </span>
                  </label>
                ))}
                <label className="flex items-center gap-2 text-ink">
                  <input
                    type="radio"
                    className="accent-slate"
                    checked={x.pick === "none"}
                    onChange={() => put(n.id, { pick: "none" })}
                  />
                  There's no deal in Zoho for this sale
                </label>
              </fieldset>
              <div className="mt-3">
                <Field label="Comments" hint="Optional.">
                  <TextArea
                    rows={1}
                    autoSize
                    placeholder="Anything Renee should know"
                    value={x.note}
                    onChange={(e) => put(n.id, { note: e.target.value })}
                  />
                </Field>
              </div>
            </div>
          );
        })}
      </div>
      {missing.length > 0 && NOT_FOUND.some((n) => !get(n.id).pick) ? (
        <p className="ds-error mt-5 text-sm" role="alert">
          {NOT_FOUND.filter((n) => !get(n.id).pick).length} still need an answer. They're marked
          above.
        </p>
      ) : null}
      <div className="mt-6">
        <Button variant="primary" onClick={send}>
          Send
        </Button>
      </div>
    </Frame>
  );
}
