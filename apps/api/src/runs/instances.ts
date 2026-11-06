// Starting and resuming RunWorkflow instances, behind a small interface so the API and the cron can
// be tested without the Workflows engine. The instance id is the run id (ARCHITECTURE §10.3).

import type { RunRequest } from "@countersign/workflows";

/**
 * RunWorkflow's params: the router's run request, plus what a retry repeats (v0.12 W1-E,
 * ARCHITECTURE §10.10). Plain JSON.
 */
export type RunParams = RunRequest & {
  /** The failed run this one retries. */
  retryOf?: string;
  /** The top-level step it runs from; the steps before it are reused from `retryOf`. */
  resumeFrom?: string | null;
};

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
  /**
   * Sends an event to a run (e.g. its inbox item was resolved). Safe to repeat: an event nobody
   * waits for is never read, and an instance that has ended takes nothing.
   */
  sendEvent(runId: string, event: RunEvent): Promise<void>;
  /**
   * Ends a run's instance (a cancel, W1-E). `missing` when it never started, `ended` when it had
   * already finished; neither is an error.
   */
  terminate(runId: string): Promise<"terminated" | "ended" | "missing">;
}

/** Instance states that will never wait for an event again. */
const ENDED = new Set<string>(["complete", "errored", "terminated"]);

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
      // Throws while the instance does not exist yet; the cron sends again (./resume.ts).
      const instance = await binding.get(runId);
      const { status } = await instance.status();
      if (ENDED.has(status)) return;
      await instance.sendEvent({ type: event.type, payload: event.payload });
    },
    async terminate(runId) {
      const instance = await binding.get(runId).catch(() => null);
      if (!instance) return "missing";
      const { status } = await instance.status();
      if (ENDED.has(status)) return "ended";
      await instance.terminate();
      return "terminated";
    },
  };
}

/** An in-memory stand-in for tests: records what was started and sent. */
export class MemoryInstances implements RunInstances {
  readonly started = new Map<string, RunParams>();
  readonly events: { runId: string; event: RunEvent }[] = [];
  readonly terminated: string[] = [];
  /** The next this-many sends throw, as an unreachable engine would. */
  failSends = 0;

  async start(params: RunParams): Promise<"started" | "exists"> {
    if (this.started.has(params.runId)) return "exists";
    this.started.set(params.runId, params);
    return "started";
  }

  async sendEvent(runId: string, event: RunEvent): Promise<void> {
    if (this.failSends > 0) {
      this.failSends--;
      throw new Error("the Workflows engine is unreachable");
    }
    this.events.push({ runId, event });
  }

  async terminate(runId: string): Promise<"terminated" | "ended" | "missing"> {
    if (!this.started.has(runId)) return "missing";
    if (this.terminated.includes(runId)) return "ended";
    this.terminated.push(runId);
    return "terminated";
  }
}
