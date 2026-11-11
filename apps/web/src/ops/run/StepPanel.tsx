// The back office's step panel on `/ops/runs/:id?step=<id>` (docs/plan.md §1.95): one row of the
// run's checklist, beside the run. What the step did, its state, times, tries, models, tokens and
// cost; its checks, approvals and the owner's decisions; what went in and came out read as fields
// (raw JSON behind a toggle); each model call with its prompt and answer on demand; its tool
// calls; and the changes it made to the client's tools, before and after. Data: the records,
// documents and changes it made or cited, with links. Back office only (invariant 11).

import { stepDocumentIds, type TimelineChecks } from "@countersign/core";
import { useState } from "react";
import type { ResponseOf } from "../../api/client";
import type { apiRoutes } from "../../api/routes";
import { useI18n } from "../../i18n/i18n";
import { ChangeTables } from "../../inbox/ChangePanel";
import { changeHeading } from "../../inbox/change";
import { sourceLabel, sourcesOf } from "../../records/SourceLinks";
import { duration, shortTime, stepStatusLabel, usd } from "../../runs/format";
import { qualifiedToolLabel as toolLabel } from "../../runs/labels";
import { StepChecks } from "../../runs/StepChecks";
import {
  DataBlock,
  documentLabel,
  FieldsView,
  type StepDataEntry,
  StepDataList,
  StepFacts,
  StepSheet,
  stepChipState,
} from "../../runs/StepPanel";
import { Badge, Button, Tag } from "../../ui/primitives";
import { SheetSection } from "../../ui/sheet";
import { StatusChip } from "../../ui/status";
import type { RunStepRow } from "./checklist";
import { OwnerCheckLines } from "./RunAudit";
import { ModelCallBody } from "./RunControls";
import { actionBadge, ownerLine, plural } from "./words";

type RunDetail = ResponseOf<typeof apiRoutes.opsRun>;
type Step = RunDetail["steps"][number];
type Action = RunDetail["actions"][number];
type Decision = NonNullable<RunDetail["oversight"]>[number];
type OwnerCheck = NonNullable<RunDetail["ownerChecks"]>[number];
type ModelCall = ResponseOf<typeof apiRoutes.opsRunModelCalls>["modelCalls"][number];

/** "6.1k" for 6,100 tokens. */
function tokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n);
}

/** What the Data tab lists for a step: its changes, the records it cites, the documents it names. */
export function opsStepData(
  data: RunDetail,
  step: Step | undefined,
  i18n: ReturnType<typeof useI18n>,
): StepDataEntry[] {
  if (!step) return [];
  const { run } = data;
  const actions = data.actions.filter((a) => a.stepRunId === step.id);
  const changes: StepDataEntry[] = actions.map((a) => {
    const badge = actionBadge(a, run.mode === "test");
    return {
      key: `change-${a.id}`,
      kind: "change",
      label: changeHeading(a.display, a.tool, a.before, a.input).title,
      end: <Badge tone={badge.tone}>{badge.label}</Badge>,
      href: `/ops/runs/${run.id}?tab=changes`,
    };
  });
  const records: StepDataEntry[] = [...new Set(sourcesOf(step.output))].map((id) => ({
    key: `record-${id}`,
    kind: "record",
    label: data.sourceNames?.[id] ?? sourceLabel(id, i18n),
    href: `/ops/clients/${run.tenantId}/records/${id}`,
  }));
  const documents: StepDataEntry[] = stepDocumentIds(step.input, step.output).map((id) => ({
    key: `document-${id}`,
    kind: "document",
    label: documentLabel(id, i18n.t),
    href: `/ops/clients/${run.tenantId}/documents/${id}`,
  }));
  return [...changes, ...records, ...documents];
}

export function OpsStepPanel({
  data,
  row,
  step,
  index,
  count,
  kind,
  skillKind,
  checks,
  decisions,
  ownerChecks,
  calls,
  onClose,
}: {
  data: RunDetail;
  row: RunStepRow;
  /** The step's run row; none for a step not reached yet. */
  step: Step | undefined;
  /** Its place in the checklist (the trigger is 0). */
  index: number;
  count: number;
  kind: string;
  skillKind: string | null;
  checks: TimelineChecks;
  decisions: readonly Decision[];
  ownerChecks: readonly OwnerCheck[];
  /** The run's model calls, once they've come. */
  calls: readonly ModelCall[] | null;
  onClose: () => void;
}) {
  const i18n = useI18n();
  const { run } = data;
  const actions = step ? data.actions.filter((a) => a.stepRunId === step.id) : [];
  const toolCalls = step ? data.toolCalls.filter((c) => c.stepRunId === step.id) : [];
  const modelCalls = step && calls ? calls.filter((c) => c.stepRunId === step.id) : [];
  const entries = opsStepData(data, step, i18n);
  const status = step?.status ?? row.status;
  const isTrigger = row.key === "trigger";
  const hasChecks =
    Object.keys(checks).some((k) => k !== "outcome") ||
    decisions.length > 0 ||
    ownerChecks.length > 0;
  return (
    <StepSheet
      testId="ops-run-step-panel"
      title={row.title}
      eyebrow={
        <span className="flex flex-wrap items-center gap-2">
          <Tag>{kind}</Tag>
          {skillKind ? <Tag testId="ops-run-step-panel-skill-kind">{skillKind}</Tag> : null}
          <StatusChip state={stepChipState(status)} testId="ops-run-step-panel-status">
            {stepStatusLabel(status)}
          </StatusChip>
          <span className="eyebrow text-ink-muted">
            {index > 0 ? `Step ${index} of ${count - 1}` : "What started it"}
          </span>
        </span>
      }
      onClose={onClose}
      dataCount={entries.length}
      data={
        entries.length > 0 ? (
          <StepDataList
            entries={entries}
            testId="ops-run-step-data"
            changesLabel="Changes to the client's tools"
          />
        ) : undefined
      }
      step={
        <>
          {step?.summary || row.detail ? (
            <p className="text-ink" data-testid="ops-run-step-panel-summary">
              {step?.summary ?? row.detail}
            </p>
          ) : null}
          {row.internal ? (
            <p className="text-sm text-ink-muted">Hidden from the client's timeline.</p>
          ) : null}
          <StepFacts
            testId="ops-run-step-panel-facts"
            facts={[
              ["Status", stepStatusLabel(status)],
              [
                "Step id",
                step ? (
                  <span key="node" className="reference">
                    {step.nodeId}
                  </span>
                ) : null,
              ],
              ["Skill or tool", step?.skillRef ? toolLabel(step.skillRef) : null],
              ["Started", step?.startedAt ? shortTime(step.startedAt) : "Not yet"],
              ["Finished", step?.finishedAt ? shortTime(step.finishedAt) : null],
              ["Duration", step?.startedAt ? duration(step.startedAt, step.finishedAt) : null],
              [
                "Tries",
                step?.attempts && step.attempts > 1
                  ? `${step.attempts} (retried ${plural(step.attempts - 1, "time", "times")})`
                  : null,
              ],
              ["Models", step?.models?.length ? step.models.join(", ") : null],
              [
                "Tokens",
                step && (step.tokensIn || step.tokensOut)
                  ? `${tokens(step.tokensIn)} in / ${tokens(step.tokensOut)} out`
                  : null,
              ],
              ["Cost", step && Number(step.costUsd) > 0 ? usd(step.costUsd) : null],
            ]}
          />
          {hasChecks ? (
            <SheetSection label="Checks, approvals and the owner">
              <StepChecks checks={checks} testId="ops-run-step-panel-checks" />
              {decisions.map((d) => (
                <div key={d.id} className="ui-stepdata__item flex flex-col gap-1 text-sm">
                  <p className="text-ink">{ownerLine(d)}.</p>
                  <p className="text-ink-muted">{d.note}</p>
                  {d.action === "retry_with" ? (
                    <DataBlock label="Corrected input" value={d.inputAfter} />
                  ) : null}
                </div>
              ))}
              <OwnerCheckLines
                checks={ownerChecks}
                runId={run.id}
                testId="ops-run-step-panel-owner-checks"
              />
            </SheetSection>
          ) : null}
          {isTrigger && !step ? (
            <DataBlock
              label="What started it"
              value={run.trigger}
              testId="ops-run-step-panel-trigger"
            />
          ) : step ? (
            <>
              <DataBlock
                label="What went in"
                value={step.input}
                testId="ops-run-step-panel-input"
              />
              <DataBlock
                label="What came out"
                value={step.output}
                testId="ops-run-step-panel-output"
              />
            </>
          ) : (
            <p className="text-sm text-ink-muted">The run hasn't reached this step yet.</p>
          )}
          {modelCalls.length > 0 ? (
            <SheetSection label={`AI · ${plural(modelCalls.length, "model call", "model calls")}`}>
              <ul className="flex flex-col gap-2" data-testid="ops-run-step-panel-model-calls">
                {modelCalls.map((c) => (
                  <ModelCallItem key={c.id} call={c} />
                ))}
              </ul>
            </SheetSection>
          ) : null}
          {toolCalls.length > 0 ? (
            <SheetSection label={`Tool calls · ${toolCalls.length}`}>
              <ul className="flex flex-col gap-2" data-testid="ops-run-step-panel-tool-calls">
                {toolCalls.map((c) => (
                  <li key={c.id} className="ui-stepdata__item">
                    <details>
                      <summary className="cursor-pointer text-sm">
                        <span className="text-ink">{toolLabel(c.tool)}</span>
                        <span className="ml-2 text-ink-muted">
                          {[c.status, c.durationMs === null ? null : `${c.durationMs} ms`]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </summary>
                      <div className="mt-3 flex flex-col gap-4">
                        <DataBlock label="Input" value={c.input} />
                        <DataBlock label="Output" value={c.output} />
                      </div>
                    </details>
                  </li>
                ))}
              </ul>
            </SheetSection>
          ) : null}
          {actions.length > 0 ? (
            <SheetSection label="Changes to the client's tools">
              <div className="flex flex-col gap-4" data-testid="ops-run-step-panel-changes">
                {actions.map((a) => (
                  <ChangeItem key={a.id} action={a} testRun={run.mode === "test"} />
                ))}
              </div>
            </SheetSection>
          ) : null}
        </>
      }
    />
  );
}

/** One model call: its model, tokens, cost and time; the prompt and answer on demand. */
function ModelCallItem({ call }: { call: ModelCall }) {
  const [open, setOpen] = useState(false);
  return (
    <li
      className="ui-stepdata__item flex flex-col gap-2"
      data-testid={`ops-run-step-panel-call-${call.id}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="reference text-ink">
          {call.provider} · {call.model}
        </span>
        <span className="figures text-ink-muted">
          {[
            shortTime(call.createdAt),
            `${tokens(call.tokensIn)} in / ${tokens(call.tokensOut)} out`,
            usd(call.costUsd),
            call.durationMs === null ? null : `${call.durationMs} ms`,
            call.stopReason,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </div>
      <Button
        variant="link"
        size="sm"
        className="self-start"
        aria-expanded={open}
        data-testid={`ops-run-step-panel-call-${call.id}-open`}
        onClick={() => setOpen(!open)}
      >
        {open ? "Hide prompt and answer" : "Prompt and answer"}
      </Button>
      {open ? <ModelCallBody id={call.id} /> : null}
    </li>
  );
}

/** A change the step made: its heading and state, now and after, and who approved it. */
function ChangeItem({ action, testRun }: { action: Action; testRun: boolean }) {
  const heading = changeHeading(action.display, action.tool, action.before, action.input);
  const badge = actionBadge(action, testRun);
  const failure = action.error as { message?: unknown } | null;
  return (
    <div
      className="ui-stepdata__item flex flex-col gap-3"
      data-testid={`ops-run-step-panel-change-${action.id}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium text-ink">{heading.title}</p>
          {heading.description ? (
            <p className="text-sm text-ink-muted">{heading.description}</p>
          ) : null}
        </div>
        <Badge tone={badge.tone}>{badge.label}</Badge>
      </div>
      <ChangeTables
        before={action.before}
        input={action.editedInput ?? action.input}
        display={action.display?.tool}
        showIds
      />
      <p className="text-sm text-ink-muted">
        {[
          action.approvedAt
            ? `Approved ${shortTime(action.approvedAt)}${action.approvedBy ? "" : " automatically"}`
            : null,
          action.editedAt ? `Edited before signing ${shortTime(action.editedAt)}` : null,
          action.status === "failed"
            ? `Failed: ${String(failure?.message ?? "unknown error")}`
            : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      {action.result !== null && action.result !== undefined ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-ink-muted">What the tool answered</summary>
          <div className="mt-2">
            <FieldsView value={action.result} />
          </div>
        </details>
      ) : null}
    </div>
  );
}
