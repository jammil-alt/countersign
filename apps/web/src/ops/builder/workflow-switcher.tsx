// The agent's workflows in the builder's bar: the others to switch to and "+ Workflow", and the
// form a new one starts from. Shared by the v4 builder (`WorkflowBuilder`) and the steps builder
// (`steps/StepsBuilder`), so an agent's workflows switch and add the same way in both.

import { type ProcessAgentBundle, processes, Slug, type TriggerOn } from "@countersign/core";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Icon } from "../../ui/icons";
import { Button, buttonClass, cx } from "../../ui/primitives";
import { slugify } from "../agents/definition-form";
import { Field } from "../agents/ui";
import type { FlowView } from "../flow/FlowBar";
import { RoleChip } from "../flow/Ways";
import { SchedulePicker, type ScheduleValue } from "../triggers/SchedulePicker";
import { EventOptions, SmallInput, SmallSelect } from "./fields";

/**
 * In the bar, before the workflow's name: the agent's other workflows to switch to (only when it
 * has several), and "+ Workflow".
 */
export function WorkflowSwitcher({
  bundle,
  stepModel = [],
  current,
  base,
  adding,
  onAdd,
  view,
}: {
  bundle: Pick<ProcessAgentBundle, "workflows">;
  /** The agent's v5 workflows (they open in the steps builder). */
  stepModel?: readonly { slug: string; name: string; enabled?: boolean | undefined }[];
  current: string;
  base: string;
  adding: boolean;
  onAdd(): void;
  view: FlowView;
}) {
  // Triggers and outputs (2026-11-23): a tab says what its workflow is, after its name.
  const roles = useMemo(() => processes.workflowRoles(bundle.workflows), [bundle]);
  return (
    <nav
      aria-label="Workflows"
      className="inline-flex max-w-full flex-wrap items-center gap-1 rounded-md border border-line bg-surface p-1"
    >
      {bundle.workflows.length + stepModel.length > 1
        ? [...bundle.workflows, ...stepModel].map((w) => {
            const r = roles.get(w.slug)?.role;
            return (
              <Link
                key={w.slug}
                to={`${base}/${view === "list" ? "steps" : "workflows"}/${w.slug}`}
                data-testid={`builder-workflow-${w.slug}-select`}
                aria-current={w.slug === current ? "page" : undefined}
                className={cx(
                  "rounded-sm px-2.5 py-1 text-sm",
                  w.slug === current
                    ? "bg-slate-tint font-medium text-ink"
                    : "text-ink-muted hover:bg-surface-subtle hover:text-ink",
                )}
              >
                {w.name}
                {w.enabled !== false ? "" : " · off"}
                {r === "trigger" || r === "output" ? (
                  <RoleChip role={r} className="ml-1.5" />
                ) : null}
              </Link>
            );
          })
        : null}
      <button
        type="button"
        data-testid="builder-workflow-add"
        aria-label="Add a workflow"
        aria-expanded={adding}
        onClick={onAdd}
        className="ds-btn ds-btn--link px-2.5 text-sm"
      >
        <Icon name="add" />
        Workflow
      </button>
    </nav>
  );
}

const TRIGGER_TYPES: { type: TriggerOn["type"]; label: string }[] = [
  { type: "manual", label: "By hand" },
  { type: "event", label: "When something happens" },
  { type: "schedule", label: "On a schedule" },
  { type: "command", label: "From a thread command" },
];

export function AddWorkflowForm({
  bundle,
  events,
  onCreate,
  onCancel,
}: {
  bundle: { workflows: readonly { slug: string }[] };
  events: string[];
  onCreate(input: { slug: string; name: string; on: TriggerOn }): void;
  onCancel(): void;
}) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState<string | null>(null);
  const [type, setType] = useState<TriggerOn["type"]>("manual");
  const [event, setEvent] = useState(events[0] ?? "");
  const [schedule, setSchedule] = useState<ScheduleValue>({ cron: "0 7 * * 1-5" });
  const [command, setCommand] = useState("");
  const [touched, setTouched] = useState(false);
  const effectiveSlug = slug ?? slugify(name);

  const problem = !name.trim()
    ? "Give it a name."
    : !Slug.safeParse(effectiveSlug).success
      ? "The slug takes lowercase letters, digits and dashes."
      : bundle.workflows.some((w) => w.slug === effectiveSlug)
        ? `This agent already has a workflow “${effectiveSlug}”.`
        : type === "event" && !event
          ? "Pick an event."
          : type === "command" && !command.trim()
            ? "Name the command."
            : null;

  const on = (): TriggerOn => {
    switch (type) {
      case "event":
        return { type, event };
      case "schedule":
        return { type, ...schedule };
      case "command":
        return { type, command: command.trim().replace(/^\//, "") };
      // v0.12 W2-E: the new kinds aren't offered here yet; anything else starts by hand.
      default:
        return { type: "manual", input: { type: "object", properties: {} } };
    }
  };

  return (
    <form
      data-testid="builder-workflow-form"
      className="mt-3 flex flex-col gap-3 rounded-md border border-line bg-surface p-4"
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (problem) return;
        onCreate({ slug: effectiveSlug, name: name.trim(), on: on() });
      }}
    >
      <p className="font-medium text-ink">
        {bundle.workflows.length === 0
          ? "This agent has no workflows yet. Add one."
          : "New workflow"}
      </p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Field label="Name">
          <SmallInput
            data-testid="builder-workflow-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Slug">
          <SmallInput
            data-testid="builder-workflow-slug"
            value={effectiveSlug}
            className="font-mono"
            onChange={(e) => setSlug(e.target.value)}
          />
        </Field>
        <Field label="Starts">
          <SmallSelect
            data-testid="builder-workflow-trigger"
            value={type}
            onChange={(e) => setType(e.target.value as TriggerOn["type"])}
          >
            {TRIGGER_TYPES.map((t) => (
              <option key={t.type} value={t.type}>
                {t.label}
              </option>
            ))}
          </SmallSelect>
        </Field>
      </div>
      {type === "event" ? (
        <Field label="Event">
          <SmallSelect
            data-testid="builder-workflow-event"
            value={event}
            onChange={(e) => setEvent(e.target.value)}
          >
            <EventOptions events={events} />
          </SmallSelect>
        </Field>
      ) : null}
      {type === "schedule" ? (
        <SchedulePicker
          small
          testId="builder-workflow-schedule"
          cronTestId="builder-workflow-cron"
          value={schedule}
          onChange={setSchedule}
        />
      ) : null}
      {type === "command" ? (
        <Field label="Command">
          <SmallInput
            data-testid="builder-workflow-command"
            value={command}
            className="font-mono"
            placeholder="reprice"
            onChange={(e) => setCommand(e.target.value)}
          />
        </Field>
      ) : null}
      {touched && problem ? (
        <p className="text-sm text-risk" data-testid="builder-workflow-form-error">
          {problem}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        {bundle.workflows.length > 0 ? (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <button
          type="submit"
          className={buttonClass("primary")}
          data-testid="builder-workflow-create"
        >
          Add workflow
        </button>
      </div>
    </form>
  );
}
