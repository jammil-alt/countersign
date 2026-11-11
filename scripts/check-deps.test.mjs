// Tests for scripts/check-deps.mjs: builds small workspace trees in a temporary directory and runs
// the check on each. Run by `pnpm lint:deps` (node --test).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const script = new URL("./check-deps.mjs", import.meta.url).pathname;

function tree(files) {
  const dir = mkdtempSync(join(tmpdir(), "check-deps-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, typeof content === "string" ? content : JSON.stringify(content));
  }
  return dir;
}

function check(files) {
  const dir = tree(files);
  try {
    const r = spawnSync(process.execPath, [script, dir], { encoding: "utf8" });
    return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const core = { "packages/core/package.json": { name: "@countersign/core" } };
const db = { "packages/db/package.json": { name: "@countersign/db" } };
const mfa = (deps, src = 'import { z } from "@countersign/core";\n') => ({
  "apps/mfa/package.json": { name: "@countersign/mfa", dependencies: deps },
  "apps/mfa/src/index.ts": src,
});

test("apps/mfa may depend on core", () => {
  const r = check({ ...core, ...mfa({ "@countersign/core": "workspace:*", hono: "^4" }) });
  assert.equal(r.ok, true, r.out);
});

test("apps/mfa may not depend on any other workspace package", () => {
  const r = check({
    ...core,
    ...db,
    ...mfa(
      { "@countersign/core": "workspace:*", "@countersign/db": "workspace:*" },
      'import { withTenant } from "@countersign/db";\n',
    ),
  });
  assert.equal(r.ok, false);
  assert.match(r.out, /apps\/mfa\/package.json: may depend only on @countersign\/core/);
});

test("apps/mfa may not import a package it does not list", () => {
  const r = check({
    ...core,
    ...db,
    ...mfa({ "@countersign/core": "workspace:*" }, 'import { x } from "@countersign/db";\n'),
  });
  assert.equal(r.ok, false);
  assert.match(r.out, /imports @countersign\/db, not a dependency/);
});

test("apps/mfa may not take a database or storage client", () => {
  const r = check({ ...core, ...mfa({ "@countersign/core": "workspace:*", postgres: "^3" }) });
  assert.equal(r.ok, false);
  assert.match(r.out, /postgres is not an allowed runtime dependency/);
});

test("nothing may depend on apps/mfa", () => {
  const r = check({
    ...core,
    ...mfa({ "@countersign/core": "workspace:*" }),
    "apps/api/package.json": {
      name: "@countersign/api",
      dependencies: { "@countersign/mfa": "workspace:*" },
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.out, /reached only by service binding/);
});

const designSystem = {
  "packages/design-system/package.json": { name: "@countersign/design-system" },
};
const site = (devDependencies, extra = {}) => ({
  "apps/site/package.json": { name: "@countersign/site", devDependencies, ...extra },
  "apps/site/build.mjs": "// builds the site\n",
});

test("apps/site may use the design system's files", () => {
  const r = check({
    ...designSystem,
    ...site({ "@countersign/design-system": "workspace:*", vitest: "^5" }),
  });
  assert.equal(r.ok, true, r.out);
});

test("apps/site may not depend on the platform", () => {
  const r = check({
    ...core,
    ...designSystem,
    ...site({ "@countersign/design-system": "workspace:*", "@countersign/core": "workspace:*" }),
  });
  assert.equal(r.ok, false);
  assert.match(r.out, /apps\/site\/package.json: may depend only on @countersign\/design-system/);
});

test("apps/site has no runtime dependencies", () => {
  const r = check({
    ...designSystem,
    ...site({ "@countersign/design-system": "workspace:*" }, { dependencies: { react: "^19" } }),
  });
  assert.equal(r.ok, false);
  assert.match(r.out, /react is not an allowed runtime dependency/);
});

test("nothing may depend on apps/site", () => {
  const r = check({
    ...designSystem,
    ...site({ "@countersign/design-system": "workspace:*" }),
    "apps/web/package.json": {
      name: "@countersign/web",
      dependencies: { "@countersign/site": "workspace:*" },
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.out, /the public site, not a library/);
});

const connectors = { "packages/connectors/package.json": { name: "@countersign/connectors" } };
const browserApp = (src, extra = {}) => ({
  "apps/browser/package.json": {
    name: "@countersign/browser",
    dependencies: { "@cloudflare/playwright": "1.3.6", zod: "^4" },
    devDependencies: {
      "@countersign/connectors": "workspace:*",
      "@countersign/core": "workspace:*",
    },
    ...extra,
  },
  "apps/browser/src/service.ts": src,
});

test("apps/browser may take connectors' types", () => {
  const r = check({
    ...core,
    ...connectors,
    ...browserApp('import type { BrowserTab } from "@countersign/connectors";\n'),
    "apps/browser/src/chromium.test.ts": 'import { signIn } from "@countersign/connectors";\n',
  });
  assert.equal(r.ok, true, r.out);
});

test("apps/browser's code may not import the platform as values", () => {
  const r = check({
    ...core,
    ...connectors,
    ...browserApp('import { remoteBrowserTab } from "@countersign/connectors";\n'),
  });
  assert.equal(r.ok, false);
  assert.match(r.out, /imports @countersign\/connectors as a value/);
});

test("apps/browser may not take a database client or another workspace package", () => {
  const r = check({
    ...core,
    ...connectors,
    ...db,
    ...browserApp('import type { BrowserTab } from "@countersign/connectors";\n', {
      dependencies: { "@cloudflare/playwright": "1.3.6", postgres: "^3" },
      devDependencies: { "@countersign/db": "workspace:*" },
    }),
  });
  assert.equal(r.ok, false);
  assert.match(r.out, /postgres is not an allowed runtime dependency/);
  assert.match(r.out, /apps\/browser\/package.json: may depend only on/);
});

test("nothing may depend on apps/browser", () => {
  const r = check({
    ...core,
    ...connectors,
    ...browserApp('import type { BrowserTab } from "@countersign/connectors";\n'),
    "apps/api/package.json": {
      name: "@countersign/api",
      dependencies: { "@countersign/browser": "workspace:*" },
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.out, /depends on @countersign\/browser, which is reached only by service binding/);
});
