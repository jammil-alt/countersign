// P-9: the vendor choice card (docs/plan.md §1.71): the quotes for a purchase request compared as
// a table (in code, one unit, one currency), the suggestion and its reasons, and a person picks one
// vendor or the suggested split. The choice is the person's and is kept on the request; Done sends
// it back to the waiting run, whose purchase order steps read it.
import { useState } from "react";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { useI18n } from "../../i18n/i18n";
import type { ResolveInput } from "../../inbox/InboxCard";
import { Badge, Button, EmptyState, ErrorNotice, Loading } from "../../ui/primitives";
import { CompareTable } from "./CompareTable";
import type { VendorChoiceData } from "./types";

export function VendorChoiceReview({
  itemId,
  surface,
  open,
  onResolve,
}: {
  itemId: string;
  surface: "portal" | "ops";
  open: boolean;
  onResolve: ((body: ResolveInput) => Promise<void>) | null;
}) {
  const { t } = useI18n();
  const client = useApiClient();
  const route = surface === "ops" ? apiRoutes.opsPackReview : apiRoutes.portalPackReview;
  const decideRoute =
    surface === "ops" ? apiRoutes.opsPackReviewDecide : apiRoutes.portalPackReviewDecide;
  const { data, error, loading, reload } = useApi(route, { params: { id: itemId } });
  const [view, setView] = useState<VendorChoiceData | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);

  if (loading && !data) return <Loading label={t("materials.choice.loading")} />;
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!data) return null;
  const review = view ?? (data.data as unknown as VendorChoiceData);
  const canDecide = data.canDecide && open;
  const { comparison, choice } = review;
  const s = comparison.suggestion;

  async function choose(input: Record<string, unknown>) {
    setBusy(true);
    setProblem(null);
    try {
      const res = await client.call(decideRoute, {
        params: { id: itemId },
        body: { action: "choose", input },
      });
      setView(res.data as unknown as VendorChoiceData);
    } catch (e) {
      setProblem(e);
    } finally {
      setBusy(false);
    }
  }

  if (comparison.vendors.length === 0) {
    return <EmptyState>{t("materials.choice.none")}</EmptyState>;
  }
  return (
    <div className="flex flex-col gap-3" data-testid="vendor-choice">
      <CompareTable comparison={comparison} />
      {s.reasons.length > 0 ? (
        <ul
          className="flex flex-col gap-1 text-sm text-ink-muted"
          data-testid="vendor-choice-reasons"
        >
          {s.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      ) : null}
      <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
        {comparison.vendors.map((v) => {
          const picked = choice?.kind === "single" && choice.quoteRequestId === v.quoteRequestId;
          return (
            <li
              key={v.quoteRequestId}
              className="flex flex-wrap items-center justify-between gap-3 p-3"
              data-testid="vendor-choice-vendor"
            >
              <span className="font-medium text-ink">{v.vendorName}</span>
              <span className="flex flex-wrap items-center gap-2">
                {s.kind === "single" && s.quoteRequestId === v.quoteRequestId ? (
                  <Badge tone="accent">{t("materials.choice.suggested")}</Badge>
                ) : null}
                {!v.complete ? <Badge>{t("materials.choice.incomplete")}</Badge> : null}
                {v.late ? <Badge>{t("materials.choice.late")}</Badge> : null}
                {picked ? <Badge tone="person">{t("materials.choice.picked")}</Badge> : null}
                {canDecide && !picked ? (
                  <Button
                    size="sm"
                    data-testid="vendor-choice-pick"
                    disabled={busy}
                    onClick={() =>
                      void choose({ kind: "single", quoteRequestId: v.quoteRequestId })
                    }
                  >
                    {t("materials.choice.pick", { vendor: v.vendorName })}
                  </Button>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
      {canDecide && s.kind === "split" && choice?.kind !== "split" ? (
        <Button
          data-testid="vendor-choice-split"
          disabled={busy}
          onClick={() =>
            void choose({
              kind: "split",
              split: s.split.map((x) => ({
                quoteRequestId: x.quoteRequestId,
                requestLineIds: x.requestLineIds,
              })),
            })
          }
        >
          {t("materials.choice.pickSplit")}
        </Button>
      ) : null}
      {choice?.kind === "split" ? (
        <Badge tone="person">{t("materials.request.chosenSplit")}</Badge>
      ) : null}
      {problem ? <ErrorNotice error={problem} /> : null}
      {canDecide && onResolve ? (
        <div className="flex justify-end">
          <Button
            variant="primary"
            data-testid="vendor-choice-finish"
            disabled={!choice || busy}
            onClick={() =>
              void onResolve({
                decision: "approve",
                answer: choice
                  ? {
                      kind: choice.kind,
                      quoteRequestId: choice.quoteRequestId,
                      split: choice.split,
                    }
                  : {},
              })
            }
          >
            {t("materials.choice.finish")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
