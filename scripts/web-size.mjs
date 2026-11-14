// The web app's first load, gzipped, against a budget (docs/audit-plan.md 9.6). Run after
// `pnpm --filter @countersign/web build --manifest`; checks.yml runs it on every pull request and
// deploy.
//
// The first load is every script a fresh visit fetches before any lazy screen: the entry chunk of
// index.html and every chunk it needs through static imports, as Vite's build manifest
// (dist/.vite/manifest.json) lists them. Lazy chunks (`dynamicImports`) and CSS are left out.
// Measured this way rather than by chunk name, so splitting or renaming chunks (phase 4) can't hide
// growth. Read from the manifest, not by parsing the HTML or the chunks, so what counts is what
// the bundler itself wrote down.
//
//   node scripts/web-size.mjs [dist]    exits 1 when the first load is over the budget

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

// DECISION: the budget is today's first load plus 2%, so it stops growth now: 460.4 kB measured
// as above on 2026-11-11 (speed/run at b840a1c), built with a Sentry DSN as deploys are (checks.yml
// builds with a placeholder DSN), so 470 kB. It is lowered to phase 4's target, 300 kB, once phase
// 4 lands (docs/audit-plan.md). The one place it is set; kB here are 1,000 bytes, as Vite prints.
export const BUDGET_KB = 470;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = process.argv[2] ?? join(root, "apps/web/dist");

/**
 * The files of the entry chunks and of every chunk they import statically, from a Vite manifest:
 * `{ [key]: { file, isEntry?, imports?: key[], dynamicImports?: key[] } }`.
 */
export function firstLoadFiles(manifest) {
  const entries = Object.keys(manifest).filter((key) => manifest[key].isEntry);
  if (entries.length === 0) throw new Error("the manifest has no entry chunk");
  const seen = new Set();
  const queue = [...entries];
  while (queue.length > 0) {
    const key = queue.shift();
    if (seen.has(key)) continue;
    const chunk = manifest[key];
    if (!chunk) throw new Error(`the manifest names ${key} but has no entry for it`);
    seen.add(key);
    queue.push(...(chunk.imports ?? []));
  }
  return [...seen].map((key) => manifest[key].file);
}

export function firstLoad(distDir) {
  const manifestPath = join(distDir, ".vite", "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`${manifestPath} not found: build the web app with --manifest first`);
  }
  const files = new Map();
  for (const file of firstLoadFiles(JSON.parse(readFileSync(manifestPath, "utf8")))) {
    const path = join(distDir, file);
    if (!existsSync(path))
      throw new Error(`the manifest names ${file}, which the build did not write`);
    const code = readFileSync(path);
    files.set(file, { raw: code.length, gzip: gzipSync(code).length });
  }
  return files;
}

const kB = (bytes) => bytes / 1000;

function main() {
  const files = firstLoad(dist);
  let raw = 0;
  let gzip = 0;
  for (const [file, size] of [...files].sort((a, b) => b[1].gzip - a[1].gzip)) {
    raw += size.raw;
    gzip += size.gzip;
    console.log(
      `  ${file.padEnd(48)} ${kB(size.raw).toFixed(1).padStart(9)} kB  ${kB(size.gzip).toFixed(1).padStart(8)} kB gzipped`,
    );
  }
  const total = kB(gzip);
  console.log(
    `web first load: ${files.size} files, ${kB(raw).toFixed(1)} kB, ${total.toFixed(1)} kB gzipped (budget ${BUDGET_KB} kB)`,
  );
  if (total > BUDGET_KB) {
    console.error(
      `web first load is ${total.toFixed(1)} kB gzipped, over the ${BUDGET_KB} kB budget (scripts/web-size.mjs).`,
    );
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) main();
