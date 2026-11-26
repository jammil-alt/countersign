// ENGINE-INTERNAL (wave 4): the engine steps a v5 workflow is loaded into to run, and the helpers
// v5 and automations reach. Not a stored format: bundles hold v5 workflows only.
// R1 (docs/plan.md §1.86): processes, workflow `schemaVersion: 4`. Exported from core as the
// `processes` namespace, so its step names don't collide with the v3 workflow schema's.
// R8: a whole bundle that may hold processes, and the builder's field picker.
// Wave 3b: v4 automations and "Save as automation" on a process.
// Skill model (2026-11-10): action write steps.
export * from "./actions";
export * from "./automation";
export * from "./bundle";
// R8: the conditions a process uses (the Library's condition sets).
export * from "./choice";
export * from "./clock";
export * from "./collect";
export * from "./conditions";
// R7: the conversation step.
export * from "./conversation";
// Ways in, ways out (owner, 2026-11-23): steps one workflow repeats from another.
export * from "./customize";
// v0.18: what each step reads and saves.
export * from "./data-use";
// How it ends (owner, 2026-11-23): the steps a run can finish on, and whether each reports out.
export * from "./ending";
// The Builder's guide to step kinds (owner, 2026-11-24).
export * from "./guide";
// Hand off (owner, 2026-11-11): what a hand-off step knows of the agent it hands off to.
export * from "./handoff";
export * from "./hours";
// Wave 5: how a step ended, for an `if` to route on.
export * from "./outcomes";
// R6: the owner.
export * from "./owner";
export * from "./paths";
export * from "./reshape";
export * from "./reshape-propose";
export * from "./roles";
// Reshape data (owner, 2026-11-11): the mapping, its evaluator, typing and proposer.
// Triggers and outputs (owner, 2026-11-23): what each workflow is to the agent's others.
export * from "./sample";
export * from "./schema";
export * from "./seats";
// Data in and out of files (owner, 2026-11-20; docs/plan.md §1.164): Read table and Write table.
export * from "./table";
// R5: write tools' undo.
export * from "./undo";
export * from "./validate";
export * from "./walk";
