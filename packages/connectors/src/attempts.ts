// v0.14 W4-C: the platform's record of a write a provider takes no idempotency key for (Slack's
// `chat.postMessage`), so a retried action never writes twice. The connector records the attempt
// before it calls the provider, the provider's refusal when it answers one (nothing was written,
// so the action may try again under a new attempt number), and the result once it has one. An
// attempt that was started and has neither is the lost answer: the connector never writes again
// and fails the action as unconfirmed (UnconfirmedWriteError), for the operator to check.
// apps/api keeps these as raw records of the connection, one per key and attempt (immutable).

import type { JsonObject } from "@countersign/core";

/** What the platform holds for one external action's key on one connection. */
export interface WriteAttemptState {
  /** The result recorded once the provider said the write was done; null until then. */
  done: JsonObject | null;
  /** Attempts started under this key (attempt numbers 1…started). */
  started: number;
  /** Of those, the ones the provider refused: nothing was written. */
  refused: number;
  /** The newest attempt's details and start, for the operator's check. */
  last: { details: JsonObject; startedAt: Date } | null;
}

export interface WriteAttemptServices {
  /** Everything recorded under this key for the call's connection. */
  stateFor(idempotencyKey: string): Promise<WriteAttemptState>;
  /**
   * Claims attempt `attempt` (1-based) before the provider is called. False when it was already
   * claimed (another run of the same action got there first): the caller must not write.
   */
  start(input: {
    idempotencyKey: string;
    attempt: number;
    details: JsonObject;
    at: Date;
  }): Promise<boolean>;
  /** The provider refused attempt `attempt` with an answer: nothing was written. */
  refused(input: {
    idempotencyKey: string;
    attempt: number;
    reason: string;
    at: Date;
  }): Promise<void>;
  /** The provider wrote it: the result, once (the first recorded stands). */
  done(input: { idempotencyKey: string; output: JsonObject; at: Date }): Promise<void>;
}
