// The durable-execution surface the executor needs (docs/plan.md §1.2 "Executor and Workers
// types"). apps/api's RunWorkflow adapts Cloudflare's WorkflowStep to it; tests use
// FakeStepRunner. No Workers types here.
//
// The contract is Cloudflare's: a run may be replayed from the top after a restart, and every
// `do` / `waitForEvent` / `sleep` with a name that already completed returns its stored result
// instead of running again. So names must be unique within a run and stable across replays, and
// every side effect belongs inside a `do`.

import type { Duration } from "@countersign/core";

export interface StepRetryConfig {
  limit: number;
  delay: Duration | number;
  backoff?: "constant" | "linear" | "exponential";
}

export interface StepConfig {
  retries?: StepRetryConfig;
  timeout?: Duration | number;
}

export interface WaitedEvent<T = unknown> {
  type: string;
  payload: T;
  timestamp?: Date;
}

// v0.14 W4-B: which try of a durable step this is, so a step's real attempts can be counted.
export interface StepTry {
  /** 1 on the first try; 2, 3… when the platform retries the step per its config. */
  attempt: number;
}

export interface StepRunner {
  /**
   * Runs `fn` once, durably: retried per `config`, its (JSON) result stored under `name`. `fn`
   * is told which try it is (v0.14 W4-B; adapters that can't tell pass nothing: the first).
   */
  do<T>(name: string, fn: (attempt?: StepTry) => Promise<T>, config?: StepConfig): Promise<T>;
  /**
   * Waits for an event of `type` sent to this run. Rejects with WaitTimeoutError after `timeout`
   * (adapters convert the platform's own timeout error).
   */
  waitForEvent<T = unknown>(
    name: string,
    options: { type: string; timeout: Duration },
  ): Promise<WaitedEvent<T>>;
  sleep(name: string, duration: Duration): Promise<void>;
}

export class WaitTimeoutError extends Error {
  override name = "WaitTimeoutError";
  constructor(
    readonly stepName: string,
    readonly eventType: string,
  ) {
    super(`no ${eventType} event for ${stepName} before the timeout`);
  }
}

/** By name as well as class, so an error rebuilt from a stored step result still counts. */
export function isWaitTimeout(error: unknown): boolean {
  return (
    error instanceof WaitTimeoutError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { name?: unknown }).name === "WaitTimeoutError")
  );
}

/**
 * The event type a run waits on for one inbox item (docs/plan.md §1.2 "Waiting on inbox items").
 * Resolving the item sends exactly this type to the run's instance.
 */
export function inboxEventType(inboxItemId: string): string {
  return `inbox-${inboxItemId.replace(/-/g, "")}`;
}
