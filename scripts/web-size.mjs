// The web app's first load, gzipped, against a budget (docs/audit-plan.md 9.6). Run after
// `pnpm --filter @countersign/web build`; checks.yml runs it on every pull request and deploy.
//
// The first load is every script a fresh visit fetches before any lazy screen: the scripts and
// module preloads in apps/web/dist/index.html and, followed through their static imports, every
// chunk they need. Lazy chunks (`import()`) and CSS are left out. Measured this way rather than by
// chunk name, so splitting or renaming chunks (phase 4) can't hide growth.
//
//   node scripts/web-size.mjs [dist]    exits 1 when the first load is over the budget

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

// DECISION: the budget is today's first load plus 2% (613 kB on 2026-11-11, measured as above at
// 601 kB), so it stops growth now. It is lowered to phase 4's target, 300 kB, once phase 4 lands.
// The one place it is set.
export const BUDGET_KB = 613;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = process.argv[2] ?? join(root, "apps/web/dist");

/** `src`/`href` of the scripts and module preloads in index.html, as files under dist. */
function entries(html) {
  const found = [];
  for (const tag of html.match(/<(script|link)\b[^>]*>/g) ?? []) {
    const isScript = tag.startsWith("<script") && /type=["']module["']/.test(tag);
    const isPreload = tag.startsWith("<link") && /rel=["']modulepreload["']/.test(tag);
    if (!isScript && !isPreload) continue;
    const url = tag.match(/\b(?:src|href)=["']([^"']+)["']/)?.[1];
    if (url && url.startsWith("/") && !url.startsWith("//")) found.push(normalize(url.slice(1)));
  }
  return found;
}

/** Relative static imports and re-exports (`import … from "./x.js"`, `import "./x.js"`), not `import()`. */
function staticImports(code) {
  const found = [];
  const pattern = /\b(?:import|export)\s*(?:[\w$*{},\s]*?\s*from\s*)?["'](\.{1,2}\/[^"']+\.js)["']/g;
  for (const m of code.matchAll(pattern)) found.push(m[1]);
  return found;
}

export function firstLoad(distDir) {
  const index = join(distDir, "index.html");
  if (!existsSync(index)) throw new Error(`${index} not found: build the web app first`);
  const files = new Map();
  const queue = entries(readFileSync(index, "utf8"));
  if (queue.length === 0) throw new Error("index.html loads no module script");
  while (queue.length > 0) {
    const file = queue.shift();
    if (files.has(file)) continue;
    const path = join(distDir, file);
    if (!existsSync(path)) throw new Error(`index.html needs ${file}, which the build did not write`);
    const code = readFileSync(path);
    files.set(file, { raw: code.length, gzip: gzipSync(code).length });
    for (const spec of staticImports(code.toString("utf8"))) {
      queue.push(relative(distDir, join(dirname(path), spec)));
    }
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
    console.log(`  ${file.padEnd(48)} ${kB(size.raw).toFixed(1).padStart(9)} kB  ${kB(size.gzip).toFixed(1).padStart(8)} kB gzipped`);
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
