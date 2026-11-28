// One checker (staging, 2026-11-28): the step builder shows what the server says would stop its
// draft publishing (`opsWorkflowCheck`: the same check a save and a publish run, with the server's
// whole catalog), never a copy worked out in the browser with whatever it had loaded. Asked when
// the page opens and again a moment after each edit; while an answer is on its way the last one
// stays shown; a check that fails says so quietly and blocks nothing.

import { canonicalJson } from "@countersign/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiRoutes } from "../../../api/routes";
import { useApiClient } from "../../../api/useApi";
import { type BuilderIssue, issuesFromServer } from "./issues";
import type { Workflow } from "./types";

/** How long after an edit the draft is checked again. */
export const CHECK_DELAY_MS = 400;

export interface WorkflowCheck {
  /** The last answer's issues; null until the first answer. */
  issues: readonly BuilderIssue[] | null;
  /** A check is waiting or on its way. */
  checking: boolean;
  /** The last check failed (the answer before it, if any, is still `issues`). */
  failed: boolean;
}

export function useWorkflowCheck(input: {
  agentId: string;
  slug: string;
  /** The version the draft was edited from: a save would make the draft its child. */
  parentVersionId: string;
  workflow: Workflow;
  delayMs?: number;
}): WorkflowCheck {
  const { agentId, slug, parentVersionId, workflow, delayMs = CHECK_DELAY_MS } = input;
  const client = useApiClient();
  const canon = useMemo(() => canonicalJson(workflow), [workflow]);
  const latest = useRef(workflow);
  latest.current = workflow;
  const first = useRef(true);
  const [answer, setAnswer] = useState<{ issues: BuilderIssue[] | null; failed: boolean }>({
    issues: null,
    failed: false,
  });
  const [checking, setChecking] = useState(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `canon` stands for the workflow (a new object on every render of an unchanged draft would check it again).
  useEffect(() => {
    const sent = latest.current;
    const control = new AbortController();
    // The page opening is checked at once; an edit once the person pauses.
    const wait = first.current ? 0 : delayMs;
    first.current = false;
    setChecking(true);
    const timer = setTimeout(() => {
      client
        .call(apiRoutes.opsWorkflowCheck, {
          params: { id: agentId },
          body: { slug, workflow: sent, parentVersionId },
          signal: control.signal,
        })
        .then((res) => {
          if (control.signal.aborted) return;
          setAnswer({ issues: issuesFromServer(res.errors, slug), failed: false });
          setChecking(false);
        })
        .catch(() => {
          if (control.signal.aborted) return;
          setAnswer((a) => ({ ...a, failed: true }));
          setChecking(false);
        });
    }, wait);
    return () => {
      clearTimeout(timer);
      control.abort();
    };
  }, [client, agentId, slug, parentVersionId, canon, delayMs]);
  return { issues: answer.issues, checking, failed: answer.failed };
}
