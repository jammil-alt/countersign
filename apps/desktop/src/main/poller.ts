// Asking Mezonas for this computer's jobs and answering them (docs/plan.md §1.124). The computer
// never takes a connection in: it waits on GET /api/desktop/jobs (the API holds the request open
// up to DESKTOP_POLL_SEC), runs what comes back one job at a time, and posts each result.
// DECISION: a long poll, not a WebSocket to a Durable Object: apps/api has no Durable Objects
// today, and a job every few seconds at most doesn't need one. The protocol is the same either
// way, so a socket can replace the poll later without changing the jobs.

import {
  DESKTOP_PATHS,
  DESKTOP_POLL_SEC,
  type DesktopFolder,
  type DesktopJob,
  type DesktopJobResult,
  DesktopJobsResponse,
} from "@countersign/core";
import { type Api, ApiError } from "./api";

export type ConnectionStatus =
  /** Waiting for jobs, Mezonas answered just now. */
  | "online"
  /** Mezonas can't be reached; trying again. */
  | "offline"
  /** Mezonas doesn't take this computer's jobs yet (this API has no desktop routes). */
  | "waiting"
  /** Mezonas no longer knows this computer: it was removed from the portal. */
  | "unpaired"
  | "stopped";

export interface PollerDeps {
  api: Api;
  run(job: DesktopJob): Promise<DesktopJobResult>;
  /** The platform's folder list, from each answer. */
  folders(list: DesktopFolder[]): Promise<void>;
  status(status: ConnectionStatus, at: Date): void;
  /** Waits; tests replace it. */
  sleep?(ms: number): Promise<void>;
  now?(): Date;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Poller {
  private running = false;
  private failures = 0;

  constructor(private readonly deps: PollerDeps) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
    this.deps.status("stopped", this.now());
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  /** One round: ask, run, answer. Returns how long to wait before the next. */
  async once(): Promise<number> {
    let res: Response;
    try {
      res = await this.deps.api.asDevice("GET", `${DESKTOP_PATHS.jobs}?wait=${DESKTOP_POLL_SEC}`);
    } catch (e) {
      if (e instanceof ApiError && e.code === "not_paired") {
        this.deps.status("unpaired", this.now());
        this.running = false;
        return 0;
      }
      return this.backoff("offline");
    }
    if (res.status === 401 || res.status === 403) {
      this.deps.status("unpaired", this.now());
      this.running = false;
      return 0;
    }
    if (res.status === 404 || res.status === 501) return this.backoff("waiting", 5 * 60_000);
    if (!res.ok) return this.backoff("offline");
    const parsed = DesktopJobsResponse.safeParse(await res.json().catch(() => null));
    if (!parsed.success) return this.backoff("offline");
    this.failures = 0;
    this.deps.status("online", this.now());
    await this.deps.folders(parsed.data.folders);
    for (const job of parsed.data.jobs) {
      const result = await this.deps.run(job);
      await this.answer(job.id, result);
    }
    return 0;
  }

  private async answer(jobId: string, result: DesktopJobResult): Promise<void> {
    // DECISION: an answer that can't be delivered is tried three times; after that the job's
    // write (if any) is still recorded here, so the platform's retry gets `alreadyDone`.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await this.deps.api.asDevice(
          "POST",
          DESKTOP_PATHS.result(jobId),
          JSON.stringify(result),
        );
        if (res.ok || res.status === 404 || res.status === 409 || res.status === 410) return;
      } catch {
        // Try again.
      }
      await (this.deps.sleep ?? defaultSleep)(1000 * (attempt + 1));
    }
  }

  private backoff(status: ConnectionStatus, at?: number): number {
    this.failures++;
    this.deps.status(status, this.now());
    return at ?? Math.min(5_000 * 2 ** Math.min(this.failures - 1, 6), 5 * 60_000);
  }

  private async loop(): Promise<void> {
    const sleep = this.deps.sleep ?? defaultSleep;
    while (this.running) {
      const wait = await this.once().catch(() => this.backoff("offline"));
      if (wait > 0 && this.running) await sleep(wait);
    }
  }
}
