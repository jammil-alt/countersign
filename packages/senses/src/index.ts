// @countersign/senses: typed events (ARCHITECTURE §8): the outbox insert, the undispatched sweep,
// marking dispatched, and the registry of event types (platform + packs).
// Allowed workspace dependencies: db core. See docs/plan.md §2.

export {
  type ClaimOptions,
  claimUndispatched,
  collectEmitted,
  DISPATCH_ATTEMPTS,
  type DispatchFailure,
  dispatchErrorText,
  type EmitInput,
  type EmitOptions,
  EmittedEvents,
  type EventRow,
  emit,
  markDispatched,
  recordDispatchFailure,
  releaseDispatched,
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
