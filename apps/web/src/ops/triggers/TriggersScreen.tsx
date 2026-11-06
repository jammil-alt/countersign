// O7 Triggers (prototype `#O7-Triggers`; ARCHITECTURE §10.8): how an agent starts. The agent's
// triggers, read from its latest version (what the next publish uses), with when each last fired
// (GET /api/ops/agents/:id/triggers, client agents only); "Add a trigger" of any of the six kinds,
// saved as a new draft version; the six kinds explained; and the settings of its webhook and
// message triggers. The hook's URL and secret are the client's (their admin keeps them in
// Accounts), so this screen never shows them.
import type { AgentBundle, Trigger, TriggerOn } from "@countersign/core";
import { type ReactNode, useState } from "react";
import { Link } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { type AgentSummary, apiRoutes, type VersionDetail } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { shortTime } from "../../runs/format";
import { Button, Card, cx, EmptyState, Tag } from "../../ui/primitives";
import { StatusChip } from "../../ui/status";
import { detailMessages, errorText, Notice, plural, useAction } from "../agents/ui";
import { rulesText, TRIGGER_KIND_LABEL } from "../workflow/describe";
import {
  AddTriggerForm,
  KIND_TITLE,
  newTriggerId,
  TRIGGER_KINDS,
  type TriggerKind,
} from "./AddTrigger";
import {
  addTrigger,
  channelWords,
  guardWords,
  localized,
  peopleWords,
  removeTrigger,
  type TriggerRow,
  triggerRows,
  whenWords,
} from "./words";

type Fired = ResponseOf<typeof apiRoutes.opsAgentTriggers>;

const KINDS: Record<TriggerKind, { tag: string; text: string; examples: string }> = {
  schedule: {
    tag: "Job",
    text: "Runs on a clock: every weekday at 8, the 1st of the month, every 2 hours. In the client's time zone.",
    examples: "A weekly price review · month-end close · a daily sweep",
  },
  event: {
    tag: "Something changed",
    text: "A connected tool or document changed: a bill created, a charge posted, a document received.",
    examples: "From connectors and packs, each with a sample payload and filters",
  },
  webhook: {
    tag: "Outside system",
    text: "Any system posts to the client's own hook: Zapier, a form, the client's ERP.",
    examples: "Signed, filtered, payload kept as data",
  },
  manual: {
    tag: "Run now",
    text: "A person presses Run with a short form: from the agent's page, the Desk or the back office.",
    examples: "The client may run it too, if you let them",
  },
  message: {
    tag: "Talk to it",
    text: "An email to the agent's address, a text or WhatsApp to its number, a /command in a thread, or Sloan passing a request.",
    examples: "Only from the people you name",
  },
  handoff: {
    tag: "Handoff",
    text: "One agent's run finishes and hands its output to the next.",
    examples: "Same client only, with the run's sources passed along",
  },
};

export function TriggersScreen({
  agent,
  latest,
  bundle,
  onChanged,
}: {
  agent: AgentSummary;
  /** The agent's latest version, which the table reads and new triggers are added to. */
  latest: VersionDetail | null;
  bundle: AgentBundle | null;
  onChanged(): void;
}) {
  const isClient = agent.kind === "client";
  const fired = useApi(apiRoutes.opsAgentTriggers, isClient ? { params: { id: agent.id } } : null);
  const [adding, setAdding] = useState<TriggerKind | null>(null);
  const [saved, setSaved] = useState<{ version: number; errors: string[]; what: string } | null>(
    null,
  );
  const action = useAction();
  const name = agent.name;

  if (!latest || !bundle) {
    return <EmptyState>This agent has no versions yet.</EmptyState>;
  }
  const rows = triggerRows(bundle);

  async function saveBundle(next: AgentBundle, what: string) {
    if (!latest) return false;
    setSaved(null);
    const res = await action.call(apiRoutes.opsSaveVersion, {
      params: { id: agent.id },
      body: { bundle: next, parentVersionId: latest.id, changeNote: what },
    });
    if (!res.ok) return false;
    setSaved({
      version: res.data.version.version,
      errors: res.data.errors.map((e) => e.message),
      what,
    });
    onChanged();
    return true;
  }

  async function add(workflow: string, on: TriggerOn) {
    if (!bundle) return;
    const trigger: Trigger = { id: newTriggerId(), on };
    const ok = await saveBundle(
      addTrigger(bundle, workflow, trigger),
      `Added a ${KIND_TITLE[on.type as TriggerKind]?.toLowerCase() ?? on.type} trigger`,
    );
    if (ok) setAdding(null);
  }

  const lastFired = (id: string) => fired.data?.triggers.find((t) => t.triggerId === id)?.lastFired;
  const webhooks = rows.filter((r) => r.trigger.on.type === "webhook");
  const messages = rows.filter((r) => r.trigger.on.type === "message");

  return (
    <div className="flex flex-col gap-8" data-testid="triggers-screen">
      <div>
        <h2 className="type-title text-ink">How {name} starts</h2>
        <p className="mt-1 text-ink-muted">
          Each trigger starts one workflow. An agent can have as many as it needs.
        </p>
      </div>

      <Card
        title={`${name}'s triggers`}
        testId="triggers-table"
        meta={
          <span className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-ink-muted">
              v{latest.version} · {latest.status === "live" ? "live" : latest.status}
            </span>
            <Button
              variant="primary"
              size="sm"
              data-testid="triggers-add"
              aria-expanded={adding !== null}
              onClick={() => setAdding(adding ? null : "schedule")}
            >
              Add a trigger
            </Button>
          </span>
        }
      >
        {saved ? (
          <div className="px-6 pb-4">
            <Notice tone={saved.errors.length ? "warning" : "positive"} testId="triggers-saved">
              {saved.what}: saved v{saved.version} as a draft. It starts work once you publish it
              from the bar above.
              {saved.errors.length ? (
                <ul className="mt-2 list-disc pl-5">
                  {saved.errors.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              ) : null}
            </Notice>
          </div>
        ) : null}
        {action.error ? (
          <div className="px-6 pb-4">
            <Notice tone="warning" testId="triggers-error">
              {errorText(action.error)}
              {detailMessages(action.error).length ? (
                <ul className="mt-2 list-disc pl-5">
                  {detailMessages(action.error).map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              ) : null}
            </Notice>
          </div>
        ) : null}
        {rows.length === 0 ? (
          <div className="px-6 pb-6">
            <EmptyState>
              No workflows yet, so nothing starts it. Add one in the workflow builder.
            </EmptyState>
          </div>
        ) : (
          <div className="dt dt-ana overflow-x-auto rounded-none border-x-0 border-b-0">
            <table>
              <thead>
                <tr className="dt-cols">
                  <th>Type</th>
                  <th>When</th>
                  <th>Starts workflow</th>
                  <th>Guards</th>
                  {isClient ? <th>Last fired</th> : null}
                  <th>On</th>
                  <th>
                    <span className="sr-only">Remove</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <TriggerTableRow
                    key={`${r.workflow}:${r.trigger.id}`}
                    row={r}
                    isClient={isClient}
                    lastFired={lastFired(r.trigger.id)}
                    busy={action.busy}
                    onRemove={() =>
                      saveBundle(
                        removeTrigger(bundle, r.workflow, r.trigger.id),
                        `Removed a ${TRIGGER_KIND_LABEL[r.trigger.on.type].toLowerCase()} trigger`,
                      )
                    }
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {adding ? (
          <AddTriggerForm
            key={adding}
            bundle={bundle}
            kind={adding}
            clientId={isClient ? agent.tenantId : null}
            agentSlug={agent.slug}
            busy={action.busy}
            onAdd={add}
            onCancel={() => setAdding(null)}
          />
        ) : null}
      </Card>

      <section className="flex flex-col gap-4" aria-labelledby="trigger-kinds">
        <h2 id="trigger-kinds" className="type-heading text-ink">
          Six ways an agent can start
        </h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {TRIGGER_KINDS.map((k) => (
            <KindCard key={k} kind={k} selected={adding === k} onAdd={() => setAdding(k)} />
          ))}
        </div>
      </section>

      {webhooks.length > 0 || messages.length > 0 ? (
        <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-2">
          {webhooks.map((r) => (
            <WebhookSettings key={r.trigger.id} row={r} />
          ))}
          {messages.map((r) => (
            <MessageSettings
              key={r.trigger.id}
              row={r}
              name={name}
              address={fired.data?.address ?? null}
              commandName={fired.data?.commandName ?? null}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TriggerTableRow({
  row,
  isClient,
  lastFired,
  busy,
  onRemove,
}: {
  row: TriggerRow;
  isClient: boolean;
  lastFired: Fired["triggers"][number]["lastFired"] | undefined;
  busy: boolean;
  onRemove(): void;
}) {
  const { trigger } = row;
  const guards = guardWords(trigger.on);
  return (
    <tr data-testid={`trigger-row-${trigger.id}`}>
      <td>
        <Tag>{TRIGGER_KIND_LABEL[trigger.on.type]}</Tag>
      </td>
      <td className="text-ink">{whenWords(trigger.on)}</td>
      <td className="text-ink">{row.workflowName}</td>
      <td className="text-sm text-ink-muted">{guards.length ? guards.join(" · ") : "None"}</td>
      {isClient ? (
        <td className="text-sm">
          {lastFired ? (
            <Link to={`/ops/runs/${lastFired.runId}`} className="figures text-link hover:underline">
              {lastFired.mode === "test" ? "Test · " : ""}
              {shortTime(lastFired.at)}
            </Link>
          ) : (
            <span className="text-ink-muted">Never</span>
          )}
        </td>
      ) : null}
      <td>
        <StatusChip state={row.enabled ? "done" : "idle"}>{row.enabled ? "On" : "Off"}</StatusChip>
      </td>
      <td className="text-right">
        {row.first ? null : (
          <button
            type="button"
            className="ds-btn ds-btn--link text-sm"
            data-testid={`trigger-remove-${trigger.id}`}
            disabled={busy}
            onClick={onRemove}
          >
            Remove
          </button>
        )}
      </td>
    </tr>
  );
}

function KindCard({
  kind,
  selected,
  onAdd,
}: {
  kind: TriggerKind;
  selected: boolean;
  onAdd(): void;
}) {
  const k = KINDS[kind];
  return (
    <div
      data-testid={`trigger-kind-${kind}`}
      className={cx(
        "flex flex-col gap-3 rounded-md border bg-surface px-6 py-5",
        selected ? "border-slate" : "border-line",
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="type-subheading text-ink">{KIND_TITLE[kind]}</h3>
        <Tag>{k.tag}</Tag>
      </div>
      <p className="text-sm text-ink">{k.text}</p>
      <p className="text-sm text-ink-muted">{k.examples}</p>
      <div className="mt-auto">
        <button
          type="button"
          className="ds-btn ds-btn--link text-sm"
          data-testid={`trigger-kind-${kind}-add`}
          aria-label={`Add a trigger: ${KIND_TITLE[kind]}`}
          onClick={onAdd}
        >
          Add one
        </button>
      </div>
    </div>
  );
}

function Setting({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="eyebrow text-ink-muted">{label}</span>
      <span className="text-sm text-ink">{children}</span>
    </div>
  );
}

function WebhookSettings({ row }: { row: TriggerRow }) {
  const on = row.trigger.on;
  if (on.type !== "webhook") return null;
  return (
    <Card
      title="Webhook settings"
      meta={<span className="text-sm text-ink-muted">{row.workflowName}</span>}
      testId={`trigger-webhook-${row.trigger.id}`}
      pad
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Setting label="Hook">
          <span className="font-mono text-xs break-all">{on.hookId}</span>
        </Setting>
        <Setting label="Signing">The hook's own secret, kept by the client</Setting>
        <Setting label="Run only if">
          {on.filter?.rules.length ? (
            <span className="font-mono text-xs">{rulesText(on.filter)}</span>
          ) : (
            "Every delivery"
          )}
        </Setting>
        <Setting label="Dedupe on">
          {on.dedupeKey ? (
            <span className="font-mono text-xs">{on.dedupeKey}</span>
          ) : (
            "Nothing: each delivery runs"
          )}
        </Setting>
        <Setting label="Limit">
          {on.rateLimit ? `${plural(on.rateLimit.max, "run")} per ${on.rateLimit.per}` : "No limit"}
        </Setting>
      </div>
      <p className="mt-4 text-sm text-ink-muted">
        The client's admin makes the hook and copies its URL in Accounts. Its payload goes in as
        data.
      </p>
    </Card>
  );
}

function MessageSettings({
  row,
  name,
  address,
  commandName,
}: {
  row: TriggerRow;
  name: string;
  address: string | null;
  commandName: string | null;
}) {
  const on = row.trigger.on;
  if (on.type !== "message") return null;
  const where = (c: string) =>
    c === "email" && address
      ? `Email · ${address}`
      : c === "command" && commandName
        ? `/${commandName} in a thread`
        : channelWords(c);
  return (
    <Card
      title="Message settings"
      meta={<span className="text-sm text-ink-muted">{row.workflowName}</span>}
      testId={`trigger-message-${row.trigger.id}`}
      pad
    >
      <div className="flex flex-col gap-4">
        <Setting label="Channels">
          <ul className="flex flex-col gap-1.5">
            {on.channels.map((c) => (
              <li key={c} className="flex items-center justify-between gap-3">
                <span>{where(c)}</span>
                <StatusChip state="done">On</StatusChip>
              </li>
            ))}
          </ul>
        </Setting>
        <Setting label="Who can start it">{peopleWords(on.from)}. Anyone else gets no run.</Setting>
        <Setting label={`What ${name} reads`}>
          The message and its attachments go in as data for the first step. A message can't change{" "}
          {name}'s rules or access.
        </Setting>
        <Setting label="Replies">
          {on.reply ? `Confirms: "${localized(on.reply.confirm)}"` : "No automatic reply"}
        </Setting>
      </div>
    </Card>
  );
}
