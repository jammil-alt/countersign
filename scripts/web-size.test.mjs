// What scripts/web-size.mjs counts as the first load: the entry chunks in Vite's manifest and the
// chunks they import statically, never lazy (`dynamicImports`) chunks.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { firstLoad, firstLoadFiles } from "./web-size.mjs";

const manifest = {
  "index.html": {
    file: "assets/index-a.js",
    isEntry: true,
    imports: ["_ui-b.js", "_runtime-d.js"],
    dynamicImports: ["src/OpsApp.tsx"],
    css: ["assets/index-c.css"],
  },
  "_ui-b.js": { file: "assets/ui-b.js", imports: ["_shared-f.js", "_runtime-d.js"] },
  "_runtime-d.js": { file: "assets/runtime-d.js" },
  "_shared-f.js": { file: "assets/shared-f.js" },
  "src/OpsApp.tsx": { file: "assets/OpsApp-e.js", isDynamicEntry: true, imports: ["_lazy-g.js"] },
  "_lazy-g.js": { file: "assets/lazy-g.js" },
};

test("follows the entry and its static imports, not lazy chunks", () => {
  assert.deepEqual(firstLoadFiles(manifest).sort(), [
    "assets/index-a.js",
    "assets/runtime-d.js",
    "assets/shared-f.js",
    "assets/ui-b.js",
  ]);
});

test("fails on a manifest with no entry, or that names a chunk it lacks", () => {
  assert.throws(() => firstLoadFiles({ "_x.js": { file: "assets/x.js" } }), /no entry/);
  assert.throws(
    () => firstLoadFiles({ "index.html": { file: "a.js", isEntry: true, imports: ["_gone.js"] } }),
    /no entry for it/,
  );
});

test("measures the files and fails when the build did not write one", () => {
  const dir = mkdtempSync(join(tmpdir(), "web-size-"));
  try {
    mkdirSync(join(dir, ".vite"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, ".vite", "manifest.json"), JSON.stringify(manifest));
    for (const name of ["index-a", "ui-b", "runtime-d", "shared-f"]) {
      writeFileSync(join(dir, "assets", `${name}.js`), "x".repeat(100));
    }
    assert.equal(firstLoad(dir).size, 4);
    rmSync(join(dir, "assets", "shared-f.js"));
    assert.throws(() => firstLoad(dir), /did not write/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
