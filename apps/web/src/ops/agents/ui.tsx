// Small helpers for the agent screens: notices, API actions, the agents-changed event. The form
// controls live in ui/forms and are re-exported here for the agent screens.
import type { RouteSpec } from "@countersign/core";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { type ApiError, type CallOptions, isApiError, type ResponseOf } from "../../api/client";
import { useApiClient } from "../../api/useApi";
import { cx } from "../../ui/primitives";

export { Field, Select, TextArea, TextInput } from "../../ui/forms";

/** A notice in one of the tones, for results of an action. */
export function Notice({
  tone,
  children,
  testId,
}: {
  /** warning = something stops the action (risk); ai = the team's suggestion (TeamMarker). */
  tone: "positive" | "warning" | "neutral" | "ai";
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div
      role={tone === "warning" ? "alert" : "status"}
      data-testid={testId}
      className={cx(
        tone === "warning" ? "ds-banner block text-sm" : "rounded-sm border px-3.5 py-3 text-sm",
        tone === "positive" && "border-positive-tint bg-positive-tint text-positive",
        tone === "neutral" && "border-line bg-surface-subtle text-ink",
        tone === "ai" && "border-line bg-surface-subtle text-slate",
      )}
    >
      {children}
    </div>
  );
}

/** The structured detail an API error carries (validation errors, activation problems). */
export function errorDetails(error: unknown): unknown {
  if (!isApiError(error)) return undefined;
  const body = error.body as { error?: { details?: unknown } } | undefined;
  return body?.error?.details;
}

/** Messages from an error's details: validation errors' `message`, or plain strings. */
export function detailMessages(error: unknown): string[] {
  const details = errorDetails(error);
  if (!Array.isArray(details)) return [];
  return details
    .map((d) =>
      typeof d === "string"
        ? d
        : d && typeof d === "object" && "message" in d
          ? `${(d as { stepId?: string | null }).stepId ? `Step ${(d as { stepId: string }).stepId}: ` : ""}${String((d as { message: unknown }).message)}`
          : null,
    )
    .filter((m): m is string => m !== null);
}

export function errorText(error: unknown): string {
  if (isApiError(error)) return error.message;
  return error instanceof Error ? error.message : String(error);
}

export type Outcome<T> = { ok: true; data: T } | { ok: false; error: unknown };

export interface Action {
  busy: boolean;
  /** The last call's failure, kept for the screen to show until the next call or `clear()`. */
  error: unknown;
  /** Calls one route; never throws. */
  call<R extends RouteSpec>(
    route: R,
    options?: Omit<CallOptions<R>, "signal">,
  ): Promise<Outcome<ResponseOf<R>>>;
  clear(): void;
}

/** One write at a time, with its failure kept for the screen to show. */
export function useAction(): Action {
  const client = useApiClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const call = useCallback(
    async <R extends RouteSpec>(
      route: R,
      options: Omit<CallOptions<R>, "signal"> = {},
    ): Promise<Outcome<ResponseOf<R>>> => {
      setBusy(true);
      setError(undefined);
      try {
        return { ok: true, data: await client.call(route, options) };
      } catch (e) {
        setError(e);
        return { ok: false, error: e };
      } finally {
        setBusy(false);
      }
    },
    [client],
  );
  const clear = useCallback(() => setError(undefined), []);
  return { busy, error, call, clear };
}

export function isCode(error: unknown, code: string): error is ApiError {
  return isApiError(error) && error.code === code;
}

// ── Agents changed (the sidebar's list refreshes when an agent is made or renamed) ──────────────

const AGENTS_CHANGED = "countersign:agents-changed";

export function notifyAgentsChanged(): void {
  window.dispatchEvent(new Event(AGENTS_CHANGED));
}

/** Calls `onChange` whenever an agent screen creates or changes an agent. */
export function useAgentsChanged(onChange: () => void): void {
  useEffect(() => {
    window.addEventListener(AGENTS_CHANGED, onChange);
    return () => window.removeEventListener(AGENTS_CHANGED, onChange);
  }, [onChange]);
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
