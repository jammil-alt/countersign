#!/usr/bin/env node
// Enforces the package layering in docs/plan.md §2:
// 1. a package may import only the @countersign/* packages listed in its package.json;
// 2. inside packages/agents, only src/registry/ and src/log/ may import @countersign/db.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const IMPORT_RE = /(?:from\s+|import\s*\(\s*|import\s+)['"](@countersign\/[a-z-]+)/g;
const AGENTS_DB_ALLOWED = ["packages/agents/src/registry/", "packages/agents/src/log/"];

function* files(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name)) yield p;
  }
}

const pkgDirs = [
  ...readdirSync(join(root, "packages")).map((d) => join("packages", d)),
  ...readdirSync(join(root, "apps")).map((d) => join("apps", d)),
].filter((d) => existsSync(join(root, d, "package.json")));

const errors = [];
for (const dir of pkgDirs) {
  const pkg = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8"));
  const allowed = new Set(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }));
  for (const file of files(join(root, dir))) {
    const rel = relative(root, file);
    const src = readFileSync(file, "utf8");
    for (const [, spec] of src.matchAll(IMPORT_RE)) {
      if (spec === pkg.name) continue;
      if (!allowed.has(spec))
        errors.push(`${rel}: imports ${spec}, not a dependency of ${pkg.name}`);
      if (
        pkg.name === "@countersign/agents" &&
        spec === "@countersign/db" &&
        !AGENTS_DB_ALLOWED.some((p) => rel.startsWith(p))
      ) {
        errors.push(`${rel}: agents may reach the database only through tools (plan §1.2)`);
      }
    }
  }
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`check-deps: ${pkgDirs.length} packages ok`);
