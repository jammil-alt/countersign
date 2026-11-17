// Whether someone has a workbook open (docs/plan.md §1.124). We write a workbook only while it is
// closed: Excel keeps its own copy in memory and would overwrite ours on its next save, or the
// person would lose theirs.
// DECISION: two signs, either is enough. Excel's owner file (`~$Name.xlsx`, beside the workbook,
// on Windows and on a Mac), and on Windows an exclusive open that fails because Excel holds the
// file. What isn't checked on real computers is in packages/connectors/src/desktop/NOTES.md.

import { access, open } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** The owner files Office may leave beside a workbook while it is open. */
export function ownerFileNames(name: string): string[] {
  const names = [`~$${name}`];
  // Office shortens the owner file of a long name by dropping its first characters.
  if (name.length > 2) names.push(`~$${name.slice(2)}`);
  if (name.length > 1) names.push(`~$${name.slice(1)}`);
  return names;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function workbookInUse(
  path: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  const dir = dirname(path);
  for (const owner of ownerFileNames(basename(path))) {
    if (await exists(join(dir, owner))) return true;
  }
  if (platform === "win32") {
    try {
      const handle = await open(path, "r+");
      await handle.close();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EBUSY" || code === "EPERM" || code === "EACCES") return true;
    }
  }
  return false;
}
