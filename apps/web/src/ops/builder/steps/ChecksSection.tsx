// Checks on a step (docs/step-model-plan.md §3, §5): Confer, Approver, Review and Tell after, each a
// switch on the step and never a step of its own, in the order they run.
//
// DECISION (invariant 8): the approver is on for every Change or Send to a client's tool and is
// shown locked on here. The env doesn't know what the client's connection allows to run on its own,
// so the switch-off, "only when" conditions and "go ahead with no answer" (all loosening) are not
// offered; who, in what order, the deadline and "skip" when nobody answers are. We turn it off per
// client, where their connection allows it.
// DECISION: a check's "only when" condition is kept as it is stored but isn't edited here; the
// condition editor of the v4 builder is typed on v4 steps and the process paths.

import type { processes } from "@countersign/core";
import type { ReactNode } from "react";
import { Button } from "../../../ui/primitives";
import { SmallInput, SmallSelect } from "../fields";
import { PersonPicker } from "../people";
import {
  type ApprovalCheck,
  checksFor,
  defaultApproval,
  needsApprover,
  REVIEW_CHOICES,
  withChecks,
  without,
} from "./checks-model";
import type { StepFormProps } from "./form-kit";
import { SuggestButton } from "./SuggestButton";
import type { Step } from "./types";

type Conferee = processes.Conferee;
type NotifyCheck = processes.NotifyCheck;

function Switch({
  id,
  label,
  on,
  onToggle,
  locked,
  aside,
  children,
}: {
  id: string;
  label: string;
  on: boolean;
  onToggle(on: boolean): void;
  locked?: boolean;
  aside?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2" data-testid={`check-${id}`}>
      <div className="flex items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={on}
            disabled={locked}
            onChange={(e) => onToggle(e.target.checked)}
          />
          {label}
        </label>
        {aside}
      </div>
      {on ? <div className="flex flex-col gap-2 pl-6">{children}</div> : null}
    </div>
  );
}

export function ChecksSection(props: StepFormProps<Step>) {
  const { step, env, onChange } = props;
  const can = checksFor(step, env.uses);
  if (!can.confer && !can.approval && !can.review && !can.tellAfter) return null;
  const checks = step.checks ?? {};
  const edit = (fn: (c: typeof checks) => typeof checks) => onChange(withChecks(step, fn));
  const suggest = (field: string, label: string) => (
    <SuggestButton
      step={step}
      field={field}
      label={label}
      suggest={env.suggest}
      onApply={onChange}
    />
  );
  const mustApprove = needsApprover(step, env.uses);
  const approval = checks.approval ?? (mustApprove ? defaultApproval() : undefined);

  return (
    <section className="flex flex-col gap-3 border-t border-line pt-4" data-testid="step-checks">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="eyebrow text-ink-muted">Checks</h3>
          <p className="mt-1 text-xs text-ink-muted">
            In this order: a second opinion, then approval, then the step, then a notice.
          </p>
        </div>
        {suggest("checks", "Checks")}
      </div>

      {can.confer ? (
        <Switch
          id="confer"
          label="Confer: ask for a second opinion"
          on={checks.confer !== undefined}
          onToggle={(on) =>
            edit((c) =>
              on
                ? { ...c, confer: { with: [{ ai: { focus: "Is this right?" } }] } }
                : without(c, "confer"),
            )
          }
          aside={suggest("checks.confer", "Confer")}
        >
          {(checks.confer?.with ?? []).map((who, i) => (
            <ConferRow
              // biome-ignore lint/suspicious/noArrayIndexKey: reviewers have no ids; order is identity.
              key={i}
              value={who}
              props={props}
              onChange={(next) =>
                edit((c) =>
                  c.confer
                    ? {
                        ...c,
                        confer: {
                          ...c.confer,
                          with: c.confer.with.map((w, j) => (j === i ? next : w)),
                        },
                      }
                    : c,
                )
              }
              onRemove={
                (checks.confer?.with.length ?? 0) > 1
                  ? () =>
                      edit((c) =>
                        c.confer
                          ? {
                              ...c,
                              confer: {
                                ...c.confer,
                                with: c.confer.with.filter((_w, j) => j !== i),
                              },
                            }
                          : c,
                      )
                  : undefined
              }
            />
          ))}
          {(checks.confer?.with.length ?? 0) < 3 ? (
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() =>
                  edit((c) =>
                    c.confer
                      ? {
                          ...c,
                          confer: {
                            ...c.confer,
                            with: [...c.confer.with, { ai: { focus: "Is this right?" } }],
                          },
                        }
                      : c,
                  )
                }
              >
                Add an AI reviewer
              </Button>
              <Button
                size="sm"
                onClick={() =>
                  edit((c) =>
                    c.confer
                      ? {
                          ...c,
                          confer: {
                            ...c.confer,
                            with: [
                              ...c.confer.with,
                              {
                                person: "client_admin",
                                deadline: { after: "1 day", hours: "clock", ifNoAnswer: "stop" },
                              },
                            ],
                          },
                        }
                      : c,
                  )
                }
              >
                Add a person
              </Button>
            </div>
          ) : null}
        </Switch>
      ) : null}

      {can.approval ? (
        <Switch
          id="approver"
          label="Approver"
          on
          locked
          onToggle={() => undefined}
          aside={suggest("checks.approval", "Approver")}
        >
          <p className="text-xs text-ink-muted">
            On: every change to a client's tool needs an approval. We turn this off per client,
            where their connection allows it, not here.
          </p>
          {approval ? (
            <ApproverFields
              approval={approval}
              props={props}
              onChange={(next) => edit((c) => ({ ...c, approval: next }))}
            />
          ) : null}
        </Switch>
      ) : null}

      {can.review ? (
        <div className="flex items-center justify-between gap-2" data-testid="check-review">
          <div className="flex items-center gap-2 text-sm text-ink">
            Review: the owner's check
            <SmallSelect
              aria-label="Review"
              value={step.review ?? "auto"}
              onChange={(e) => {
                const value = e.target.value as "auto" | "off" | "always";
                const { review: _drop, ...rest } = step;
                onChange((value === "auto" ? rest : { ...rest, review: value }) as Step);
              }}
            >
              {REVIEW_CHOICES.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </SmallSelect>
          </div>
          {suggest("review", "Review")}
        </div>
      ) : null}

      {can.tellAfter ? (
        <Switch
          id="tell-after"
          label="Tell after"
          on={(checks.notify?.length ?? 0) > 0}
          onToggle={(on) =>
            edit((c) =>
              on
                ? { ...c, notify: [{ to: ["client_admin"], channel: "inbox", message: "" }] }
                : without(c, "notify"),
            )
          }
          aside={suggest("checks.notify", "Tell after")}
        >
          {(checks.notify ?? []).map((n, i) => (
            <NoticeRow
              // biome-ignore lint/suspicious/noArrayIndexKey: notices have no ids; order is identity.
              key={i}
              value={n}
              props={props}
              onChange={(next) =>
                edit((c) => ({
                  ...c,
                  notify: (c.notify ?? []).map((x, j) => (j === i ? next : x)),
                }))
              }
              onRemove={() =>
                edit((c) => {
                  const rest = (c.notify ?? []).filter((_x, j) => j !== i);
                  return rest.length ? { ...c, notify: rest } : without(c, "notify");
                })
              }
            />
          ))}
          {(checks.notify?.length ?? 0) < 5 ? (
            <Button
              size="sm"
              className="self-start"
              onClick={() =>
                edit((c) => ({
                  ...c,
                  notify: [
                    ...(c.notify ?? []),
                    { to: ["client_admin"], channel: "inbox", message: "" },
                  ],
                }))
              }
            >
              Add a notice
            </Button>
          ) : null}
        </Switch>
      ) : null}
    </section>
  );
}

function ConferRow({
  value,
  props,
  onChange,
  onRemove,
}: {
  value: Conferee;
  props: StepFormProps<Step>;
  onChange(next: Conferee): void;
  onRemove: (() => void) | undefined;
}) {
  return (
    <div className="flex items-center gap-2" data-testid="confer-row">
      {"ai" in value ? (
        <>
          <span className="w-16 shrink-0 text-xs text-ink-muted">AI asks</span>
          <SmallInput
            aria-label="What the AI looks at"
            value={value.ai.focus}
            onChange={(e) => onChange({ ...value, ai: { ...value.ai, focus: e.target.value } })}
          />
        </>
      ) : (
        <>
          <span className="w-16 shrink-0 text-xs text-ink-muted">A person</span>
          <PersonPicker
            label="Who gives the second opinion"
            value={value.person}
            people={props.env.people}
            field="checks.confer.person"
            testId="confer-person"
            onChange={(v) => onChange({ ...value, person: v ?? value.person })}
          />
          <SmallInput
            aria-label="Waits up to"
            value={value.deadline.after}
            onChange={(e) =>
              onChange({ ...value, deadline: { ...value.deadline, after: e.target.value } })
            }
          />
        </>
      )}
      {onRemove ? (
        <Button size="sm" onClick={onRemove} aria-label="Remove this reviewer">
          Remove
        </Button>
      ) : null}
    </div>
  );
}

function ApproverFields({
  approval,
  props,
  onChange,
}: {
  approval: ApprovalCheck;
  props: StepFormProps<Step>;
  onChange(next: ApprovalCheck): void;
}) {
  const approvers = approval.approvers ?? [];
  // Never looser: `required` stays as it is and the condition is dropped (invariant 8).
  const set = (patch: Partial<ApprovalCheck>) =>
    onChange({ ...approval, ...patch, required: "required", when: undefined } as ApprovalCheck);
  return (
    <div className="flex flex-col gap-2">
      {approvers.map((a, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: approvers have no ids; order is identity.
        <div key={i} className="flex items-center gap-2" data-testid="approver-row">
          <PersonPicker
            label="Who approves"
            value={a.who}
            people={props.env.people}
            field={`checks.approval.approvers.${i}.who`}
            testId={`approver-${i}`}
            allowDefault="The default approver"
            onChange={(who) =>
              set({
                approvers: approvers.map((x, j) =>
                  j === i ? { ...x, ...(who ? { who } : { who: undefined }) } : x,
                ),
              })
            }
          />
          <SmallInput
            aria-label="Waits up to"
            placeholder="1 day"
            value={a.deadline?.after ?? ""}
            onChange={(e) =>
              set({
                approvers: approvers.map((x, j) =>
                  j === i
                    ? {
                        ...x,
                        deadline: e.target.value
                          ? { after: e.target.value, hours: "clock", ifNoAnswer: "stop" }
                          : undefined,
                      }
                    : x,
                ),
              })
            }
          />
          <Button
            size="sm"
            onClick={() => set({ approvers: approvers.filter((_x, j) => j !== i) })}
          >
            Remove
          </Button>
        </div>
      ))}
      {approvers.length < 5 ? (
        <Button
          size="sm"
          className="self-start"
          onClick={() => set({ approvers: [...approvers, {}] })}
        >
          Add an approver
        </Button>
      ) : null}
      {approvers.length > 1 ? (
        <SmallSelect
          aria-label="How they approve"
          value={approval.mode}
          onChange={(e) => set({ mode: e.target.value as ApprovalCheck["mode"] })}
        >
          <option value="in_turn">In turn</option>
          <option value="any">Any one of them</option>
          <option value="all">All of them</option>
        </SmallSelect>
      ) : null}
      <SmallSelect
        aria-label="If no one answers"
        value={approval.ifNoAnswer === "skip" ? "skip" : "stop"}
        onChange={(e) => set({ ifNoAnswer: e.target.value === "skip" ? "skip" : "stop" })}
      >
        <option value="stop">If no one answers: stop</option>
        <option value="skip">If no one answers: skip this step</option>
      </SmallSelect>
    </div>
  );
}

function NoticeRow({
  value,
  props,
  onChange,
  onRemove,
}: {
  value: NotifyCheck;
  props: StepFormProps<Step>;
  onChange(next: NotifyCheck): void;
  onRemove(): void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-sm border border-line p-2" data-testid="notice-row">
      <div className="flex items-center gap-2">
        <PersonPicker
          label="Who is told"
          value={value.to[0]}
          people={props.env.people}
          field="checks.notify.to"
          testId="notice-to"
          onChange={(v) => onChange({ ...value, to: [v ?? "client_admin", ...value.to.slice(1)] })}
        />
        <SmallSelect
          aria-label="How"
          value={value.channel}
          onChange={(e) =>
            onChange({ ...value, channel: e.target.value as NotifyCheck["channel"] })
          }
        >
          <option value="inbox">Inbox</option>
          <option value="email">Email</option>
          <option value="sms">Text message</option>
        </SmallSelect>
        <Button size="sm" onClick={onRemove}>
          Remove
        </Button>
      </div>
      <SmallInput
        aria-label="What it says"
        placeholder="What it says"
        value={value.message}
        onChange={(e) => onChange({ ...value, message: e.target.value })}
      />
    </div>
  );
}
