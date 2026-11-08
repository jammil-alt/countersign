// B-6 (docs/plan.md §1.79): the account questions card. "What do you use this account for?" for the
// accounts nobody has described yet, each with what was booked there before; each answer is the
// client's own note on the account, which the Bookkeeper reads first from then on.
import { useState } from "react";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { useI18n } from "../../i18n/i18n";
import type { ResolveInput } from "../../inbox/InboxCard";
import { Badge, Button, ErrorNotice, Loading } from "../../ui/primitives";
import type { AccountQuestionsData } from "./types";

export function AccountQuestions({
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
  const [view, setView] = useState<AccountQuestionsData | null>(null);
  const [answer, setAnswer] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<unknown>(null);

  if (loading && !data) return <Loading label={t("bookkeeping.questions.loading")} />;
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!data) return null;
  const review = view ?? (data.data as unknown as AccountQuestionsData);
  const canDecide = data.canDecide && open;

  async function save(id: string) {
    setBusy(id);
    setProblem(null);
    try {
      const res = await client.call(decideRoute, {
        params: { id: itemId },
        body: {
          action: "answer",
          input: { ledgerAccountId: id, answer: answer[id]?.trim() ?? "" },
        },
      });
      setView(res.data as unknown as AccountQuestionsData);
      setAnswer((c) => ({ ...c, [id]: "" }));
    } catch (e) {
      setProblem(e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-3" data-testid="account-questions">
      <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
        {review.accounts.map((a) => {
          const answered = a.notes.find((n) => n.source === "client");
          return (
            <li
              key={a.id}
              className="flex flex-col gap-2 p-4"
              data-testid="account-questions-account"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium text-ink">
                    {t("bookkeeping.questions.ask", {
                      account: [a.number, a.fullName].filter(Boolean).join(" "),
                    })}
                  </p>
                  {a.examples.length > 0 ? (
                    <p className="text-sm text-ink-muted">
                      {t("bookkeeping.questions.examples", {
                        payees: a.examples.map((e) => e.payee).join(", "),
                      })}
                    </p>
                  ) : null}
                  {answered ? <p className="text-sm text-ink">{answered.note}</p> : null}
                </div>
                {answered ? (
                  <Badge tone="person">{t("bookkeeping.questions.answered")}</Badge>
                ) : canDecide ? (
                  <Badge tone="warning">{t("common.waitingOnYou")}</Badge>
                ) : null}
              </div>
              {canDecide && !answered ? (
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    className="ds-input min-w-64 flex-1"
                    aria-label={t("bookkeeping.questions.ask", { account: a.fullName })}
                    data-testid="account-questions-answer"
                    maxLength={500}
                    value={answer[a.id] ?? ""}
                    onChange={(e) => setAnswer((c) => ({ ...c, [a.id]: e.target.value }))}
                  />
                  <Button
                    size="sm"
                    variant="primary"
                    data-testid="account-questions-save"
                    disabled={busy !== null || !answer[a.id]?.trim()}
                    onClick={() => void save(a.id)}
                  >
                    {t("bookkeeping.questions.save")}
                  </Button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {problem ? <ErrorNotice error={problem} /> : null}
      {canDecide && onResolve ? (
        <div className="flex justify-end">
          <Button
            variant="primary"
            data-testid="account-questions-finish"
            disabled={busy !== null}
            onClick={() => void onResolve({ decision: "approve" })}
          >
            {t("bookkeeping.questions.done")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
