// Parts the back office's business pages share (docs/ui-plan.md, "Pages the prototype doesn't
// show": usage, billing, feedback, audit, website logins, requests), drafted in the prototype's
// back-office style (`#O1-Command`, `#O9-Runs`): a table in a card with its title and meta, and the
// Usage | Billing tabs under the sidebar's one "Usage and billing" item.
import { type Money, sumMoney } from "@countersign/core";
import type { ReactNode } from "react";
import { price } from "../../billing/parts";
import { Card, Tabs } from "../../ui/primitives";
import { OPS_PATHS } from "../paths";

/** "All agents": a card with a head row and an analytical table under it, scrolling sideways. */
export function TableCard({
  title,
  meta,
  footer,
  children,
  testId,
}: {
  title: ReactNode;
  meta?: ReactNode;
  footer?: ReactNode;
  /** The `<table>`. */
  children: ReactNode;
  testId?: string;
}) {
  return (
    <Card
      titleAbove
      title={title}
      meta={meta}
      footer={footer}
      {...(testId ? { testId } : {})}
      className="overflow-hidden"
    >
      <div className="dt dt-ana overflow-x-auto rounded-none border-0">{children}</div>
    </Card>
  );
}

/** The sidebar's "Usage and billing" is two pages; these tabs move between them. */
export function BusinessTabs() {
  return (
    <Tabs
      items={[
        { to: OPS_PATHS.usage, label: "Usage", end: true },
        { to: OPS_PATHS.billing, label: "Billing", end: true },
      ]}
    />
  );
}

/**
 * Money added up per currency, never as floats (invariant 6): "$1,240.00", or
 * "$1,240.00 + 80.00 EUR" when clients bill in more than one.
 */
export function moneyTotal(items: readonly Money[], empty = "$0.00"): string {
  const byCurrency = new Map<string, Money[]>();
  for (const m of items) byCurrency.set(m.currency, [...(byCurrency.get(m.currency) ?? []), m]);
  if (byCurrency.size === 0) return empty;
  return [...byCurrency].map(([currency, list]) => price(sumMoney(list, currency))).join(" + ");
}
