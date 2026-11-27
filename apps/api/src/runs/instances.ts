// Starting and resuming RunWorkflow instances, behind a small interface so the API and the cron can
// be tested without the Workflows engine. The instance id is the run id (ARCHITECTURE §10.3).

import type { TestPeople } from "@countersign/core";
import type { RunRange, RunRequest } from "@countersign/workflows";

/**
 * RunWorkflow's params: the router's run request, plus what a retry repeats (v0.12 W1-E,
 * ARCHITECTURE §10.10). Plain JSON.
 */
export type RunParams = RunRequest & {
  /** The failed run this one retries. */
  retryOf?: string;
  /** The top-level step it runs from; the steps before it are reused from `retryOf`. */
  resumeFrom?: string | null;
  /** A test of some of the steps (docs/plan.md §1.185); kept on the run's row with its trigger. */
  range?: RunRange;
  /**
   * Owner, 2026-11-27: a Sandbox test run started with "Ask me": who stands in for everyone, and
   * where its messages go. Kept on the run's row with its trigger (`trigger.testPeople`).
   */
  testPeople?: TestPeople;
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
  /**
   * The instance's state as the engine reports it (`queued`, `running`, `waiting`, `errored`,
   * `terminated`, `complete`, ...), or null only when the engine says it has no instance for the
   * run; any other failure throws, so nothing is started or failed on a guess. The run reconciler
   * reads it (./reconcile.ts); without it, it does nothing.
   */
  inspect?(runId: string): Promise<InstanceState | null>;
}

/** What the engine says about one instance. */
export interface InstanceState {
  status: string;
  /** Why it errored, when it did (the engine's message). */
  error?: string | null;
}

/** The engine's error for an instance, as text: an `{ name, message }` or a string. */
function errorText(error: unknown): string | null {
  if (!error) return null;
  if (typeof error === "string") return error;
  if (typeof error === "object") {
    const e = error as { name?: unknown; message?: unknown };
    const text = [e.name, e.message].filter((x) => typeof x === "string" && x).join(": ");
    return text || null;
  }
  return String(error);
}

/** The engine's answer to `get` for an id it has no instance of (`instance.not_found`). */
export function isNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\binstance\.not_found\b|\binstance not found\b/i.test(message);
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
    async inspect(runId) {
      let instance: Awaited<ReturnType<Workflow["get"]>>;
      try {
        instance = await binding.get(runId);
      } catch (error) {
        // The engine refuses `get` for an id it has never seen (or has removed).
        if (isNotFound(error)) return null;
        throw error;
      }
      const s = await instance.status();
      return { status: s.status, error: errorText((s as { error?: unknown }).error) };
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
  /** The next this-many starts throw, as an unreachable engine would. */
  failStarts = 0;
  /** Each start asked for, in order (a repeat included). */
  readonly startCalls: string[] = [];
  /** An instance's state other than `running` (e.g. `errored`), as a test sets it. */
  readonly states = new Map<string, InstanceState>();
  /** The next this-many inspects throw, as an unreachable engine would (not a "not found"). */
  failInspects = 0;

  async start(params: RunParams): Promise<"started" | "exists"> {
    this.startCalls.push(params.runId);
    if (this.failStarts > 0) {
      this.failStarts--;
      throw new Error("the Workflows engine is unreachable");
    }
    if (this.started.has(params.runId)) return "exists";
    this.started.set(params.runId, params);
    return "started";
  }

  async inspect(runId: string): Promise<InstanceState | null> {
    if (this.failInspects > 0) {
      this.failInspects--;
      throw new Error("the Workflows engine is unreachable");
    }
    if (!this.started.has(runId)) return null;
    if (this.terminated.includes(runId)) return { status: "terminated" };
    return this.states.get(runId) ?? { status: "running" };
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
