// v0.14 capture: starting CaptureWorkflow instances (one per message and start; the id names the
// client and the message), behind a small interface so routes and tests run without the
// Workflows engine (docs/plan.md §1.55).

import type { CaptureParams } from "./media";

export interface CaptureJobs {
  /** Starts the message's job; an id already used answers `exists`. */
  start(params: CaptureParams): Promise<"started" | "exists">;
}

/**
 * The instance id: `capture-<client>-<message sid>`, plus the start's own suffix for a restart or a
 * "download now" (a finished instance can't be started again under its id).
 */
export function captureInstanceId(params: CaptureParams, suffix?: string): string {
  const base = `capture-${params.tenantId}-${params.messageSid}`;
  return suffix ? `${base}-${suffix}` : base;
}

/** Over the CAPTURE_WORKFLOW binding. */
export function captureJobs(binding: Workflow, suffix: () => string): CaptureJobs {
  return {
    async start(params) {
      // P-3: a reply's job is one per message too (`…-reply`), beside its capture job.
      const id = captureInstanceId(
        params,
        params.reason === "inbound" ? undefined : params.reason === "reply" ? "reply" : suffix(),
      );
      try {
        await binding.create({ id, params });
        return "started";
      } catch (error) {
        const existing = await binding.get(id).catch(() => null);
        if (existing) return "exists";
        throw error;
      }
    },
  };
}

/** Runs the job in the request's `waitUntil` (local runs and tests, where the binding is absent). */
export function inlineCaptureJobs(run: (params: CaptureParams) => Promise<void>): CaptureJobs {
  return {
    async start(params) {
      await run(params);
      return "started";
    },
  };
}
