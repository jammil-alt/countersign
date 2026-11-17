// Sending a folder's files (ingest.ts): the file checked is the file sent, once, and a link is
// never followed out of the folder.

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesktopFolder } from "@countersign/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Api } from "./api";
import { Ingest } from "./ingest";

let root: string;
let folder: DesktopFolder;
let posts: number;
let sent: Map<string, string>;

function ingest(): Ingest {
  const api = {
    asDevice: async () => {
      posts++;
      return new Response("{}", { status: 201 });
    },
  } as unknown as Api;
  return new Ingest({
    api,
    since: () => null,
    sent: (key) => sent.get(key) ?? null,
    recordSent: async (key, sha) => {
      sent.set(key, sha);
    },
    log: async () => {},
    sleep: async () => {},
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mezonas-ingest-"));
  await writeFile(join(root, "outside.pdf"), "%PDF-1.4 not in the folder");
  const path = join(root, "Accounting");
  await mkdir(path);
  folder = {
    id: "00000000-0000-4000-8000-000000000001",
    path,
    label: "Accounting",
    access: "read",
    ingest: true,
  } as DesktopFolder;
  posts = 0;
  sent = new Map();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("sending a folder's files", () => {
  it("sends a file once, and again only when it changes", async () => {
    const file = join(folder.path, "invoice.pdf");
    await writeFile(file, "%PDF-1.4 one");
    const i = ingest();
    expect(await i.consider(folder, file)).toBe("sent");
    expect(await i.consider(folder, file)).toBe("skipped");
    await writeFile(file, "%PDF-1.4 two");
    expect(await i.consider(folder, file)).toBe("sent");
    expect(posts).toBe(2);
  });

  it.skipIf(process.platform === "win32")("never follows a link out of the folder", async () => {
    const link = join(folder.path, "invoice.pdf");
    await symlink(join(root, "outside.pdf"), link);
    expect(await ingest().consider(folder, link)).not.toBe("sent");
    expect(posts).toBe(0);
  });
});
