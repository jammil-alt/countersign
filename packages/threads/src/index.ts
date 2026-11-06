// @countersign/threads: threads, messages, `/command` resolution and read state (ARCHITECTURE §11.2;
// docs/plan.md §1.38). apps/api wires the routes; agents reach it through `threads.post` and
// `threads.read` (packages/agents' threads port).
// Allowed workspace dependencies: senses db core. See docs/plan.md §2.

import type { Tx } from "@countersign/db";
import { type EmitOptions, type EventRow, emit } from "@countersign/senses";
import type { EmitPosted } from "./store";

export * from "./access";
export * from "./commands";
export * from "./lead";
export * from "./post";
export * from "./store";

/**
 * Emits `thread.message_posted` with packages/senses' outbox, collecting each row for the caller
 * to dispatch after commit.
 */
export function senseEmitPosted(
  options: Omit<EmitOptions, "collect"> & { collect?: EventRow[] } = {},
): EmitPosted {
  const { collect, ...emitOptions } = options;
  return async (tx: Tx, event) => {
    const row = await emit(tx, event, emitOptions);
    if (row && collect) collect.push(row);
  };
}
