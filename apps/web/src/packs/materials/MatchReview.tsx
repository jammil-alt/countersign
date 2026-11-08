// The match review card (ARCHITECTURE §12.2 "Match review in the Inbox"): the invoice lines the
// matching skill wasn't sure of, each with the catalog items it weighed. Match (to one of them), New item or
// Skip, line by line; a Match or New item is a person's decision and teaches the catalog the
// vendor's name for it. Finish sends the review back to the waiting run.
//
// The client's Desk and the back office's Escalations both show it; its words come from the
// message catalog (`materials.review.*`), in English outside the portal. Invoice lines and catalog
// item names are data and show as written.
import { useState } from "react";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { type I18n, useI18n } from "../../i18n/i18n";
import type { ResolveInput } from "../../inbox/InboxCard";
import { Badge, Button, ErrorNotice, Loading } from "../../ui/primitives";
import type { MatchReviewData, ReviewLine } from "./types";

type Action = "match" | "new_item" | "skip";

/** A line's state; an undecided one waits on whoever can decide it (the portal's status words). */
function decisionWord(
  line: ReviewLine,
  skipped: boolean,
  canDecide: boolean,
  { t }: Pick<I18n, "t">,
): { label: string; tone: "person" | "neutral" | "warning" } {
  if (line.method === "human" && line.decision === "matched")
    return { label: t("materials.review.matched"), tone: "person" };
  if (line.method === "human" && line.decision === "new_item")
    return { label: t("materials.review.newItem"), tone: "person" };
  if (skipped) return { label: t("materials.review.skipped"), tone: "neutral" };
  return { label: t(canDecide ? "common.waitingOnYou" : "common.waiting"), tone: "warning" };
}

export function MatchReview({
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
  const i18n = useI18n();
  const { t, fmt, intl } = i18n;
  const client = useApiClient();
  const route = surface === "ops" ? apiRoutes.opsPackReview : apiRoutes.portalPackReview;
  const decideRoute =
    surface === "ops" ? apiRoutes.opsPackReviewDecide : apiRoutes.portalPackReviewDecide;
  const { data, error, loading, reload } = useApi(route, { params: { id: itemId } });
  const [view, setView] = useState<MatchReviewData | null>(null);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<unknown>(null);

  if (loading && !data) return <Loading label={t("materials.review.loading")} />;
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!data) return null;
  const review = view ?? (data.data as unknown as MatchReviewData);
  const canDecide = data.canDecide && open;
  const done = (l: ReviewLine) => l.method === "human" || skipped.has(l.docLineId);
  const remaining = review.lines.filter((l) => !done(l)).length;
  const sure = new Intl.NumberFormat(intl, { style: "percent", maximumFractionDigits: 0 });

  async function decide(line: ReviewLine, action: Action) {
    setBusy(line.docLineId);
    setProblem(null);
    try {
      const catalogItemId = choice[line.docLineId] ?? line.candidates[0]?.catalogItemId;
      const res = await client.call(decideRoute, {
        params: { id: itemId },
        body: {
          docLineId: line.docLineId,
          action,
          ...(action === "match" && catalogItemId ? { catalogItemId } : {}),
        },
      });
      setView(res.data as unknown as MatchReviewData);
      setSkipped((s) => {
        const next = new Set(s);
        if (action === "skip") next.add(line.docLineId);
        else next.delete(line.docLineId);
        return next;
      });
    } catch (e) {
      setProblem(e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-3" data-testid="match-review">
      <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
        {review.lines.map((line) => {
          const word = decisionWord(line, skipped.has(line.docLineId), canDecide, i18n);
          const options = line.candidates.filter((c) => !c.vetoed);
          return (
            <li
              key={line.docLineId}
              className="flex flex-col gap-2 p-4"
              data-testid="match-review-line"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium text-ink">{line.description}</p>
                  <p className="text-sm text-ink-muted tabular-nums">
                    {t("materials.review.line", {
                      // The line's own unit, as the invoice printed it.
                      qty: [fmt.figure(line.qty), line.uom].filter(Boolean).join(" "),
                      price: fmt.unitPrice(line.unitPrice),
                    })}
                    {line.vendorSku ? (
                      <span className="ml-2 reference">{line.vendorSku}</span>
                    ) : null}
                  </p>
                  {line.method === "human" && line.catalogItemName ? (
                    <p className="text-sm text-ink">
                      {t("materials.review.now", { item: line.catalogItemName })}
                    </p>
                  ) : null}
                </div>
                <Badge tone={word.tone} testId="match-review-state">
                  {word.label}
                </Badge>
              </div>
              {canDecide && line.method !== "human" ? (
                <div className="flex flex-wrap items-center gap-2">
                  {options.length > 0 ? (
                    <select
                      className="ds-select min-w-64 flex-1"
                      aria-label={t("materials.review.pick", { line: line.description })}
                      data-testid="match-review-candidate"
                      value={choice[line.docLineId] ?? options[0]?.catalogItemId}
                      onChange={(e) =>
                        setChoice((c) => ({ ...c, [line.docLineId]: e.target.value }))
                      }
                    >
                      {options.map((c) => (
                        <option key={c.catalogItemId} value={c.catalogItemId}>
                          {t("materials.review.candidate", {
                            name: c.name,
                            sure: sure.format(c.confidence),
                          })}
                        </option>
                      ))}
                    </select>
                  ) : null}
                  {options.length > 0 ? (
                    <Button
                      size="sm"
                      variant="primary"
                      data-testid="match-review-match"
                      disabled={busy !== null}
                      onClick={() => void decide(line, "match")}
                    >
                      {t("materials.review.match")}
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    data-testid="match-review-new"
                    disabled={busy !== null}
                    onClick={() => void decide(line, "new_item")}
                  >
                    {t("materials.review.newItem")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    data-testid="match-review-skip"
                    disabled={busy !== null || skipped.has(line.docLineId)}
                    onClick={() => void decide(line, "skip")}
                  >
                    {t("materials.review.skip")}
                  </Button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {problem ? <ErrorNotice error={problem} /> : null}
      {canDecide && onResolve ? (
        <div className="flex items-center justify-end gap-3">
          <span className="text-sm text-ink-muted">
            {remaining === 0
              ? t("materials.review.allDecided")
              : t("materials.review.left", { left: remaining, count: review.lines.length })}
          </span>
          <Button
            variant="primary"
            data-testid="match-review-finish"
            disabled={remaining > 0 || busy !== null}
            onClick={() =>
              void onResolve({
                decision: "approve",
                answer: { reviewed: review.lines.length, skipped: [...skipped] },
              })
            }
          >
            {t("materials.review.finish")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
