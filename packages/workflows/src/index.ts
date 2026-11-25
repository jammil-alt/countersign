// @countersign/workflows: the step-list executor (against a StepRunner, no Workers types), its
// injected ports, a fake runner for tests, and the pure trigger router.
// Allowed workspace dependencies: agents threads senses db core. See docs/plan.md §2.

export {
  DEFAULT_APPROVAL_TIMEOUT,
  type ExecutorContext,
  // v0.13 W2-I
  type ExecutorOversight,
  executeLoaded,
  executeWorkflow,
  FOR_EACH_MAX_ITEMS,
  jsonBytes,
  pool,
  type RunEndStatus,
  // v0.12 W1-E
  type RunRange,
  type RunResult,
  type RunResume,
  resumePoint,
  STEP_OUTPUT_MAX_BYTES,
} from "./executor";
// v0.12 W2-B
export * from "./expand";
// The step model (docs/step-model-plan.md §7): a fake Match port for tests.
export { FakeMatchPort } from "./fake-match";
export {
  type FakeCall,
  FakeStepRunner,
  type FakeStepRunnerOptions,
} from "./fake-runner";
// R6: what the owner watches.
export * from "./oversight";
export * from "./ports";
// The step shapes the ports take, and the engine steps the executor runs.
export {
  type ActionStep,
  type ClientVisibility,
  clientLabel,
  gateApproval,
  type LoadedProcess,
  type NotifyStep,
  type PersonChoice,
  type PersonStep,
  ProcessLoadError,
  type SkillStep,
  stepStateLabel,
} from "./process";
export * from "./router";
export * from "./runner";
// The step model (docs/step-model-plan.md): a v5 workflow on today's engines.
export {
  catalogKindOf,
  fieldsSchema,
  LOOP_SKILL,
  type LoadedStepModel,
  loadStepModel,
  MATCH_SKILL,
  STEP_MODEL_WRITE_ACTIONS,
  type StepLoop,
  type StepModelRun,
} from "./step-model";
