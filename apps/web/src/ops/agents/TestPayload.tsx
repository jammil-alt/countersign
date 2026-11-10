// What a test run starts from (docs/plan.md §1.16 "Test-run payloads"): the trigger's sample
// payload, one of the client's recent events of the trigger's type (its payload as emitted, so the
// run reads real records), or input typed by hand. Shared by a client agent's Settings tab and the
// workflow builder's test-run panel.
import { allTriggers, type RecentEvent, type Trigger, type Workflow } from "@countersign/core";
import type { ResponseOf } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { money } from "../../portal/documents";
import { shortTime } from "../../runs/format";
import { Select } from "./ui";

type CatalogEvent = ResponseOf<typeof apiRoutes.opsEventCatalog>["events"][number];

/** `sample`, `manual`, or `event:<id>` for one of the recent events. */
export type PayloadSource = "sample" | "manual" | `event:${string}`;

/** A v3 workflow (its `trigger` and `moreTriggers`) or a v4 process (its `triggers`). */
export type Triggered =
  | Pick<Workflow, "trigger" | "moreTriggers">
  | { triggers: readonly Trigger[] };

/**
 * The trigger a test run's payload stands for: the first event trigger, else the first trigger
 * (undefined when a process has none yet). The sample and the recent events both read this one, so
 * "Sample trigger payload" and "Use a recent event" offer payloads of the same trigger.
 */
export function testTrigger(workflow: Triggered): Trigger | undefined {
  const all = allTriggers(workflow);
  return all.find((t) => t.on.type === "event") ?? all[0];
}

/**
 * The event type a workflow waits for: its first event trigger's, or null when none of its
 * triggers is an event. A v4 process reads its `triggers` (core's `allTriggers`), so a live v4
 * version's Versions tab doesn't fail on a missing `trigger`.
 */
export function triggerEventType(workflow: Triggered | null | undefined): string | null {
  if (!workflow) return null;
  const on = testTrigger(workflow)?.on;
  return on?.type === "event" ? on.event : null;
}

/**
 * The sample payload of the trigger a test run stands for (`testTrigger`): the event catalogue's
 * sample (undefined when its type has none, or the process has no trigger yet), or a blank of the
 * input's shape.
 */
export function samplePayload(
  workflow: Triggered,
  events: readonly Pick<CatalogEvent, "type" | "sample">[],
): unknown {
  const first = testTrigger(workflow);
  if (!first) return undefined;
  const on = first.on;
  switch (on.type) {
    case "event":
      return events.find((e) => e.type === on.event)?.sample ?? undefined;
    case "schedule":
      return { scheduledAt: new Date().toISOString() };
    case "command":
      return { args: "" };
    case "manual": {
      const props = (on.input.properties ?? {}) as Record<string, { type?: unknown }>;
      return Object.fromEntries(
        Object.entries(props).map(([k, p]) => [
          k,
          p.type === "number" || p.type === "integer" ? 0 : p.type === "boolean" ? false : "",
        ]),
      );
    }
    // v0.12 W2-E: the new kinds' payloads (docs/plan.md §1.48).
    case "webhook":
      return events.find((e) => e.type === "webhook.received")?.sample ?? undefined;
    case "message":
      return {
        channel: on.channels[0] ?? "email",
        contactId: null,
        userId: null,
        rawRecordId: null,
        threadId: null,
        messageId: null,
        documents: [],
      };
    case "handoff":
      return {
        from: {
          agentId: "",
          agentSlug: on.from.agent,
          workflowSlug: on.from.workflow ?? "",
          runId: "",
        },
        output: null,
        sources: [],
        depth: 1,
      };
  }
}

/**
 * The client's ten latest events of the trigger's type, newest first; waits while either is
 * unknown (no client yet, or not an event trigger).
 */
export function useRecentEvents(clientId: string | null, eventType: string | null) {
  return useApi(
    apiRoutes.opsClientEvents,
    clientId && eventType ? { params: { id: clientId }, query: { type: eventType } } : null,
  );
}

/** "northline-20418.pdf · Northline Panel Supply · $9,742.35 · Oct 29, 10:00". */
export function recentEventLabel(e: RecentEvent, now?: Date): string {
  return [
    e.label,
    e.vendorName,
    e.total ? money(e.total.amount, e.total.currency) : null,
    shortTime(e.createdAt, now),
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The payload text a source stands for; null for manual input (the text stays as typed). */
export function payloadFor(
  source: PayloadSource,
  sample: unknown,
  recent: readonly RecentEvent[],
): string | null {
  if (source === "sample") return JSON.stringify(sample, null, 2);
  if (source === "manual") return null;
  const id = source.slice("event:".length);
  const found = recent.find((e) => e.id === id);
  return found ? JSON.stringify(found.payload, null, 2) : null;
}

/**
 * The typed input as JSON: blank is `{}`; anything else must parse. The box starts blank (with a
 * `{}` placeholder), never prefilled with `{}`: typing or pasting `{…}` into a box that already
 * held `{}` left an extra closing brace, which read as the box closing braces by itself.
 */
export function parsePayload(text: string): { ok: true; value: unknown } | { ok: false } {
  if (!text.trim()) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** A plain text box for JSON: no spelling, capitals or smart quotes changing what is typed. */
export const JSON_INPUT_PROPS = {
  spellCheck: false,
  autoCapitalize: "off",
  autoCorrect: "off",
  autoComplete: "off",
  placeholder: "{}",
} as const;

/**
 * The payload's source: the sample (when there is one), "Use a recent event" with the client's
 * latest events of the trigger's type, or manual input.
 */
export function PayloadSourceSelect({
  value,
  onChange,
  hasSample,
  eventType,
  recent,
  testId,
  className,
}: {
  value: PayloadSource;
  onChange(source: PayloadSource): void;
  hasSample: boolean;
  /** The trigger's event type; null when the workflow isn't triggered by an event. */
  eventType: string | null;
  recent: ReturnType<typeof useRecentEvents>;
  testId: string;
  className?: string;
}) {
  const events = recent.data?.events ?? [];
  const waiting = recent.loading && !recent.data;
  return (
    <Select
      aria-label="Payload"
      data-testid={testId}
      value={value}
      className={className}
      onChange={(e) => onChange(e.target.value as PayloadSource)}
    >
      {hasSample ? <option value="sample">Sample trigger payload</option> : null}
      {eventType ? (
        <optgroup label="Use a recent event">
          {events.map((e) => (
            <option key={e.id} value={`event:${e.id}`}>
              {recentEventLabel(e)}
            </option>
          ))}
          {events.length === 0 ? (
            <option value="none" disabled>
              {waiting
                ? "Loading recent events…"
                : recent.error
                  ? "Recent events could not be loaded"
                  : `No ${eventType} events yet`}
            </option>
          ) : null}
        </optgroup>
      ) : null}
      <option value="manual">Manual input</option>
    </Select>
  );
}
