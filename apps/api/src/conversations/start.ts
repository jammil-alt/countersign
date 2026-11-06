// v0.14 capture: what a capture job needs, and where it runs: the CAPTURE_WORKFLOW binding where
// the deployment has it, else inline after the response (docs/plan.md §1.55).

import { type FetchLike, globalFetch } from "@countersign/connectors";
import type { Db } from "@countersign/db";
import type { Bindings } from "../env";
import type { AppDeps } from "../http";
import type { Platform } from "../platform";
import { extractInBackground } from "../routes/documents";
import { type CaptureJobs, captureJobs, inlineCaptureJobs } from "./instances";
import { type CaptureDeps, runCaptureInline } from "./media";

export function captureDepsFor(input: {
  db: Db;
  env: Bindings;
  deps: AppDeps;
  platform: Platform;
}): CaptureDeps {
  const { db, env, deps } = input;
  const fetch: FetchLike = deps.fetch?.(env) ?? globalFetch();
  return {
    db,
    env,
    objects: deps.objects(env),
    fetch,
    events: input.platform.events,
    instances: deps.instances(env),
    read: (tenantId, ids) => extractInBackground({ db, env, deps }, tenantId, ids),
  };
}

export function captureJobsFor(env: Bindings, capture: CaptureDeps): CaptureJobs {
  const binding = env.CAPTURE_WORKFLOW;
  if (binding) return captureJobs(binding, () => Date.now().toString(36));
  return inlineCaptureJobs((params) => runCaptureInline(capture, params));
}
