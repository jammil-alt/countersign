// Starting ExportWorkflow instances (one per client data export, the instance id is the export
// id), behind a small interface so the route can be tested without the Workflows engine.

import type { ExportParams } from "./client-data";

export interface ExportJobs {
  /** Starts the export's job; an id already used answers `exists`. */
  start(params: ExportParams): Promise<"started" | "exists">;
}

/** Over the EXPORT_WORKFLOW binding. */
export function exportJobs(binding: Workflow): ExportJobs {
  return {
    async start(params) {
      try {
        await binding.create({ id: params.exportId, params });
        return "started";
      } catch (error) {
        const existing = await binding.get(params.exportId).catch(() => null);
        if (existing) return "exists";
        throw error;
      }
    },
  };
}

/** An in-memory stand-in for tests: records what was started. */
export class MemoryExportJobs implements ExportJobs {
  readonly started: ExportParams[] = [];
  async start(params: ExportParams) {
    if (this.started.some((p) => p.exportId === params.exportId)) return "exists" as const;
    this.started.push(params);
    return "started" as const;
  }
}
