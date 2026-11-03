// Parts shared by the "new template" and "new client agent" pages (design screen 4): the job's
// fields, the start-from choices (the Builder's "my description" is shown, not built yet), the
// stepper, and the starting workflow on the right.
import type { AgentBundle } from "@countersign/core";
import type { ReactNode } from "react";
import { Badge, Card, cx, SectionLabel, StepKindTag } from "../../ui/primitives";
import { KIND_LABEL, triggerTitle } from "../workflow/describe";
import { MODEL_OPTIONS, type NewAgentFields } from "./definition-form";
import { Field, Select, TextArea, TextInput } from "./ui";

export type JobErrors = Partial<Record<keyof NewAgentFields | "slug", string>>;

export function validateJob(fields: NewAgentFields): JobErrors {
  const errors: JobErrors = {};
  if (!fields.name.trim()) errors.name = "Give it a name.";
  if (!fields.modelId.trim()) errors.modelId = "Choose a model.";
  return errors;
}

export function JobFields({
  fields,
  errors,
  onChange,
  testPrefix,
}: {
  fields: NewAgentFields;
  errors: JobErrors;
  onChange(next: NewAgentFields): void;
  testPrefix: string;
}) {
  const set = (key: keyof NewAgentFields, value: string) => onChange({ ...fields, [key]: value });
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <Field label="Name" error={errors.name} testId={`${testPrefix}-name`}>
        <TextInput
          data-testid={`${testPrefix}-name-input`}
          value={fields.name}
          invalid={Boolean(errors.name)}
          onChange={(e) => set("name", e.target.value)}
        />
      </Field>
      <Field label="Area" hint="e.g. Purchasing, Accounts payable.">
        <TextInput
          data-testid={`${testPrefix}-role-input`}
          value={fields.role}
          onChange={(e) => set("role", e.target.value)}
        />
      </Field>
      <Field
        label="What should it do?"
        className="md:col-span-2"
        hint="Its mission, in a sentence or two."
      >
        <TextArea
          data-testid={`${testPrefix}-mission-input`}
          rows={3}
          value={fields.mission}
          onChange={(e) => set("mission", e.target.value)}
        />
      </Field>
      <Field
        label="Instructions"
        className="md:col-span-2"
        hint="How it works, in plain language. You can change this later."
      >
        <TextArea
          data-testid={`${testPrefix}-instructions-input`}
          rows={4}
          value={fields.instructions}
          onChange={(e) => set("instructions", e.target.value)}
        />
      </Field>
      <Field label="Model" error={errors.modelId}>
        <Select
          data-testid={`${testPrefix}-model-select`}
          value={fields.modelId}
          onChange={(e) => set("modelId", e.target.value)}
        >
          {MODEL_OPTIONS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  );
}

export function StartOption({
  selected,
  disabled,
  title,
  text,
  onSelect,
  testId,
  badge,
}: {
  selected: boolean;
  disabled?: boolean;
  title: string;
  text: string;
  onSelect(): void;
  testId: string;
  badge?: ReactNode;
}) {
  return (
    <label
      className={cx(
        "flex items-start gap-3 rounded-md border px-4 py-3",
        disabled
          ? "cursor-not-allowed border-dashed border-line-strong opacity-70"
          : selected
            ? "cursor-pointer border-slate bg-slate-tint"
            : "cursor-pointer border-line bg-surface hover:bg-surface-subtle",
      )}
    >
      <input
        type="radio"
        name="start-from"
        className="mt-1 size-4 accent-slate"
        data-testid={testId}
        checked={selected}
        disabled={disabled}
        onChange={onSelect}
      />
      <span className="min-w-0">
        <span className="flex items-center gap-2 font-medium text-ink">
          {title}
          {badge}
        </span>
        <span className="block text-sm text-ink-muted">{text}</span>
      </span>
    </label>
  );
}

/** The Builder (ARCHITECTURE §9.6) is not built yet: its option is shown, disabled. */
export function BuilderOption() {
  return (
    <StartOption
      selected={false}
      disabled
      title="My description"
      text="The Builder drafts the steps from what you wrote."
      badge={<Badge tone="neutral">Coming soon</Badge>}
      onSelect={() => {}}
      testId="new-agent-start-builder"
    />
  );
}

export function Stepper() {
  const steps = ["Describe", "Build the workflow", "Test and publish"];
  return (
    // The Mezonas Stepper (ds-step), laid out in a row.
    <ol className="flex items-center gap-2" aria-label="Steps">
      {steps.map((s, i) => (
        <li
          key={s}
          aria-current={i === 0 ? "step" : undefined}
          className={cx(
            "ds-step rounded-sm",
            i === 0 ? "ds-step--current font-medium" : "ds-step--todo",
          )}
        >
          <span className="ds-step__mark font-sans figures">{i + 1}</span>
          {s}
        </li>
      ))}
    </ol>
  );
}

/** The workflow it starts with, numbered as in design screen 4. */
export function WorkflowPreview({
  bundle,
  title = "Starting workflow",
  note,
}: {
  bundle: AgentBundle | null;
  title?: string;
  note?: ReactNode;
}) {
  const steps =
    bundle?.workflows.flatMap((w) => [
      {
        key: `${w.slug}:trigger`,
        kind: KIND_LABEL.trigger,
        kindId: "trigger",
        name: triggerTitle(w.workflow.trigger),
        approval: false,
      },
      ...w.workflow.steps.map((s) => ({
        key: `${w.slug}:${s.id}`,
        kind: KIND_LABEL[s.kind],
        kindId: s.kind as string,
        name: s.name,
        approval: s.kind === "action" ? s.approval.required === "required" : false,
      })),
    ]) ?? [];
  return (
    <Card className="p-5" testId="new-agent-preview">
      <SectionLabel>
        {title}
        {bundle ? ` · ${steps.length} ${steps.length === 1 ? "step" : "steps"}` : ""}
      </SectionLabel>
      {!bundle ? <p className="text-sm text-ink-muted">Choose where to start.</p> : null}
      {bundle && steps.length === 0 ? (
        <p className="text-sm text-ink-muted">No workflows: it answers asks and commands.</p>
      ) : null}
      <ol className="flex flex-col">
        {steps.map((s, i) => (
          <li key={s.key} className="flex items-center gap-3 py-1.5">
            <span className="w-5 text-right text-sm text-ink-muted figures">{i + 1}</span>
            <span className="flex w-20 shrink-0">
              <StepKindTag kind={s.kindId} label={s.kind} />
            </span>
            <span className="min-w-0 truncate text-ink">{s.name}</span>
            {s.approval ? <Badge tone="person">Approval</Badge> : null}
          </li>
        ))}
      </ol>
      {note ? <div className="mt-4">{note}</div> : null}
    </Card>
  );
}
