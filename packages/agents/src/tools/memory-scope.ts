// Memory scopes, shared by `memory.write` and `knowledge.search`.

export const MEMORY_TEST_SCOPE_PREFIX = "test-run:";

/** The memory scope a note is written under: test runs tag theirs with the run (ARCHITECTURE §10.4). */
export function memoryScope(mode: "live" | "test", runId: string): string {
  return mode === "test" ? `${MEMORY_TEST_SCOPE_PREFIX}${runId}` : "agent";
}
