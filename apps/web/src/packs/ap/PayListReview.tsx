// The approve-to-pay card (Plan entry §1.233), the AP pack's `ap.pay_list`: the week's list on the
// client's Desk and in the back office's Escalations. A person decides each bill (or the ready ones
// together); "Done for this week" sends the card back to the waiting run. Nothing is paid here.
// Loaded with the card, never in the first load (scripts/web-size.mjs).
import { useState } from "react";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { useI18n } from "../../i18n/i18n";
import type { ResolveInput } from "../../inbox/InboxCard";
import { Button, ErrorNotice, Loading } from "../../ui/primitives";
import { PayListView } from "./PayList";
import type { Account, PayList, PayListDecision } from "./types";

interface CardData {
  list: PayList;
  accounts: Account[];
}

export function PayListReview({
  itemId,
  surface,
  open,
  onResolve,
}: {
  itemId: string;
  surface: "portal" | "ops";
  open: boolean;
  /** Null when this person can't resolve the item. */
  onResolve: ((body: ResolveInput) => Promise<void>) | null;
}) {
  const { t } = useI18n();
  const client = useApiClient();
  const route = surface === "ops" ? apiRoutes.opsPackReview : apiRoutes.portalPackReview;
  const decideRoute =
    surface === "ops" ? apiRoutes.opsPackReviewDecide : apiRoutes.portalPackReviewDecide;
  const { data, error, loading, reload } = useApi(route, { params: { id: itemId } });
  const [view, setView] = useState<CardData | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);

  if (loading && !data) return <Loading label={t("ap.list.loading")} />;
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!data) return null;
  const card = view ?? (data.data as unknown as CardData);
  const canDecide = data.canDecide && open;

  async function decide(body: PayListDecision) {
    setBusy(true);
    setProblem(null);
    try {
      const res = await client.call(decideRoute, { params: { id: itemId }, body });
      setView(res.data as unknown as CardData);
      return true;
    } catch (e) {
      setProblem(e);
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4" data-testid="ap-pay-list-review">
      <PayListView
        list={card.list}
        accounts={card.accounts}
        onDecide={canDecide ? decide : undefined}
        busy={busy}
      />
      {problem ? <ErrorNotice error={problem} /> : null}
      {canDecide && onResolve ? (
        <div className="flex justify-end">
          <Button
            variant="primary"
            disabled={busy}
            data-testid="ap-done"
            onClick={() => void onResolve({ decision: "approve" })}
          >
            {t("ap.list.done")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
