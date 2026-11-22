// Where a Dev queue request is shown: the Feedback page's Dev queue tab (docs/plan.md §1.125). Kept
// on its own so the build page links to it without loading the chart's modules.

/** A request on the Feedback page's Dev queue tab. */
export function devQueuePath(ref: string): string {
  return `/ops/utilities/feedback?tab=dev-queue&request=${encodeURIComponent(ref)}`;
}
