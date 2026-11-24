// Marcus Bell's review form: the public form page's frame (forms/FormPage.tsx) with his October
// filings in three parts. 1: confirm each is his territory and in the right group. 2: for existing
// clients ROMCO didn't quote, say why. 3: for buyers new to ROMCO, say whether he knew and what's
// next. Then check the answers and send; his regional manager gets a copy.
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Logo } from "../../ui/brand";
import { Field, Select, TextArea } from "../../ui/forms";
import { Badge, Button, Card, cx } from "../../ui/primitives";
import { TourBar } from "./DemoShell";
import { FILINGS, type Filing } from "./filings";
import { REPS, repByKey } from "./people";
import { RUN, useDemo } from "./state";

const MINE = FILINGS.filter((f) => f.rep === "marcus");
const DEALS = MINE.filter((f) => f.group === "won" || f.group === "lost");
const EXISTING = MINE.filter((f) => f.group === "existing");
const NEW = MINE.filter((f) => f.group === "new");

const WHY = [
  "Didn't know they were buying",
  "They bought through a national or fleet account",
  "Price or financing: we'd have lost anyway",
  "ROMCO doesn't carry that machine or size",
  "Needed it sooner than we could deliver",
  "Rental they converted to a purchase",
  "Other (say below)",
];
const COMMENT_PROMPT: Record<Filing["group"], string> = {
  won: "How did we win it? Anything to repeat?",
  lost: "What happened? Who won it, and at what price or terms?",
  existing: "What should we know about this client and this purchase?",
  new: "Who are they, who did they buy from, and who's the contact?",
};
const KNEW = ["Yes, I was talking to them", "I knew of them, no contact", "No, new to me"];
const NEXT = ["Add as a lead", "Already working them", "Not a fit for ROMCO"];

type Answer = {
  mine: "yes" | "no" | "";
  moveTo: string;
  why: string;
  knew: string;
  next: string;
  note: string;
};
const EMPTY: Answer = { mine: "", moveTo: "", why: "", knew: "", next: "", note: "" };

const EXAMPLE: Record<string, Partial<Answer>> = {
  f1: { mine: "yes", note: "Second fleet order this year; they want a service quote next." },
  f2: { mine: "yes", note: "Won on delivery: we had one in the yard." },
  f3: { mine: "yes", note: "Lost on price; their Cat dealer came in 6% under." },
  f4: { mine: "yes", note: "Needed it in two weeks; ours was eight." },
  f5: {
    mine: "yes",
    why: WHY[0] as string,
    note: "Haven't had a call with Tomball Grading since spring.",
  },
  f6: {
    mine: "yes",
    why: WHY[3] as string,
    note: "They wanted a smaller track loader than we stock. Worth a look at the line.",
  },
  f7: { mine: "yes", why: WHY[1] as string, note: "Bought under their parent's fleet agreement." },
  f8: { mine: "yes", why: WHY[0] as string, note: "Same account as Huntsville Timber, confirmed." },
  f9: {
    mine: "yes",
    why: WHY[5] as string,
    note: "Rented from us for 6 months, then bought from another dealer.",
  },
  f10: {
    mine: "yes",
    knew: KNEW[2] as string,
    next: NEXT[0] as string,
    note: "New residential developer in Magnolia. I'll call this week.",
  },
  f11: {
    mine: "no",
    moveTo: "kelsey",
    knew: KNEW[1] as string,
    next: NEXT[1] as string,
    note: "Belongs to Kelsey's Conroe branch account.",
  },
  f12: {
    mine: "yes",
    knew: KNEW[0] as string,
    next: NEXT[0] as string,
    note: "Met them at the October demo day; they went with a rental-to-own deal elsewhere.",
  },
};

export function ReviewForm() {
  const navigate = useNavigate();
  const { state, set } = useDemo();
  const [a, setA] = useState<Record<string, Answer>>({});
  const [problems, setProblems] = useState<string[]>([]);
  const [overall, setOverall] = useState("");
  const [checking, setChecking] = useState(false);
  const [sent, setSent] = useState(state.marcusDone);
  const get = (id: string): Answer => a[id] ?? EMPTY;
  const put = (id: string, patch: Partial<Answer>) =>
    setA((all) => ({ ...all, [id]: { ...get(id), ...patch } }));

  const fillExample = () => {
    const next: Record<string, Answer> = {};
    for (const f of MINE) next[f.id] = { ...EMPTY, ...EXAMPLE[f.id] };
    setA(next);
    setOverall(
      "Two of the five existing clients bought without calling. I'd like a quarterly check-in list for Houston North accounts that haven't bought in 12 months.",
    );
    setProblems([]);
  };

  const check = () => {
    const p: string[] = [];
    for (const f of MINE) {
      const x = get(f.id);
      if (!x.mine) p.push(f.id);
      else if (x.mine === "no" && !x.moveTo) p.push(f.id);
      else if (f.group === "existing" && x.mine === "yes" && !x.why) p.push(f.id);
      else if (f.group === "new" && x.mine === "yes" && (!x.knew || !x.next)) p.push(f.id);
    }
    setProblems(p);
    if (p.length === 0) setChecking(true);
  };

  if (sent) {
    return (
      <Frame>
        <p className="eyebrow text-ink-muted">ROMCO · UCC filings review</p>
        <h1 className="type-heading text-ink">Thanks, Marcus. Your answers are in.</h1>
        <p className="mt-2 text-ink">
          Ray Delgado has a copy. We moved Willis Ready Mix Hauling to Kelsey Tran and asked her
          about it.
        </p>
        <p className="mt-2 text-sm text-ink-muted">You can close this page.</p>
        <div className="mt-6 flex gap-2">
          <Link to={RUN("answers")} className="ds-btn ds-btn--primary">
            Back to the run
          </Link>
        </div>
      </Frame>
    );
  }

  const bad = new Set(problems);
  const head = (
    <>
      <p className="eyebrow text-ink-muted">ROMCO asks · UCC filings review</p>
      <h1 className="type-heading text-ink">Your October UCC review, Marcus</h1>
      <p className="mt-2 text-ink">
        12 equipment sales were filed in Houston North in October. Tell us which are yours, why we
        didn't quote the existing clients, and whether the new buyers were on your radar.
      </p>
      <p className="mt-2 text-sm text-ink-muted">
        Due Monday, November 10, 2026 · about 10 minutes · Ray Delgado gets a copy
      </p>
    </>
  );

  if (checking) {
    return (
      <Frame>
        {head}
        <p className="mt-5 text-ink">Check your answers, then send.</p>
        <dl className="mt-4 flex flex-col gap-3">
          {MINE.map((f) => {
            const x = get(f.id);
            return (
              <div key={f.id}>
                <dt className="text-sm font-medium text-ink">{f.debtor}</dt>
                <dd className="text-ink-muted">
                  {x.mine === "no" ? `Not mine: move to ${repByKey(x.moveTo).name}` : "Mine"}
                  {x.why ? ` · ${x.why}` : ""}
                  {x.knew ? ` · ${x.knew}` : ""}
                  {x.next ? ` · ${x.next}` : ""}
                </dd>
                {x.note ? <dd className="mt-0.5 text-sm text-ink">Comment: {x.note}</dd> : null}
              </div>
            );
          })}
          {overall ? (
            <div>
              <dt className="text-sm font-medium text-ink">Anything else about October</dt>
              <dd className="text-sm text-ink">{overall}</dd>
            </div>
          ) : null}
        </dl>
        <div className="mt-6 flex gap-2">
          <Button variant="secondary" onClick={() => setChecking(false)}>
            Change answers
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              set({ marcusDone: true, formsSent: true });
              setSent(true);
              window.scrollTo(0, 0);
            }}
          >
            Send
          </Button>
        </div>
      </Frame>
    );
  }

  return (
    <Frame>
      {head}
      <div className="demo-formbar">
        <span className="text-sm text-ink-muted">For the demo:</span>
        <Button size="sm" onClick={fillExample}>
          Fill example answers
        </Button>
        <span className="flex-1" />
        <button type="button" className="ds-btn ds-btn--link text-sm" onClick={() => navigate(-1)}>
          Back
        </button>
      </div>

      <Part
        n={1}
        title="Deals you worked"
        lede="These matched your deals in Zoho CRM. Confirm they're yours; add anything we should know."
      >
        {DEALS.map((f) => (
          <Row key={f.id} f={f} x={get(f.id)} put={(p) => put(f.id, p)} bad={bad.has(f.id)} />
        ))}
      </Part>

      <Part
        n={2}
        title="Existing clients we didn't quote"
        lede="These are ROMCO accounts that bought without a deal in Zoho CRM. Why didn't we get a shot?"
      >
        {EXISTING.map((f) => (
          <Row key={f.id} f={f} x={get(f.id)} put={(p) => put(f.id, p)} bad={bad.has(f.id)}>
            {get(f.id).mine === "yes" ? (
              <Field label="Why didn't ROMCO quote it?">
                <Select
                  value={get(f.id).why}
                  onChange={(e) => put(f.id, { why: e.target.value })}
                  invalid={bad.has(f.id) && !get(f.id).why}
                >
                  <option value="">Choose one</option>
                  {WHY.map((w) => (
                    <option key={w}>{w}</option>
                  ))}
                </Select>
              </Field>
            ) : null}
          </Row>
        ))}
      </Part>

      <Part
        n={3}
        title="New to ROMCO"
        lede="These buyers aren't in Zoho CRM. Were they on your radar, and what's next?"
      >
        {NEW.map((f) => (
          <Row key={f.id} f={f} x={get(f.id)} put={(p) => put(f.id, p)} bad={bad.has(f.id)}>
            {get(f.id).mine === "yes" ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Did you know about them?">
                  <Select
                    value={get(f.id).knew}
                    onChange={(e) => put(f.id, { knew: e.target.value })}
                    invalid={bad.has(f.id) && !get(f.id).knew}
                  >
                    <option value="">Choose one</option>
                    {KNEW.map((w) => (
                      <option key={w}>{w}</option>
                    ))}
                  </Select>
                </Field>
                <Field label="What's next?">
                  <Select
                    value={get(f.id).next}
                    onChange={(e) => put(f.id, { next: e.target.value })}
                    invalid={bad.has(f.id) && !get(f.id).next}
                  >
                    <option value="">Choose one</option>
                    {NEXT.map((w) => (
                      <option key={w}>{w}</option>
                    ))}
                  </Select>
                </Field>
              </div>
            ) : null}
          </Row>
        ))}
      </Part>

      <Part
        n={4}
        title="Anything else"
        lede="Comments on October as a whole: patterns you're seeing, accounts to watch, what would help."
      >
        <Field label="Comments" hint="Optional.">
          <TextArea
            rows={3}
            autoSize
            placeholder="Anything we should know about your territory this month"
            value={overall}
            onChange={(e) => setOverall(e.target.value)}
          />
        </Field>
      </Part>

      {problems.length > 0 ? (
        <p className="ds-error mt-5 text-sm" role="alert">
          {problems.length} {problems.length === 1 ? "filing needs" : "filings need"} an answer.
          They're marked above.
        </p>
      ) : null}
      <div className="mt-6 flex gap-2">
        <Button variant="primary" onClick={check}>
          Check my answers
        </Button>
      </div>
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <>
      <div
        className="flex min-h-screen flex-col items-center gap-8 bg-paper px-4 py-10 pb-32"
        data-testid="form-page"
      >
        <Logo height={22} />
        <Card className="w-full max-w-3xl" pad>
          {children}
        </Card>
        <p className="text-xs text-ink-muted">
          Sent by Mezonas for ROMCO. Only you and Ray Delgado see your answers.
        </p>
      </div>
      <TourBar />
    </>
  );
}

function Part({
  n,
  title,
  lede,
  children,
}: {
  n: number;
  title: string;
  lede: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-8">
      <div className="flex items-baseline gap-3">
        <span className="font-mono text-xs text-ink-muted">{n}</span>
        <h2 className="type-subheading text-ink">{title}</h2>
      </div>
      <p className="mt-1 mb-3 text-sm text-ink-muted">{lede}</p>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}

function Row({
  f,
  x,
  put,
  bad,
  children,
}: {
  f: Filing;
  x: Answer;
  put: (p: Partial<Answer>) => void;
  bad: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className={cx("demo-frow", bad && "demo-frow--bad")}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium text-ink">{f.debtor}</p>
          <p className="text-sm text-ink-muted">
            {f.equipment} · {f.city} {f.zip} · filed {f.filed} · {f.securedParty}
          </p>
          {f.deal ? (
            <p className="mt-1 text-sm">
              <span className="font-mono text-xs">{f.deal.id}</span> {f.deal.name} · {f.deal.amount}
            </p>
          ) : f.account ? (
            <p className="mt-1 text-sm">
              <span className="font-mono text-xs">{f.account.id}</span> client since{" "}
              {f.account.since} · last bought {f.account.lastPurchase}
            </p>
          ) : null}
        </div>
        {f.deal ? (
          <Badge tone={f.deal.stage === "Closed won" ? "positive" : "neutral"}>
            {f.deal.stage === "Closed won" ? "Won" : "Lost"}
          </Badge>
        ) : f.confidence < 92 ? (
          <Badge tone="warning">Please confirm the match</Badge>
        ) : null}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
        <span className="text-ink">Is this yours?</span>
        <label className="flex items-center gap-2 text-ink">
          <input
            type="radio"
            className="accent-slate"
            checked={x.mine === "yes"}
            onChange={() => put({ mine: "yes" })}
          />
          Yes
        </label>
        <label className="flex items-center gap-2 text-ink">
          <input
            type="radio"
            className="accent-slate"
            checked={x.mine === "no"}
            onChange={() => put({ mine: "no" })}
          />
          No, it's another territory
        </label>
        {x.mine === "no" ? (
          <Select
            className="w-56"
            value={x.moveTo}
            onChange={(e) => put({ moveTo: e.target.value })}
            invalid={bad && !x.moveTo}
          >
            <option value="">Whose is it?</option>
            {REPS.filter((r) => r.key !== "marcus").map((r) => (
              <option key={r.key} value={r.key}>
                {r.name} · {r.territory}
              </option>
            ))}
          </Select>
        ) : null}
      </div>
      {children ? <div className="mt-3">{children}</div> : null}
      <div className="mt-3">
        <Field label="Comments" hint="Optional. Ray Delgado sees them too.">
          <TextArea
            rows={2}
            autoSize
            placeholder={COMMENT_PROMPT[f.group]}
            value={x.note}
            onChange={(e) => put({ note: e.target.value })}
          />
        </Field>
      </div>
    </div>
  );
}
