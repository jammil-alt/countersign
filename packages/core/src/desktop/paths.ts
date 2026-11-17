// The Mezonas desktop app (docs/plan.md §1.124): which folders on a client's computer can be given
// to Mezonas, and which paths inside them a job may name. Pure string rules, shared by apps/api
// (which refuses a job outside a grant before it is sent) and apps/desktop (which checks again on
// the computer, after resolving links with the file system). Nothing here touches a disk.

import { z } from "zod";

export const DesktopPlatform = z.enum(["mac", "windows"]);
export type DesktopPlatform = z.infer<typeof DesktopPlatform>;

/** What a folder grant lets Mezonas do there. Delete is never offered. */
export const FolderAccess = z.enum(["read", "read_write"]);
export type FolderAccess = z.infer<typeof FolderAccess>;

/** Longest absolute folder path we keep, and longest relative path a job may name. */
export const DESKTOP_MAX_PATH = 1024;
/** Folders one computer may give. */
export const DESKTOP_MAX_FOLDERS = 20;

/**
 * A path as the computer shows it, normalised for comparing: separators made one kind, repeated
 * separators collapsed, a trailing separator dropped. Null when it isn't absolute for the platform
 * or carries a `.` or `..` segment (a grant is never named through one).
 */
export function normaliseDevicePath(path: string, platform: DesktopPlatform): string | null {
  if (path.length === 0 || path.length > DESKTOP_MAX_PATH) return null;
  for (let i = 0; i < path.length; i++) {
    if (path.charCodeAt(i) < 32) return null;
  }
  if (platform === "windows") {
    const p = path.split("/").join("\\");
    // A drive path only (C:\...): no UNC shares (\\server\share) or device paths (\\?\) in v1.
    // DECISION: network shares are left out until a client asks; a mapped drive letter works.
    const drive = p.charCodeAt(0);
    const isLetter = (drive >= 65 && drive <= 90) || (drive >= 97 && drive <= 122);
    if (!isLetter || p[1] !== ":" || p[2] !== "\\") return null;
    const segments = p
      .slice(3)
      .split("\\")
      .filter((s) => s.length > 0);
    if (segments.some((s) => s === "." || s === ".." || s.includes(":"))) return null;
    return `${p[0]?.toUpperCase()}:\\${segments.join("\\")}`;
  }
  if (!path.startsWith("/")) return null;
  const segments = path.split("/").filter((s) => s.length > 0);
  if (segments.some((s) => s === "." || s === "..")) return null;
  return `/${segments.join("/")}`;
}

function separator(platform: DesktopPlatform): string {
  return platform === "windows" ? "\\" : "/";
}

/** Path comparison: case-insensitive on both platforms (NTFS and APFS by default). */
function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Whether `inner` is `outer` or below it (both normalised). */
export function isWithin(outer: string, inner: string, platform: DesktopPlatform): boolean {
  if (same(outer, inner)) return true;
  const sep = separator(platform);
  const prefix = outer.endsWith(sep) ? outer : `${outer}${sep}`;
  return inner.toLowerCase().startsWith(prefix.toLowerCase());
}

const MAC_SYSTEM = [
  "/System",
  "/Library",
  "/Applications",
  "/bin",
  "/sbin",
  "/usr",
  "/private",
  "/etc",
  "/var",
  "/tmp",
  "/dev",
  "/cores",
  "/opt",
];
const WINDOWS_SYSTEM = ["\\Windows", "\\Program Files", "\\Program Files (x86)", "\\ProgramData"];

/**
 * Why a folder can't be given to Mezonas, or null when it can. `home` is the person's home folder
 * on that computer. Refused: the top of a disk, the home folder itself or anything above it,
 * system folders, hidden folders directly in the home folder, `~/Library` on a Mac and `AppData`
 * on Windows (other apps' data and keys live there), and `/Volumes` itself (a drive inside it is
 * fine).
 */
// DECISION: the same rule as Remote Control's folders for cloud sessions: never home itself, never a
// hidden folder directly under it, never ~/Library. A person gives the folder that holds the work
// (Documents/Accounting), not the whole account.
export function folderGrantProblem(
  path: string,
  platform: DesktopPlatform,
  home: string,
): string | null {
  const p = normaliseDevicePath(path, platform);
  if (p === null) return "Choose a folder on this computer's own drive.";
  const h = normaliseDevicePath(home, platform);
  const sep = separator(platform);
  const segments = platform === "windows" ? p.slice(3).split(sep) : p.slice(1).split(sep);
  if (segments.length === 0 || segments[0] === "") return "Choose a folder, not the whole drive.";
  if (h !== null && isWithin(p, h, platform)) {
    return "Choose a folder inside your home folder, not the home folder itself.";
  }
  if (platform === "windows") {
    const rest = p.slice(2);
    if (WINDOWS_SYSTEM.some((s) => isWithin(s, rest, platform))) {
      return "System folders can't be given to Mezonas.";
    }
  } else {
    if (MAC_SYSTEM.some((s) => isWithin(s, p, platform))) {
      return "System folders can't be given to Mezonas.";
    }
    if (same(p, "/Volumes") || same(p, "/Users")) return "Choose a folder, not the whole drive.";
  }
  if (h !== null && isWithin(h, p, platform)) {
    const below = p.slice(h.length + 1).split(sep);
    const first = below[0] ?? "";
    if (first.startsWith(".")) return "Hidden folders can't be given to Mezonas.";
    if (platform === "mac" && same(first, "Library")) {
      return "Your Library folder holds other apps' data and can't be given to Mezonas.";
    }
    if (platform === "windows" && same(first, "AppData")) {
      return "AppData holds other apps' data and can't be given to Mezonas.";
    }
  }
  return null;
}

const WINDOWS_RESERVED = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

/** Why a path inside a granted folder is refused, or null. Always `/`-separated, never absolute. */
export function relativePathProblem(path: string): string | null {
  if (path.length === 0) return "empty path";
  if (path.length > DESKTOP_MAX_PATH) return "path too long";
  if (path.startsWith("/")) return "the path must be inside the folder, not absolute";
  for (let i = 0; i < path.length; i++) {
    const c = path.charCodeAt(i);
    if (c < 32) return "the path has a control character";
    // Backslash, colon (drive letters, Windows streams) and the characters Windows refuses.
    if (c === 92 || c === 58 || c === 42 || c === 63 || c === 34 || c === 60 || c === 62) {
      return "the path has a character files can't have";
    }
    if (c === 124) return "the path has a character files can't have";
  }
  for (const segment of path.split("/")) {
    if (segment.length === 0) return "the path has an empty part";
    if (segment === "." || segment === "..") return "the path must stay inside the folder";
    if (segment.length > 255) return "a name in the path is too long";
    if (segment.endsWith(" ") || segment.endsWith(".")) {
      return "a name can't end with a space or a full stop";
    }
    const stem = (segment.split(".")[0] ?? "").toLowerCase();
    if (WINDOWS_RESERVED.has(stem)) return "the path has a name Windows reserves";
  }
  return null;
}

/** A path inside a granted folder, `/`-separated (`Invoices/2026/Northside 1042.pdf`). */
export const DesktopRelativePath = z
  .string()
  .max(DESKTOP_MAX_PATH)
  .superRefine((p, ctx) => {
    const problem = relativePathProblem(p);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  });

/** The extension of a name, lower case, without the dot ("" when it has none). */
export function extensionOf(name: string): string {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

/**
 * The files the desktop app sends to Mezonas from a granted folder, by extension, with the type
 * the documents capability stores them as. Anything else stays on the computer.
 */
// DECISION: documents and the office files agents work with, nothing else: no archives, programs,
// scripts or mail stores, under every setting. Old binary .xls is not read in v1.
export const DESKTOP_FILE_TYPES: Readonly<Record<string, string>> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  heic: "image/heic",
  webp: "image/webp",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  csv: "text/csv",
  txt: "text/plain",
  md: "text/markdown",
};

/** Text files a job may read as text, or create. */
export const DESKTOP_TEXT_TYPES: ReadonlySet<string> = new Set(["csv", "txt", "md"]);

/** The largest file the app sends or reads: 25 MiB. */
export const DESKTOP_MAX_FILE_BYTES = 25 * 1024 * 1024;

/** The type a file goes to Mezonas as, or null when it stays on the computer. */
export function desktopFileType(name: string): string | null {
  const base = name.slice(name.lastIndexOf("/") + 1);
  // Office's lock files (~$Budget.xlsx) and hidden files never go.
  if (base.startsWith("~$") || base.startsWith(".")) return null;
  return DESKTOP_FILE_TYPES[extensionOf(base)] ?? null;
}
