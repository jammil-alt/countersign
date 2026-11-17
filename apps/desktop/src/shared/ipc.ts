// What the window and the main process say to each other (docs/plan.md §1.124). The window never
// touches files, keys or the network: it asks the main process through `window.mezonas`, which
// the preload exposes, and gets plain data back. Shared by the main process, the preload and the
// window; types only, plus the channel names.

import type { DesktopFolder, FolderAccess } from "@countersign/core";

export type ConnectionState = "online" | "offline" | "waiting" | "unpaired" | "stopped";

export interface ActivityRow {
  id: string;
  at: string;
  kind: "read" | "write" | "sent" | "refused" | "error" | "info";
  text: string;
}

export interface FolderRow extends DesktopFolder {
  /** On Mezonas's list too (jobs reach it); false while the platform hasn't taken it yet. */
  onMezonas: boolean;
  /** Mezonas allows changes here too (the stricter of both lists wins). */
  writable: boolean;
}

export interface DeskRow {
  id: string;
  title: string;
  createdAt: string;
}

export interface DesktopView {
  version: string;
  origin: string;
  platform: "mac" | "windows";
  /** This computer's own name, offered when it is added. */
  computerName: string;
  /** The person signed in, or null. Pairing and folder changes need a client admin. */
  person: { name: string; email: string; clientName: string | null; admin: boolean } | null;
  /** True while we wait for the browser to hand sign-in back. */
  signingIn: boolean;
  /** This computer, once paired. */
  device: { name: string; clientName: string } | null;
  connection: ConnectionState;
  lastContactAt: string | null;
  folders: FolderRow[];
  /** What waits on the person (titles only); null when signed out. */
  desk: DeskRow[] | null;
  activity: ActivityRow[];
  settings: { notifications: boolean; openAtLogin: boolean };
  /** A message for the person after something they did (pairing refused, a folder refused). */
  notice: { tone: "info" | "risk"; text: string } | null;
}

export type Result = { ok: true } | { ok: false; message: string };

export interface NewFolder {
  path: string;
  label: string;
  access: FolderAccess;
  ingest: boolean;
}

/** `window.mezonas` in the window. */
export interface DesktopBridge {
  view(): Promise<DesktopView>;
  onView(listener: (view: DesktopView) => void): () => void;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  pair(name: string): Promise<Result>;
  unpair(): Promise<Result>;
  /** The OS folder picker; the folder checked, with a suggested label. */
  chooseFolder(): Promise<
    ({ ok: true; path: string; label: string } | { ok: false; message: string }) | null
  >;
  addFolder(folder: NewFolder): Promise<Result>;
  updateFolder(
    id: string,
    patch: Partial<Pick<DesktopFolder, "label" | "access" | "ingest">>,
  ): Promise<Result>;
  removeFolder(id: string): Promise<Result>;
  showFolder(id: string): Promise<void>;
  openDesk(): Promise<void>;
  setSettings(patch: Partial<DesktopView["settings"]>): Promise<void>;
  dismissNotice(): Promise<void>;
}

export const IPC = {
  view: "mezonas:view",
  viewChanged: "mezonas:view-changed",
  call: "mezonas:call",
} as const;

/** The bridge's methods the window may call through `IPC.call` (everything but `onView`). */
export const BRIDGE_METHODS = [
  "view",
  "signIn",
  "signOut",
  "pair",
  "unpair",
  "chooseFolder",
  "addFolder",
  "updateFolder",
  "removeFolder",
  "showFolder",
  "openDesk",
  "setSettings",
  "dismissNotice",
] as const satisfies readonly Exclude<keyof DesktopBridge, "onView">[];
export type BridgeMethod = (typeof BRIDGE_METHODS)[number];
