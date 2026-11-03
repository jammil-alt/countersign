// @countersign/workflows: the step-list executor (against a StepRunner, no Workers types), its
// injected ports, a fake runner for tests, and the pure trigger router.
// Allowed workspace dependencies: agents threads senses db core. See docs/plan.md §2.

export {
  DEFAULT_APPROVAL_TIMEOUT,
  type ExecutorContext,
  executeWorkflow,
  pool,
  type RunEndStatus,
  type RunResult,
} from "./executor";
export {
  type FakeCall,
  FakeStepRunner,
  type FakeStepRunnerOptions,
} from "./fake-runner";
export * from "./ports";
export * from "./router";
export * from "./runner";
