// `/ops/deals/:id` (docs/plan.md §1.123.2; docs/design/pipelines.html `record()` for a deal): the
// deal's stage stepper, the composer and its timeline, and beside them its terms, people, Reggie's
// read, the builds it opened and its details. "Set up the account" on a new deal at its proposal
// or set-up creates the client and a build per agent; an agreed expansion opens its builds.
import {
  type DealActivityView,
  type DealDetail,
  type DealStage,
  SALES_PIPELINES,
  SALES_WORDS,
  salesPipeOf,
  shortDay,
} from "@countersign/core";
import { type ReactNode, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { apiRoutes } from "../../../api/routes";
import { useApi, useApiClient } from "../../../api/useApi";
import { cx } from "../../../ui/cx";
import { ErrorNotice } from "../../../ui/ErrorState";
import { Field, Select, TextArea, TextInput } from "../../../ui/forms";
import { Icon } from "../../../ui/icons";
import { Page } from "../../../ui/page";
import { Button, Loading } from "../../../ui/primitives";
import { OPS_PATHS } from "../../paths";
import { TodosPanel } from "../call/TodosPanel";
import { Due, monthValue, plural, Standing } from "./parts";
import { TermsPanel } from "./TermsPanel";

export function DealScreen() {
  const { id } = useParams();
  if (!id) return null;
  return (
    <Page testId="deal">
      <DealPage key={id} id={id} />
    </Page>
  );
}

const SOURCE_WORDS: Record<DealDetail["deal"]["source"], string> = {
  site_form: "The site's form",
  email: "Email",
  referral: "Referral",
  ops: "Added by you",
  reggie: "Spotted by Reggie",
};

function DealPage({ id }: { id: string }) {
  const res = useApi(apiRoutes.opsDeal, { params: { id } });
  const api = useApiClient();
  const [error, setError] = useState<unknown>(null);
  const [closing, setClosing] = useState(false);
  if (res.loading && !res.data) return <Loading />;
  if (!res.data) return res.error ? <ErrorNotice error={res.error} onRetry={res.reload} /> : null;
  const detail = res.data;
  const d = detail.deal;
  const pipe = salesPipeOf(d.kind);
  const isLead = d.kind === "new" && !d.client;
  const idx = detail.stages.findIndex((s) => s.id === d.stage);
  const closed = d.outcome !== "open";

  async function moveTo(stage: DealStage) {
    setError(null);
    try {
      await api.call(apiRoutes.opsUpdateDeal, { params: { id }, body: { stage } });
      res.reload();
    } catch (e) {
      setError(e);
    }
  }

  return (
    <div className="flex flex-col gap-5" data-testid="deal-page">
      <nav className="flex items-center gap-1.5 text-sm text-ink-muted" aria-label="Crumbs">
        <Link to={OPS_PATHS.sales} className="hover:underline">
          Sales
        </Link>
        <Icon name="chevron-right" />
        <Link to={OPS_PATHS.salesTab(pipe)} className="hover:underline">
          {SALES_PIPELINES[pipe].name}
        </Link>
        {d.client ? (
          <>
            <Icon name="chevron-right" />
            <Link to={OPS_PATHS.client(d.client.id)} className="hover:underline">
              {d.client.name}
            </Link>
          </>
        ) : null}
      </nav>
      <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="type-title text-ink" data-testid="deal-title">
            {isLead ? d.company : d.title}
          </h1>
          <p className="mt-1 text-ink-muted">
            {isLead ? `${d.title}${d.description ? ` · ${d.description}` : ""}` : d.description}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-muted">
            {d.client ? <span>{d.client.name}</span> : null}
            <span data-testid="deal-value">
              {d.agentCount ? `${plural(d.agentCount, "agent")} · ` : ""}
              {monthValue(d)} a month
            </span>
            <span className="flex items-center gap-2">
              Next step due <Due on={d.nextDueOn} today={utcToday()} done={closed} />
            </span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Standing standing={d.standing} text={d.statusText} testId="deal-standing" />
          {closed ? null : (
            <Button size="sm" onClick={() => setClosing((c) => !c)} data-testid="deal-close">
              {d.kind === "new" ? "Lost" : "Close"}
            </Button>
          )}
        </div>
      </header>
      {closing ? (
        <OutcomeForm
          id={id}
          kind={d.kind}
          onDone={() => {
            setClosing(false);
            res.reload();
          }}
          onCancel={() => setClosing(false)}
        />
      ) : null}
      <fieldset
        className="m-0 flex flex-wrap gap-1 border-0 p-0"
        aria-label="Stage"
        data-testid="deal-stages"
      >
        {detail.stages.map((s, n) => (
          <button
            key={s.id}
            type="button"
            disabled={closed || n === idx}
            aria-current={n === idx ? "step" : undefined}
            onClick={() => void moveTo(s.id)}
            className={cx(
              "min-w-0 flex-1 rounded-sm border px-3 py-2 text-left text-xs font-medium",
              n === idx
                ? "border-slate bg-slate-tint text-slate"
                : n < idx
                  ? "border-line bg-surface-subtle text-ink"
                  : "border-line bg-surface text-ink-muted hover:text-ink",
            )}
            data-testid={`deal-stage-${s.id}`}
          >
            {s.name}
          </button>
        ))}
      </fieldset>
      {error ? <ErrorNotice error={error} /> : null}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-4">
          <SetUp detail={detail} onChanged={res.reload} />
          <Composer id={id} isLead={isLead} onDone={res.reload} />
          <Timeline items={detail.activity} />
        </div>
        <aside className="flex flex-col gap-4">
          <TermsPanel detail={detail} onChanged={res.reload} />
          <TodosPanel about={{ kind: "deal", id: d.id }} clientId={d.client?.id ?? null} />
          <ReggieRead detail={detail} />
          <People detail={detail} onChanged={res.reload} />
          {detail.builds.length > 0 ? <Builds detail={detail} /> : null}
          <Details detail={detail} />
        </aside>
      </div>
    </div>
  );
}

/** The deal's own day for due dates: today in UTC, as the list reads it. */
function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function OutcomeForm({
  id,
  kind,
  onDone,
  onCancel,
}: {
  id: string;
  kind: "new" | "expansion";
  onDone(): void;
  onCancel(): void;
}) {
  const api = useApiClient();
  const [outcome, setOutcome] = useState<"lost" | "not_now" | "no" | "won">("lost");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<unknown>(null);
  const needsReason = outcome === "no";
  return (
    <form
      className="ds-card flex flex-col gap-3 p-4"
      data-testid="deal-outcome"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        try {
          await api.call(apiRoutes.opsDealOutcome, {
            params: { id },
            body: { outcome, ...(reason.trim() ? { reason: reason.trim() } : {}) },
          });
          onDone();
        } catch (err) {
          setError(err);
        }
      }}
    >
      <div className="flex flex-wrap gap-3">
        <Field label="How it ended">
          <Select
            value={outcome}
            onChange={(e) => setOutcome(e.target.value as typeof outcome)}
            data-testid="deal-outcome-kind"
          >
            <option value="lost">Lost: Reggie checks back in 90 days</option>
            <option value="not_now">Not now: Reggie checks back in 60 days</option>
            <option value="no">They said no</option>
            <option value="won">{kind === "new" ? "Won" : "Agreed and billed"}</option>
          </Select>
        </Field>
        <Field label={needsReason ? "Why" : "Why (optional)"} className="min-w-0 flex-1">
          <TextInput
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            data-testid="deal-outcome-reason"
          />
        </Field>
      </div>
      {error ? <ErrorNotice error={error} /> : null}
      <div className="flex gap-2">
        <Button
          type="submit"
          size="sm"
          variant="primary"
          disabled={needsReason && !reason.trim()}
          data-testid="deal-outcome-go"
        >
          Close the deal
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

interface AgentLine {
  name: string;
  templateId: string | null;
  promisedOn: string;
}

/** Set up the account (a new deal), or open the builds (an agreed expansion). */
function SetUp({ detail, onChanged }: { detail: DealDetail; onChanged(): void }) {
  const d = detail.deal;
  const api = useApiClient();
  const navigate = useNavigate();
  const canSetUp =
    d.kind === "new" &&
    !d.client &&
    d.outcome === "open" &&
    ["proposal", "setup"].includes(d.stage);
  const canOpen = d.kind === "expansion" && d.stage === "agreed" && d.outcome === "open";
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(d.company ?? d.title);
  const [timezone, setTimezone] = useState("");
  const [adminEmail, setAdminEmail] = useState(d.people.find((p) => p.isPrimary)?.email ?? "");
  const [agents, setAgents] = useState<AgentLine[]>(() =>
    (d.agentsSold.length > 0
      ? d.agentsSold
      : Array.from({ length: Math.max(1, d.agentCount) }, () => ({ name: "", templateId: null }))
    ).map((a) => ({ ...a, promisedOn: "" })),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (!canSetUp && !canOpen) return null;
  const primary = d.people.find((p) => p.isPrimary);
  const lines = agents
    .filter((a) => a.name.trim())
    .map((a) => ({
      name: a.name.trim(),
      templateId: a.templateId,
      ...(a.promisedOn ? { promisedOn: a.promisedOn } : {}),
    }));

  async function go() {
    setBusy(true);
    setError(null);
    try {
      if (canSetUp) {
        const out = await api.call(apiRoutes.opsDealSetup, {
          params: { id: d.id },
          body: {
            name: name.trim(),
            ...(timezone.trim() ? { timezone: timezone.trim() } : {}),
            ...(adminEmail.trim()
              ? {
                  adminEmail: adminEmail.trim(),
                  ...(primary && primary.email === adminEmail.trim()
                    ? { adminName: primary.name }
                    : {}),
                }
              : {}),
            agents: lines,
          },
        });
        onChanged();
        navigate(OPS_PATHS.client(out.clientId));
      } else {
        await api.call(apiRoutes.opsDealOpenBuilds, {
          params: { id: d.id },
          body: { agents: lines },
        });
        setOpen(false);
        onChanged();
      }
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div
        className="ds-card flex flex-wrap items-center justify-between gap-3 p-4"
        data-testid="deal-setup"
      >
        <span className="text-sm text-ink">
          {canSetUp
            ? "Creating the client and a build for each agent sold is yours."
            : "The terms are agreed: open a build for each agent sold."}
        </span>
        <Button
          size="sm"
          variant="primary"
          onClick={() => setOpen(true)}
          data-testid="deal-setup-open"
        >
          {canSetUp ? SALES_WORDS.setUp : SALES_WORDS.openBuilds}
        </Button>
      </div>
    );
  }
  return (
    <form
      className="ds-card flex flex-col gap-4 p-4"
      data-testid="deal-setup-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (lines.length > 0 && (!canSetUp || name.trim())) void go();
      }}
    >
      {canSetUp ? (
        <div className="flex flex-wrap gap-3">
          <Field label="Client name" className="min-w-0 flex-1">
            <TextInput
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-testid="deal-setup-name"
            />
          </Field>
          <Field label="Time zone" hint="Such as America/Chicago">
            <TextInput value={timezone} onChange={(e) => setTimezone(e.target.value)} />
          </Field>
          <Field label="Invite as admin" className="min-w-0 flex-1">
            <TextInput
              type="email"
              value={adminEmail}
              onChange={(e) => setAdminEmail(e.target.value)}
              data-testid="deal-setup-admin"
            />
          </Field>
        </div>
      ) : null}
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium text-ink">A build for each agent</span>
        {agents.map((a, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are edited in place, never reordered.
          <div key={i} className="flex flex-wrap items-end gap-3">
            <Field label="Agent" className="min-w-0 flex-1">
              <TextInput
                value={a.name}
                onChange={(e) =>
                  setAgents((xs) =>
                    xs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)),
                  )
                }
                data-testid={`deal-setup-agent-${i}`}
              />
            </Field>
            <Field label="Promised">
              <TextInput
                type="date"
                value={a.promisedOn}
                onChange={(e) =>
                  setAgents((xs) =>
                    xs.map((x, j) => (j === i ? { ...x, promisedOn: e.target.value } : x)),
                  )
                }
              />
            </Field>
          </div>
        ))}
        <Button
          size="sm"
          variant="ghost"
          className="self-start"
          onClick={() => setAgents((xs) => [...xs, { name: "", templateId: null, promisedOn: "" }])}
        >
          Add an agent
        </Button>
      </div>
      {error ? <ErrorNotice error={error} /> : null}
      <div className="flex gap-2">
        <Button
          type="submit"
          size="sm"
          variant="primary"
          disabled={busy || lines.length === 0 || (canSetUp && !name.trim())}
          data-testid="deal-setup-go"
        >
          {busy
            ? "Working…"
            : canSetUp
              ? `Create the client and ${plural(lines.length, "build")}`
              : `Open ${plural(lines.length, "build")}`}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

const COMPOSER_TABS = [
  ["email", "Email"],
  ["note", "Internal note"],
  ["call", "Call"],
  ["meeting", "Meeting"],
] as const;
type ComposerTab = (typeof COMPOSER_TABS)[number][0];

function Composer({ id, isLead, onDone }: { id: string; isLead: boolean; onDone(): void }) {
  const api = useApiClient();
  // The Email tab sends through Reggie's inbox (§1.123.4, `POST /api/ops/deals/:id/email`) to
  // the deal's primary person, written on the timeline as email out. The composer opens on the
  // internal note.
  const [tab, setTab] = useState<ComposerTab>("note");
  const [text, setText] = useState("");
  const [subject, setSubject] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const tabs = COMPOSER_TABS.map(
    ([k, label]) => [k, k === "email" && !isLead ? "Reply to the client" : label] as const,
  );
  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (tab === "email") {
        await api.call(apiRoutes.opsDealEmail, {
          params: { id },
          body: { subject: subject.trim(), text: text.trim() },
        });
        setSubject("");
      } else {
        await api.call(apiRoutes.opsDealActivity, {
          params: { id },
          body: { kind: tab, body: text.trim() },
        });
      }
      setText("");
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="ds-card p-4" data-testid="deal-composer">
      <div className="ds-tabs mb-3" role="tablist">
        {tabs.map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            data-testid={`deal-composer-${k}`}
          >
            {label}
          </button>
        ))}
      </div>
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim() && (tab !== "email" || subject.trim())) void save();
        }}
      >
        {tab === "email" ? (
          <TextInput
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Subject"
            aria-label="Subject"
            data-testid="deal-composer-subject"
          />
        ) : null}
        <TextArea
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={
            tab === "note"
              ? "Only the back office sees this."
              : tab === "email"
                ? "Write to them. Replies come back to this deal."
                : "What was said"
          }
          data-testid="deal-composer-text"
        />
        {error ? <ErrorNotice error={error} /> : null}
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-ink-muted">
            {tab === "email"
              ? "Goes from you via Mezonas to the deal's primary person."
              : "Goes on the timeline as activity."}
          </span>
          <Button
            type="submit"
            size="sm"
            variant="primary"
            disabled={busy || !text.trim() || (tab === "email" && !subject.trim())}
            data-testid="deal-composer-save"
          >
            {tab === "email" ? "Send" : "Save"}
          </Button>
        </div>
      </form>
    </div>
  );
}

const KIND_WORDS: Partial<Record<DealActivityView["kind"], string>> = {
  email_in: "Email",
  email_out: "Email",
  note: "Internal note",
  call: "Call",
  meeting: "Meeting",
  form: "Site form",
  terms: "Terms",
};

function when(at: string): string {
  const d = new Date(at);
  return `${shortDay(at)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function Timeline({ items }: { items: DealActivityView[] }) {
  if (items.length === 0) return null;
  return (
    <ol className="m-0 flex list-none flex-col gap-3 p-0" data-testid="deal-timeline">
      {items.map((a) => {
        const system = a.kind === "stage" || a.kind === "system";
        const note = a.kind === "note";
        return (
          <li
            key={a.id}
            data-testid={`deal-activity-${a.id}`}
            className={cx(
              "rounded-sm border px-4 py-3 text-sm",
              note ? "border-copper-tint bg-copper-tint" : "border-line bg-surface",
              system && "border-transparent bg-transparent py-1 text-ink-muted",
            )}
          >
            <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
              {a.who ? <span className="font-medium text-ink">{a.who}</span> : null}
              {KIND_WORDS[a.kind] ? (
                <span className={note ? "ds-pill ds-pill--person ds-pill--sm" : "ds-tag"}>
                  {KIND_WORDS[a.kind]}
                </span>
              ) : null}
              <span>{when(a.createdAt)}</span>
            </div>
            {a.subject ? <p className="m-0 font-medium text-ink">{a.subject}</p> : null}
            <p className={cx("m-0 whitespace-pre-wrap", system ? "text-ink-muted" : "text-ink")}>
              {a.body}
            </p>
          </li>
        );
      })}
    </ol>
  );
}

function Panel({
  title,
  meta,
  children,
  testId,
}: {
  title: string;
  meta?: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section className="ds-card" data-testid={testId}>
      <div className="ui-card__head">
        <h3 className="type-subheading text-ink">{title}</h3>
        {meta ? <span className="text-xs text-ink-muted">{meta}</span> : null}
      </div>
      <div className="ui-card__body text-sm">{children}</div>
    </section>
  );
}

function ReggieRead({ detail }: { detail: DealDetail }) {
  const ev = detail.deal.evidence;
  return (
    <Panel title="Reggie's read" testId="deal-read">
      {ev.length === 0 ? (
        <p className="m-0 text-ink-muted">Reggie hasn't read this yet.</p>
      ) : (
        <ul className="m-0 flex list-disc flex-col gap-1 pl-4">
          {ev.map((e) => (
            <li key={e.text}>{e.text}</li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function People({ detail, onChanged }: { detail: DealDetail; onChanged(): void }) {
  const api = useApiClient();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("");
  const [error, setError] = useState<unknown>(null);
  async function add() {
    setError(null);
    try {
      await api.call(apiRoutes.opsAddDealPerson, {
        params: { id: detail.deal.id },
        body: {
          name: name.trim(),
          ...(email.trim() ? { email: email.trim() } : {}),
          ...(role.trim() ? { role: role.trim() } : {}),
        },
      });
      setAdding(false);
      setName("");
      setEmail("");
      setRole("");
      onChanged();
    } catch (e) {
      setError(e);
    }
  }
  return (
    <Panel title="People" testId="deal-people">
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {detail.deal.people.map((p) => (
          <li key={p.id} className="flex flex-col">
            <span className="text-ink">
              {p.name}
              {p.isPrimary ? (
                <span className="ml-2 text-xs text-ink-muted">Main contact</span>
              ) : null}
            </span>
            <span className="text-xs text-ink-muted">
              {[p.role, p.email, p.phone].filter(Boolean).join(" · ")}
            </span>
          </li>
        ))}
        {detail.deal.people.length === 0 ? <li className="text-ink-muted">Nobody yet.</li> : null}
      </ul>
      {adding ? (
        <form
          className="mt-3 flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) void add();
          }}
        >
          <TextInput
            placeholder="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            data-testid="deal-person-name"
          />
          <TextInput
            placeholder="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <TextInput placeholder="Role" value={role} onChange={(e) => setRole(e.target.value)} />
          {error ? <ErrorNotice error={error} /> : null}
          <div className="flex gap-2">
            <Button type="submit" size="sm" variant="primary" data-testid="deal-person-save">
              Add
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          className="mt-2"
          onClick={() => setAdding(true)}
          data-testid="deal-person-add"
        >
          Add a person
        </Button>
      )}
    </Panel>
  );
}

function Builds({ detail }: { detail: DealDetail }) {
  return (
    <Panel title="Builds" meta={plural(detail.builds.length, "build")} testId="deal-builds">
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {detail.builds.map((b) => (
          <li key={b.id}>
            <Link to={OPS_PATHS.build(b.id)} className="text-ink hover:underline">
              {b.title}
            </Link>
            <span className="ml-2 text-xs text-ink-muted">
              {b.status === "live" ? "Live" : b.status === "stopped" ? "Stopped" : "In progress"}
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function Details({ detail }: { detail: DealDetail }) {
  const d = detail.deal;
  const facts: [string, string][] = [
    ["Stage", d.stageName],
    d.client ? ["Client", d.client.name] : ["Company", d.company ?? ""],
    ["Value", `${monthValue(d)} a month`],
    ...(d.agentsSold.length > 0
      ? ([["Fits", d.agentsSold.map((a) => a.name).join(", ")]] as [string, string][])
      : []),
    [
      "Source",
      d.sourceDetail ? `${SOURCE_WORDS[d.source]}: ${d.sourceDetail}` : SOURCE_WORDS[d.source],
    ],
    ...(d.outcomeReason ? ([["Why it closed", d.outcomeReason]] as [string, string][]) : []),
    ...(d.checkBackOn ? ([["Check back", shortDay(d.checkBackOn)]] as [string, string][]) : []),
  ];
  return (
    <Panel title="Details" testId="deal-details">
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
        {facts.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-ink-muted">{k}</dt>
            <dd className="m-0 text-ink">{v}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}
