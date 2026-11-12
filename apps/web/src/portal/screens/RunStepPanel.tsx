// The client's step panel on `/runs/:id?step=<id>` (docs/plan.md §1.95): one step of the run,
// beside it. What the step did in plain words, its state, times and tries; "AI read this" when it
// asked a model (never which, its prompt or its cost); its checks and approvals; what went in and
// came out as the API serves them to a client (`clientStepData`); and the changes it made to the
// client's tools, before and after. Data: the records, documents and changes it made or cited.
// Renders only the fields the portal contract names (invariant 11), and reads the step's data
// through `clientStepData` again, as the API did, so nothing it leaves out can show here.

import { clientStepData, pickLocalized, stepDocumentIds } from "@countersign/core";
import type { ResponseOf } from "../../api/client";
import type { apiRoutes } from "../../api/routes";
import type { PlainKey } from "../../i18n/catalog";
import { useI18n } from "../../i18n/i18n";
import { ChangeTables } from "../../inbox/ChangePanel";
import { changeHeading } from "../../inbox/change";
import { sourceLabel } from "../../records/SourceLinks";
import { duration, shortTime, stepStatusLabel } from "../../runs/format";
import { conferTitle, StepChecks } from "../../runs/StepChecks";
import {
  DataBlock,
  documentLabel,
  type StepDataEntry,
  StepDataList,
  StepFacts,
  StepSheet,
  stepChipState,
} from "../../runs/StepPanel";
import { writeLine } from "../../runs/write";
import { Badge, Button, Tag, type Tone } from "../../ui/primitives";
import { SheetSection } from "../../ui/sheet";
import { StatusChip } from "../../ui/status";
import { useSloanPanel } from "../SloanPanel";

type RunData = ResponseOf<typeof apiRoutes.portalRun>;
type Step = RunData["steps"][number];
type Action = RunData["actions"][number];

const ACTION_WORDS: Record<string, PlainKey> = {
  proposed: "action.status.proposed",
  approved: "action.status.approved",
  executing: "action.status.executing",
  done: "action.status.done",
  rejected: "action.status.rejected",
  failed: "action.status.failed",
};

const ACTION_TONE: Record<string, Tone> = {
  proposed: "warning",
  approved: "person",
  done: "positive",
  failed: "risk",
};

/** What the Data tab lists for a step: its changes, the records it cites, the documents it names. */
export function portalStepData(
  step: Step,
  actions: readonly Action[],
  names: Readonly<Record<string, string>> | undefined,
  i18n: ReturnType<typeof useI18n>,
): StepDataEntry[] {
  const { t, locale } = i18n;
  const changes: StepDataEntry[] = actions.map((a) => {
    const heading = changeHeading(a.display, a.tool, a.before, a.input, locale);
    return {
      key: `change-${a.id}`,
      kind: "change",
      label: a.display?.tool?.description
        ? pickLocalized(a.display.tool.description, locale)
        : heading.title,
      end: <ActionBadge action={a} />,
    };
  });
  const records: StepDataEntry[] = [...new Set(step.sources)].map((id) => ({
    key: `record-${id}`,
    kind: "record",
    label: names?.[id] ?? sourceLabel(id, i18n),
    href: `/records/${id}`,
  }));
  const documents: StepDataEntry[] = stepDocumentIds(step.input, step.output).map((id) => ({
    key: `document-${id}`,
    kind: "document",
    label: documentLabel(id, t),
    href: `/documents/${id}`,
  }));
  return [...changes, ...records, ...documents];
}

function ActionBadge({ action }: { action: Action }) {
  const { t } = useI18n();
  const words = ACTION_WORDS[action.status];
  return (
    <Badge tone={ACTION_TONE[action.status] ?? "neutral"}>{words ? t(words) : action.status}</Badge>
  );
}

export function PortalStepPanel({
  step,
  index,
  count,
  data,
  onClose,
}: {
  step: Step;
  /** Its place on the timeline, from 1. */
  index: number;
  count: number;
  data: RunData;
  onClose: () => void;
}) {
  const i18n = useI18n();
  const { t, locale } = i18n;
  const time = (iso: string | null) => (iso ? shortTime(iso, undefined, i18n) : null);
  const panel = useSloanPanel();
  const actions = data.actions.filter((a) => a.stepRunId === step.id);
  const entries = portalStepData(step, actions, data.sourceNames, i18n);
  const title = step.confer ? conferTitle(i18n, step.confer) : step.label;
  const hasChecks =
    !!step.confer ||
    !!step.approval ||
    !!step.noAnswer ||
    !!step.urgent ||
    !!step.route ||
    !!step.carriedOn ||
    (step.oversight?.length ?? 0) > 0;
  return (
    <StepSheet
      testId="portal-run-step-panel"
      title={title}
      eyebrow={
        <span className="flex flex-wrap items-center gap-2">
          <StatusChip state={stepChipState(step.status)} testId="portal-run-step-panel-status">
            {stepStatusLabel(step.status, i18n)}
          </StatusChip>
          <span className="eyebrow text-ink-muted">
            {t("stepPanel.eyebrow", { n: index, count })}
          </span>
        </span>
      }
      onClose={onClose}
      dataCount={entries.length}
      data={
        entries.length > 0 ? (
          <StepDataList entries={entries} testId="portal-run-step-data" />
        ) : undefined
      }
      step={
        <>
          <div className="flex flex-col gap-2">
            <p className="text-ink" data-testid="portal-run-step-panel-summary">
              {step.confer
                ? t("run.confer.on", { step: step.label })
                : (step.summary ?? stepStatusLabel(step.status, i18n))}
            </p>
            {step.write ? (
              <p className="text-sm text-ink-muted">{writeLine(t, step.write, step.status)}</p>
            ) : null}
            {step.ai ? (
              <p
                className="flex flex-wrap items-center gap-2 text-sm text-ink-muted"
                data-testid="portal-run-step-panel-ai"
              >
                <Tag>{t("stepPanel.ai")}</Tag>
                {t("stepPanel.aiHint")}
              </p>
            ) : null}
          </div>
          <StepFacts
            testId="portal-run-step-panel-facts"
            facts={[
              [t("stepPanel.status"), stepStatusLabel(step.status, i18n)],
              [t("stepPanel.started"), time(step.startedAt) ?? t("stepPanel.notYet")],
              [t("stepPanel.finished"), time(step.finishedAt)],
              [
                t("stepPanel.took"),
                step.startedAt && step.finishedAt
                  ? duration(step.startedAt, step.finishedAt, undefined, i18n)
                  : null,
              ],
              [
                t("stepPanel.tries"),
                step.attempts && step.attempts > 1
                  ? t("stepPanel.triesValue", { count: step.attempts })
                  : null,
              ],
            ]}
          />
          {hasChecks ? (
            <SheetSection label={t("stepPanel.checks")}>
              <StepChecks checks={step} testId="portal-run-step-panel-checks" />
              {step.oversight && step.oversight.length > 0 ? (
                <ul className="text-sm text-ink-muted">
                  {step.oversight.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              ) : null}
            </SheetSection>
          ) : null}
          {step.confer ? null : (
            <>
              <DataBlock
                label={t("stepPanel.input")}
                value={clientStepData(step.input)}
                testId="portal-run-step-panel-input"
              />
              <DataBlock
                label={t("stepPanel.output")}
                value={clientStepData(step.output)}
                testId="portal-run-step-panel-output"
              />
            </>
          )}
          {actions.length > 0 ? (
            <SheetSection label={t("stepPanel.changes")}>
              <div className="flex flex-col gap-4" data-testid="portal-run-step-panel-changes">
                {actions.map((a) => {
                  const heading = changeHeading(a.display, a.tool, a.before, a.input, locale);
                  return (
                    <div key={a.id} className="ui-stepdata__item flex flex-col gap-3">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-medium text-ink">{heading.title}</p>
                          {heading.description ? (
                            <p className="text-sm text-ink-muted">{heading.description}</p>
                          ) : null}
                        </div>
                        <ActionBadge action={a} />
                      </div>
                      <ChangeTables
                        before={clientStepData(a.before) ?? null}
                        input={clientStepData(a.input) ?? null}
                        display={a.display?.tool ?? null}
                      />
                      {a.executedAt ? (
                        <p className="text-sm text-ink-muted figures">{time(a.executedAt)}</p>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </SheetSection>
          ) : null}
          {/* v0.17 (§10.15): tell the agent's owner what was wrong, in the chat. */}
          <div>
            <Button
              size="sm"
              data-testid="portal-run-step-panel-tell"
              onClick={() => panel.open(t("stepPanel.tellPrompt", { step: step.label }))}
            >
              {t("stepPanel.tell")}
            </Button>
          </div>
        </>
      }
    />
  );
}
