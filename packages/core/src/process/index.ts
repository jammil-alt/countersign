// R1 (docs/plan.md §1.86): processes, workflow `schemaVersion: 4`. Exported from core as the
// `processes` namespace, so its step names don't collide with the v3 workflow schema's.
export * from "./clock";
// R7: the conversation step.
export * from "./conversation";
export * from "./convert";
export * from "./customize";
export * from "./hours";
// R6: the owner.
export * from "./owner";
export * from "./schema";
// R5: write tools' undo.
export * from "./undo";
export * from "./validate";
export * from "./walk";
