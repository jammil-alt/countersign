// @countersign/senses: typed events (ARCHITECTURE §8): the outbox insert, the undispatched sweep,
// marking dispatched, and the registry of event types (platform + packs).
// Allowed workspace dependencies: db core. See docs/plan.md §2.

export {
  type EmitInput,
  type EmitOptions,
  type EventRow,
  emit,
  markDispatched,
  type UndispatchedOptions,
  undispatched,
} from "./outbox";
export * from "./platform";
export {
  EventPayloadError,
  EventTypeRegistry,
  platformRegistry,
  UnknownEventTypeError,
} from "./registry";
