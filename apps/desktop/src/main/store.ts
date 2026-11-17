// What the app keeps on this computer (docs/plan.md §1.124), in its own data folder: which client
// it is paired with, the folders it gives, its settings, what it has sent, the writes it has done
// (so a retried job is never done twice) and a short activity list. Secrets (the computer's key
// and the person's session) are not here: they are in the vault (vault.ts), encrypted by the
// operating system. No file contents are ever kept here.

import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { DesktopFolder, DesktopPlatform } from "@countersign/core";
import { z } from "zod";

/** Writes done, kept this long for retries; activity rows kept; backups kept. */
const DONE_DAYS = 90;
const ACTIVITY_ROWS = 200;
const BACKUP_DAYS = 30;

export const ActivityItem = z.object({
  id: z.string(),
  at: z.string(),
  kind: z.enum(["read", "write", "sent", "refused", "error", "info"]),
  /** Plain words: "Added 3 rows to Costs.xlsx in Books". Never file contents. */
  text: z.string().max(300),
});
export type ActivityItem = z.infer<typeof ActivityItem>;

export const PairedDevice = z.object({
  deviceId: z.string(),
  tenantId: z.string(),
  clientName: z.string(),
  connectionId: z.string(),
  name: z.string(),
  platform: DesktopPlatform,
});
export type PairedDevice = z.infer<typeof PairedDevice>;

export const DesktopState = z.object({
  version: z.literal(1).default(1),
  device: PairedDevice.nullable().default(null),
  folders: z.array(DesktopFolder).default([]),
  /** The platform's list as last seen; null until the first answer. */
  platformFolders: z.array(DesktopFolder).nullable().default(null),
  settings: z
    .object({
      notifications: z.boolean().default(true),
      openAtLogin: z.boolean().default(true),
    })
    .default({ notifications: true, openAtLogin: true }),
  /** When each folder was given (folder id → ISO time): older files aren't sent. */
  given: z.record(z.string(), z.string()).default({}),
  /** Files sent, by `folderId:path`: the hash sent, so an unchanged file isn't sent again. */
  sent: z.record(z.string(), z.object({ sha256: z.string(), at: z.string() })).default({}),
  /** Writes done, by idempotency key: what they answered. */
  done: z
    .record(z.string(), z.object({ at: z.string(), output: z.record(z.string(), z.unknown()) }))
    .default({}),
  activity: z.array(ActivityItem).default([]),
});
export type DesktopState = z.infer<typeof DesktopState>;

export class Store {
  private state: DesktopState = DesktopState.parse({});
  private writing: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(s: DesktopState) => void>();

  constructor(
    private readonly dir: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private get file(): string {
    return join(this.dir, "state.json");
  }

  async load(): Promise<DesktopState> {
    await mkdir(this.dir, { recursive: true });
    try {
      const parsed = DesktopState.safeParse(JSON.parse(await readFile(this.file, "utf8")));
      // A file we can't read is set aside, never trusted in part.
      if (parsed.success) this.state = parsed.data;
      else await rename(this.file, `${this.file}.unreadable-${Date.now()}`);
    } catch {
      // No state yet.
    }
    this.prune();
    return this.state;
  }

  get(): DesktopState {
    return this.state;
  }

  onChange(listener: (s: DesktopState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Changes the state and writes it (a temporary file renamed over the old one). */
  async update(change: (s: DesktopState) => DesktopState | undefined): Promise<DesktopState> {
    const draft = structuredClone(this.state);
    const next = change(draft) ?? draft;
    this.state = DesktopState.parse(next);
    const snapshot = JSON.stringify(this.state);
    this.writing = this.writing.then(async () => {
      const tmp = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(tmp, snapshot, { mode: 0o600 });
      await rename(tmp, this.file);
    });
    await this.writing;
    for (const l of this.listeners) l(this.state);
    return this.state;
  }

  async log(kind: ActivityItem["kind"], text: string): Promise<void> {
    await this.update((s) => {
      s.activity = [
        { id: randomUUID(), at: this.now().toISOString(), kind, text: text.slice(0, 300) },
        ...s.activity,
      ].slice(0, ACTIVITY_ROWS);
    });
  }

  doneOutput(key: string): Record<string, unknown> | null {
    return this.state.done[key]?.output ?? null;
  }

  async recordDone(key: string, output: Record<string, unknown>): Promise<void> {
    await this.update((s) => {
      s.done[key] = { at: this.now().toISOString(), output };
    });
  }

  /** Forgets the pairing and everything that came with it; keeps settings. */
  async unpair(): Promise<void> {
    await this.update((s) => ({
      ...DesktopState.parse({}),
      settings: s.settings,
    }));
  }

  private prune(): void {
    const cutoff = this.now().getTime() - DONE_DAYS * 86_400_000;
    for (const [k, v] of Object.entries(this.state.done)) {
      if (Date.parse(v.at) < cutoff) delete this.state.done[k];
    }
  }

  // ── Backups ──

  private get backups(): string {
    return join(this.dir, "backups");
  }

  /** A copy of a file before we change it, kept 30 days; its path. */
  async backup(path: string, jobId: string): Promise<string> {
    await mkdir(this.backups, { recursive: true, mode: 0o700 });
    const target = join(
      this.backups,
      `${this.now().toISOString().slice(0, 10)}-${jobId}-${basename(path)}`,
    );
    await copyFile(path, target);
    return target;
  }

  async pruneBackups(): Promise<void> {
    const cutoff = this.now().getTime() - BACKUP_DAYS * 86_400_000;
    let names: string[] = [];
    try {
      names = await readdir(this.backups);
    } catch {
      return;
    }
    for (const name of names) {
      const p = join(this.backups, name);
      if ((await stat(p)).mtimeMs < cutoff) await rm(p, { force: true });
    }
  }
}
