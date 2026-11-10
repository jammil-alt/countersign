// O5 New agent, by conversation (prototype `#O5-NewAgent`; ARCHITECTURE §9.6): the operator tells
// the Builder what the job is, turn by turn, and sees the draft it keeps beside the conversation:
// what the agent is, how it starts, the plan step by step, and the access it will ask the client
// for. Each change the Builder makes can be undone on its own. Nothing is an agent until the
// operator saves the draft (POST /api/ops/builder/sessions/:id/save), which opens it in the
// workflow builder. The conversation's id rides in `?session=` so a reload picks it up again.
import {
  type AgentBundle,
  AgentBundle as AgentBundleSchema,
  allTriggers,
  type BuilderSessionView,
  type BuilderTurnView,
  type Step,
} from "@countersign/core";
import { type ReactNode, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { connectorLabel, toolLabel } from "../../runs/labels";
import { AgentBadge } from "../../ui/badges";
import {
  Badge,
  Button,
  Card,
  cx,
  EmptyState,
  PageHeader,
  StepKindTag,
  Tag,
} from "../../ui/primitives";
import { StatusChip } from "../../ui/status";
import { BuilderMark, Composer, Turns } from "../builder/chat";
import {
  KIND_LABEL,
  stepDetail,
  TRIGGER_KIND_LABEL,
  triggerDetail,
  triggerTitle,
} from "../workflow/describe";
import { Stepper } from "./NewAgentParts";
import { detailMessages, errorText, isCode, Notice, notifyAgentsChanged, useAction } from "./ui";

type Detail = ResponseOf<typeof apiRoutes.opsBuilderSession>;
type Connection = ResponseOf<typeof apiRoutes.opsClient>["connections"][number];

function bundleOf(session: BuilderSessionView | undefined): AgentBundle | null {
  if (!session) return null;
  const parsed = AgentBundleSchema.safeParse(session.bundle);
  return parsed.success ? parsed.data : null;
}

/** Whether the Builder has drafted anything yet: a workflow, or a change to the blank start. */
function drafted(turns: readonly BuilderTurnView[]): boolean {
  return turns.some((t) => t.role === "builder" && t.changes.some((c) => !c.undone));
}

export function NewAgentConversation({
  clientId,
  clientName,
  connections = [],
  other,
}: {
  /** A client agent's client; none for a template. */
  clientId?: string;
  clientName?: string;
  /** The client's connections, for the access the draft will ask for. */
  connections?: readonly Connection[];
  /** The other ways to start (a template, blank, another client's agent). */
  other: ReactNode;
}) {
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const sessionId = search.get("session");
  const [detail, setDetail] = useState<Detail | null>(null);
  const loaded = useApi(
    apiRoutes.opsBuilderSession,
    sessionId && detail?.session.id !== sessionId ? { params: { id: sessionId } } : null,
  );
  const current = detail?.session.id === sessionId ? detail : (loaded.data ?? null);
  const [pending, setPending] = useState<string | null>(null);
  const action = useAction();
  const save = useAction();

  async function send(text: string): Promise<boolean> {
    setPending(text);
    let id = current?.session.id ?? null;
    if (!id) {
      const started = await action.call(apiRoutes.opsStartBuilderSession, {
        body: { kind: "agent", ...(clientId ? { clientId } : {}) },
      });
      if (!started.ok) {
        setPending(null);
        return false;
      }
      id = started.data.session.id;
      setDetail(started.data);
      setSearch({ session: id }, { replace: true });
    }
    const res = await action.call(apiRoutes.opsBuilderTurn, { params: { id }, body: { text } });
    setPending(null);
    if (!res.ok) return false;
    setDetail(res.data);
    return true;
  }

  async function undo(turnId: string, changeId: string) {
    if (!current) return;
    const res = await action.call(apiRoutes.opsBuilderUndo, {
      params: { id: current.session.id },
      body: { turnId, changeId },
    });
    if (res.ok) setDetail(res.data);
  }

  const bundle = bundleOf(current?.session);
  const first = bundle?.workflows[0]?.slug;

  async function openInBuilder() {
    if (!current) return;
    const res = await save.call(apiRoutes.opsBuilderSave, {
      params: { id: current.session.id },
      body: {},
    });
    if (!res.ok || !res.data.agent) return;
    notifyAgentsChanged();
    const base = clientId
      ? `/ops/clients/${clientId}/agents/${res.data.agent.slug}`
      : `/ops/templates/${res.data.agent.slug}`;
    navigate(first ? `${base}/workflows/${first}` : base);
  }

  const turns = current?.turns ?? [];
  const step = !bundle || !drafted(turns) ? 0 : 1;
  const title = clientName ? `New agent for ${clientName}` : "New template";

  return (
    <div className="flex flex-col gap-6" data-testid="new-agent-conversation">
      <PageHeader
        eyebrow={
          <span>
            <Link to="/ops/lab" className="hover:underline">
              Agent lab
            </Link>{" "}
            / {clientName ? "New agent" : "New template"}
          </span>
        }
        title={title}
        actions={<Stepper current={step} />}
      />
      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[460px_minmax(0,1fr)]">
        <Card
          title={
            <span className="flex items-center gap-2.5">
              <BuilderMark />
              Builder
            </span>
          }
          meta={<span className="text-sm text-ink-muted">Talk to it. It drafts, you decide.</span>}
          testId="new-agent-chat"
        >
          <div className="ui-card__body flex max-h-[70vh] min-h-[280px] flex-col gap-5 overflow-y-auto [overflow-wrap:anywhere]">
            {sessionId && !current && loaded.error ? (
              <Notice tone="warning" testId="new-agent-session-error">
                {errorText(loaded.error)}
              </Notice>
            ) : null}
            <Turns
              turns={turns}
              busy={action.busy}
              pending={pending}
              onUndo={undo}
              empty={
                <p className="text-sm text-ink-muted" data-testid="new-agent-chat-empty">
                  Say what the job is: what starts it, what it looks at, what it changes in the
                  client's tools, and who signs. The Builder uses the skills, automations and
                  connections you already have, lists anything missing, and asks before it guesses.
                  Every step that changes a tool starts with approval on.
                </p>
              }
            />
            {action.error ? (
              <Notice tone="warning" testId="new-agent-chat-error">
                {isCode(action.error, "builder_unavailable")
                  ? `The Builder can't reach its model right now. ${errorText(action.error)}`
                  : errorText(action.error)}
              </Notice>
            ) : null}
          </div>
          <div className="border-t border-line p-4">
            <Composer
              placeholder="Tell the Builder what to add or change"
              busy={action.busy}
              onSend={send}
            />
          </div>
        </Card>

        <div className="flex flex-col gap-6">
          {bundle && current ? (
            <DraftPlan
              bundle={bundle}
              session={current.session}
              clientName={clientName}
              connections={clientId ? connections : null}
              saving={save.busy}
              onOpen={openInBuilder}
            />
          ) : (
            <Card title="The plan" testId="new-agent-plan-empty" pad>
              <p className="text-sm text-ink-muted">
                The Builder's draft shows here as you talk: how the agent starts, each step, and the
                access it will ask the client for.
              </p>
            </Card>
          )}
          {save.error ? (
            <Notice tone="warning" testId="new-agent-save-error">
              {errorText(save.error)}
              {detailMessages(save.error).length ? (
                <ul className="mt-2 list-disc pl-5">
                  {detailMessages(save.error).map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              ) : null}
            </Notice>
          ) : null}
          <Card title="Start another way" pad testId="new-agent-other">
            {other}
          </Card>
        </div>
      </div>
    </div>
  );
}

// ── The draft beside the conversation ───────────────────────────────────────────────────────────

function DraftPlan({
  bundle,
  session,
  clientName,
  connections,
  saving,
  onOpen,
}: {
  bundle: AgentBundle;
  session: BuilderSessionView;
  clientName: string | undefined;
  /** A client agent's client's connections; null for a template. */
  connections: readonly Connection[] | null;
  saving: boolean;
  onOpen(): void;
}) {
  const { identity } = bundle.definition;
  const line = [identity.role, clientName ? `for ${clientName}` : "Template"].filter(Boolean);
  const closest = session.closest[0];
  return (
    <>
      <Card testId="new-agent-draft">
        <div className="ui-card__body flex flex-col gap-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-4">
              <AgentBadge name={identity.name} size="lg" />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="type-heading text-ink" data-testid="new-agent-draft-name">
                    {identity.name}
                  </h2>
                  <Badge tone="neutral">Draft</Badge>
                </div>
                <p className="mt-1 text-sm text-ink-muted">{line.join(" · ")}</p>
              </div>
            </div>
            <Button
              variant="primary"
              data-testid="new-agent-open-builder"
              disabled={saving}
              onClick={onOpen}
            >
              {saving ? "Saving…" : "Open in workflow builder"}
            </Button>
          </div>
          {identity.mission ? <p className="text-ink">{identity.mission}</p> : null}
          {closest ? (
            <p
              className="flex flex-wrap items-center gap-2 text-sm text-ink-muted"
              data-testid="new-agent-closest"
            >
              Closest template:
              <Link
                to={`/ops/templates/${closest.slug}`}
                className="rounded-sm border border-line px-2 py-0.5 text-ink hover:bg-surface-subtle"
              >
                {closest.name} v{closest.version} · {Math.round(closest.score * 100)}% alike
              </Link>
            </p>
          ) : null}
          <p className="text-sm text-ink-muted">
            Opening it saves the draft as {clientName ? "this client's agent" : "a template"}, v1,
            suggest only. Nothing runs until you test and publish it.
          </p>
          {session.errors.length > 0 ? (
            <Notice tone="neutral" testId="new-agent-draft-errors">
              Before it can be published:
              <ul className="mt-2 list-disc pl-5">
                {session.errors.map((e) => (
                  <li key={`${e.workflow}:${e.stepId}:${e.field}:${e.code}`}>{e.message}</li>
                ))}
              </ul>
            </Notice>
          ) : null}
        </div>
      </Card>

      <StartsWhen bundle={bundle} />
      <Plan bundle={bundle} />
      <Access bundle={bundle} connections={connections} />
    </>
  );
}

function StartsWhen({ bundle }: { bundle: AgentBundle }) {
  const rows = bundle.workflows.flatMap((w) =>
    allTriggers(w.workflow).map((t) => ({ t, workflow: w.name, key: `${w.slug}:${t.id}` })),
  );
  return (
    <Card titleAbove title="Starts when" testId="new-agent-starts">
      {rows.length === 0 ? (
        <div className="ui-card__body">
          <EmptyState>No triggers yet: it answers asks and commands.</EmptyState>
        </div>
      ) : (
        <ul>
          {rows.map(({ t, workflow, key }) => (
            <li
              key={key}
              className="flex items-center gap-4 border-t border-line px-6 py-3.5 first:border-t-0"
            >
              <Tag className="w-24 shrink-0 justify-center">{TRIGGER_KIND_LABEL[t.on.type]}</Tag>
              <span className="min-w-0">
                <span className="block text-ink">{triggerTitle(t)}</span>
                <span className="block text-sm text-ink-muted">
                  {[triggerDetail(t), `starts ${workflow}`].filter(Boolean).join(" · ")}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Top-level steps; a fork or loop shows its own line and the count inside. */
function Plan({ bundle }: { bundle: AgentBundle }) {
  const many = bundle.workflows.length > 1;
  return (
    <Card title="The plan" testId="new-agent-plan">
      {bundle.workflows.length === 0 ? (
        <div className="ui-card__body">
          <EmptyState>No workflows yet.</EmptyState>
        </div>
      ) : (
        <div className="ui-card__body flex flex-col gap-5">
          {bundle.workflows.map((w) => (
            <section key={w.slug} className="flex flex-col gap-2">
              {many ? <p className="eyebrow text-ink-muted">{w.name}</p> : null}
              <ol className="flex flex-col gap-2">
                <PlanRow
                  n={1}
                  kind="trigger"
                  title={triggerTitle(w.workflow.trigger)}
                  detail={triggerDetail(w.workflow.trigger)}
                />
                {w.workflow.steps.map((s, i) => (
                  <PlanStep key={s.id} n={i + 2} step={s} />
                ))}
              </ol>
            </section>
          ))}
        </div>
      )}
    </Card>
  );
}

function PlanStep({ n, step }: { n: number; step: Step }) {
  return (
    <PlanRow
      n={n}
      kind={step.kind}
      title={step.name || KIND_LABEL[step.kind]}
      detail={stepDetail(step)}
      person={step.kind === "person"}
    />
  );
}

function PlanRow({
  n,
  kind,
  title,
  detail,
  person,
}: {
  n: number;
  kind: string;
  title: string;
  detail: string | null;
  person?: boolean;
}) {
  return (
    <li
      className="flex items-center gap-3 rounded-md border border-line px-4 py-3"
      data-testid="new-agent-plan-step"
    >
      <span className="flex size-6 shrink-0 items-center justify-center rounded-sm border border-line text-xs text-ink-muted figures">
        {n}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cx("block truncate", person ? "text-copper-ink" : "text-ink")}>
          {title}
        </span>
        {detail ? <span className="block truncate text-sm text-ink-muted">{detail}</span> : null}
      </span>
      <StepKindTag kind={kind} label={KIND_LABEL[kind as keyof typeof KIND_LABEL] ?? kind} />
    </li>
  );
}

/** What the draft changes in the client's tools, by connector, and whether the client is connected. */
function Access({
  bundle,
  connections,
}: {
  bundle: AgentBundle;
  connections: readonly Connection[] | null;
}) {
  const byConnector = new Map<string, Set<string>>();
  const add = (tool: string) => {
    const connector = tool.split(".")[0] ?? tool;
    const set = byConnector.get(connector) ?? new Set<string>();
    set.add(tool);
    byConnector.set(connector, set);
  };
  for (const tool of bundle.definition.extraTools) add(tool);
  for (const w of bundle.workflows) {
    const walk = (steps: readonly Step[]) => {
      for (const s of steps) {
        if (s.kind === "action") add(s.tool);
        if (s.kind === "fork") {
          for (const p of s.paths) walk(p.steps);
          walk(s.otherwise.steps);
        }
        if (s.kind === "for_each") walk(s.steps);
      }
    };
    walk(w.workflow.steps);
  }
  const rows = [...byConnector.entries()].sort(([a], [b]) => a.localeCompare(b));
  return (
    <Card
      titleAbove
      title="Access it will ask for"
      meta={
        connections ? (
          <span className="text-sm text-ink-muted">The client grants these in Accounts</span>
        ) : null
      }
      testId="new-agent-access"
    >
      {rows.length === 0 ? (
        <div className="ui-card__body">
          <EmptyState>It changes none of the client's tools yet.</EmptyState>
        </div>
      ) : (
        <ul>
          {rows.map(([connector, tools]) => {
            const connected = connections?.some(
              (c) => c.connector === connector && c.status === "connected",
            );
            return (
              <li
                key={connector}
                className="flex items-center gap-4 border-t border-line px-6 py-3.5 first:border-t-0"
                data-testid={`new-agent-access-${connector}`}
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-sm border border-line font-mono text-xs text-ink">
                  {connector.slice(0, 2).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1 truncate text-ink">
                  {connectorLabel(connector)} · {[...tools].map((t) => toolLabel(t)).join(", ")}
                </span>
                {connections ? (
                  connected ? (
                    <StatusChip state="done">Connected</StatusChip>
                  ) : (
                    <StatusChip state="waiting">Not connected</StatusChip>
                  )
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
