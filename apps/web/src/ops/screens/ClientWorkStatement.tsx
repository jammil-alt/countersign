// docs/plan.md §1.234 (Y5): a client's work statement in the back office, under its Billing: the
// same answer, counted by the same query, as the client's page, its PDF and the PDF emailed with
// the invoice. Its own chunk (loaded when Billing opens), with its route's schema.
import { workStatementRoutes } from "@countersign/core";
import { useState } from "react";
import { useApi } from "../../api/useApi";
import { WorkMonthForm, WorkStatementView } from "../../billing/WorkStatementView";
import { Loaded } from "../../ui/page";
import { SkeletonRows } from "../../ui/skeleton";

export function ClientWorkStatement({ clientId }: { clientId: string }) {
  const [month, setMonth] = useState<string | null>(null);
  const state = useApi(workStatementRoutes.opsWorkStatement, {
    params: { id: clientId },
    query: month ? { month } : {},
  });
  const base = `/api/ops/billing/clients/${clientId}/work.pdf`;
  return (
    <div className="flex flex-col gap-4" data-testid="ops-work-statement">
      <WorkMonthForm month={month} onChange={setMonth} />
      <Loaded state={state} skeleton={<SkeletonRows rows={4} columns={6} />}>
        {(statement) => (
          <WorkStatementView
            statement={statement}
            pdfHref={month ? `${base}?month=${encodeURIComponent(month)}` : base}
          />
        )}
      </Loaded>
    </div>
  );
}
