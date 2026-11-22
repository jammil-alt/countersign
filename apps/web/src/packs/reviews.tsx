// Inbox cards that packs add (ARCHITECTURE §11, §12.2): an inbox item whose payload names a
// `review` gets that pack's card in place of the plain question. The inbox itself names no pack.
import { lazy, type ReactNode, Suspense } from "react";
import type { ResolveInput } from "../inbox/InboxCard";
import { AccountQuestions } from "./bookkeeping/AccountQuestions";
import { BookingsReview } from "./bookkeeping/BookingsReview";
import { ReconciliationReview } from "./bookkeeping/ReconciliationReview";
import { ACCOUNT_QUESTIONS, BOOKINGS_REVIEW, RECONCILIATION_REVIEW } from "./bookkeeping/types";
import { MatchReview } from "./materials/MatchReview";
// P-9: the Purchasing area's cards (docs/plan.md §1.71)
import { RequestLinesReview } from "./materials/RequestLinesReview";
import { MATCH_REVIEW, REQUEST_LINES_REVIEW, VENDOR_CHOICE_REVIEW } from "./materials/types";
import { VendorChoiceReview } from "./materials/VendorChoiceReview";
import { SALES_MATCH_REVIEW } from "./sales/types";

// Plan entry §1.233: the AP pack's approve-to-pay card loads with the card.
const AP_PAY_LIST_REVIEW = "ap.pay_list";
const PayListReview = lazy(() =>
  import("./ap/PayListReview").then((m) => ({ default: m.PayListReview })),
);

// §1.164: the Sales area's card loads with the card, never in the first load (the web budget,
// scripts/web-size.mjs).
const ConfirmMatches = lazy(() =>
  import("./sales/ConfirmMatches").then((m) => ({ default: m.ConfirmMatches })),
);

interface ReviewCardProps {
  itemId: string;
  surface: "portal" | "ops";
  open: boolean;
  onResolve: ((body: ResolveInput) => Promise<void>) | null;
}

const CARDS: Record<string, (props: ReviewCardProps) => ReactNode> = {
  [MATCH_REVIEW]: (p) => <MatchReview {...p} />,
  // P-9
  [REQUEST_LINES_REVIEW]: (p) => <RequestLinesReview {...p} />,
  [VENDOR_CHOICE_REVIEW]: (p) => <VendorChoiceReview {...p} />,
  // B-6 (docs/plan.md §1.79): the Bookkeeping area's cards.
  [BOOKINGS_REVIEW]: (p) => <BookingsReview {...p} />,
  [ACCOUNT_QUESTIONS]: (p) => <AccountQuestions {...p} />,
  // R-1 (docs/plan.md §1.80): the reconciliation card.
  [RECONCILIATION_REVIEW]: (p) => <ReconciliationReview {...p} />,
  // §1.164: Confirm matches (the Sales area).
  // Plan entry §1.233: the week's approve-to-pay list (the AP pack).
  [AP_PAY_LIST_REVIEW]: (p) => (
    <Suspense fallback={null}>
      <PayListReview {...p} />
    </Suspense>
  ),
  [SALES_MATCH_REVIEW]: (p) => (
    <Suspense fallback={null}>
      <ConfirmMatches {...p} />
    </Suspense>
  ),
};

/** The pack card for an item's payload, or null for a plain item. */
export function packReviewCard(payload: Record<string, unknown>) {
  const key = typeof payload.review === "string" ? payload.review : null;
  return key ? (CARDS[key] ?? null) : null;
}
