// A build's Requirements request (docs/cases-plan.md §3.2; docs/plan.md §1.125.2): the agent's card
// on the client's intake is the request. The build shows that card's progress ("7 of 12
// answered"), what's still needed to start and who has it, and the client's Start with this or Not
// now. Read from the back office's intake routes; nothing here writes.
import type { OpsIntakeSummary, SectionProgress } from "@countersign/core";
import { agentSectionKey, OPEN_INTAKE_STATUSES } from "@countersign/core";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { Badge, Card } from "../../ui/primitives";

/** The newest intake at the client that asks this template's card (open ones first). */
export function intakeForTemplate(
  intakes: readonly OpsIntakeSummary[],
  templateId: string,
): OpsIntakeSummary | null {
  const asking = intakes.filter((i) => i.covers.templateIds.includes(templateId));
  const open = asking.filter((i) => OPEN_INTAKE_STATUSES.includes(i.status));
  const pick = (list: OpsIntakeSummary[]) =>
    [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  return pick(open) ?? pick(asking);
}

export function RequirementsCard({
  clientId,
  templateId,
}: {
  clientId: string;
  templateId: string;
}) {
  const list = useApi(apiRoutes.opsIntakes, { query: { client: clientId } });
  const found = list.data ? intakeForTemplate(list.data.intakes, templateId) : null;
  const one = useApi(apiRoutes.opsIntake, found ? { params: { id: found.id } } : null);
  if (!list.data || (found && !one.data)) return null;
  if (!found) {
    return (
      <Card pad testId="build-requirements">
        <p className="text-sm text-ink-muted">
          No intake asks for this agent yet. Invite the client from the deal, or add its card to an
          open intake.
        </p>
      </Card>
    );
  }
  const view = one.data;
  if (!view) return null;
  const key = agentSectionKey(templateId);
  const progress: SectionProgress | undefined = view.progress.find((p) => p.sectionKey === key);
  const done = progress ? progress.answered + progress.notSure >= progress.total : false;
  return (
    <Card
      testId="build-requirements"
      title="Requirements request"
      meta={
        progress ? (
          <Badge tone={done ? "positive" : "neutral"} testId="build-requirements-progress">
            {progress.answered} of {progress.total} answered
          </Badge>
        ) : null
      }
    >
      <div className="ui-card__body flex flex-col gap-3 text-sm">
        <p className="text-ink-muted">
          The agent's card on {view.intake.client.name}'s intake ({view.intake.status}).
          {progress?.notSure ? ` ${progress.notSure} marked not sure.` : ""}
          {progress?.decision === "start"
            ? " They chose to start with it."
            : progress?.decision === "not_now"
              ? " They said not now."
              : ""}
        </p>
        {progress && progress.missing.length > 0 ? (
          <div>
            <p className="font-medium text-ink">Still needed to start</p>
            <ul className="mt-1 flex flex-col gap-1" data-testid="build-requirements-missing">
              {progress.missing.map((m) => (
                <li key={m.fieldKey} className="flex flex-wrap items-center gap-2">
                  <span className="text-ink">{m.label}</span>
                  {m.who ? <Badge tone="person">{m.who} has it</Badge> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : progress ? (
          <p className="text-ink" data-testid="build-requirements-ready">
            Everything needed to start is in.
          </p>
        ) : (
          <p className="text-ink-muted">This intake has no card for the agent.</p>
        )}
      </div>
    </Card>
  );
}
