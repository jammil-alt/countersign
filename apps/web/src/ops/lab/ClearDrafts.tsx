// Clearing the lab's Drafts on a test environment (docs/plan.md §1.173; owner, 2026-11-21:
// "remove the agents in progress from staging so that we can test through some of these basic
// agents again … staging only … we should have an archive"). The button shows only where the API
// says this environment allows it (never production) and there is something to clear. One press,
// confirmed in place, stops every build in progress and discards the drafts never published.
// Nothing is deleted: both are listed in the Archive under the board, and a draft restores from its
// own page.
import type { BuildSummary, ClearDraftsPreview } from "@countersign/core";
import { useState } from "react";
import { Link } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { Button, Card } from "../../ui/primitives";
import { errorText, plural, useAction } from "../agents/ui";
import { buildKindLine } from "../builds/BuildsBoard";
import { buildPath } from "../builds/words";

/** "3 builds and 2 drafts", "3 builds", "2 drafts". */
export function clearWords(p: Pick<ClearDraftsPreview, "builds" | "drafts">): string {
  return [
    p.builds > 0 ? plural(p.builds, "build") : null,
    p.drafts > 0 ? plural(p.drafts, "draft") : null,
  ]
    .filter(Boolean)
    .join(" and ");
}

export function ClearDrafts({
  preview,
  onCleared,
}: {
  preview: ClearDraftsPreview | undefined;
  onCleared(): void;
}) {
  const [confirming, setConfirming] = useState(false);
  const action = useAction();
  if (!preview?.allowed || preview.builds + preview.drafts === 0) return null;

  async function clear() {
    const res = await action.call(apiRoutes.opsClearDrafts);
    if (res.ok) {
      setConfirming(false);
      onCleared();
    }
  }

  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-line bg-surface-subtle px-4 py-2.5 text-sm"
      data-testid="lab-clear-drafts"
    >
      {confirming ? (
        <>
          <span className="text-ink" data-testid="lab-clear-drafts-ask">
            Stop and archive {clearWords(preview)}? Nothing is deleted: they move to the Archive
            below.
          </span>
          <Button
            variant="primary"
            size="sm"
            data-testid="lab-clear-drafts-yes"
            disabled={action.busy}
            onClick={() => void clear()}
          >
            {action.busy ? "Clearing…" : "Clear them"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
            Keep them
          </Button>
          {action.error ? (
            <span className="ds-error text-sm">{errorText(action.error)}</span>
          ) : null}
        </>
      ) : (
        <>
          <span className="text-ink-muted">
            This is a test environment. Start again with an empty board:
          </span>
          <Button
            size="sm"
            variant="ghost"
            data-testid="lab-clear-drafts-start"
            onClick={() => setConfirming(true)}
          >
            Clear all drafts
          </Button>
        </>
      )}
    </div>
  );
}

/** The Archive's stopped builds: each opens its build page, with its records as they were. */
export function StoppedBuilds({ builds }: { builds: readonly BuildSummary[] }) {
  if (builds.length === 0) return null;
  return (
    <Card titleAbove title={`Stopped builds · ${builds.length}`} testId="lab-stopped">
      <ul className="flex flex-col divide-y divide-line">
        {builds.map((b) => (
          <li key={b.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-6 py-2.5">
            <Link to={buildPath(b.id)} className="text-sm text-link hover:underline">
              {b.title}
            </Link>
            <span className="text-sm text-ink-muted">{buildKindLine(b)}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
