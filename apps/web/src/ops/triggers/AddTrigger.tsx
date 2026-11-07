// "Add a trigger" in the agent's Workflow tab (prototype `#O7-Triggers`; ARCHITECTURE §10.8): one
// more way to start one of the agent's workflows, any of the six kinds (the dialog picks the kind). It is added to the workflow's
// `moreTriggers` with a new id and saved as a new draft version, like any edit: it takes effect
// when that version is published. What the trigger may do is the workflow's; the trigger only
// starts it.
import {
  type AgentBundle,
  CONTACT_RELATIONSHIPS,
  MESSAGE_CHANNELS,
  type MessageChannel,
  RATE_LIMIT_WINDOWS,
  type TriggerOn,
  uuidv7,
} from "@countersign/core";
import { useState } from "react";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { Button } from "../../ui/primitives";
import { Field, Select, TextInput } from "../agents/ui";
import { channelWords, eventLabels, eventWords, MAX_MORE_TRIGGERS } from "./words";

/** The six kinds, in the order the screen explains them. */
export const TRIGGER_KINDS = [
  "schedule",
  "event",
  "webhook",
  "manual",
  "message",
  "handoff",
] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

export const KIND_TITLE: Record<TriggerKind, string> = {
  schedule: "Schedule",
  event: "Event",
  webhook: "Webhook",
  manual: "Manual",
  message: "Message",
  handoff: "Another agent",
};

function Check({
  label,
  checked,
  onChange,
  testId,
}: {
  label: string;
  checked: boolean;
  onChange(v: boolean): void;
  testId: string;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-ink">
      <input
        type="checkbox"
        className="size-4 accent-slate"
        data-testid={testId}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

export function AddTriggerForm({
  bundle,
  kind,
  clientId,
  agentSlug,
  busy,
  onAdd,
  onCancel,
}: {
  bundle: AgentBundle;
  kind: TriggerKind;
  /** A client agent's client, for the agents a handoff can come from; none for a template. */
  clientId: string | null;
  agentSlug: string;
  busy: boolean;
  onAdd(workflow: string, on: TriggerOn): void;
  onCancel(): void;
}) {
  const open = bundle.workflows.filter(
    (w) => (w.workflow.moreTriggers?.length ?? 0) < MAX_MORE_TRIGGERS,
  );
  const [workflow, setWorkflow] = useState(open[0]?.slug ?? "");
  const [cron, setCron] = useState("0 8 * * 1-5");
  const [tz, setTz] = useState("");
  const [skipHolidays, setSkipHolidays] = useState(false);
  const events = useApi(apiRoutes.opsEventCatalog, kind === "event" ? {} : null);
  const [event, setEvent] = useState("");
  const [canRun, setCanRun] = useState(false);
  const [runLabel, setRunLabel] = useState("");
  const [hookId, setHookId] = useState("");
  const [dedupeKey, setDedupeKey] = useState("");
  const [rateMax, setRateMax] = useState("");
  const [ratePer, setRatePer] = useState<(typeof RATE_LIMIT_WINDOWS)[number]>("hour");
  const [channels, setChannels] = useState<MessageChannel[]>(["email"]);
  const [tags, setTags] = useState("");
  const [relationships, setRelationships] = useState<string[]>([]);
  const [admins, setAdmins] = useState(false);
  const [team, setTeam] = useState(false);
  const [confirm, setConfirm] = useState("");
  const agents = useApi(
    apiRoutes.opsClientAgents,
    kind === "handoff" && clientId ? { params: { id: clientId } } : null,
  );
  const [fromAgent, setFromAgent] = useState("");
  const [fromWorkflow, setFromWorkflow] = useState("");
  const [touched, setTouched] = useState(false);

  const eventType = event || events.data?.events[0]?.type || "";
  const labels = eventLabels(events.data?.events);
  const tagList = tags
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const clientRoles = [admins ? "client_admin" : null, team ? "client_user" : null].filter(
    (r): r is "client_admin" | "client_user" => r !== null,
  );
  const max = Number.parseInt(rateMax, 10);

  const problem = !workflow
    ? "This agent has no workflow with room for another trigger."
    : kind === "schedule" && !cron.trim()
      ? "Write when it runs, as a cron line."
      : kind === "event" && !eventType
        ? "Pick an event."
        : kind === "webhook" && !/^[0-9a-f-]{36}$/i.test(hookId.trim())
          ? "Paste the hook's id from the client's webhook connection."
          : kind === "webhook" && rateMax && (Number.isNaN(max) || max < 1)
            ? "The limit is a whole number of runs."
            : kind === "message" && channels.length === 0
              ? "Pick at least one channel."
              : kind === "message" &&
                  tagList.length === 0 &&
                  relationships.length === 0 &&
                  clientRoles.length === 0
                ? "Say who may start it: nobody can until you do."
                : kind === "handoff" && !fromAgent.trim()
                  ? "Pick the agent it follows."
                  : null;

  function build(): TriggerOn {
    switch (kind) {
      case "schedule":
        return {
          type: "schedule",
          cron: cron.trim(),
          ...(tz.trim() ? { tz: tz.trim() } : {}),
          ...(skipHolidays ? { skipHolidays: true } : {}),
        };
      case "event":
        return { type: "event", event: eventType };
      case "manual":
        return {
          type: "manual",
          input: { type: "object", properties: {} },
          ...(canRun
            ? { client: { canRun: true, ...(runLabel.trim() ? { label: runLabel.trim() } : {}) } }
            : {}),
        };
      case "webhook":
        return {
          type: "webhook",
          hookId: hookId.trim().toLowerCase(),
          ...(dedupeKey.trim() ? { dedupeKey: dedupeKey.trim() } : {}),
          ...(rateMax ? { rateLimit: { max, per: ratePer } } : {}),
        };
      case "message":
        return {
          type: "message",
          channels,
          from: {
            ...(tagList.length ? { tags: tagList } : {}),
            ...(relationships.length
              ? { relationships: relationships as (typeof CONTACT_RELATIONSHIPS)[number][] }
              : {}),
            ...(clientRoles.length ? { clientRoles } : {}),
          },
          ...(confirm.trim() ? { reply: { confirm: confirm.trim() } } : {}),
        };
      case "handoff":
        return {
          type: "handoff",
          from: {
            agent: fromAgent.trim(),
            ...(fromWorkflow.trim() ? { workflow: fromWorkflow.trim() } : {}),
          },
        };
    }
  }

  const others = (agents.data?.agents ?? []).filter((a) => a.slug !== agentSlug && !a.testCopy);

  return (
    <form
      data-testid="trigger-form"
      className="flex flex-col gap-4 border-t border-line pt-4"
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (problem) return;
        onAdd(workflow, build());
      }}
    >
      {/* One workflow: nothing to choose. */}
      {bundle.workflows.length > 1 ? (
        <Field
          label="Starts workflow"
          hint="The trigger only starts it; the workflow's steps and approvals stay as they are."
        >
          <Select
            data-testid="trigger-form-workflow"
            value={workflow}
            onChange={(e) => setWorkflow(e.target.value)}
          >
            {open.map((w) => (
              <option key={w.slug} value={w.slug}>
                {w.name}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}

      {kind === "schedule" ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field label="When (cron)" hint="0 8 * * 1-5 is weekdays at 8:00.">
            <TextInput
              data-testid="trigger-form-cron"
              className="font-mono"
              value={cron}
              onChange={(e) => setCron(e.target.value)}
            />
          </Field>
          <Field label="Time zone" hint="Empty: the client's.">
            <TextInput
              data-testid="trigger-form-tz"
              value={tz}
              placeholder="America/Chicago"
              onChange={(e) => setTz(e.target.value)}
            />
          </Field>
          <div className="flex items-end pb-2">
            <Check
              label="Skip holidays"
              checked={skipHolidays}
              onChange={setSkipHolidays}
              testId="trigger-form-holidays"
            />
          </div>
        </div>
      ) : null}

      {kind === "event" ? (
        <Field label="Event">
          <Select
            data-testid="trigger-form-event"
            value={eventType}
            onChange={(e) => setEvent(e.target.value)}
          >
            {(events.data?.events ?? []).map((e) => (
              <option key={e.type} value={e.type}>
                {eventWords(e.type, labels)}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}

      {kind === "manual" ? (
        <div className="flex flex-col gap-3">
          <Check
            label="The client may run it from the agent's page"
            checked={canRun}
            onChange={setCanRun}
            testId="trigger-form-can-run"
          />
          {canRun ? (
            <Field label="Button label" hint="What the client's Run button says.">
              <TextInput
                data-testid="trigger-form-run-label"
                value={runLabel}
                maxLength={80}
                onChange={(e) => setRunLabel(e.target.value)}
              />
            </Field>
          ) : null}
        </div>
      ) : null}

      {kind === "webhook" ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field
            label="Hook id"
            className="md:col-span-3"
            hint="The client's admin makes the hook in Accounts, on their webhook connection, and keeps its URL and secret."
          >
            <TextInput
              data-testid="trigger-form-hook"
              className="font-mono"
              value={hookId}
              onChange={(e) => setHookId(e.target.value)}
            />
          </Field>
          <Field label="Dedupe on" hint="The same key twice starts one run.">
            <TextInput
              data-testid="trigger-form-dedupe"
              className="font-mono"
              value={dedupeKey}
              placeholder="{{trigger.data.id}}"
              onChange={(e) => setDedupeKey(e.target.value)}
            />
          </Field>
          <Field label="Limit (runs)" hint="Empty: no limit.">
            <TextInput
              data-testid="trigger-form-rate-max"
              inputMode="numeric"
              value={rateMax}
              onChange={(e) => setRateMax(e.target.value)}
            />
          </Field>
          <Field label="Per">
            <Select value={ratePer} onChange={(e) => setRatePer(e.target.value as typeof ratePer)}>
              {RATE_LIMIT_WINDOWS.map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      ) : null}

      {kind === "message" ? (
        <div className="flex flex-col gap-4">
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium text-ink">Channels</legend>
            {MESSAGE_CHANNELS.map((c) => (
              <Check
                key={c}
                label={c === "command" ? `/${agentSlug} in a thread` : channelWords(c)}
                checked={channels.includes(c)}
                onChange={(on) =>
                  setChannels((cs) => (on ? [...cs, c] : cs.filter((x) => x !== c)))
                }
                testId={`trigger-form-channel-${c}`}
              />
            ))}
          </fieldset>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium text-ink">Who can start it</legend>
            <Field
              label="Contacts tagged"
              hint="Comma-separated tags from People, e.g. cardholder."
            >
              <TextInput
                data-testid="trigger-form-tags"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
              />
            </Field>
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {CONTACT_RELATIONSHIPS.map((r) => (
                <Check
                  key={r}
                  label={`${r.charAt(0).toUpperCase()}${r.slice(1)} contacts`}
                  checked={relationships.includes(r)}
                  onChange={(on) =>
                    setRelationships((rs) => (on ? [...rs, r] : rs.filter((x) => x !== r)))
                  }
                  testId={`trigger-form-relationship-${r}`}
                />
              ))}
              <Check
                label="The client's admins"
                checked={admins}
                onChange={setAdmins}
                testId="trigger-form-admins"
              />
              <Check
                label="The client's team"
                checked={team}
                onChange={setTeam}
                testId="trigger-form-team"
              />
            </div>
            <p className="text-sm text-ink-muted">
              Anyone else gets no run. The message and its attachments go in as data for the first
              step: a message can't change the agent's rules or access.
            </p>
          </fieldset>
          <Field label="Reply" hint="Optional: fixed words to the sender, at most a text long.">
            <TextInput
              data-testid="trigger-form-confirm"
              value={confirm}
              maxLength={320}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </Field>
        </div>
      ) : null}

      {kind === "handoff" ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="After this agent" hint="Same client only; its run's sources come along.">
            {clientId ? (
              <Select
                data-testid="trigger-form-from-agent"
                value={fromAgent}
                onChange={(e) => setFromAgent(e.target.value)}
              >
                <option value="">Choose an agent…</option>
                {others.map((a) => (
                  <option key={a.id} value={a.slug}>
                    {a.serviceName ?? a.name}
                  </option>
                ))}
              </Select>
            ) : (
              <TextInput
                data-testid="trigger-form-from-agent"
                className="font-mono"
                value={fromAgent}
                placeholder="agent-slug"
                onChange={(e) => setFromAgent(e.target.value)}
              />
            )}
          </Field>
          <Field label="Its workflow" hint="Empty: any of its workflows.">
            <TextInput
              data-testid="trigger-form-from-workflow"
              className="font-mono"
              value={fromWorkflow}
              onChange={(e) => setFromWorkflow(e.target.value)}
            />
          </Field>
        </div>
      ) : null}

      {touched && problem ? (
        <p className="text-sm text-risk" data-testid="trigger-form-error">
          {problem}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <button
          type="submit"
          className="ds-btn ds-btn--primary"
          data-testid="trigger-form-save"
          disabled={busy}
        >
          {busy ? "Saving…" : "Add as a draft"}
        </button>
      </div>
    </form>
  );
}

/** A new trigger's id: made once, never regenerated (CLAUDE.md invariant 3). */
export function newTriggerId(): string {
  return uuidv7();
}
