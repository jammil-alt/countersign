// Which event types exist and what their payloads look like: the platform's (code, Zod) plus each
// registered pack's (EventTypeSpec, JSON Schema). apps/api builds one registry at startup from the
// platform and every pack manifest; nothing here names a pack.

import { EventTypeSpec, PLATFORM_EVENT_TYPES } from "@countersign/core";
import { z } from "zod";
import { PLATFORM_EVENTS, platformEventSpecs } from "./platform";

export class UnknownEventTypeError extends Error {
  override name = "UnknownEventTypeError";
  constructor(readonly type: string) {
    super(`unknown event type: ${type}`);
  }
}

export class EventPayloadError extends Error {
  override name = "EventPayloadError";
  constructor(
    readonly type: string,
    readonly issues: z.core.$ZodIssue[],
  ) {
    super(`invalid payload for ${type}: ${z.prettifyError(new z.ZodError(issues))}`);
  }
}

interface Entry {
  spec: EventTypeSpec;
  /** `platform`, the pack id, or `connector:<id>` for a connector's types. */
  source: string;
  payload: z.ZodType;
}

const PLATFORM = new Set<string>(PLATFORM_EVENT_TYPES);

// v0.14 W4-A: one event type from two connectors: both must be connectors, the type in a
// namespace the new one declares as shared (not its own id), and the payloads the same.
function sharedType(
  existing: Entry,
  spec: EventTypeSpec,
  connectorId: string,
  sharedNamespaces: readonly string[],
): boolean {
  const ns = spec.type.split(".")[0] ?? "";
  return (
    existing.source.startsWith("connector:") &&
    ns !== connectorId &&
    sharedNamespaces.includes(ns) &&
    JSON.stringify(existing.spec.payload) === JSON.stringify(spec.payload)
  );
}

export class EventTypeRegistry {
  readonly #entries = new Map<string, Entry>();

  constructor() {
    for (const spec of platformEventSpecs()) {
      const def = PLATFORM_EVENTS[spec.type as keyof typeof PLATFORM_EVENTS];
      this.#entries.set(spec.type, { spec, source: "platform", payload: def.payload });
    }
  }

  /**
   * Adds a pack's event types. A pack may not redefine a platform type or another pack's, and its
   * types must start with its own id (`materials.price.changed`), so two packs never collide.
   */
  registerPack(packId: string, specs: readonly EventTypeSpec[]): this {
    for (const raw of specs) {
      const spec = EventTypeSpec.parse(raw);
      if (PLATFORM.has(spec.type)) {
        throw new Error(`pack ${packId} may not redefine platform event ${spec.type}`);
      }
      if (!spec.type.startsWith(`${packId}.`)) {
        throw new Error(`pack ${packId} event ${spec.type} must start with "${packId}."`);
      }
      const existing = this.#entries.get(spec.type);
      if (existing)
        throw new Error(`event ${spec.type} is already registered by ${existing.source}`);
      // Pack payloads are JSON Schema (the manifest is data); Zod checks emits against it.
      const payload = z.fromJSONSchema(spec.payload as Parameters<typeof z.fromJSONSchema>[0]);
      this.#entries.set(spec.type, { spec, source: packId, payload });
    }
    return this;
  }

  /**
   * Adds a connector's event types (its manifest's `events`, e.g. `webhook.received`). Like a
   * pack's, they start with the connector's id; unlike a pack's, they are in every client's
   * catalogue (whether a client can receive them depends on its connections, not on enabling).
   */
  registerConnector(
    connectorId: string,
    specs: readonly EventTypeSpec[],
    /** The manifest's `sharedNamespaces` (e.g. `message`): types may start with those too. */
    sharedNamespaces: readonly string[] = [],
  ): this {
    const prefixes = [connectorId, ...sharedNamespaces].map((p) => `${p}.`);
    for (const raw of specs) {
      const spec = EventTypeSpec.parse(raw);
      if (PLATFORM.has(spec.type)) {
        throw new Error(`connector ${connectorId} may not redefine platform event ${spec.type}`);
      }
      if (!prefixes.some((p) => spec.type.startsWith(p))) {
        throw new Error(
          `connector ${connectorId} event ${spec.type} must start with "${connectorId}."`,
        );
      }
      const existing = this.#entries.get(spec.type);
      // v0.14 W4-A: a type in a shared namespace (`message.received`) may come from several
      // connectors (Twilio and Meta) when they declare the same payload; the first one stands.
      if (existing && sharedType(existing, spec, connectorId, sharedNamespaces)) continue;
      if (existing)
        throw new Error(`event ${spec.type} is already registered by ${existing.source}`);
      const payload = z.fromJSONSchema(spec.payload as Parameters<typeof z.fromJSONSchema>[0]);
      this.#entries.set(spec.type, { spec, source: `connector:${connectorId}`, payload });
    }
    return this;
  }

  has(type: string): boolean {
    return this.#entries.has(type);
  }

  get(type: string): EventTypeSpec | undefined {
    return this.#entries.get(type)?.spec;
  }

  sourceOf(type: string): string | undefined {
    return this.#entries.get(type)?.source;
  }

  /**
   * The catalogue a client sees in the trigger picker (`GET /api/catalog/events`): platform types
   * plus those of the packs enabled for it. Without `enabledPacks`, every registered type.
   */
  list(enabledPacks?: readonly string[]): EventTypeSpec[] {
    const packs = enabledPacks ? new Set(enabledPacks) : undefined;
    return [...this.#entries.values()]
      .filter(
        (e) =>
          e.source === "platform" ||
          e.source.startsWith("connector:") ||
          !packs ||
          packs.has(e.source),
      )
      .map((e) => e.spec);
  }

  /** As `list`, keyed by type: the `events` registry workflow validation takes. */
  byType(enabledPacks?: readonly string[]): Record<string, EventTypeSpec> {
    return Object.fromEntries(this.list(enabledPacks).map((s) => [s.type, s]));
  }

  /** The payload, parsed; throws UnknownEventTypeError or EventPayloadError. */
  parsePayload(type: string, payload: unknown): Record<string, unknown> {
    const entry = this.#entries.get(type);
    if (!entry) throw new UnknownEventTypeError(type);
    const result = entry.payload.safeParse(payload);
    if (!result.success) throw new EventPayloadError(type, result.error.issues);
    return result.data as Record<string, unknown>;
  }
}

/** A registry with the platform's types only. */
export function platformRegistry(): EventTypeRegistry {
  return new EventTypeRegistry();
}
