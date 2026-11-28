// The one bar of an open build in its draft (owner, 2026-11-27: "keep it simple: make sure we can
// run through all the steps, then publish"): "Draft · Ready to publish", or what holds it, with
// Publish. The build page and the agent's Build tab press it here; the steps page shows the same
// bar without a button, since its own Publish (in the builder's bar) ends the build the same way.

import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { Icon } from "../../ui/icons";
import { Button } from "../../ui/primitives";
import { OPS_PATHS } from "../paths";

/** "Ready to publish", or the gate's reasons in one line: the server's own words. */
export function draftStateWords(reasons: readonly string[] | null): string {
  if (reasons === null) return "Checking the draft…";
  return reasons.length === 0 ? "Ready to publish" : reasons.join(" ");
}

export function PublishBar({
  reasons,
  busy = false,
  publishing = false,
  onPublish,
  note,
  children,
  testId = "build-publish-bar",
}: {
  /** The draft's gate: why it can't be published yet (empty: it can; null: not read yet). */
  reasons: readonly string[] | null;
  busy?: boolean;
  publishing?: boolean;
  /** Without it the bar has no button: Publish is elsewhere on the page. */
  onPublish?: (() => void) | undefined;
  /** One short line under the state. */
  note?: ReactNode;
  /** Links at the bar's start. */
  children?: ReactNode;
  testId?: string;
}) {
  const ready = reasons !== null && reasons.length === 0;
  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-line bg-surface px-4 py-3"
      data-testid={testId}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {children}
        <p className="text-sm text-ink" data-testid={`${testId}-state`}>
          <span className="font-medium">Draft</span>
          <span className="text-ink-muted"> · </span>
          <span className={ready ? "text-ink" : "text-ink-muted"}>{draftStateWords(reasons)}</span>
        </p>
        <p className="text-xs text-ink-muted">
          {note ??
            "Run it through in the step builder first: a test run writes nothing. Publishing ends the build."}
        </p>
      </div>
      {onPublish ? (
        <Button
          variant="primary"
          disabled={busy || !ready}
          working={publishing}
          title={ready ? undefined : draftStateWords(reasons)}
          onClick={onPublish}
          data-testid={`${testId}-publish`}
        >
          {publishing ? "Publishing…" : "Publish"}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The steps page of an agent with an open build: the way back to the build, and the bar's state,
 * read from the build as its page reads it. The page's own Publish ends the build.
 */
// DECISION: no second Publish button here. The builder's bar has one, which saves unsaved edits
// first; this one would publish the last saved version, so two would mean two different things.
export function StepsBuildBar({ build }: { build: { id: string; title: string } }) {
  const read = useApi(apiRoutes.opsBuild, { params: { id: build.id } });
  const back = (
    <Link to={OPS_PATHS.build(build.id)} className="ui-back" data-testid="agent-back-build">
      <Icon name="arrow" size={14} className="rotate-180" />
      Back to the build: {build.title}
    </Link>
  );
  const d = read.data;
  if (
    read.error ||
    (d && (d.build.status !== "open" || d.build.phase === "intake" || d.build.phase === "fitgap"))
  )
    return back;
  return (
    <PublishBar
      testId="steps-build-bar"
      reasons={d ? d.gate.reasons : null}
      note="Run it through with Try first: a test run writes nothing. Publish here makes it live and ends the build."
    >
      {back}
    </PublishBar>
  );
}
