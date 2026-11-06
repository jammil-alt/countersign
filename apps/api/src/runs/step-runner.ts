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

export function cloudflareStepRunner(step: WorkflowStepLike): StepRunner {
  return {
    async do<T>(
      name: string,
      fn: (attempt?: StepTry) => Promise<T>,
      config?: StepConfig,
    ): Promise<T> {
      // v0.14 W4-B: the try's number, for the step's attempts (1 when the engine gives none).
      const run = (ctx?: { attempt?: number }) =>
        fn({ attempt: Math.max(1, Math.trunc(Number(ctx?.attempt ?? 1)) || 1) });
      const result = config ? await step.do(name, toConfig(config), run) : await step.do(name, run);
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
