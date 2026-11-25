// The forms of the seven kinds that aren't a Do (docs/step-model-plan.md §4, §13a): Loop, Fork,
// For each, Repeat, Wait, Hand off. Each says its goal, has Suggest at the top, and shows the
// step's issues in plain words. The Do form, the End card and the Checks are in their own files.

import { uuidv7 } from "@countersign/core";
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "../../../ui/primitives";
import { NEW_LOOP_PATH } from "../../lab/loops/paths";
import { formFromStep, fromSavedLoop, readableFor, writeInStep } from "../../lab/loops/use-loop";
import { DurationPicker } from "../duration";
import { NO_ERRORS, Row, SmallInput, SmallSelect } from "../fields";
import { RulesEditor } from "../rules";
import { FieldsEditor } from "./FieldsEditor";
import type { StepFormProps } from "./form-kit";
import type { BuilderIssue } from "./issues";
import { type InputOption, inputOptions } from "./options";
import { pickPaths } from "./paths";
import { SuggestButton } from "./SuggestButton";
import type { Step } from "./types";

type Of<K extends Step["kind"]> = Extract<Step, { kind: K }>;

/** The step's name row, with Suggest for the whole step beside it. */
function Head({
  props,
  label,
  placeholder,
}: {
  props: StepFormProps;
  label: string;
  placeholder: string;
}) {
  const { step, env } = props;
  return (
    <div className="flex items-end gap-2">
      <div className="min-w-0 flex-1">
        <Row label={label}>
          <SmallInput
            aria-label={label}
            value={step.name}
            placeholder={placeholder}
            onChange={(e) => props.onChange({ ...step, name: e.target.value })}
          />
        </Row>
      </div>
      <SuggestButton
        step={step}
        label="this step"
        suggest={env.suggest}
        onApply={(next) => props.onChange(next)}
      />
    </div>
  );
}

function Issues({ issues }: { issues: readonly BuilderIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1" data-testid="step-issues">
      {issues.map((i) => (
        <li key={`${i.code}:${i.message}`} className="text-xs text-risk-ink">
          <span className="font-medium">Needs fixing: </span>
          {i.message}
        </li>
      ))}
    </ul>
  );
}

function Field({
  label,
  step,
  field,
  props,
  children,
  hint,
}: {
  label: string;
  step: Step;
  field: string;
  props: StepFormProps;
  children: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <Row
      label={label}
      hint={hint}
      aside={
        <SuggestButton
          step={step}
          field={field}
          label={label}
          suggest={props.env.suggest}
          onApply={(next) => props.onChange(next)}
        />
      }
    >
      {children}
    </Row>
  );
}

/** What a step may read, for its rule rows and its list. */
function readable(props: StepFormProps): InputOption[] {
  return inputOptions(props.env.workflow, props.step.id, props.env.uses, props.env.trigger);
}

const area = "ds-textarea min-h-20 w-full";

// ── Loop ─────────────────────────────────────────────────────────────────────────────────────────

export function LoopForm(props: StepFormProps<Of<"loop">>) {
  const { step, env } = props;
  const set = (patch: Partial<Of<"loop">>) => props.onChange({ ...step, ...patch });
  // Step model §8: a saved Loop (from the Agent lab's Loop designer) or one written in the step.
  const saved = env.uses.loops ?? [];
  const chosen = saved.find((l) => l.ref === step.skill);
  const navigate = useNavigate();
  const canRead = readableFor(chosen);
  const gets = env.uses.actions.groups
    .map((g) => ({
      ...g,
      actions: g.actions.filter((a) => a.kind === "get" && (canRead ? canRead(a.id) : true)),
    }))
    .filter((g) => g.actions.length > 0);
  return (
    <div className="flex flex-col gap-4" data-testid="form-loop">
      <Head props={props} label="Name" placeholder="Look into the leftovers" />
      <Issues issues={props.issues} />
      {saved.length > 0 || step.skill ? (
        <Row
          label="Loop"
          hint={
            chosen
              ? "It reads at most what this Loop reads and runs at most its turns."
              : "Pick one from the Agent lab's Loop designer, or write it here."
          }
        >
          <SmallSelect
            aria-label="Saved Loop"
            value={step.skill ?? ""}
            onChange={(e) => {
              const next = saved.find((l) => l.ref === e.target.value);
              props.onChange(next ? fromSavedLoop(step, next) : writeInStep(step));
            }}
          >
            <option value="">Written in this step</option>
            {step.skill && !chosen ? <option value={step.skill}>{step.skill}</option> : null}
            {saved.map((l) => (
              <option key={l.ref} value={l.ref}>
                {l.name}
              </option>
            ))}
          </SmallSelect>
        </Row>
      ) : null}
      {!step.skill ? (
        <Row
          label="Save as Loop"
          hint="A Loop written here can be drafted, but an agent publishes only a saved Loop that passed its tests."
        >
          <Button
            size="sm"
            onClick={() => navigate(NEW_LOOP_PATH, { state: { loop: formFromStep(step) } })}
          >
            Save as Loop
          </Button>
        </Row>
      ) : null}
      <Field
        label="Goal"
        step={step}
        field="goal"
        props={props}
        hint="What it works toward until it is done."
      >
        <textarea
          aria-label="Goal"
          className={area}
          value={step.goal}
          onChange={(e) => set({ goal: e.target.value })}
        />
      </Field>
      <Field
        label="Reads"
        step={step}
        field="reads"
        props={props}
        hint="A Loop only reads. What it decides is saved by a step after it."
      >
        <div className="flex flex-col gap-2">
          {gets.map((g) => (
            <fieldset key={`${g.type}:${g.id}`} className="flex flex-col gap-1">
              <legend className="eyebrow text-ink-muted">{g.name}</legend>
              {g.actions.map((a) => (
                <label key={a.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={step.reads.includes(a.id)}
                    onChange={(e) =>
                      set({
                        reads: e.target.checked
                          ? [...step.reads, a.id]
                          : step.reads.filter((r) => r !== a.id),
                      })
                    }
                  />
                  {env.uses.actions.get(a.id)?.label ?? a.label}
                </label>
              ))}
            </fieldset>
          ))}
          {gets.length === 0 ? (
            <p className="text-sm text-ink-muted">No read actions are offered yet.</p>
          ) : null}
        </div>
      </Field>
      <Field label="Instructions" step={step} field="instructions" props={props}>
        <textarea
          aria-label="Instructions"
          className={area}
          value={step.instructions}
          onChange={(e) => set({ instructions: e.target.value })}
        />
      </Field>
      <Row label="Output" hint="The fields it hands on.">
        <FieldsEditor label="Output" fields={step.output} onChange={(output) => set({ output })} />
      </Row>
      <div className="grid grid-cols-2 gap-3">
        <Row label="Most turns">
          <SmallInput
            type="number"
            min={1}
            max={50}
            aria-label="Most turns"
            value={step.maxTurns}
            onChange={(e) =>
              set({ maxTurns: Math.max(1, Math.min(50, Number(e.target.value) || 1)) })
            }
          />
        </Row>
        <Row label="At the limit">
          <SmallSelect
            aria-label="At the limit"
            value={step.atLimit}
            onChange={(e) => set({ atLimit: e.target.value as Of<"loop">["atLimit"] })}
          >
            <option value="stop">Stop</option>
            <option value="hand_back">Hand back what it has</option>
          </SmallSelect>
        </Row>
      </div>
    </div>
  );
}

// ── Fork ─────────────────────────────────────────────────────────────────────────────────────────

export function ForkForm(props: StepFormProps<Of<"fork">>) {
  const { step } = props;
  const paths = pickPaths(readable(props));
  const set = (patch: Partial<Of<"fork">>) => props.onChange({ ...step, ...patch });
  const setPath = (i: number, patch: Partial<Of<"fork">["paths"][number]>) =>
    set({ paths: step.paths.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  return (
    <div className="flex flex-col gap-4" data-testid="form-fork">
      <Head props={props} label="Name" placeholder="Is the vendor known?" />
      <Issues issues={props.issues} />
      <Field label="Decided by" step={step} field="decide" props={props}>
        <SmallSelect
          aria-label="Decided by"
          value={step.decide ?? "rules"}
          onChange={(e) => set({ decide: e.target.value as "rules" | "agent" })}
        >
          <option value="rules">Rules: the first path whose rules hold</option>
          <option value="agent">AI: picks one of the paths you built</option>
        </SmallSelect>
      </Field>
      {step.paths.map((p, i) => (
        <section
          key={p.id}
          className="flex flex-col gap-2 border border-line p-3"
          data-testid={`fork-path-${i}`}
        >
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <Row label={`Path ${i + 1}`}>
                <SmallInput
                  aria-label={`Path ${i + 1} name`}
                  value={p.name}
                  placeholder="Not found"
                  onChange={(e) => setPath(i, { name: e.target.value })}
                />
              </Row>
            </div>
            {step.paths.length > 1 ? (
              <Button
                size="sm"
                onClick={() => set({ paths: step.paths.filter((_, j) => j !== i) })}
              >
                Remove path
              </Button>
            ) : null}
          </div>
          {step.decide === "agent" ? (
            <Row label="When to take it, in words">
              <SmallInput
                aria-label={`Path ${i + 1} when, in words`}
                value={p.describe ?? ""}
                onChange={(e) => setPath(i, { describe: e.target.value })}
              />
            </Row>
          ) : (
            <RulesEditor
              rules={p.when}
              paths={paths}
              errors={NO_ERRORS}
              prefix={`paths.${i}.when`}
              testPrefix={`fork-path-${i}`}
              onChange={(when) => setPath(i, { when })}
            />
          )}
        </section>
      ))}
      <div>
        <Button
          size="sm"
          onClick={() =>
            set({
              paths: [
                ...step.paths,
                { id: uuidv7(), name: "", when: { match: "all", rules: [] }, steps: [] },
              ],
            })
          }
        >
          Add a path
        </Button>
      </div>
      {step.decide === "agent" ? (
        <Row label="If the AI is unsure">
          <SmallSelect
            aria-label="If the AI is unsure"
            value={step.ifUnsure ?? "otherwise"}
            onChange={(e) => set({ ifUnsure: e.target.value as "otherwise" | "ask" })}
          >
            <option value="otherwise">Take Otherwise</option>
            <option value="ask">Ask a person</option>
          </SmallSelect>
        </Row>
      ) : null}
    </div>
  );
}

// ── For each and Repeat ──────────────────────────────────────────────────────────────────────────

export function ForEachForm(props: StepFormProps<Of<"for_each">>) {
  const { step } = props;
  const lists = readable(props).filter((o) => o.type === "list");
  const set = (patch: Partial<Of<"for_each">>) => props.onChange({ ...step, ...patch });
  return (
    <div className="flex flex-col gap-4" data-testid="form-for-each">
      <Head props={props} label="Name" placeholder="For each line" />
      <Issues issues={props.issues} />
      <Field
        label="The list"
        step={step}
        field="over"
        props={props}
        hint="The steps inside run once per item."
      >
        <SmallSelect
          aria-label="The list"
          value={lists.some((l) => l.ref === step.over) ? step.over : ""}
          onChange={(e) => set({ over: e.target.value })}
        >
          <option value="">Pick a list</option>
          {lists.map((l) => (
            <option key={l.ref} value={l.ref}>
              {l.label}
            </option>
          ))}
        </SmallSelect>
      </Field>
      <Row label="How many at once">
        <SmallInput
          type="number"
          min={1}
          max={50}
          aria-label="How many at once"
          value={step.concurrency}
          onChange={(e) =>
            set({ concurrency: Math.max(1, Math.min(50, Number(e.target.value) || 1)) })
          }
        />
      </Row>
    </div>
  );
}

export function RepeatForm(props: StepFormProps<Of<"repeat">>) {
  const { step } = props;
  const paths = pickPaths(readable(props));
  const set = (patch: Partial<Of<"repeat">>) => props.onChange({ ...step, ...patch });
  const byRules = "rules" in step.until;
  return (
    <div className="flex flex-col gap-4" data-testid="form-repeat">
      <Head props={props} label="Name" placeholder="Try again until it matches" />
      <Issues issues={props.issues} />
      <Field label="Until" step={step} field="until" props={props}>
        <SmallSelect
          aria-label="Until"
          value={byRules ? "rules" : "agent"}
          onChange={(e) =>
            set({
              until:
                e.target.value === "rules"
                  ? { rules: { match: "all", rules: [] } }
                  : { agent: { goal: "It is done" } },
            })
          }
        >
          <option value="rules">Rules say stop</option>
          <option value="agent">A goal the AI judges</option>
        </SmallSelect>
      </Field>
      {"rules" in step.until ? (
        <RulesEditor
          rules={step.until.rules}
          paths={paths}
          errors={NO_ERRORS}
          prefix="until.rules"
          testPrefix="repeat-until"
          onChange={(rules) => set({ until: { rules } })}
        />
      ) : (
        <Row label="The goal">
          <SmallInput
            aria-label="The goal"
            value={step.until.agent.goal}
            onChange={(e) =>
              set({
                until: {
                  agent: {
                    ...("agent" in step.until ? step.until.agent : {}),
                    goal: e.target.value,
                  },
                },
              })
            }
          />
        </Row>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Row label="Most times">
          <SmallInput
            type="number"
            min={1}
            max={10}
            aria-label="Most times"
            value={step.maxTimes}
            onChange={(e) =>
              set({ maxTimes: Math.max(1, Math.min(10, Number(e.target.value) || 1)) })
            }
          />
        </Row>
        <Row label="At the limit">
          <SmallSelect
            aria-label="At the limit"
            value={step.onLimit}
            onChange={(e) => set({ onLimit: e.target.value as "stop" | "proceed" })}
          >
            <option value="stop">Stop</option>
            <option value="proceed">Go on</option>
          </SmallSelect>
        </Row>
      </div>
      <DurationPicker
        label="Wait between"
        field="between"
        testId="repeat-between"
        value={step.between ?? "0 minutes"}
        onChange={(between) => set({ between })}
      />
    </div>
  );
}

// ── Wait and Hand off ────────────────────────────────────────────────────────────────────────────

export function WaitForm(props: StepFormProps<Of<"wait">>) {
  const { step } = props;
  return (
    <div className="flex flex-col gap-4" data-testid="form-wait">
      <Head props={props} label="Name" placeholder="Wait for the vendor" />
      <Issues issues={props.issues} />
      <DurationPicker
        label="How long"
        field="for"
        testId="wait-for"
        value={step.for}
        onChange={(value) => props.onChange({ ...step, for: value })}
      />
    </div>
  );
}

export function HandoffForm(props: StepFormProps<Of<"handoff">>) {
  const { step, env } = props;
  const mine = step.to.agent === "@self";
  // A step of this agent's own workflow, or (another agent) written as its id.
  const own = flatIds(env.workflow.steps);
  const set = (to: Partial<Of<"handoff">["to"]>) =>
    props.onChange({ ...step, to: { ...step.to, ...to } });
  return (
    <div className="flex flex-col gap-4" data-testid="form-handoff">
      <Head props={props} label="Name" placeholder="Hand the exceptions to AP" />
      <Issues issues={props.issues} />
      <Field label="Hand off to" step={step} field="to.agent" props={props}>
        <SmallSelect
          aria-label="Hand off to"
          value={step.to.agent}
          onChange={(e) => set({ agent: e.target.value, step: "" })}
        >
          <option value="">Pick an agent</option>
          <option value="@self">This agent, another workflow or step</option>
          {(env.agents ?? []).map((a) => (
            <option key={a.slug} value={a.slug}>
              {a.name}
            </option>
          ))}
        </SmallSelect>
      </Field>
      {mine ? (
        <Row label="At step">
          <SmallSelect
            aria-label="At step"
            value={step.to.step}
            onChange={(e) => set({ step: e.target.value })}
          >
            <option value="">Its first step</option>
            {own.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name || s.id}
              </option>
            ))}
          </SmallSelect>
        </Row>
      ) : null}
    </div>
  );
}

function flatIds(list: readonly Step[]): { id: string; name: string }[] {
  return list.flatMap((s) => [
    { id: s.id, name: s.name },
    ...(s.kind === "fork"
      ? [...s.paths.flatMap((p) => flatIds(p.steps)), ...flatIds(s.otherwise.steps)]
      : s.kind === "for_each" || s.kind === "repeat"
        ? flatIds(s.steps)
        : []),
  ]);
}
