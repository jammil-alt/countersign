// P-9: the request line review card (docs/plan.md §1.71): a purchase request's lines the rules
// weren't sure of, or that say no quantity, each with its candidates and the client's catalog. A
// person picks the item and sets how many, line by line (their decision, recorded on the request);
// Done sends the review back to the waiting run. Line words and item names are data.
import { useState } from "react";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { useI18n } from "../../i18n/i18n";
import type { ResolveInput } from "../../inbox/InboxCard";
import { Badge, Button, ErrorNotice, Loading } from "../../ui/primitives";
import type { RequestLinesData } from "./types";

type Line = RequestLinesData["lines"][number];

export function RequestLinesReview({
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
  const { t, fmt } = useI18n();
  const client = useApiClient();
  const route = surface === "ops" ? apiRoutes.opsPackReview : apiRoutes.portalPackReview;
  const decideRoute =
    surface === "ops" ? apiRoutes.opsPackReviewDecide : apiRoutes.portalPackReviewDecide;
  const { data, error, loading, reload } = useApi(route, { params: { id: itemId } });
  const [view, setView] = useState<RequestLinesData | null>(null);
  const [item, setItem] = useState<Record<string, string>>({});
  const [qty, setQty] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<unknown>(null);

  if (loading && !data) return <Loading label={t("materials.lineReview.loading")} />;
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!data) return null;
  const review = view ?? (data.data as unknown as RequestLinesData);
  const canDecide = data.canDecide && open;
  const left = review.lines.filter((l) => !l.settled).length;

  async function save(line: Line) {
    setBusy(line.id);
    setProblem(null);
    try {
      const catalogItemId =
        item[line.id] ?? (line.catalogItemId ? undefined : line.candidates[0]?.catalogItemId);
      const howMany = qty[line.id]?.trim();
      const res = await client.call(decideRoute, {
        params: { id: itemId },
        body: {
          action: "line",
          input: {
            lineId: line.id,
            ...(catalogItemId ? { catalogItemId } : {}),
            ...(howMany ? { qty: howMany } : {}),
          },
        },
      });
      setView(res.data as unknown as RequestLinesData);
    } catch (e) {
      setProblem(e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-3" data-testid="request-lines-review">
      <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
        {review.lines.map((line) => (
          <li key={line.id} className="flex flex-col gap-2 p-4" data-testid="request-lines-line">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-medium text-ink">{line.description}</p>
                <p className="text-sm text-ink-muted">
                  {[
                    line.qty === null
                      ? t("materials.request.howMany")
                      : [fmt.figure(line.qty), line.unit].filter(Boolean).join(" "),
                    line.catalogItemName ?? t("materials.request.unmatched"),
                  ].join(" · ")}
                </p>
              </div>
              <Badge
                tone={
                  line.settled ? (line.matchMethod === "chosen" ? "person" : "positive") : "warning"
                }
                testId="request-lines-state"
              >
                {line.settled
                  ? t("materials.lineReview.settled")
                  : t(canDecide ? "common.waitingOnYou" : "common.waiting")}
              </Badge>
            </div>
            {canDecide && !line.settled ? (
              <div className="flex flex-wrap items-center gap-2">
                {line.catalogItemId === null ? (
                  <select
                    className="ds-select min-w-64 flex-1"
                    aria-label={t("materials.lineReview.pick", { line: line.description })}
                    data-testid="request-lines-item"
                    value={item[line.id] ?? line.candidates[0]?.catalogItemId ?? ""}
                    onChange={(e) => setItem((c) => ({ ...c, [line.id]: e.target.value }))}
                  >
                    {line.candidates.length === 0 ? (
                      <option value="">{t("materials.lineReview.choose")}</option>
                    ) : null}
                    {[
                      ...line.candidates.map((c) => ({ id: c.catalogItemId, name: c.name })),
                      ...review.catalog.filter(
                        (c) => !line.candidates.some((x) => x.catalogItemId === c.id),
                      ),
                    ].map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                ) : null}
                {line.qty === null ? (
                  <input
                    className="ds-input w-28"
                    inputMode="decimal"
                    aria-label={t("materials.lineReview.qty", { line: line.description })}
                    data-testid="request-lines-qty"
                    value={qty[line.id] ?? ""}
                    onChange={(e) => setQty((c) => ({ ...c, [line.id]: e.target.value }))}
                  />
                ) : null}
                <Button
                  size="sm"
                  variant="primary"
                  data-testid="request-lines-save"
                  disabled={busy !== null}
                  onClick={() => void save(line)}
                >
                  {t("materials.lineReview.save")}
                </Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {problem ? <ErrorNotice error={problem} /> : null}
      {canDecide && onResolve ? (
        <div className="flex items-center justify-end gap-3">
          <span className="text-sm text-ink-muted">
            {left === 0
              ? t("materials.lineReview.allSettled")
              : t("materials.lineReview.left", { left, count: review.lines.length })}
          </span>
          <Button
            variant="primary"
            data-testid="request-lines-finish"
            disabled={left > 0 || busy !== null}
            onClick={() =>
              void onResolve({ decision: "approve", answer: { settled: review.lines.length } })
            }
          >
            {t("materials.lineReview.finish")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
