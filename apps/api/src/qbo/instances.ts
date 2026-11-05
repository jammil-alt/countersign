// Starting QboSyncWorkflow instances, behind a small interface so the webhook, the cron and the
// operator's "sync now" can be tested without the Workflows engine.

export interface QboSyncParams {
  tenantId: string;
  connectionId: string;
  /** What asked for it, for the logs. */
  reason: "cron" | "webhook" | "operator" | "connected";
}

export interface QboSyncInstances {
  /** Starts one sync under `id`; an id already used answers `exists` (the engine refuses it). */
  start(id: string, params: QboSyncParams): Promise<"started" | "exists">;
}

/**
 * The instance id: the connection and a time slot, so a burst of webhooks or a repeated cron tick
 * starts one sync per slot, not one per notification.
 */
// DECISION: webhook and operator syncs share one-minute slots; the cron's are its 15-minute ticks.
export function qboSyncInstanceId(
  connectionId: string,
  reason: QboSyncParams["reason"],
  at: Date,
): string {
  const slotMs = reason === "cron" ? 15 * 60_000 : 60_000;
  const slot = Math.floor(at.getTime() / slotMs) * slotMs;
  const stamp = new Date(slot).toISOString().replace(/[-:]/g, "").slice(0, 13);
  return `qbo-${connectionId}-${reason === "cron" ? "c" : "n"}${stamp}`;
}

/** Over the QBO_SYNC binding. */
export function qboSyncInstances(binding: Workflow): QboSyncInstances {
  return {
    async start(id, params) {
      try {
        await binding.create({ id, params });
        return "started";
      } catch (error) {
        const existing = await binding.get(id).catch(() => null);
        if (existing) return "exists";
        throw error;
      }
    },
  };
}

/** An in-memory stand-in for tests: records what was started. */
export class MemoryQboSyncInstances implements QboSyncInstances {
  readonly started = new Map<string, QboSyncParams>();
  async start(id: string, params: QboSyncParams) {
    if (this.started.has(id)) return "exists" as const;
    this.started.set(id, params);
    return "started" as const;
  }
}
