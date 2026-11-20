// SEC lens: the desktop app's folder guard (apps/desktop/src/main/guard.ts), the check every job's
// path goes through on the client's computer (jobs.ts runJob → resolveInFolder). Node only, on a
// temporary directory; imported by relative path (apps/desktop is not a package of the API).
import { mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { GuardProblem, resolveInFolder } from "../../../desktop/src/main/guard";

const base = await mkdtemp(join(tmpdir(), "sec-desktop-"));
afterAll(() => rm(base, { recursive: true, force: true }));

describe("SEC: the desktop folder guard", () => {
  it("SEC-7: a new file through a linked folder makes no directory outside the grant", async () => {
    const granted = join(base, "Accounting");
    const outside = join(base, "Private");
    await mkdir(granted);
    await mkdir(outside);
    // A link inside the granted folder to a folder the client never gave Mezonas.
    await symlink(outside, join(granted, "shortcut"));
    const folder = {
      id: "0190f5e8-8a3c-7d6e-8f00-000000000abc",
      path: granted,
      label: "Accounting",
      access: "read_write" as const,
      ingest: false,
    };
    const refused = await resolveInFolder(folder, "shortcut/made-by-mezonas/new.xlsx", {
      platform: "mac",
      mode: "new",
    }).catch((e: unknown) => e);
    // The guard refuses the path ...
    expect(refused).toBeInstanceOf(GuardProblem);
    // ... but must not have changed the disk outside the grant on the way.
    expect(await readdir(outside)).toEqual([]);
  });
});
