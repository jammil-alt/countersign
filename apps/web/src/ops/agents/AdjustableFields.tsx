// B5 (docs/builder-plan.md §7): where the operator lets the client adjust a setting. Under each of
// an agent's skill parameters (numbers, money, words, dates), a checkbox and its bounds; for its
// schedules, a card with the times the client may choose. The client admin then changes them on
// the agent's Settings in the portal: within the bounds (or stricter) at once, beyond them as a
// request to us. Approvals, permissions, writes and steps are never offered here: they are ours.

import type { AdjustTarget, AnyAgentBundle } from "@countersign/core";
import { cronText } from "@countersign/core";
import { Card, SectionLabel } from "../../ui/primitives";
import {
  type AdjustDraft,
  draftFor,
  scheduleTargets,
  toggleDraft,
  updateDraft,
} from "./adjustable-form";
import { Field, Select, TextArea, TextInput } from "./ui";

/** The parameter types a client may adjust (buckets are set in the builder only). */
const ADJUSTABLE_TYPES = new Set(["number", "money", "text", "date"]);

export function canAdjust(type: string): boolean {
  return ADJUSTABLE_TYPES.has(type);
}

/** The checkbox and bounds under one skill parameter. */
export function ParameterAdjust({
  target,
  label,
  drafts,
  errors,
  onChange,
}: {
  target: Extract<AdjustTarget, { kind: "parameter" }>;
  /** The parameter's own label, the starting name the client reads. */
  label: string;
  drafts: readonly AdjustDraft[];
  errors: Record<string, string>;
  onChange(next: AdjustDraft[]): void;
}) {
  const draft = draftFor(drafts, target);
  const testId = `adjust-${target.skill}-${target.parameter}`;
  const numeric = target.type === "number" || target.type === "money";
  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      <label className="flex items-center gap-2 text-sm text-ink">
        <input
          type="checkbox"
          className="size-4 accent-slate"
          data-testid={`${testId}-toggle`}
          checked={draft !== undefined}
          onChange={(e) => onChange(toggleDraft(drafts, target, e.target.checked, { label }))}
        />
        The client may adjust this
      </label>
      {draft ? (
        <div className="grid grid-cols-1 gap-3 border-l border-line pl-4 md:grid-cols-2">
          <Field label="Name the client reads" error={errors[`adjustable.${draft.id}`]}>
            <TextInput
              data-testid={`${testId}-label`}
              value={draft.label}
              onChange={(e) => onChange(updateDraft(drafts, target, { label: e.target.value }))}
            />
          </Field>
          <Field label="Help line" hint="Optional: one plain sentence.">
            <TextInput
              data-testid={`${testId}-hint`}
              value={draft.hint}
              onChange={(e) => onChange(updateDraft(drafts, target, { hint: e.target.value }))}
            />
          </Field>
          {numeric ? (
            <>
              <Field label="Low limit">
                <TextInput
                  data-testid={`${testId}-min`}
                  inputMode="decimal"
                  value={draft.min}
                  onChange={(e) => onChange(updateDraft(drafts, target, { min: e.target.value }))}
                />
              </Field>
              <Field label="High limit">
                <TextInput
                  data-testid={`${testId}-max`}
                  inputMode="decimal"
                  value={draft.max}
                  onChange={(e) => onChange(updateDraft(drafts, target, { max: e.target.value }))}
                />
              </Field>
              <Field
                label="Stricter is"
                hint="A stricter value applies even past the limits; a looser one past them comes to us."
              >
                <Select
                  data-testid={`${testId}-tighter`}
                  value={draft.tighter}
                  onChange={(e) =>
                    onChange(
                      updateDraft(drafts, target, {
                        tighter: e.target.value as AdjustDraft["tighter"],
                      }),
                    )
                  }
                >
                  <option value="">Neither</option>
                  <option value="lower">Lower</option>
                  <option value="higher">Higher</option>
                </Select>
              </Field>
            </>
          ) : target.type === "text" ? (
            <Field label="Options" hint="One per line. None: any words.">
              <TextArea
                data-testid={`${testId}-options`}
                rows={3}
                value={draft.options}
                onChange={(e) => onChange(updateDraft(drafts, target, { options: e.target.value }))}
              />
            </Field>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The agent's schedules, each with the times the client may choose. */
export function ScheduleAdjustCard({
  bundle,
  drafts,
  errors,
  onChange,
}: {
  bundle: Pick<AnyAgentBundle, "workflows">;
  drafts: readonly AdjustDraft[];
  errors: Record<string, string>;
  onChange(next: AdjustDraft[]): void;
}) {
  const schedules = scheduleTargets(bundle);
  if (schedules.length === 0) return null;
  return (
    <Card className="p-5" testId="adjust-schedules">
      <SectionLabel>Schedules the client may change</SectionLabel>
      <p className="mb-3 text-sm text-ink-muted">
        The client admin picks one of the times you list on the agent's Settings; any other time
        comes to us as a request.
      </p>
      <ul className="flex flex-col gap-4">
        {schedules.map((s) => {
          const target = s.target as Extract<AdjustTarget, { kind: "schedule" }>;
          const draft = draftFor(drafts, target);
          const testId = `adjust-schedule-${target.workflow}-${target.triggerId}`;
          return (
            <li key={testId} className="flex flex-col gap-2" data-testid={testId}>
              <label className="flex items-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  className="size-4 accent-slate"
                  data-testid={`${testId}-toggle`}
                  checked={draft !== undefined}
                  onChange={(e) =>
                    onChange(
                      toggleDraft(drafts, target, e.target.checked, {
                        label: `When ${s.workflow} runs`,
                        options: s.cron,
                      }),
                    )
                  }
                />
                {s.workflow}: {cronText(s.cron)}
              </label>
              {draft ? (
                <div className="grid grid-cols-1 gap-3 border-l border-line pl-4 md:grid-cols-2">
                  <Field label="Name the client reads" error={errors[`adjustable.${draft.id}`]}>
                    <TextInput
                      data-testid={`${testId}-label`}
                      value={draft.label}
                      onChange={(e) =>
                        onChange(updateDraft(drafts, target, { label: e.target.value }))
                      }
                    />
                  </Field>
                  <Field label="Times the client may choose" hint="One schedule (cron) per line.">
                    <TextArea
                      data-testid={`${testId}-options`}
                      rows={3}
                      value={draft.options}
                      onChange={(e) =>
                        onChange(updateDraft(drafts, target, { options: e.target.value }))
                      }
                    />
                  </Field>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
