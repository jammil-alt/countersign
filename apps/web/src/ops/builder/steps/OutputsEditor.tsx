// The workflow's declared outputs, next to the triggers (docs/step-model-plan.md §9, §13a): triggers
// are the declared ways in, outputs the declared ways out. Each has a name, a kind, where it goes,
// its fields and, optionally, when it applies. An End delivers them; the list is what the workflow
// promises. Placement is the host's.

import { steps } from "@countersign/core";
import { Badge, Button } from "../../../ui/primitives";
import { SmallInput, SmallSelect } from "../fields";
import { PeopleList } from "../people";
import { OUTPUT_KIND_WORDS } from "./EndCard";
import { FieldsEditor } from "./FieldsEditor";
import type { StepFormEnv } from "./form-kit";
import type { BuilderIssue } from "./issues";
import { addOutput, endSteps, newOutput, removeOutput, updateOutput } from "./model";
import type { OutputKind, Workflow, WorkflowOutput } from "./types";

export interface OutputsEditorProps {
  workflow: Workflow;
  env: StepFormEnv;
  /** Issues about outputs (`at` is an output's id), in plain words. */
  issues: readonly BuilderIssue[];
  onChange(next: Workflow): void;
}

const RULE_OPS = ["=", "!=", ">", ">=", "<", "<=", "contains", "exists"] as const;

/** An output as its kind needs it: the part that says how, empty, and none of the other kinds'. */
export function withKind(o: WorkflowOutput, kind: OutputKind): WorkflowOutput {
  const { report: _r, action: _a, handoff: _h, passOn: _p, ...rest } = o;
  const base = { ...rest, kind } as WorkflowOutput;
  switch (kind) {
    case "report":
      return { ...base, report: { to: [], channel: "inbox", message: "" } };
    case "write":
    case "save":
      return { ...base, action: { action: "", input: {} } };
    case "handoff":
      return { ...base, handoff: { agent: "@self", step: "", input: {} } };
    case "pass_on":
      return { ...base, passOn: { output: "" } };
    case "nothing":
      return base;
  }
}

export function OutputsEditor({ workflow, env, issues, onChange }: OutputsEditorProps) {
  const ends = endSteps(workflow);
  return (
    <section className="flex flex-col gap-3" data-testid="workflow-outputs">
      <div>
        <h3 className="eyebrow text-ink-muted">What this workflow delivers</h3>
        <p className="mt-1 text-xs text-ink-muted">
          The ways out. Every End picks one or more of these, and every one is picked by an End.
        </p>
      </div>
      {workflow.outputs.map((o) => {
        const by = ends.filter((e) => e.outputs.includes(o.id));
        const mine = issues.filter((i) => i.at === o.id);
        return (
          <OutputCard
            key={o.id}
            output={o}
            env={env}
            deliveredBy={by.map((e) => e.name.trim() || "An End")}
            issues={mine}
            onChange={(edit) => onChange(updateOutput(workflow, o.id, edit))}
            onRemove={() => onChange(removeOutput(workflow, o.id))}
            last={workflow.outputs.length <= 1}
          />
        );
      })}
      <Button
        size="sm"
        className="self-start"
        onClick={() => onChange(addOutput(workflow, newOutput("")))}
      >
        Add an output
      </Button>
    </section>
  );
}

function OutputCard({
  output: o,
  env,
  deliveredBy,
  issues,
  onChange,
  onRemove,
  last,
}: {
  last: boolean;
  output: WorkflowOutput;
  env: StepFormEnv;
  deliveredBy: string[];
  issues: readonly BuilderIssue[];
  onChange(edit: (o: WorkflowOutput) => WorkflowOutput): void;
  onRemove(): void;
}) {
  const label = o.name.trim() || "New output";
  const actions = env.uses.actions.groups.flatMap((g) =>
    g.actions
      .filter((a) =>
        o.kind === "write" ? a.kind === "change" || a.kind === "send" : a.kind === "save",
      )
      .map((a) => ({
        id: a.id,
        text: `${g.name} › ${env.uses.actions.get(a.id)?.label ?? a.label}`,
      })),
  );
  const chosen = o.action ? env.uses.actions.get(o.action.action) : undefined;
  return (
    <div className="flex flex-col gap-3 border border-line p-3" data-testid={`output-${o.id}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge>{OUTPUT_KIND_WORDS[o.kind]}</Badge>
          {deliveredBy.length > 0 ? (
            <span className="text-xs text-ink-muted">Delivered by: {deliveredBy.join(", ")}</span>
          ) : (
            <Badge tone="warning">No End delivers this yet</Badge>
          )}
          {o.kind === "write" ? <Badge tone="accent">Needs approval</Badge> : null}
        </div>
        <Button
          size="sm"
          aria-label={`Remove ${label}`}
          disabled={last}
          title={last ? "A workflow keeps at least one output." : undefined}
          onClick={onRemove}
        >
          Remove
        </Button>
      </div>
      <div className="flex flex-col gap-1 text-sm">
        <span className="text-ink">Name</span>
        <SmallInput
          aria-label={`Name of ${label}`}
          value={o.name}
          onChange={(e) => onChange((x) => ({ ...x, name: e.target.value }))}
        />
      </div>
      <div className="flex flex-col gap-1 text-sm">
        <span className="text-ink">What it is, in one line</span>
        <SmallInput
          aria-label={`About ${label}`}
          value={o.about ?? ""}
          onChange={(e) => onChange((x) => ({ ...x, about: e.target.value }))}
        />
      </div>
      <div className="flex flex-col gap-1 text-sm">
        <span className="text-ink">Kind</span>
        <SmallSelect
          aria-label={`Kind of ${label}`}
          value={o.kind}
          onChange={(e) => onChange((x) => withKind(x, e.target.value as OutputKind))}
        >
          {steps.OUTPUT_KINDS.map((k) => (
            <option key={k} value={k}>
              {OUTPUT_KIND_WORDS[k]}
            </option>
          ))}
        </SmallSelect>
      </div>

      {o.kind === "report" && o.report ? (
        <div className="flex flex-col gap-2">
          <span className="text-sm text-ink">Goes to</span>
          <PeopleList
            value={o.report.to}
            people={env.people}
            max={10}
            field={`outputs.${o.id}.to`}
            testId={`output-${o.id}-to`}
            onChange={(to) =>
              onChange((x) => ({
                ...x,
                report: { ...(x.report as NonNullable<typeof x.report>), to },
              }))
            }
          />
          <SmallSelect
            aria-label={`Channel of ${label}`}
            value={o.report.channel}
            onChange={(e) =>
              onChange((x) => ({
                ...x,
                report: {
                  ...(x.report as NonNullable<typeof x.report>),
                  channel: e.target.value as "inbox" | "email" | "sms",
                },
              }))
            }
          >
            <option value="inbox">Inbox</option>
            <option value="email">Email</option>
            <option value="sms">Text</option>
          </SmallSelect>
          <SmallInput
            aria-label={`Message of ${label}`}
            placeholder="What it says"
            value={o.report.message}
            onChange={(e) =>
              onChange((x) => ({
                ...x,
                report: { ...(x.report as NonNullable<typeof x.report>), message: e.target.value },
              }))
            }
          />
        </div>
      ) : null}

      {(o.kind === "write" || o.kind === "save") && o.action ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-col gap-1 text-sm">
            <span className="text-ink">
              {o.kind === "write" ? "Tool and action" : "Area and action"}
            </span>
            <SmallSelect
              aria-label={`Action of ${label}`}
              value={o.action.action}
              onChange={(e) =>
                onChange((x) => ({ ...x, action: { action: e.target.value, input: {} } }))
              }
            >
              <option value="">Pick one</option>
              {actions.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.text}
                </option>
              ))}
            </SmallSelect>
          </div>
          {chosen?.input.map((f) => (
            <div key={f.name} className="flex items-center gap-2 text-sm">
              <span className="w-32 shrink-0 text-ink">{f.name}</span>
              <span className="text-ink-muted">←</span>
              <SmallInput
                aria-label={`${f.name} for ${label}`}
                placeholder="Where it comes from"
                value={String((o.action?.input[f.name] as string | undefined) ?? "")}
                onChange={(e) =>
                  onChange((x) => ({
                    ...x,
                    action: {
                      action: x.action?.action ?? "",
                      input: { ...(x.action?.input ?? {}), [f.name]: e.target.value },
                    },
                  }))
                }
              />
            </div>
          ))}
        </div>
      ) : null}

      {o.kind === "handoff" && o.handoff ? (
        <div className="flex flex-col gap-2">
          {(["agent", "workflow", "step"] as const).map((k) => (
            <div key={k} className="flex flex-col gap-1 text-sm">
              <span className="text-ink">
                {k === "agent"
                  ? "Agent (@self for this one)"
                  : k === "workflow"
                    ? "Workflow"
                    : "Step"}
              </span>
              <SmallInput
                aria-label={`${k} of ${label}`}
                value={o.handoff?.[k] ?? ""}
                onChange={(e) =>
                  onChange((x) => ({
                    ...x,
                    handoff: {
                      ...(x.handoff as NonNullable<typeof x.handoff>),
                      [k]: e.target.value,
                    },
                  }))
                }
              />
            </div>
          ))}
        </div>
      ) : null}

      {o.kind === "pass_on" && o.passOn ? (
        <div className="flex flex-col gap-1 text-sm">
          <span className="text-ink">What other agents receive</span>
          <SmallInput
            aria-label={`Passed on by ${label}`}
            value={
              typeof o.passOn.output === "string"
                ? o.passOn.output
                : JSON.stringify(o.passOn.output)
            }
            onChange={(e) =>
              onChange((x) => ({
                ...x,
                passOn: { ...(x.passOn as NonNullable<typeof x.passOn>), output: e.target.value },
              }))
            }
          />
        </div>
      ) : null}

      <div className="flex flex-col gap-1">
        <span className="text-sm text-ink">Fields</span>
        <FieldsEditor
          fields={o.fields}
          label={`Fields of ${label}`}
          onChange={(fields) => onChange((x) => ({ ...x, fields }))}
        />
      </div>

      <WhenRows output={o} label={label} onChange={onChange} />

      {issues.map((i) => (
        <p key={`${i.code}-${i.message}`} className="text-sm text-risk-ink">
          Needs fixing: {i.message}
        </p>
      ))}
    </div>
  );
}

/** "Only when": rule rows, absent means always. */
function WhenRows({
  output: o,
  label,
  onChange,
}: {
  output: WorkflowOutput;
  label: string;
  onChange(edit: (o: WorkflowOutput) => WorkflowOutput): void;
}) {
  const rules = o.when?.rules ?? [];
  const set = (next: typeof rules) =>
    onChange((x) => {
      const { when: _w, ...rest } = x;
      return next.length === 0
        ? (rest as WorkflowOutput)
        : { ...rest, when: { match: x.when?.match ?? "all", rules: next } };
    });
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm text-ink">Only when</span>
      {rules.length === 0 ? <span className="text-xs text-ink-muted">Always.</span> : null}
      {rules.map((r, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rule rows have no ids; their order is their identity.
        <div key={i} className="flex items-center gap-1.5">
          <SmallInput
            aria-label={`Field of condition ${i + 1} of ${label}`}
            value={r.field}
            onChange={(e) =>
              set(rules.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)))
            }
          />
          <SmallSelect
            aria-label={`Operator of condition ${i + 1} of ${label}`}
            value={r.op}
            onChange={(e) =>
              set(rules.map((x, j) => (j === i ? { ...x, op: e.target.value as typeof r.op } : x)))
            }
          >
            {RULE_OPS.map((op) => (
              <option key={op} value={op}>
                {op}
              </option>
            ))}
          </SmallSelect>
          <SmallInput
            aria-label={`Value of condition ${i + 1} of ${label}`}
            value={r.value === undefined ? "" : String(r.value)}
            onChange={(e) =>
              set(rules.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))
            }
          />
          <Button
            size="sm"
            aria-label={`Remove condition ${i + 1} of ${label}`}
            onClick={() => set(rules.filter((_, j) => j !== i))}
          >
            Remove
          </Button>
        </div>
      ))}
      <Button
        size="sm"
        className="self-start"
        onClick={() => set([...rules, { field: "", op: "=", value: "" }])}
      >
        Add condition
      </Button>
    </div>
  );
}
