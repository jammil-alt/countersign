// Inbox cards that packs add (ARCHITECTURE §11, §12.2): an inbox item whose payload names a
// `review` gets that pack's card in place of the plain question. The inbox itself names no pack.
import type { ReactNode } from "react";
import type { ResolveInput } from "../inbox/InboxCard";
import { MatchReview } from "./materials/MatchReview";
// P-9: the Purchasing area's cards (docs/plan.md §1.71)
import { RequestLinesReview } from "./materials/RequestLinesReview";
import { MATCH_REVIEW, REQUEST_LINES_REVIEW, VENDOR_CHOICE_REVIEW } from "./materials/types";
import { VendorChoiceReview } from "./materials/VendorChoiceReview";

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
};

/** The pack card for an item's payload, or null for a plain item. */
export function packReviewCard(payload: Record<string, unknown>) {
  const key = typeof payload.review === "string" ? payload.review : null;
  return key ? (CARDS[key] ?? null) : null;
}
