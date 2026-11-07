// A deterministic StepRunner for tests. It keeps Cloudflare's replay semantics (results stored by
// name, a second call with the same name in one execution is a bug), so `replay()` can show a
// resumed run doesn't repeat its side effects. Waits resolve from events delivered beforehand,
// from events delivered while waiting, or time out, as each test chooses.

import { cloneJson, type Duration } from "@countersign/core";
import {
  type StepConfig,
  type StepRunner,
  type StepTry,
  type WaitedEvent,
  WaitTimeoutError,
} from "./runner";

export type FakeCall =
  | { kind: "do"; name: string; cached: boolean }
  | { kind: "wait"; name: string; type: string; timeout: Duration }
  | { kind: "sleep"; name: string; duration: Duration };

export interface FakeStepRunnerOptions {
  /**
   * What a wait does when no matching event has been delivered:
   * `timeout` (default) rejects with WaitTimeoutError at once; `block` waits for `deliver()`.
   */
  onWait?: "timeout" | "block";
}

type Stored =
  | { ok: true; value: unknown }
  | { ok: false; error: { name: string; message: string } };

export class FakeStepRunner implements StepRunner {
  readonly calls: FakeCall[] = [];
  /** Names used in the current execution: Cloudflare would silently return a stored result. */
  #seen = new Set<string>();
  readonly #stored = new Map<string, Stored>();
  readonly #queued = new Map<string, unknown[]>();
  readonly #waiters = new Map<string, ((payload: unknown) => void)[]>();
  #onWait: "timeout" | "block";
  /** Called when a wait starts (after checking queued events): tests deliver from here. */
  onWaitStarted?: (name: string, type: string) => void;

  constructor(options: FakeStepRunnerOptions = {}) {
    this.#onWait = options.onWait ?? "timeout";
  }

  setOnWait(mode: "timeout" | "block"): void {
    this.#onWait = mode;
  }

  /** Sends an event to the run: resolves a waiting `waitForEvent`, else queues it. */
  deliver(type: string, payload: unknown): void {
    const waiter = this.#waiters.get(type)?.shift();
    if (waiter) waiter(cloneJson(payload));
    else this.#queued.set(type, [...(this.#queued.get(type) ?? []), cloneJson(payload)]);
  }

  /** Starts a new execution of the same run (a restart): stored results are kept. */
  replay(): void {
    this.#seen = new Set();
    this.calls.length = 0;
  }

  names(kind?: FakeCall["kind"]): string[] {
    return this.calls.filter((c) => !kind || c.kind === kind).map((c) => c.name);
  }

  #claim(name: string): Stored | undefined {
    if (this.#seen.has(name)) throw new Error(`step name used twice in one run: ${name}`);
    this.#seen.add(name);
    return this.#stored.get(name);
  }

  #replayStored<T>(stored: Stored): T {
    if (stored.ok) return cloneJson(stored.value) as T;
    const e = new Error(stored.error.message);
    e.name = stored.error.name;
    throw e;
  }

  async do<T>(
    name: string,
    fn: (attempt?: StepTry) => Promise<T>,
    config?: StepConfig,
  ): Promise<T> {
    const stored = this.#claim(name);
    this.calls.push({ kind: "do", name, cached: stored !== undefined });
    if (stored) return this.#replayStored<T>(stored);
    const attempts = 1 + (config?.retries?.limit ?? 0);
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        // Step results cross a serialization boundary in Cloudflare; JSON round-trip here too.
        // v0.14 W4-B: each try is told its number, as Cloudflare's step context does.
        const value = cloneJson(await fn({ attempt: i + 1 }));
        this.#stored.set(name, { ok: true, value });
        return cloneJson(value) as T;
      } catch (error) {
        last = error;
      }
    }
    throw last;
  }

  async waitForEvent<T = unknown>(
    name: string,
    options: { type: string; timeout: Duration },
  ): Promise<WaitedEvent<T>> {
    const stored = this.#claim(name);
    this.calls.push({ kind: "wait", name, type: options.type, timeout: options.timeout });
    if (stored) return this.#replayStored<WaitedEvent<T>>(stored);
    const queue = this.#queued.get(options.type);
    let payload: unknown;
    if (queue && queue.length > 0) {
      payload = queue.shift();
    } else {
      let mine: (payload: unknown) => void = () => {};
      const pending = new Promise<unknown>((resolve) => {
        mine = resolve;
      });
      this.#waiters.set(options.type, [...(this.#waiters.get(options.type) ?? []), mine]);
      this.onWaitStarted?.(name, options.type);
      const list = this.#waiters.get(options.type) ?? [];
      if (this.#onWait === "timeout" && list.includes(mine)) {
        this.#waiters.set(
          options.type,
          list.filter((w) => w !== mine),
        );
        const error = new WaitTimeoutError(name, options.type);
        this.#stored.set(name, { ok: false, error: { name: error.name, message: error.message } });
        throw error;
      }
      payload = await pending;
    }
    const event = { type: options.type, payload: payload as T };
    this.#stored.set(name, { ok: true, value: event });
    return cloneJson(event);
  }

  async sleep(name: string, duration: Duration): Promise<void> {
    const stored = this.#claim(name);
    this.calls.push({ kind: "sleep", name, duration });
    if (!stored) this.#stored.set(name, { ok: true, value: null });
  }
}
