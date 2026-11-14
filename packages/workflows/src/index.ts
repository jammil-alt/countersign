// @countersign/workflows: the step-list executor (against a StepRunner, no Workers types), its
// injected ports, a fake runner for tests, and the pure trigger router.
// Allowed workspace dependencies: agents threads senses db core. See docs/plan.md §2.

export {
  DEFAULT_APPROVAL_TIMEOUT,
  type ExecutorContext,
  // v0.13 W2-I
  type ExecutorOversight,
  executeWorkflow,
  pool,
  type RunEndStatus,
  type RunResult,
  // v0.12 W1-E
  type RunResume,
  resumePoint,
} from "./executor";
// v0.12 W2-B
export * from "./expand";
export {
  type FakeCall,
  FakeStepRunner,
  type FakeStepRunnerOptions,
} from "./fake-runner";
// R6: what the owner watches.
export * from "./oversight";
export * from "./ports";
// R3: v3 workflows read as v4 processes, with their stored steps kept for the ports.
export {
  type AnyWorkflow,
  gateApproval,
  type LoadedProcess,
  loadProcess,
  NO_LOOKUP,
  ProcessLoadError,
} from "./process";
export * from "./router";
export * from "./runner";
