// Starting and resuming RunWorkflow instances, behind a small interface so the API and the cron can
// be tested without the Workflows engine. The instance id is the run id (ARCHITECTURE §10.3).

import type { RunRequest } from "@countersign/workflows";

/** RunWorkflow's params: the router's run request, as is. Plain JSON. */
export type RunParams = RunRequest;

export interface RunEvent {
  type: string;
  payload: unknown;
}

export interface RunInstances {
  /**
   * Starts the instance for `params.runId`. A second start of the same id is refused by the
   * engine; that answers `exists` (a re-dispatched event or a repeated cron tick).
   */
  start(params: RunParams): Promise<"started" | "exists">;
  /** Sends an event to a waiting run (e.g. its inbox item was resolved). */
  sendEvent(runId: string, event: RunEvent): Promise<void>;
}

/** Over the RUN_WORKFLOW binding. */
export function workflowInstances(binding: Workflow): RunInstances {
  return {
    async start(params) {
      try {
        await binding.create({ id: params.runId, params });
        return "started";
      } catch (error) {
        // The engine refuses an id it has seen; anything else is a real failure.
        const existing = await binding.get(params.runId).catch(() => null);
        if (existing) return "exists";
        throw error;
      }
    },
    async sendEvent(runId, event) {
      const instance = await binding.get(runId);
      await instance.sendEvent({ type: event.type, payload: event.payload });
    },
  };
}

/** An in-memory stand-in for tests: records what was started and sent. */
export class MemoryInstances implements RunInstances {
  readonly started = new Map<string, RunParams>();
  readonly events: { runId: string; event: RunEvent }[] = [];

  async start(params: RunParams): Promise<"started" | "exists"> {
    if (this.started.has(params.runId)) return "exists";
    this.started.set(params.runId, params);
    return "started";
  }

  async sendEvent(runId: string, event: RunEvent): Promise<void> {
    this.events.push({ runId, event });
  }
}
