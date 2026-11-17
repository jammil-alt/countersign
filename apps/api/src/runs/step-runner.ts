// Cloudflare's WorkflowStep as packages/workflows' StepRunner (docs/plan.md §1.2 "Executor and
// Workers types"). The executor has no Workers types; this is the one place they meet.
//
// `step` is a JS-RPC stub, not an object with methods: `step.do.bind(step)` composes a remote
// call to a method named `bind` (Plenary Labs found this the hard way). Every call below goes
// through a closure over `step`.

import {
  type StepConfig,
  type StepRunner,
  type StepTry,
  WaitTimeoutError,
} from "@countersign/workflows";

/** The parts of Cloudflare's WorkflowStep used here, loosely typed so a fake can stand in. */
// v0.14 W4-B: Cloudflare hands the callback its step context, whose `attempt` counts tries from 1.
type StepCallback = (ctx?: { attempt?: number }) => Promise<unknown>;

export interface WorkflowStepLike {
  do(name: string, callback: StepCallback): Promise<unknown>;
  do(name: string, config: CloudflareStepConfig, callback: StepCallback): Promise<unknown>;
  sleep(name: string, duration: string | number): Promise<void>;
  waitForEvent(
    name: string,
    options: { type: string; timeout?: string | number },
  ): Promise<{ type: string; payload: unknown; timestamp?: Date }>;
}

export interface CloudflareStepConfig {
  retries?: {
    limit: number;
    delay: string | number;
    backoff?: "constant" | "linear" | "exponential";
  };
  timeout?: string | number;
}

function toConfig(config: StepConfig): CloudflareStepConfig {
  const out: CloudflareStepConfig = {};
  if (config.retries) {
    out.retries = {
      limit: config.retries.limit,
      delay: config.retries.delay,
      ...(config.retries.backoff ? { backoff: config.retries.backoff } : {}),
    };
  }
  if (config.timeout !== undefined) out.timeout = config.timeout;
  return out;
}

/**
 * Whether `waitForEvent` gave up waiting. The engine throws a `WorkflowTimeoutError` ("Execution
 * timed out after …ms"); across the RPC boundary only its name and message are sure to survive.
 */
export function isEngineTimeout(error: unknown): boolean {
  const e = error as { name?: unknown; message?: unknown } | null;
  if (!e || typeof e !== "object") return false;
  if (e.name === "WorkflowTimeoutError") return true;
  return typeof e.message === "string" && /timed out/i.test(e.message);
}

/**
 * The most a durable step's result may hold, serialized. The engine keeps a step's result up to
 * 1 MiB and fails the instance past it; ours stop before, with an error that says why. A skill or
 * action step's own output is checked first, at 900 KiB, on its own row (the executor's
 * `STEP_OUTPUT_MAX_BYTES`); this is the backstop for every durable step (the run's load, a sync).
 */
// DECISION (audit 4.4): a result over the limit fails its step with a clear error rather than
// being stored elsewhere and fetched back by reference: a reference would change what every
// later step and every replay reads. 960 KiB leaves the engine's encoding room under 1 MiB and
// fails nothing that fits today but for the last few KiB.
export const STEP_RESULT_MAX_BYTES = 960 * 1024;

/** What the engine stores in place of a result over the limit: small, and the same on a replay. */
const TOO_LARGE = "__stepResultTooLarge";

export class StepResultTooLargeError extends Error {
  override name = "StepResultTooLargeError";
  constructor(
    readonly stepName: string,
    readonly bytes: number,
  ) {
    super(
      `the result of step ${stepName} is ${Math.ceil(bytes / 1024)} KiB, over the ${STEP_RESULT_MAX_BYTES / 1024} KiB a step may hand on`,
    );
  }
}

/** A value's size as the engine stores it (JSON, UTF-8). */
export function resultBytes(value: unknown): number {
  const json = JSON.stringify(value ?? null) ?? "null";
  return new TextEncoder().encode(json).length;
}

function tooLarge(value: unknown): number | null {
  if (value === null || typeof value !== "object" || !(TOO_LARGE in value)) return null;
  const bytes = (value as Record<string, unknown>)[TOO_LARGE];
  return typeof bytes === "number" ? bytes : null;
}

export function cloudflareStepRunner(step: WorkflowStepLike): StepRunner {
  return {
    async do<T>(
      name: string,
      fn: (attempt?: StepTry) => Promise<T>,
      config?: StepConfig,
    ): Promise<T> {
      // v0.14 W4-B: the try's number, for the step's attempts (1 when the engine gives none).
      // Audit 4.4: a result over the limit is stored as a small marker (so the engine neither
      // retries the step nor fails on its size), and the step fails here, the same on a replay.
      const run = async (ctx?: { attempt?: number }) => {
        const out = await fn({ attempt: Math.max(1, Math.trunc(Number(ctx?.attempt ?? 1)) || 1) });
        const bytes = resultBytes(out);
        return bytes > STEP_RESULT_MAX_BYTES ? { [TOO_LARGE]: bytes } : out;
      };
      const result = config ? await step.do(name, toConfig(config), run) : await step.do(name, run);
      const over = tooLarge(result);
      if (over !== null) throw new StepResultTooLargeError(name, over);
      return result as T;
    },
    async waitForEvent<T>(name: string, options: { type: string; timeout: string }) {
      try {
        const event = await step.waitForEvent(name, {
          type: options.type,
          timeout: options.timeout,
        });
        return {
          type: event.type,
          payload: event.payload as T,
          ...(event.timestamp ? { timestamp: event.timestamp } : {}),
        };
      } catch (error) {
        if (isEngineTimeout(error)) throw new WaitTimeoutError(name, options.type);
        throw error;
      }
    },
    async sleep(name, duration) {
      await step.sleep(name, duration);
    },
  };
}
