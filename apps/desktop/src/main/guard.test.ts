// The folder guard every job's path goes through on the client's computer (jobs.ts runJob →
// resolveInFolder), on a temporary directory: a new file through a link that leaves the granted
// folder is refused without changing the disk outside the grant (PLATFORM_QA SEC-7).
import { mkdir, mkdtemp, readdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { GuardProblem, resolveInFolder } from "./guard";

const base = await mkdtemp(join(tmpdir(), "guard-"));
afterAll(() => rm(base, { recursive: true, force: true }));

let n = 0;
async function granted() {
  n += 1;
  const path = join(base, `Accounting-${n}`);
  const outside = join(base, `Private-${n}`);
  await mkdir(path);
  await mkdir(outside);
  const folder = {
    id: "0190f5e8-8a3c-7d6e-8f00-000000000abc",
    path,
    label: "Accounting",
    access: "read_write" as const,
    ingest: false,
  };
  return { folder, path, outside };
}

describe("a new file's folder", () => {
  it("(PLATFORM_QA SEC-7) a new file through a linked folder makes no directory outside the grant", async () => {
    const { folder, path, outside } = await granted();
    // A link inside the granted folder to a folder the client never gave Mezonas.
    await symlink(outside, join(path, "shortcut"));
    const refused = await resolveInFolder(folder, "shortcut/made-by-mezonas/new.xlsx", {
      platform: "mac",
      mode: "new",
    }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(GuardProblem);
    expect((refused as GuardProblem).code).toBe("not_granted");
    expect(await readdir(outside)).toEqual([]);
  });

  it("(PLATFORM_QA SEC-7) a link to a folder that isn't there is refused, not followed", async () => {
    const { folder, path, outside } = await granted();
    await symlink(join(outside, "gone"), join(path, "dangling"));
    const refused = await resolveInFolder(folder, "dangling/new.xlsx", {
      platform: "mac",
      mode: "new",
    }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(GuardProblem);
    expect(await readdir(outside)).toEqual([]);
  });

  it("makes the missing folders inside the grant, level by level", async () => {
    const { folder, path } = await granted();
    await mkdir(join(path, "2026"));
    const target = await resolveInFolder(folder, "2026/November/week 3/new.xlsx", {
      platform: "mac",
      mode: "new",
    });
    expect(target.endsWith(join("2026", "November", "week 3", "new.xlsx"))).toBe(true);
    expect((await stat(join(path, "2026", "November", "week 3"))).isDirectory()).toBe(true);
    // A new file at the top needs nothing made.
    const top = await resolveInFolder(folder, "top.xlsx", { platform: "mac", mode: "new" });
    expect(top.endsWith("top.xlsx")).toBe(true);
  });
});
