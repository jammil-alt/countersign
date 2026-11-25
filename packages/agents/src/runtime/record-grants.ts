// The gate's check on our own records (docs/step-model-plan.md §10f, part 3): a record type's
// standard action (Find, Get by id, Create, Update) runs only within the pinned agent version's
// grant on that record type: its own grants and its data sets that are on (`definition.data`).
// A Find needs read on its own record type and on each one it follows, so a link never reaches a
// record type the agent wasn't granted. Nothing is granted by default, and nothing in a run can
// change what is: the grant comes from the version only (invariants 4 and 9).
//
// Pure: the spec says which record type and action (core `ToolSpec.record`), the pinned version
// says what is granted.

import { type AgentData, accessFor, recordGrantAllows, type ToolSpec } from "@countersign/core";
import type { PinnedAgent } from "./ports";

const WORDS = { read: "read", create: "create", update: "change" } as const;

/** Why the call is refused, or null when the grant allows it (and for any other tool). */
export function recordGrantRefusal(
  agent: Pick<PinnedAgent, "bundle">,
  spec: Pick<ToolSpec, "id" | "record">,
  input: unknown,
): string | null {
  const record = spec.record;
  if (!record) return null;
  const data = (agent.bundle.definition as { data?: AgentData }).data;
  const access = accessFor(record.action);
  if (!recordGrantAllows(data, record.type, access)) {
    return `this agent isn't granted to ${WORDS[access]} ${record.type} records (${spec.id})`;
  }
  if (record.action === "find") {
    const follow =
      input && typeof input === "object" ? (input as { follow?: unknown }).follow : undefined;
    for (const name of Array.isArray(follow) ? follow : []) {
      const to = typeof name === "string" ? record.links?.[name] : undefined;
      if (!to) return `${spec.id} has no link ${String(name)}`;
      if (!recordGrantAllows(data, to, "read")) {
        return `this agent isn't granted to read ${to} records, which ${spec.id} follows through ${name}`;
      }
    }
  }
  return null;
}
