// v0.12 W2-C: starting TestSuiteWorkflow instances (one per suite run; the instance id is the suite
// run's id), behind a small interface so the routes can be tested without the Workflows engine.

import type { SuiteParams } from "./suite";

export interface TestSuiteJobs {
  /** Starts the suite's job; an id already used answers `exists`. */
  start(params: SuiteParams): Promise<"started" | "exists">;
}

/** Over the TEST_SUITE_WORKFLOW binding. */
export function testSuiteJobs(binding: Workflow): TestSuiteJobs {
  return {
    async start(params) {
      try {
        await binding.create({ id: params.suiteRunId, params });
        return "started";
      } catch (error) {
        const existing = await binding.get(params.suiteRunId).catch(() => null);
        if (existing) return "exists";
        throw error;
      }
    },
  };
}

/** An in-memory stand-in for tests: records what was started. */
export class MemoryTestSuiteJobs implements TestSuiteJobs {
  readonly started: SuiteParams[] = [];
  async start(params: SuiteParams) {
    if (this.started.some((p) => p.suiteRunId === params.suiteRunId)) return "exists" as const;
    this.started.push(params);
    return "started" as const;
  }
}
