// O7 Triggers (prototype `#O7-Triggers`; ARCHITECTURE §10.8), folded into the agent page's Workflow
// tab as its first step (the owner's v1 screens 5 and 7): how the agent starts, read from its
// latest version (what the next publish uses), with when each trigger last fired (GET
// /api/ops/agents/:id/triggers, client agents only). Each row opens to its guards and, for webhook
// and message triggers, their settings. "Add a trigger" opens a dialog that explains the six kinds
// and saves the new trigger as a new draft version. The hook's URL and secret are the client's
// (their admin keeps them in Accounts), so this panel never shows them.
import type { AnyAgentBundle, Trigger, TriggerOn } from "@countersign/core";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { type AgentSummary, apiRoutes, type VersionDetail } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { shortTime } from "../../runs/format";
import { Icon } from "../../ui/icons";
import { Button, Card, cx, Tag } from "../../ui/primitives";
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
  type EventLabels,
  eventLabels,
  guardWords,
  localized,
  peopleWords,
  removeTrigger,
  type TriggerRow,
  triggerRows,
  whenWords,
} from "./words";

type Fired = ResponseOf<typeof apiRoutes.opsAgentTriggers>;

export const KINDS: Record<TriggerKind, { tag: string; text: string; examples: string }> = {
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

export function TriggersPanel({
  agent,
  latest,
  bundle,
  onChanged,
}: {
  agent: AgentSummary;
  /** The agent's latest version, which the list reads and new triggers are added to. */
  latest: VersionDetail | null;
  bundle: AnyAgentBundle | null;
  /** After a save, with the new draft version's id. */
  onChanged(versionId: string): void;
}) {
  const isClient = agent.kind === "client";
  const fired = useApi(apiRoutes.opsAgentTriggers, isClient ? { params: { id: agent.id } } : null);
  const events = useApi(apiRoutes.opsEventCatalog, { life: "catalog" });
  const [adding, setAdding] = useState(false);
  const [saved, setSaved] = useState<{ version: number; errors: string[]; what: string } | null>(
    null,
  );
  const action = useAction();
  // The trigger whose Remove was pressed: only its button says "Removing…" (1.8).
  const [removing, setRemoving] = useState<string | null>(null);

  if (!latest || !bundle) return null;
  const rows = triggerRows(bundle);
  const labels = eventLabels(events.data?.events);
  const manyWorkflows = bundle.workflows.length > 1;

  async function saveBundle(next: AnyAgentBundle, what: string) {
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
    onChanged(res.data.version.id);
    return true;
  }

  async function add(workflow: string, on: TriggerOn) {
    if (!bundle) return;
    const trigger: Trigger = { id: newTriggerId(), on };
    const ok = await saveBundle(
      addTrigger(bundle, workflow, trigger),
      `Added a ${KIND_TITLE[on.type as TriggerKind]?.toLowerCase() ?? on.type} trigger`,
    );
    if (ok) setAdding(false);
  }

  const lastFired = (id: string) => fired.data?.triggers.find((t) => t.triggerId === id)?.lastFired;

  return (
    <Card
      titleAbove
      title={`Starts when · ${plural(rows.length, "trigger")}`}
      testId="triggers-table"
      meta={
        <Button
          size="sm"
          data-testid="triggers-add"
          aria-haspopup="dialog"
          onClick={() => setAdding(true)}
        >
          Add a trigger
        </Button>
      }
    >
      {saved || action.error ? (
        <div className="flex flex-col gap-2 px-6 pb-4">
          {saved ? (
            <Notice tone={saved.errors.length ? "warning" : "positive"} testId="triggers-saved">
              {saved.what}: saved v{saved.version} as a draft. It starts work once you publish it.
              {saved.errors.length ? (
                <ul className="mt-2 list-disc pl-5">
                  {saved.errors.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              ) : null}
            </Notice>
          ) : null}
          {action.error && !adding ? (
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
          ) : null}
        </div>
      ) : null}
      {rows.length === 0 ? (
        <p className="px-6 pb-5 text-sm text-ink-muted">
          No workflows yet, so nothing starts it. Add a step below to make one.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-line border-t border-line">
          {rows.map((r) => (
            <TriggerItem
              key={`${r.workflow}:${r.trigger.id}`}
              row={r}
              labels={labels}
              showWorkflow={manyWorkflows}
              isClient={isClient}
              lastFired={lastFired(r.trigger.id)}
              busy={action.busy}
              removing={action.busy && removing === r.trigger.id}
              name={agent.name}
              address={fired.data?.address ?? null}
              commandName={fired.data?.commandName ?? null}
              onRemove={() => {
                setRemoving(r.trigger.id);
                return saveBundle(
                  removeTrigger(bundle, r.workflow, r.trigger.id),
                  `Removed a ${TRIGGER_KIND_LABEL[r.trigger.on.type].toLowerCase()} trigger`,
                );
              }}
            />
          ))}
        </ul>
      )}
      {adding ? (
        <AddTriggerDialog
          bundle={bundle}
          clientId={isClient ? agent.tenantId : null}
          agentSlug={agent.slug}
          busy={action.busy}
          error={action.error}
          onAdd={add}
          onClose={() => {
            action.clear();
            setAdding(false);
          }}
        />
      ) : null}
    </Card>
  );
}

function TriggerItem({
  row,
  labels,
  showWorkflow,
  isClient,
  lastFired,
  busy,
  removing,
  name,
  address,
  commandName,
  onRemove,
}: {
  row: TriggerRow;
  labels: EventLabels;
  showWorkflow: boolean;
  isClient: boolean;
  lastFired: Fired["triggers"][number]["lastFired"] | undefined;
  busy: boolean;
  /** This row's Remove is on its way to the server. */
  removing: boolean;
  name: string;
  address: string | null;
  commandName: string | null;
  onRemove(): void;
}) {
  const [open, setOpen] = useState(false);
  const { trigger } = row;
  const guards = guardWords(trigger.on);
  const hasMore = trigger.on.type === "webhook" || trigger.on.type === "message";
  return (
    <li data-testid={`trigger-row-${trigger.id}`} className="px-6 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Tag>{TRIGGER_KIND_LABEL[trigger.on.type]}</Tag>
        <span className="min-w-0 flex-1 text-ink">
          {whenWords(trigger.on, labels)}
          {showWorkflow ? (
            <span className="text-ink-muted"> · starts {row.workflowName}</span>
          ) : null}
        </span>
        {isClient ? (
          <span className="text-sm">
            {lastFired ? (
              <Link
                to={`/ops/runs/${lastFired.runId}`}
                className="figures text-link hover:underline"
              >
                Last fired {lastFired.mode === "test" ? "Test · " : ""}
                {shortTime(lastFired.at)}
              </Link>
            ) : (
              <span className="text-ink-muted">Never fired</span>
            )}
          </span>
        ) : null}
        <StatusChip state={row.enabled ? "done" : "idle"}>{row.enabled ? "On" : "Off"}</StatusChip>
        {hasMore ? (
          <button
            type="button"
            className="ds-btn ds-btn--link inline-flex items-center gap-1 text-sm"
            aria-expanded={open}
            data-testid={`trigger-details-${trigger.id}`}
            onClick={() => setOpen((o) => !o)}
          >
            Details
            <Icon name={open ? "chevron-down" : "chevron-right"} size={16} />
          </button>
        ) : null}
        {row.first ? null : (
          <button
            type="button"
            className="ds-btn ds-btn--link text-sm"
            data-testid={`trigger-remove-${trigger.id}`}
            disabled={busy}
            onClick={onRemove}
          >
            {removing ? "Removing…" : "Remove"}
          </button>
        )}
      </div>
      {guards.length > 0 ? (
        <p className="mt-1 text-sm text-ink-muted" data-testid={`trigger-guards-${trigger.id}`}>
          Guards (limits on when it starts): {guards.join(" · ")}
        </p>
      ) : null}
      {open ? (
        <div className="mt-3 flex flex-col gap-4 rounded-md bg-surface-subtle px-4 py-3">
          {trigger.on.type === "webhook" ? <WebhookSettings row={row} /> : null}
          {trigger.on.type === "message" ? (
            <MessageSettings row={row} name={name} address={address} commandName={commandName} />
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** "Add a trigger": the six kinds explained as choices, then the chosen kind's form. */
function AddTriggerDialog({
  bundle,
  clientId,
  agentSlug,
  busy,
  error,
  onAdd,
  onClose,
}: {
  bundle: AnyAgentBundle;
  clientId: string | null;
  agentSlug: string;
  busy: boolean;
  error: unknown;
  onAdd(workflow: string, on: TriggerOn): void;
  onClose(): void;
}) {
  const [kind, setKind] = useState<TriggerKind>("schedule");
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="ds-scrim" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-trigger-title"
        data-testid="trigger-dialog"
        className={cx(
          "ds-dialog flex max-h-[calc(100vh-32px)] w-[760px] flex-col",
          "max-sm:h-full max-sm:max-h-none max-sm:w-full max-sm:max-w-none max-sm:rounded-none",
        )}
      >
        <div className="ds-dialog__body min-h-0 flex-1 overflow-y-auto">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2
                id="add-trigger-title"
                ref={heading}
                tabIndex={-1}
                className="type-subheading text-ink outline-none"
              >
                Add a trigger
              </h2>
              <p className="text-sm text-ink-muted">
                Six ways an agent can start. Each trigger starts one workflow; what the workflow may
                do stays as it is. Adding one saves a new draft version, so save your changes to the
                steps first.
              </p>
            </div>
            <button
              type="button"
              className="ds-btn ds-btn--ghost ds-btn--sm"
              aria-label="Close"
              onClick={onClose}
            >
              <Icon name="close" />
            </button>
          </div>
          <fieldset className="grid grid-cols-1 gap-2 sm:grid-cols-2" aria-label="Kind">
            {TRIGGER_KINDS.map((k) => (
              <KindChoice key={k} kind={k} selected={kind === k} onPick={() => setKind(k)} />
            ))}
          </fieldset>
          <AddTriggerForm
            key={kind}
            bundle={bundle}
            kind={kind}
            clientId={clientId}
            agentSlug={agentSlug}
            busy={busy}
            onAdd={onAdd}
            onCancel={onClose}
          />
          {error ? (
            <Notice tone="warning" testId="triggers-error">
              {errorText(error)}
              {detailMessages(error).length ? (
                <ul className="mt-2 list-disc pl-5">
                  {detailMessages(error).map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              ) : null}
            </Notice>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function KindChoice({
  kind,
  selected,
  onPick,
}: {
  kind: TriggerKind;
  selected: boolean;
  onPick(): void;
}) {
  const k = KINDS[kind];
  return (
    <button
      type="button"
      data-testid={`trigger-kind-${kind}`}
      aria-pressed={selected}
      aria-label={`${KIND_TITLE[kind]}: ${k.tag}`}
      onClick={onPick}
      className={cx(
        "flex flex-col gap-1 rounded-md border bg-surface px-4 py-3 text-left",
        selected ? "border-slate" : "border-line hover:border-line-strong",
      )}
    >
      <span className="flex items-center justify-between gap-3">
        <b className="font-medium text-ink">{KIND_TITLE[kind]}</b>
        <Tag>{k.tag}</Tag>
      </span>
      <span className="text-sm text-ink">{k.text}</span>
      <span className="text-sm text-ink-muted">{k.examples}</span>
    </button>
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
    <div className="flex flex-col gap-3" data-testid={`trigger-webhook-${row.trigger.id}`}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
      <p className="text-sm text-ink-muted">
        The client's admin makes the hook and copies its URL in Accounts. Its payload goes in as
        data.
      </p>
    </div>
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
    <div className="flex flex-col gap-4" data-testid={`trigger-message-${row.trigger.id}`}>
      <Setting label="Channels">
        <ul className="flex flex-col gap-1.5">
          {on.channels.map((c) => (
            <li key={c}>{where(c)}</li>
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
  );
}
