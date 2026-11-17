// Where a job's file is on this computer, checked again here (docs/plan.md §1.151): the platform
// already refused paths outside the folders it knows, but this computer holds to its own list and
// to the disk as it is, after following links. A path that leaves its folder through a symbolic
// link, a junction or an alias is refused like one written with "..".

import { lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  type DesktopFolder,
  type DesktopPlatform,
  isWithin,
  normaliseDevicePath,
  relativePathProblem,
} from "@countersign/core";

/** This computer's platform as the protocol names it; Linux (tests, development) reads as a Mac. */
export function devicePlatform(platform: NodeJS.Platform = process.platform): DesktopPlatform {
  return platform === "win32" ? "windows" : "mac";
}

export class GuardProblem extends Error {
  constructor(
    readonly code: "not_granted" | "read_only" | "not_found" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "GuardProblem";
  }
}

const isMissing = (e: unknown) => (e as NodeJS.ErrnoException | null)?.code === "ENOENT";

/** The folder's own path on disk, links followed. */
async function rootOf(folder: DesktopFolder, platform: DesktopPlatform): Promise<string> {
  try {
    const real = await realpath(folder.path);
    if (!(await lstat(real)).isDirectory()) throw new Error("not a folder");
    return normaliseDevicePath(real, platform) ?? real;
  } catch {
    throw new GuardProblem(
      "not_found",
      `The folder ${folder.label} isn't on this computer any more. Choose it again in Mezonas.`,
    );
  }
}

function inside(root: string, target: string, platform: DesktopPlatform): boolean {
  const t = normaliseDevicePath(target, platform);
  return t !== null && isWithin(root, t, platform);
}

/**
 * The absolute path of `relative` in `folder`, after links are followed. `existing`: it must be
 * there (a read, a change); `new`: it must not be checked for existence here, but its folder must
 * be inside the grant (made if needed, for a new file).
 */
export async function resolveInFolder(
  folder: DesktopFolder,
  relative: string | undefined,
  options: { platform: DesktopPlatform; mode: "existing" | "new" },
): Promise<string> {
  const root = await rootOf(folder, options.platform);
  if (relative === undefined || relative === "") return root;
  const problem = relativePathProblem(relative);
  if (problem) throw new GuardProblem("invalid", `That path can't be used: ${problem}.`);
  const parts = relative.split("/");
  const candidate = join(root, ...parts);
  if (options.mode === "existing") {
    let real: string;
    try {
      real = await realpath(candidate);
    } catch (e) {
      if (isMissing(e))
        throw new GuardProblem("not_found", `There's no ${relative} in ${folder.label}.`);
      throw e;
    }
    if (!inside(root, real, options.platform)) {
      throw new GuardProblem("not_granted", `${relative} leads outside ${folder.label}.`);
    }
    return real;
  }
  // A new file: its folder is made inside the grant, then checked once links are followed.
  const parent = join(root, ...parts.slice(0, -1));
  await mkdir(parent, { recursive: true });
  const realParent = await realpath(parent);
  if (!inside(root, realParent, options.platform)) {
    throw new GuardProblem("not_granted", `${relative} leads outside ${folder.label}.`);
  }
  return join(realParent, parts[parts.length - 1] ?? "");
}

/**
 * The folders this computer works in: those on both its own list and the platform's, each with
 * the stricter access. A folder taken off either list is out at once.
 */
export function effectiveFolders(
  local: readonly DesktopFolder[],
  platform: readonly DesktopFolder[] | null,
): DesktopFolder[] {
  if (platform === null) return [...local];
  return local.flatMap((mine) => {
    const theirs = platform.find((f) => f.id === mine.id);
    if (!theirs) return [];
    const access =
      mine.access === "read_write" && theirs.access === "read_write" ? "read_write" : "read";
    return [{ ...mine, access, ingest: mine.ingest && theirs.ingest }];
  });
}
