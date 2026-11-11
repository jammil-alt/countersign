// R1 (docs/plan.md §1.86): processes, workflow `schemaVersion: 4`. Exported from core as the
// `processes` namespace, so its step names don't collide with the v3 workflow schema's.
// R8: a whole bundle that may hold processes, and the builder's field picker.
// Wave 3b: v4 automations and "Save as automation" on a process.
// Skill model (2026-11-10): action write steps.
export * from "./actions";
export * from "./automation";
export * from "./bundle";
export * from "./clock";
// R8: the conditions a process uses (the Library's condition sets).
export * from "./conditions";
// R7: the conversation step.
export * from "./conversation";
export * from "./convert";
export * from "./customize";
// Hand off (owner, 2026-11-11): what a hand-off step knows of the agent it hands off to.
export * from "./handoff";
export * from "./hours";
// Wave 5: how a step ended, for an `if` to route on.
export * from "./outcomes";
// R6: the owner.
export * from "./owner";
export * from "./paths";
// Reshape data (owner, 2026-11-11): the mapping, its evaluator, typing and proposer.
export * from "./reshape";
export * from "./reshape-propose";
export * from "./schema";
// R5: write tools' undo.
export * from "./undo";
export * from "./validate";
export * from "./walk";
