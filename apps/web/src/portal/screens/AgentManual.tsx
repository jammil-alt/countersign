// The agent page's Manual tab (docs/builder-plan.md §5, B3): the agent's manual as the client reads
// it, from the portal's own route (a view made by code: never the bundle, instructions, prompts or
// cost, invariant 11). Read only. "Ask about this" on any line opens Sloan with the line quoted.
// What it learned is the client admin's to read; a client user sees that it is theirs.
// B5 (docs/builder-plan.md §7): "This is wrong" on any line opens a short form under it; "because…"
// files a request to us linked to the line (a decision by its id). A change someone of the client
// made on the agent's settings reads "Changed by Ada on …"; one of ours "Changed by us".
// DECISION: "Ask about this" opens Sloan, the client's account agent, which reaches the area
// owner of the agent's area when it needs to; a manual line is not tied to one area owner's chat.

import { adjustRoutes, manualRoutes } from "@countersign/core";
import { useState } from "react";
import { useApi, useApiClient } from "../../api/useApi";
import { useI18n } from "../../i18n/i18n";
import { type ManualLine, ManualSections, type ManualText } from "../../manual/ManualSections";
import { TextArea } from "../../ui/forms";
import { Loaded } from "../../ui/page";
import { Button, ErrorNotice } from "../../ui/primitives";
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
    changedBy: (who, date) => {
      const when = date ? fmt.date(date) : "";
      return who
        ? t("manual.changedBy", { who, date: when })
        : t("manual.changedByUs", { date: when });
    },
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
            feedback={{
              label: t("manual.wrong"),
              render: (line, close) => <WrongForm agentId={id} line={line} onClose={close} />,
            }}
          />
        )}
      </Loaded>
    </div>
  );
}

/** "This is wrong because…": the person's words, sent to us as a request linked to the line. */
function WrongForm({
  agentId,
  line,
  onClose,
}: {
  agentId: string;
  line: ManualLine;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const api = useApiClient();
  const [because, setBecause] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [sent, setSent] = useState<number | null>(null);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const out = await api.call(adjustRoutes.portalManualFeedback, {
        params: { id: agentId },
        body: {
          section: line.section,
          ...(line.lineId ? { lineId: line.lineId } : {}),
          line: line.line.slice(0, 1000),
          because: because.trim(),
        },
      });
      setSent(out.request.number);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  if (sent !== null) {
    return (
      <p className="mt-2 text-sm text-ink" role="status" data-testid="manual-wrong-sent">
        {t("manual.wrongSent", { number: String(sent) })}
      </p>
    );
  }
  return (
    <div className="mt-2 flex flex-col gap-2" data-testid="manual-wrong-form">
      <TextArea
        aria-label={t("manual.wrongBecause")}
        placeholder={t("manual.wrongBecause")}
        rows={3}
        maxLength={2000}
        value={because}
        data-testid="manual-wrong-input"
        onChange={(e) => setBecause(e.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          size="sm"
          disabled={busy || !because.trim()}
          data-testid="manual-wrong-send"
          onClick={() => void send()}
        >
          {t("manual.wrongSend")}
        </Button>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t("common.cancel")}
        </Button>
      </div>
      {error ? <ErrorNotice error={error} /> : null}
    </div>
  );
}
