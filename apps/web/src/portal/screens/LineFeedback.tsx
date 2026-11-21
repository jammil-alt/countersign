// "This is wrong because…" on a line of the agent's SOP (docs/sop-plan.md S1; the manual's form,
// docs/builder-plan.md §7 B5): the person's words, sent to us as a request linked to the line (a
// step or a decision by its id). Anyone of the client's team may send one.

import { adjustRoutes } from "@countersign/core";
import { useState } from "react";
import { useApiClient } from "../../api/useApi";
import { useI18n } from "../../i18n/i18n";
import type { ManualLine } from "../../manual/ManualSections";
import { TextArea } from "../../ui/forms";
import { Button, ErrorNotice } from "../../ui/primitives";

/** "This is wrong because…": the person's words, sent to us as a request linked to the line. */
export function WrongForm({
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
