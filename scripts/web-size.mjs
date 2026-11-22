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
// DECISION (owner, 2026-11-17): raised to 480 kB. main had reached 469.7 kB, and the pre-launch
// write-path fix adds two approval reasons in all six languages (every language's Desk wording
// ships in the first load). Loading each language's wording on demand is the follow-up that
// brings it back down.
// DECISION (owner, 2026-11-17): raised to 490 kB for onboarding v1 (docs/plan.md §1.146, §1.149).
// main was at 478.8 kB and onboarding at 483.5 kB after its routes left the registry. Each screen
// loading only the routes it uses (audit item 4.6) is the follow-up that brings it back down.
// DECISION (2026-11-20): raised to 495 kB for the platform QA fixes (PLATFORM_QA.md, the Desk
// edit form, Getting started and the Desk's error states, with their wording in six languages).
// main was at 489.4 kB and these fixes add 2.5 kB to the first load. The same follow-ups as above
// (each language's wording on demand, screens loading only their routes) bring it back down.
// DECISION (2026-11-22): lowered to 351 kB (H9, docs/plan.md §1.192). The client portal is its
// own chunk, started beside the session call at a portal address as the back office's is at /ops,
// so the first load no longer carries its screens or core's wording in six languages. main was at
// 494.8 kB; this measured 344.1 kB, plus 2%. Each portal screen loading on its own and the route
// contract split per screen (audit item 4.6) are the follow-ups toward phase 4's 300 kB.
// DECISION (2026-11-22): raised to 352 kB for R2 (docs/plan.md §1.193): its English wording and
// core's `about` filter add 0.5 kB to the first load. main was at 350.8 kB after the staging
// walk-through (#523), so the 2% headroom H9 left is used up; the follow-ups above are what bring
// it back down, and the next first-load feature should come with one of them.
// DECISION (2026-11-22): lowered to 335 kB (docs/plan.md §1.208). English's wording loads on
// demand like the other five languages (only the session's language is fetched, and the back
// office's English with its chunk), so the first load measured 301.9 kB, down from 351.4 kB. 335 kB
// leaves 33 kB of room, as round 4 asked (30 kB or more); phase 4's 300 kB is still the target.
export const BUDGET_KB = 335;

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
