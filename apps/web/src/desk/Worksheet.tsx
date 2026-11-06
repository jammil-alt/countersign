// "Worksheet: how Pia got here" under the Desk's open item (docs/design/prototype.html `#C3-Desk`):
// the run's steps as the client timeline shows them (`GET /api/runs/:id`), then the person's own
// step, "Your sign", with why it needs them in the API's words (`payload.whyApproval`).
import { DESK_WORDS, type Locale } from "@countersign/core";
import { apiRoutes } from "../api/routes";
import { useApi } from "../api/useApi";
import { useI18n } from "../i18n/i18n";
import { Card } from "../ui/primitives";
import { type StepItem, StepList, type StepState } from "../ui/steps";
import { type DeskItem, needOf, whyOf } from "./model";

/** Why a change waits for this person, in their language: the gate's reasons, never the agent's. */
export function whyLines(item: Pick<DeskItem, "payload">, locale: Locale): string[] {
  const why = whyOf(item);
  if (!why) return [];
  const words = DESK_WORDS[locale] ?? DESK_WORDS.en;
  const lines = why.reasons.map((r) =>
    r === "stage" ? words.stage[why.stage ?? "trial"] : words.why[r],
  );
  if (why.route?.source === "rule") lines.push(words.byRule);
  return lines;
}

function stepState(status: string): StepState {
  switch (status) {
    case "succeeded":
      return "done";
    case "running":
      return "current";
    case "waiting":
      return "waiting";
    case "failed":
      return "failed";
    default:
      return "todo";
  }
}

export function DeskWorksheet({ item, agent }: { item: DeskItem; agent: string | null }) {
  const i18n = useI18n();
  const { t, fmt } = i18n;
  const run = useApi(apiRoutes.portalRun, item.runId ? { params: { id: item.runId } } : null);
  const why = whyLines(item, i18n.locale);
  const open = item.status === "open";
  // The run's own waiting step is this item; it is shown once, as the person's step below.
  const steps: StepItem[] = (run.data?.steps ?? [])
    .filter((s) => !(open && s.status === "waiting"))
    .map((s) => ({
      key: s.id,
      title: s.label,
      ...(s.summary ? { detail: s.summary } : {}),
      state: stepState(s.status),
      ...(s.finishedAt || s.startedAt ? { time: fmt.time(s.finishedAt ?? s.startedAt) } : {}),
    }));
  if (open && needOf(item) === "sign") {
    steps.push({
      key: "your-sign",
      title: t("desk.worksheet.yourSign"),
      ...(why.length > 0 ? { detail: why.join(" ") } : {}),
      state: "waiting",
    });
  }
  if (steps.length === 0) return null;
  return (
    <Card
      title={t("desk.worksheet.title")}
      meta={
        agent ? <span className="text-sm">{t("desk.worksheet.how", { agent })}</span> : undefined
      }
      pad
      testId="desk-worksheet"
    >
      <StepList steps={steps} />
    </Card>
  );
}
