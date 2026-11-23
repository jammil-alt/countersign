// The client page's Interviews (`/ops/clients/:clientId/interviews`, under the File tab; docs/plan.md
// §1.217): start a process interview for one of the client's contacts and copy its link to send
// them; read one as it goes and once finished: the answers, the sample files, the current-state
// map, the open questions and the reuse check; then draft the client's agent from it, which opens
// the build's Check the steps (§1.170). Loaded with its route, never in the first load.
import {
  INTAKE_AREA_TITLES,
  INTAKE_AREAS,
  type IntakeArea,
  type InterviewReuse,
  interviewRoutes,
  type OpsInterviewView,
} from "@countersign/core";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useApi, useApiClient } from "../../api/useApi";
import { ErrorNotice } from "../../ui/ErrorState";
import { Field, Select, TextInput } from "../../ui/forms";
import { Badge, Button, Card, Loading, Tag } from "../../ui/primitives";
import { cost } from "../../usage/format";
import { ClientFrame, clientPagePath } from "../client/ClientFrame";
import { OPS_PATHS } from "../paths";

const STATUS: Record<OpsInterviewView["status"], string> = {
  open: "Waiting on answers",
  finished: "Finished",
  closed: "Closed",
};

export default function InterviewsScreen() {
  const { clientId = "", id } = useParams();
  return (
    <ClientFrame
      clientId={clientId}
      intro="Ask someone at the client how a process works today, one question at a time."
    >
      {id ? <InterviewDetail clientId={clientId} id={id} /> : <InterviewList clientId={clientId} />}
    </ClientFrame>
  );
}

function CopyLink({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <TextInput readOnly value={link} className="min-w-0 flex-1" data-testid="interview-link" />
      <Button
        onClick={async () => {
          await navigator.clipboard.writeText(link);
          setCopied(true);
        }}
      >
        {copied ? "Copied" : "Copy link"}
      </Button>
    </div>
  );
}

function InterviewList({ clientId }: { clientId: string }) {
  const api = useApiClient();
  const list = useApi(interviewRoutes.opsInterviews, { params: { clientId } });
  const [contactId, setContactId] = useState("");
  const [process, setProcess] = useState("");
  const [area, setArea] = useState<IntakeArea | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [started, setStarted] = useState<OpsInterviewView | null>(null);

  if (list.loading && !list.data) return <Loading />;
  if (!list.data) {
    return list.error ? <ErrorNotice error={list.error} onRetry={list.reload} /> : null;
  }

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const made = await api.call(interviewRoutes.opsStartInterview, {
        params: { clientId },
        body: { contactId, process, area: area || null },
      });
      setStarted(made);
      setProcess("");
      list.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Card title="Start an interview" pad>
        <div className="flex flex-col gap-4">
          <Field label="Who to ask">
            <Select value={contactId} onChange={(e) => setContactId(e.target.value)}>
              <option value="">Choose a contact</option>
              {list.data.contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Which process" hint="In their words, for example Invoice reconciliation.">
            <TextInput
              value={process}
              maxLength={200}
              onChange={(e) => setProcess(e.target.value)}
            />
          </Field>
          <Field label="Business area" hint="Its intake questions are what the interview covers.">
            <Select value={area} onChange={(e) => setArea(e.target.value as IntakeArea | "")}>
              <option value="">None</option>
              {INTAKE_AREAS.map((a) => (
                <option key={a} value={a}>
                  {INTAKE_AREA_TITLES[a]}
                </option>
              ))}
            </Select>
          </Field>
          {error ? <ErrorNotice error={error} /> : null}
          <Button
            variant="primary"
            className="self-start"
            disabled={!contactId || !process.trim()}
            working={busy}
            onClick={() => void start()}
          >
            Start
          </Button>
          {started?.link ? (
            <div className="flex flex-col gap-2" data-testid="interview-started">
              <p className="text-ink">
                Send this link to {started.contact.name}. It works for 14 days, with no sign-in.
              </p>
              <CopyLink link={started.link} />
            </div>
          ) : null}
        </div>
      </Card>
      <Card title="Interviews">
        {list.data.interviews.length === 0 ? (
          <p className="px-6 py-5 text-ink-muted">No interviews yet.</p>
        ) : (
          <ul className="divide-y divide-line" data-testid="interview-list">
            {list.data.interviews.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-3 px-6 py-3">
                <Link
                  className="text-ink underline-offset-2 hover:underline"
                  to={clientPagePath(clientId, `interviews/${i.id}`)}
                >
                  {i.process}
                </Link>
                <span className="text-ink-muted">{i.contact.name}</span>
                <Badge
                  tone={
                    i.status === "finished"
                      ? "positive"
                      : i.status === "open"
                        ? "warning"
                        : "neutral"
                  }
                >
                  {STATUS[i.status]}
                </Badge>
                <span className="ml-auto text-ink-muted text-sm">{i.answered} answered</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function ReuseList({ reuse, stepId }: { reuse: InterviewReuse | null; stepId: string }) {
  const found = reuse?.steps.find((s) => s.stepId === stepId)?.candidates ?? [];
  if (!reuse) return null;
  if (found.length === 0)
    return <p className="text-ink-muted text-sm">Nothing in the catalog yet.</p>;
  return (
    <p className="text-ink-muted text-sm">
      May reuse: {found.map((c) => `${c.name} (${c.partType})`).join(", ")}
    </p>
  );
}

function InterviewDetail({ clientId, id }: { clientId: string; id: string }) {
  const api = useApiClient();
  const navigate = useNavigate();
  const view = useApi(interviewRoutes.opsInterview, { params: { clientId, id } });
  const [busy, setBusy] = useState<"close" | "draft" | null>(null);
  const [error, setError] = useState<unknown>(null);
  if (view.loading && !view.data) return <Loading />;
  const v = view.data;
  if (!v) return view.error ? <ErrorNotice error={view.error} onRetry={view.reload} /> : null;

  async function close() {
    setBusy("close");
    setError(null);
    try {
      await api.call(interviewRoutes.opsCloseInterview, { params: { clientId, id } });
      view.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  async function draft() {
    setBusy("draft");
    setError(null);
    try {
      const out = await api.call(interviewRoutes.opsDraftInterview, { params: { clientId, id } });
      if (out.buildId) navigate(OPS_PATHS.buildCheck(out.buildId));
    } catch (err) {
      setError(err);
      view.reload();
    } finally {
      setBusy(null);
    }
  }

  const outputs = v.outputs;
  return (
    <div className="flex flex-col gap-6" data-testid="interview-detail">
      <Card
        title={v.process}
        meta={
          <Badge
            tone={
              v.status === "finished" ? "positive" : v.status === "open" ? "warning" : "neutral"
            }
          >
            {STATUS[v.status]}
          </Badge>
        }
        pad
      >
        <div className="flex flex-col gap-3">
          <p className="text-ink">
            {v.contact.name}, {v.answered} answered. Their model calls cost us {cost(v.costUsd)}.
          </p>
          {v.link ? <CopyLink link={v.link} /> : null}
          {v.files.length > 0 ? (
            <p className="text-ink-muted text-sm">
              Sample files: {v.files.map((f) => f.filename).join(", ")} (in the client's documents)
            </p>
          ) : null}
          {error ? <ErrorNotice error={error} /> : null}
          <div className="flex flex-wrap gap-2">
            {v.status === "open" ? (
              <Button onClick={() => void close()} working={busy === "close"}>
                Close it
              </Button>
            ) : null}
            {v.status === "finished" && !v.buildId ? (
              <Button variant="primary" onClick={() => void draft()} working={busy === "draft"}>
                Draft the agent
              </Button>
            ) : null}
            {v.buildId ? (
              <Link className="ds-btn ds-btn--secondary" to={OPS_PATHS.buildCheck(v.buildId)}>
                Open the build
              </Link>
            ) : null}
          </div>
        </div>
      </Card>
      {outputs ? (
        <>
          <Card title="How it works today" pad>
            {outputs.map.trigger ? (
              <p className="mb-3 text-ink">Starts when: {outputs.map.trigger}</p>
            ) : null}
            <ol className="flex list-decimal flex-col gap-3 pl-5" data-testid="interview-map">
              {outputs.map.steps.map((s) => (
                <li key={s.id} className="text-ink">
                  <span>{s.name}</span>
                  {s.estimate ? (
                    <Tag tone="neutral" className="ml-2">
                      Estimate
                    </Tag>
                  ) : null}
                  <p className="text-ink-muted text-sm">
                    {[s.who, s.tool, s.volume].filter(Boolean).join(" · ")}
                  </p>
                  {s.detail ? <p className="text-ink-muted text-sm">{s.detail}</p> : null}
                  <ReuseList reuse={v.reuse} stepId={s.id} />
                </li>
              ))}
            </ol>
            {outputs.map.outcome ? (
              <p className="mt-3 text-ink">Ends with: {outputs.map.outcome}</p>
            ) : null}
            {outputs.ungrounded > 0 ? (
              <p className="mt-3 text-ink-muted text-sm">
                {outputs.ungrounded} step{outputs.ungrounded === 1 ? " was" : "s were"} left off
                because no answer described {outputs.ungrounded === 1 ? "it" : "them"}.
              </p>
            ) : null}
          </Card>
          <Card title="Still open" pad>
            {outputs.openQuestions.length === 0 ? (
              <p className="text-ink-muted">Nothing.</p>
            ) : (
              <ul className="flex flex-col gap-2" data-testid="interview-open">
                {outputs.openQuestions.map((q, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list, in order
                  <li key={i} className="text-ink">
                    {q.question}
                    <p className="text-ink-muted text-sm">{q.why}</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      ) : null}
      <Card title="Questions and answers" pad>
        <ol className="flex flex-col gap-2">
          {v.turns.map((t, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: turns are append-only, in order
            <li key={i} className={t.role === "agent" ? "text-ink" : "pl-3 text-ink-muted"}>
              {t.role === "agent"
                ? t.text
                : `${t.skipped ? "Didn't know." : t.text}${t.estimate ? " (an estimate)" : ""}`}
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}
