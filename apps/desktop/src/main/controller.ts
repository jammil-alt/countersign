// The desktop app's own logic (docs/plan.md §1.151), apart from Electron so it can be tested:
// signing in, pairing this computer, the folders it gives, the jobs it runs, the files it sends,
// the Desk it watches and the view the window shows. index.ts gives it the operating system's
// parts (browser, notifications, folder picker, keychain) and the window.

import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename } from "node:path";
import {
  DESKTOP_MAX_FOLDERS,
  DESKTOP_PATHS,
  type DesktopFolder,
  DesktopFolder as DesktopFolderSchema,
  type DesktopPlatform,
  folderGrantProblem,
  MOBILE_SIGNED_IN_URL,
  normaliseDevicePath,
  PairedDesktop,
  routes,
} from "@countersign/core";
import type { DeskRow, DesktopView, FolderRow, NewFolder, Result } from "../shared/ipc";
import { Api, ApiError, type Credentials, type Fetch } from "./api";
import { effectiveFolders } from "./guard";
import { Ingest } from "./ingest";
import { runJob } from "./jobs";
import { newDeviceKey, pkcePair } from "./keys";
import { type ConnectionStatus, Poller } from "./poller";
import type { Store } from "./store";
import type { Vault } from "./vault";

/** What the operating system gives the app. */
export interface Shell {
  openExternal(url: string): Promise<void>;
  notify(title: string, body: string, onClick: () => void): void;
  chooseFolder(): Promise<string | null>;
  showFolder(path: string): Promise<void>;
  setOpenAtLogin(open: boolean): void;
  homedir: string;
  platform: DesktopPlatform;
  appVersion: string;
  computerName: string;
}

export interface ControllerOptions {
  origin: string;
  store: Store;
  vault: Vault;
  shell: Shell;
  fetch?: Fetch;
  /** Local `wrangler dev` only: sign in as this email with the dev adapter's header. */
  devUser?: string | undefined;
  now?: () => Date;
}

/** How often the Desk is checked while someone is signed in. */
const DESK_EVERY_MS = 60_000;

export class Controller {
  readonly api: Api;
  private session: string | null = null;
  private devicePem: string | null = null;
  private person: DesktopView["person"] = null;
  private desk: DeskRow[] | null = null;
  private seenDesk: Set<string> | null = null;
  private connection: ConnectionStatus = "stopped";
  private lastContactAt: string | null = null;
  private signingIn: { verifier: string } | null = null;
  private notice: DesktopView["notice"] = null;
  private poller: Poller | null = null;
  private readonly ingest: Ingest;
  private deskTimer: ReturnType<typeof setInterval> | null = null;
  private readonly listeners = new Set<(v: DesktopView) => void>();

  constructor(private readonly o: ControllerOptions) {
    this.api = new Api({
      origin: o.origin,
      ...(o.fetch ? { fetch: o.fetch } : {}),
      ...(o.now ? { now: o.now } : {}),
      credentials: () => this.credentials(),
      renewed: (s) => void this.keepSession(s),
      ended: () => void this.endSession(),
      device: () => {
        const d = o.store.get().device;
        return d && this.devicePem ? { deviceId: d.deviceId, privatePem: this.devicePem } : null;
      },
    });
    this.ingest = new Ingest({
      api: this.api,
      since: (id) => {
        const at = o.store.get().given[id];
        return at ? new Date(at) : null;
      },
      sent: (key) => o.store.get().sent[key]?.sha256 ?? null,
      recordSent: (key, sha256) =>
        o.store
          .update((s) => {
            s.sent[key] = { sha256, at: this.now().toISOString() };
          })
          .then(() => undefined),
      log: (kind, text) => o.store.log(kind, text),
    });
    o.store.onChange(() => this.emit());
  }

  private now(): Date {
    return (this.o.now ?? (() => new Date()))();
  }

  private credentials(): Credentials {
    if (this.o.devUser) return { kind: "dev", email: this.o.devUser };
    return this.session ? { kind: "session", session: this.session } : { kind: "none" };
  }

  async start(): Promise<void> {
    await this.o.store.load();
    this.session = await this.o.vault.get("session");
    this.devicePem = await this.o.vault.get("device-key");
    await this.o.store.pruneBackups().catch(() => undefined);
    this.o.shell.setOpenAtLogin(this.o.store.get().settings.openAtLogin);
    if (this.credentials().kind !== "none") await this.loadPerson();
    this.startDevice();
    this.emit();
  }

  stop(): void {
    this.poller?.stop();
    this.ingest.stop();
    if (this.deskTimer) clearInterval(this.deskTimer);
  }

  // ── The view ──

  view(): DesktopView {
    const s = this.o.store.get();
    const working = this.workingFolders();
    const folders: FolderRow[] = s.folders.map((f) => {
      const w = working.find((x) => x.id === f.id);
      return { ...f, onMezonas: Boolean(w), writable: w?.access === "read_write" };
    });
    return {
      version: this.o.shell.appVersion,
      origin: this.api.origin,
      platform: this.o.shell.platform,
      computerName: this.o.shell.computerName,
      person: this.person,
      signingIn: this.signingIn !== null,
      device: s.device ? { name: s.device.name, clientName: s.device.clientName } : null,
      connection: s.device ? this.connection : "unpaired",
      lastContactAt: this.lastContactAt,
      folders,
      desk: this.desk,
      activity: s.activity.slice(0, 50),
      settings: s.settings,
      notice: this.notice,
    };
  }

  onView(listener: (v: DesktopView) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const v = this.view();
    for (const l of this.listeners) l(v);
  }

  private say(tone: "info" | "risk", text: string): void {
    this.notice = { tone, text };
    this.emit();
  }

  async dismissNotice(): Promise<void> {
    this.notice = null;
    this.emit();
  }

  // ── Signing in (the phone app's handoff: browser sign-in, then mezonas://signed-in?code=) ──

  async signIn(): Promise<void> {
    if (this.o.devUser) {
      await this.loadPerson();
      return;
    }
    const { verifier, challenge } = pkcePair();
    this.signingIn = { verifier };
    this.emit();
    await this.o.shell.openExternal(
      // §1.219: `app=desktop`, so the confirm page and the audit rows name this app.
      `${this.api.origin}/api/mobile/sign-in?challenge=${encodeURIComponent(challenge)}&app=desktop`,
    );
  }

  /** A `mezonas://` link the OS handed the app. Only sign-in's is taken. */
  async handleUrl(url: string): Promise<void> {
    if (!url.startsWith(MOBILE_SIGNED_IN_URL)) return;
    const pending = this.signingIn;
    this.signingIn = null;
    const q = new URL(url).searchParams;
    const error = q.get("error");
    const code = q.get("code");
    if (!pending || error || !code) {
      this.say(
        "risk",
        error === "operator"
          ? "The desktop app is for your business's team. Mezonas staff use the back office."
          : "Sign-in didn't finish. Try again.",
      );
      return;
    }
    try {
      const out = await this.api.call(routes.mobileSession, {
        body: { code, verifier: pending.verifier },
      });
      await this.keepSession(out.session);
      await this.loadPerson();
    } catch {
      this.say("risk", "Sign-in didn't finish. Try again.");
    }
  }

  private async keepSession(session: string): Promise<void> {
    this.session = session;
    await this.o.vault.set("session", session).catch(() => undefined);
  }

  private async endSession(): Promise<void> {
    if (!this.session && !this.person) return;
    this.session = null;
    this.person = null;
    this.desk = null;
    this.seenDesk = null;
    if (this.deskTimer) clearInterval(this.deskTimer);
    this.deskTimer = null;
    await this.o.vault.delete("session");
    this.emit();
  }

  async signOut(): Promise<void> {
    try {
      await this.api.call(routes.signOut, { byPerson: true });
    } catch {
      // Signed out here whatever the API says.
    }
    await this.endSession();
  }

  private async loadPerson(): Promise<void> {
    try {
      const me = await this.api.call(routes.session, { byPerson: true });
      const tenant = me.tenants.find((t) => t.id === me.activeTenantId) ?? me.tenants[0];
      this.person = {
        name: me.user.name ?? me.user.email,
        email: me.user.email,
        clientName: tenant?.name ?? null,
        admin: tenant?.role === "client_admin",
      };
      this.emit();
      await this.refreshDesk();
      if (this.deskTimer) clearInterval(this.deskTimer);
      this.deskTimer = setInterval(() => void this.refreshDesk(), DESK_EVERY_MS);
    } catch {
      this.person = null;
      this.emit();
    }
  }

  // ── The Desk ──

  async refreshDesk(): Promise<void> {
    if (!this.person) return;
    try {
      const { items } = await this.api.call(routes.portalInbox, { query: { view: "waiting" } });
      this.desk = items.map((i) => ({ id: i.id, title: i.title, createdAt: i.createdAt }));
      const fresh = this.seenDesk ? items.filter((i) => !this.seenDesk?.has(i.id)) : [];
      this.seenDesk = new Set(items.map((i) => i.id));
      if (fresh.length > 0 && this.o.store.get().settings.notifications) {
        // As the phone's: a count, never amounts, vendors or customers.
        const body =
          fresh.length === 1
            ? "1 new item waits on you."
            : `${fresh.length} new items wait on you.`;
        this.o.shell.notify("Mezonas", body, () => void this.openDesk());
      }
      this.emit();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) await this.endSession();
    }
  }

  async openDesk(): Promise<void> {
    await this.o.shell.openExternal(`${this.api.origin}/desk`);
  }

  // ── Pairing ──

  async pair(name: string): Promise<Result> {
    const trimmed = name.trim();
    if (!trimmed) return { ok: false, message: "Give this computer a name." };
    if (!this.person) return { ok: false, message: "Sign in first." };
    if (!this.person.admin) {
      return { ok: false, message: "Only an admin of your business can add a computer." };
    }
    if (!this.o.vault.available()) {
      return {
        ok: false,
        message:
          "This computer can't keep the app's key safely (no keychain), so it can't be added.",
      };
    }
    const key = newDeviceKey();
    try {
      const res = await this.api.asPerson("POST", DESKTOP_PATHS.devices, {
        name: trimmed,
        platform: this.o.shell.platform,
        appVersion: this.o.shell.appVersion,
        publicKey: key.publicJwk,
      });
      const paired = PairedDesktop.parse(await res.json());
      await this.o.vault.set("device-key", key.privatePem);
      this.devicePem = key.privatePem;
      await this.o.store.update((s) => {
        s.device = { ...paired, name: trimmed, platform: this.o.shell.platform };
      });
      await this.o.store.log("info", `Added this computer to ${paired.clientName} as ${trimmed}`);
      this.startDevice();
      return { ok: true };
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        return {
          ok: false,
          message: "Mezonas can't add computers yet. We'll let you know when it can.",
        };
      }
      return {
        ok: false,
        message: e instanceof ApiError ? e.message : "This computer wasn't added. Try again.",
      };
    }
  }

  async unpair(): Promise<Result> {
    const d = this.o.store.get().device;
    if (!d) return { ok: true };
    try {
      await this.api.asPerson(
        "DELETE",
        `${DESKTOP_PATHS.devices}/${encodeURIComponent(d.deviceId)}`,
      );
    } catch (e) {
      // Already gone on Mezonas's side is fine; anything else is said, and we remove it here anyway.
      if (!(e instanceof ApiError && (e.status === 404 || e.status === 401))) {
        this.say(
          "risk",
          "We removed this computer here; ask your Mezonas lead to check the portal.",
        );
      }
    }
    this.poller?.stop();
    this.poller = null;
    this.ingest.stop();
    this.devicePem = null;
    await this.o.vault.delete("device-key");
    await this.o.store.unpair();
    return { ok: true };
  }

  private startDevice(): void {
    const d = this.o.store.get().device;
    if (!d || !this.devicePem) return;
    this.poller?.stop();
    this.poller = new Poller({
      api: this.api,
      run: async (job) => {
        const result = await runJob(job, {
          folders: () => this.workingFolders(),
          platform: this.o.shell.platform,
          doneOutput: (k) => this.o.store.doneOutput(k),
          recordDone: (k, out) => this.o.store.recordDone(k, out),
          backup: (p, id) => this.o.store.backup(p, id),
          now: () => this.now(),
        });
        await this.o.store.log(...describeJob(job.request, result, this.o.store.get().folders));
        return result;
      },
      folders: async (list) => {
        await this.o.store.update((s) => {
          s.platformFolders = list;
        });
        await this.ingest.use(this.workingFolders());
      },
      status: (status, at) => {
        if (status === "unpaired" && this.connection !== "unpaired") {
          this.say("risk", "Mezonas no longer knows this computer. Add it again to keep working.");
        }
        this.connection = status;
        if (status === "online") this.lastContactAt = at.toISOString();
        this.emit();
      },
    });
    this.poller.start();
    void this.ingest.use(this.workingFolders());
  }

  // ── Folders ──

  /** The folders this computer works in now: on both lists, with the stricter access. */
  workingFolders(): DesktopFolder[] {
    const s = this.o.store.get();
    return effectiveFolders(s.folders, s.platformFolders);
  }

  async chooseFolder(): Promise<
    { ok: true; path: string; label: string } | { ok: false; message: string } | null
  > {
    const picked = await this.o.shell.chooseFolder();
    if (!picked) return null;
    const checked = await this.checkFolder(picked);
    return checked.ok ? { ok: true, path: checked.path, label: basename(checked.path) } : checked;
  }

  private async checkFolder(
    path: string,
  ): Promise<{ ok: true; path: string } | { ok: false; message: string }> {
    let real: string;
    try {
      real = await realpath(path);
    } catch {
      return { ok: false, message: "That folder isn't there." };
    }
    const platform = this.o.shell.platform;
    const problem = folderGrantProblem(real, platform, this.o.shell.homedir);
    if (problem) return { ok: false, message: problem };
    const normal = normaliseDevicePath(real, platform) ?? real;
    if (this.o.store.get().folders.some((f) => f.path.toLowerCase() === normal.toLowerCase())) {
      return { ok: false, message: "Mezonas already has that folder." };
    }
    return { ok: true, path: normal };
  }

  async addFolder(input: NewFolder): Promise<Result> {
    if (!this.o.store.get().device)
      return { ok: false, message: "Add this computer to Mezonas first." };
    if (this.o.store.get().folders.length >= DESKTOP_MAX_FOLDERS) {
      return { ok: false, message: `A computer can give at most ${DESKTOP_MAX_FOLDERS} folders.` };
    }
    // Checked again here: the window is less trusted than this process.
    const checked = await this.checkFolder(input.path);
    if (!checked.ok) return checked;
    const folder = DesktopFolderSchema.safeParse({
      id: randomUUID(),
      path: checked.path,
      label: input.label,
      access: input.access,
      ingest: input.ingest,
    });
    if (!folder.success)
      return { ok: false, message: "Give the folder a name of up to 80 characters." };
    await this.o.store.update((s) => {
      s.folders.push(folder.data);
      s.given[folder.data.id] = this.now().toISOString();
    });
    await this.o.store.log(
      "info",
      `Gave ${folder.data.label} to Mezonas (${accessWords(folder.data)})`,
    );
    return this.syncFolders();
  }

  async updateFolder(
    id: string,
    patch: Partial<Pick<DesktopFolder, "label" | "access" | "ingest">>,
  ): Promise<Result> {
    const current = this.o.store.get().folders.find((f) => f.id === id);
    if (!current) return { ok: false, message: "That folder isn't on the list." };
    const next = DesktopFolderSchema.safeParse({ ...current, ...patch });
    if (!next.success)
      return { ok: false, message: "Give the folder a name of up to 80 characters." };
    await this.o.store.update((s) => {
      s.folders = s.folders.map((f) => (f.id === id ? next.data : f));
      // Turning sending on starts from now, as a new folder does.
      if (patch.ingest && !current.ingest) s.given[id] = this.now().toISOString();
    });
    await this.o.store.log("info", `${next.data.label}: ${accessWords(next.data)}`);
    return this.syncFolders();
  }

  async removeFolder(id: string): Promise<Result> {
    const current = this.o.store.get().folders.find((f) => f.id === id);
    if (!current) return { ok: true };
    // Removed here first: from now on this computer refuses its jobs, whatever Mezonas says.
    await this.o.store.update((s) => {
      s.folders = s.folders.filter((f) => f.id !== id);
      delete s.given[id];
    });
    await this.o.store.log("info", `Took ${current.label} back from Mezonas`);
    await this.ingest.use(this.workingFolders());
    return this.syncFolders();
  }

  async showFolder(id: string): Promise<void> {
    const f = this.o.store.get().folders.find((x) => x.id === id);
    if (f) await this.o.shell.showFolder(f.path);
  }

  /** Sends this computer's folder list to Mezonas (a client admin's session). */
  private async syncFolders(): Promise<Result> {
    const s = this.o.store.get();
    await this.ingest.use(this.workingFolders());
    if (!s.device) return { ok: true };
    try {
      const res = await this.api.asPerson("PUT", DESKTOP_PATHS.folders(s.device.deviceId), {
        folders: s.folders,
      });
      const body = (await res.json().catch(() => null)) as { folders?: unknown } | null;
      const parsed = DesktopFolderSchema.array().safeParse(body?.folders);
      if (parsed.success) {
        await this.o.store.update((st) => {
          st.platformFolders = parsed.data;
        });
      }
      await this.ingest.use(this.workingFolders());
      return { ok: true };
    } catch (e) {
      // Kept here; Mezonas takes it once someone who can sign in as an admin opens the app.
      const message =
        e instanceof ApiError && e.code === "signed_out"
          ? "Saved on this computer. Sign in as an admin so Mezonas can use it."
          : e instanceof ApiError && e.status === 403
            ? "Saved on this computer. Only an admin of your business can give Mezonas a folder."
            : "Saved on this computer. Mezonas will use it once it's reachable.";
      this.say("info", message);
      return { ok: true };
    }
  }

  async setSettings(patch: Partial<DesktopView["settings"]>): Promise<void> {
    await this.o.store.update((s) => {
      s.settings = { ...s.settings, ...patch };
    });
    if (patch.openAtLogin !== undefined) this.o.shell.setOpenAtLogin(patch.openAtLogin);
  }
}

function accessWords(f: DesktopFolder): string {
  const access = f.access === "read_write" ? "read and change" : "read only";
  return f.ingest ? `${access}, sends new files` : access;
}

/** One activity row for a job: what was done, in plain words. Never the file's contents. */
export function describeJob(
  request: import("@countersign/core").DesktopJobRequest,
  result: import("@countersign/core").DesktopJobResult,
  folders: readonly DesktopFolder[],
): ["read" | "write" | "refused" | "error", string] {
  const label = folders.find((f) => f.id === request.folderId)?.label ?? "a folder";
  const where = "path" in request && request.path ? `${request.path} in ${label}` : label;
  if (!result.ok) {
    const kind = result.error.code === "failed" ? "error" : "refused";
    return [kind, `Didn't ${verbOf(request.kind)} ${where}: ${result.error.message}`];
  }
  const out = result.output as Record<string, unknown>;
  switch (request.kind) {
    case "xlsx.append":
      return [
        "write",
        `Added ${request.rows.length} row(s) to ${where}${out.alreadyDone ? " (already done)" : ""}`,
      ];
    case "xlsx.update":
      return [
        "write",
        `Changed ${request.range} in ${where}${out.alreadyDone ? " (already done)" : ""}`,
      ];
    case "file.create":
      return ["write", `Saved ${where}`];
    case "files.list":
      return ["read", `Listed ${where}`];
    default:
      return ["read", `Read ${where}`];
  }
}

function verbOf(kind: string): string {
  switch (kind) {
    case "xlsx.append":
      return "add rows to";
    case "xlsx.update":
      return "change";
    case "file.create":
      return "save";
    case "files.list":
      return "list";
    default:
      return "read";
  }
}
