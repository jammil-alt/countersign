// Form controls and small helpers for the agent screens, on the Groundwork tokens (no raw colours).
import type { RouteSpec } from "@countersign/core";
import {
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useCallback,
  useEffect,
  useState,
} from "react";
import { type ApiError, type CallOptions, isApiError, type ResponseOf } from "../../api/client";
import { useApiClient } from "../../api/useApi";
import { cx } from "../../ui/primitives";

const CONTROL =
  "w-full rounded-md border border-control bg-card px-3 text-[15px] text-primary placeholder:text-faint focus:border-focus disabled:opacity-60";

export function Field({
  label,
  hint,
  error,
  children,
  testId,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | undefined;
  children: ReactNode;
  testId?: string;
  className?: string;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is the label's child.
    <label className={cx("flex flex-col gap-1.5", className)}>
      <span className="text-sm font-medium text-primary">{label}</span>
      {children}
      {error ? (
        <span
          className="text-sm text-tone-warning-ink"
          data-testid={testId ? `${testId}-error` : undefined}
        >
          {error}
        </span>
      ) : hint ? (
        <span className="text-sm text-secondary">{hint}</span>
      ) : null}
    </label>
  );
}

export function TextInput({
  invalid,
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return (
    <input
      {...rest}
      aria-invalid={invalid || undefined}
      className={cx(CONTROL, "h-10", invalid && "border-tone-warning-edge", className)}
    />
  );
}

export function TextArea({
  invalid,
  className,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return (
    <textarea
      {...rest}
      aria-invalid={invalid || undefined}
      className={cx(
        CONTROL,
        "py-2 leading-relaxed",
        invalid && "border-tone-warning-edge",
        className,
      )}
    />
  );
}

export function Select({
  invalid,
  className,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }) {
  return (
    <select
      {...rest}
      aria-invalid={invalid || undefined}
      className={cx(CONTROL, "h-10 pr-8", invalid && "border-tone-warning-edge", className)}
    />
  );
}

/** A notice in one of the tones, for results of an action. */
export function Notice({
  tone,
  children,
  testId,
}: {
  tone: "positive" | "warning" | "neutral" | "ai";
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div
      role={tone === "warning" ? "alert" : "status"}
      data-testid={testId}
      className={cx(
        "rounded-md border px-4 py-3 text-[15px]",
        tone === "positive" && "border-tone-positive-edge bg-tone-positive text-tone-positive-ink",
        tone === "warning" && "border-tone-warning-edge bg-tone-warning text-tone-warning-ink",
        tone === "neutral" && "border-tone-neutral-edge bg-tone-neutral text-tone-neutral-ink",
        tone === "ai" && "border-ai-edge bg-ai text-ai-ink",
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
