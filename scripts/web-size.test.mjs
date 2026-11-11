// What scripts/web-size.mjs counts as the first load: index.html's module scripts and preloads and
// their static imports, never lazy `import()` chunks or other pages' scripts.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { firstLoad } from "./web-size.mjs";

function dist(files) {
  const dir = mkdtempSync(join(tmpdir(), "web-size-"));
  mkdirSync(join(dir, "assets"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

test("follows the entry, its preloads and static imports, not lazy chunks", () => {
  const dir = dist({
    "index.html":
      '<script type="module" crossorigin src="/assets/index-a.js"></script>' +
      '<link rel="modulepreload" crossorigin href="/assets/ui-b.js">' +
      '<link rel="stylesheet" href="/assets/index-c.css">' +
      '<script src="https://example.com/other.js"></script>',
    "assets/index-a.js":
      'import{a as b}from"./ui-b.js";import"./runtime-d.js";const L=()=>import("./OpsApp-e.js");',
    "assets/ui-b.js": 'export*from"./shared-f.js";export const a=1;',
    "assets/runtime-d.js": "x",
    "assets/shared-f.js": "y",
    "assets/OpsApp-e.js": "lazy",
    "assets/index-c.css": "body{}",
  });
  try {
    assert.deepEqual([...firstLoad(dir).keys()].sort(), [
      "assets/index-a.js",
      "assets/runtime-d.js",
      "assets/shared-f.js",
      "assets/ui-b.js",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fails when index.html needs a file the build did not write", () => {
  const dir = dist({ "index.html": '<script type="module" src="/assets/gone.js"></script>' });
  try {
    assert.throws(() => firstLoad(dir), /did not write/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
