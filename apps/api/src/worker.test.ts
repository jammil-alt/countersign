// The deployed entry point must export every class wrangler.jsonc binds (Workflows, Durable
// Objects), or `wrangler deploy` refuses the Worker. Tests import ./index, and worker.ts needs the
// Workers runtime to load, so this reads its source.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const wrangler = read("../wrangler.jsonc");
const entry = read("./worker.ts");
const classNames = [
  ...new Set([...wrangler.matchAll(/"class_name"\s*:\s*"([^"]+)"/g)].map((m) => m[1] as string)),
];

describe("worker entry point", () => {
  it("is wrangler's main", () => {
    expect(wrangler).toMatch(/"main"\s*:\s*"src\/worker\.ts"/);
  });

  it.each(classNames)("exports %s", (name) => {
    expect(entry).toMatch(new RegExp(`export (const|class) ${name}\\b`));
  });
});
