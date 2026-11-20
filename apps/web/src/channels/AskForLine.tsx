// An agent's own phone number (docs/plan.md §1.160, owner 2026-11-20): the client admin asks for
// one, at the line price a month; we buy it in the client's Twilio account and make it the
// agent's own line from the back office. The ask is an ordinary request about the agent ("An idea
// or a change", `POST /api/requests`), in the reader's language, so it lands in our requests
// queue and its answer comes back on the request. Nothing is bought or billed until we set it up.
import type { ChannelLine, Money } from "@countersign/core";
import { useState } from "react";
import { Link } from "react-router-dom";
import { apiRoutes } from "../api/routes";
import { useApiClient } from "../api/useApi";
import { localAmount } from "../billing/parts";
import { useI18n } from "../i18n/i18n";
import { PORTAL_PATHS } from "../portal/paths";
import { ErrorNotice } from "../ui/ErrorState";
import { Button } from "../ui/primitives";

/** The agent has a number of its own (texts or calls), not only the account's. */
export function hasOwnNumber(lines: readonly ChannelLine[]): boolean {
  return lines.some((l) => l.kind !== "email" && l.source === "agent");
}

export function AskForLine({
  agentId,
  name,
  price,
  testId,
}: {
  agentId: string;
  name: string;
  price: Money;
  testId: string;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const api = useApiClient();
  const [step, setStep] = useState<"idle" | "confirm" | "asked">("idle");
  const [requestId, setRequestId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const amount = localAmount(price, i18n);

  const ask = async () => {
    setBusy(true);
    setError(null);
    try {
      const { item } = await api.call(apiRoutes.portalRaiseRequest, {
        body: {
          kind: "idea",
          serviceId: agentId,
          subject: t("line.subject", { name }),
          text: t("line.text", { name, price: amount }),
        },
      });
      setRequestId(item.id);
      setStep("asked");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 px-6 py-3 max-sm:px-4" data-testid={testId}>
      {step === "asked" ? (
        <p className="text-sm text-ink" data-testid={`${testId}-asked`}>
          {t("line.asked")}{" "}
          {requestId ? (
            <Link to={PORTAL_PATHS.request(requestId)} className="text-link hover:underline">
              {t("line.seeRequest")}
            </Link>
          ) : null}
        </p>
      ) : step === "confirm" ? (
        <>
          <p className="text-sm text-ink" data-testid={`${testId}-confirm`}>
            {t("line.confirm", { name, price: amount })}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              size="sm"
              working={busy}
              onClick={() => void ask()}
              data-testid={`${testId}-send`}
            >
              {t("line.confirmButton")}
            </Button>
            <Button size="sm" disabled={busy} onClick={() => setStep("idle")}>
              {t("common.cancel")}
            </Button>
          </div>
          {error ? <ErrorNotice error={error} /> : null}
        </>
      ) : (
        <>
          <p className="text-sm text-ink-muted">{t("line.help", { name, price: amount })}</p>
          <div>
            <Button size="sm" onClick={() => setStep("confirm")} data-testid={`${testId}-start`}>
              {t("line.ask")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
