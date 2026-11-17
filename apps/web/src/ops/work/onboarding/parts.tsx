// The onboarding screens' small parts, on the design system only (Checkbox, Radio, Segmented,
// Stepper): a checkbox and a radio as the design system draws them, the covers picker that
// Invite's step 2 and the starts list share, and the Invite stepper. No colours of their own.
import {
  type Covers,
  INTAKE_AREAS,
  type IntakeArea,
  START_MODES,
  type StartMode,
} from "@countersign/core";
import type { ReactNode } from "react";
import { apiRoutes } from "../../../api/routes";
import { useApi } from "../../../api/useApi";
import { cx } from "../../../ui/cx";
import { AREA_WORDS, START_MODE_HELP, START_MODE_WORDS } from "./words";

/** The design system's Checkbox: a button with role=checkbox, its mark first. */
export function Check({
  checked,
  onChange,
  children,
  testId,
  disabled,
  className,
}: {
  checked: boolean;
  onChange(v: boolean): void;
  children: ReactNode;
  testId?: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: the design system's Checkbox is a button with role=checkbox.
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx("ds-choice items-start text-left disabled:opacity-60", className)}
      data-testid={testId}
    >
      <span className="ds-check mt-0.5">{checked ? "✓" : ""}</span>
      <span className="min-w-0">{children}</span>
    </button>
  );
}

/** One of the design system's Radio buttons; the caller wraps them in a radiogroup. */
export function RadioChoice({
  checked,
  onSelect,
  children,
  testId,
}: {
  checked: boolean;
  onSelect(): void;
  children: ReactNode;
  testId?: string;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: the design system's Radio is a button with role=radio.
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      className="ds-choice items-start text-left"
      data-testid={testId}
    >
      <span className="ds-radio mt-0.5" />
      <span className="min-w-0">{children}</span>
    </button>
  );
}

/** Get to the point or talk it through: the design system's Segmented, with a line of help. */
export function StartModePicker({
  value,
  onChange,
  testId = "start-mode",
}: {
  value: StartMode;
  onChange(m: StartMode): void;
  testId?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <fieldset className="ds-seg self-start" aria-label="How they start" data-testid={testId}>
        {START_MODES.map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={value === m}
            onClick={() => onChange(m)}
            data-testid={`${testId}-${m}`}
          >
            {START_MODE_WORDS[m]}
          </button>
        ))}
      </fieldset>
      <span className="text-xs text-ink-muted">{START_MODE_HELP[value]}</span>
    </div>
  );
}

function toggle<T>(xs: readonly T[], x: T, on: boolean): T[] {
  return on ? (xs.includes(x) ? [...xs] : [...xs, x]) : xs.filter((y) => y !== x);
}

/**
 * What an intake covers: the general questions, any areas, any agent templates. Nothing ticked is
 * "Just the account": the account and the welcome email, no questions.
 */
export function CoversPicker({
  value,
  onChange,
  testId = "covers",
}: {
  value: Covers;
  onChange(c: Covers): void;
  testId?: string;
}) {
  const templates = useApi(apiRoutes.opsTemplates);
  const list = (templates.data?.templates ?? []).filter((t) => t.kind === "template");
  return (
    <div className="flex flex-col gap-4" data-testid={testId}>
      <section className="flex flex-col gap-2">
        <h4 className="eyebrow text-ink-muted">General</h4>
        <Check
          checked={value.general}
          onChange={(general) => onChange({ ...value, general })}
          testId={`${testId}-general`}
        >
          <span className="block text-ink">The business</span>
          <span className="block text-sm text-ink-muted">
            What they do, the team, systems, volumes, how work flows, what hurts, limits.
          </span>
        </Check>
      </section>
      <section className="flex flex-col gap-2">
        <h4 className="eyebrow text-ink-muted">Areas</h4>
        <div className="grid gap-2 sm:grid-cols-2">
          {INTAKE_AREAS.map((a: IntakeArea) => (
            <Check
              key={a}
              checked={value.areas.includes(a)}
              onChange={(on) => onChange({ ...value, areas: toggle(value.areas, a, on) })}
              testId={`${testId}-area-${a}`}
            >
              {AREA_WORDS[a]}
            </Check>
          ))}
        </div>
      </section>
      <section className="flex flex-col gap-2">
        <h4 className="eyebrow text-ink-muted">Agents</h4>
        {templates.loading && !templates.data ? (
          <span className="text-sm text-ink-muted">Loading the templates…</span>
        ) : list.length === 0 ? (
          <span className="text-sm text-ink-muted">No templates yet.</span>
        ) : (
          <div className="flex flex-col gap-2">
            {list.map((t) => (
              <Check
                key={t.id}
                checked={value.templateIds.includes(t.id)}
                onChange={(on) =>
                  onChange({ ...value, templateIds: toggle(value.templateIds, t.id, on) })
                }
                testId={`${testId}-template-${t.id}`}
              >
                <span className="block text-ink">{t.serviceName ?? t.name}</span>
                {t.serviceDescription ? (
                  <span className="block text-sm text-ink-muted">{t.serviceDescription}</span>
                ) : null}
              </Check>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/** The Invite flow's steps as the design system's Stepper; a done step can be gone back to. */
export function FlowSteps({
  steps,
  current,
  onGo,
  testId,
}: {
  steps: readonly string[];
  current: number;
  onGo(i: number): void;
  testId?: string;
}) {
  return (
    <ol className="m-0 flex list-none flex-wrap items-center gap-2 p-0" data-testid={testId}>
      {steps.map((s, i) => (
        <li key={s}>
          <button
            type="button"
            aria-current={i === current ? "step" : undefined}
            disabled={i > current}
            onClick={() => onGo(i)}
            className={cx(
              "ds-step rounded-sm",
              i < current
                ? "ds-step--done"
                : i === current
                  ? "ds-step--current font-medium"
                  : "ds-step--todo",
            )}
            data-testid={testId ? `${testId}-${i + 1}` : undefined}
          >
            <span className="ds-step__mark font-sans figures">{i < current ? "✓" : i + 1}</span>
            {s}
          </button>
        </li>
      ))}
    </ol>
  );
}
