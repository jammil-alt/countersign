// The agent page's Manual tab (docs/builder-plan.md §5, B3): the agent's manual as the client reads
// it, from the portal's own route (a view made by code: never the bundle, instructions, prompts or
// cost, invariant 11). Read only. "Ask about this" on any line opens Sloan with the line quoted.
// What it learned is the client admin's to read; a client user sees that it is theirs.
// DECISION: "Ask about this" opens Sloan, the client's account agent, which reaches the area
// owner of the agent's area when it needs to; a manual line is not tied to one area owner's chat.

import { manualRoutes } from "@countersign/core";
import { useApi } from "../../api/useApi";
import { useI18n } from "../../i18n/i18n";
import { ManualSections, type ManualText } from "../../manual/ManualSections";
import { Loaded } from "../../ui/page";
import { SkeletonRows } from "../../ui/skeleton";
import { askSloan } from "../paths";

export function AgentManual({ id, isAdmin }: { id: string; isAdmin: boolean }) {
  const { t, fmt } = useI18n();
  const manual = useApi(manualRoutes.portalAgentManual, { params: { id } });
  const text: ManualText = {
    whatItDoes: t("manual.whatItDoes"),
    howItWorks: t("manual.howItWorks"),
    decisions: t("manual.decisions"),
    decisionPoints: t("manual.decisionPoints"),
    knownRisks: t("manual.knownRisks"),
    setup: t("manual.setup"),
    learned: t("manual.learned"),
    reads: t("manual.reads"),
    notWritten: t("manual.notWritten"),
    nothingYet: t("manual.nothingYet"),
    notAnswered: t("manual.notAnswered"),
    highRisk: t("manual.highRisk"),
    learnedHidden: isAdmin ? undefined : t("manual.learnedHidden"),
    ask: t("manual.ask"),
    startsAt: (value) => t("manual.startsAt", { value }),
    onStep: (step) => t("manual.onStep", { step }),
    who: (who) => t("manual.who", { who }),
    byWhen: (when) => t("manual.byWhen", { when }),
    // Our operator's name is never in the portal's view; this is never called with one.
    lookedAtBy: () => "",
    kind: (k) => t(`manual.kind.${k}`),
    status: (s) => t(`manual.status.${s}`),
    date: (iso) => fmt.date(iso),
  };
  return (
    <div data-testid="portal-agent-manual">
      <Loaded state={manual} skeleton={<SkeletonRows rows={6} columns={1} />}>
        {(view) => (
          <ManualSections
            view={view}
            text={text}
            askHref={(line) => askSloan(t("manual.askText", { agent: view.agent.name, line }))}
          />
        )}
      </Loaded>
    </div>
  );
}
