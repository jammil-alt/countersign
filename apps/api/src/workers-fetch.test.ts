// Cloudflare Workers accept only `redirect: "follow"` or `"manual"`; `new Request(…, { redirect:
// "error" })` throws there ("won't be implemented since it does not make sense at the edge"), while
// Node, where the tests run, accepts it. So every outbound call failed on staging and passed here
// (QuickBooks sign-in, 2026-11-05). Calls use "manual": a redirect is never followed and comes back
// as a 3xx, which each caller treats as a failure like any other non-2xx answer.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../../../", import.meta.url).pathname;
const SCANNED = ["packages", "apps", "packs"];

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

describe("outbound fetch in Workers", () => {
  it('never asks for redirect: "error"', () => {
    const offenders = SCANNED.flatMap((d) => sources(join(ROOT, d)))
      .filter((f) => /redirect\s*:\s*["']error["']/.test(readFileSync(f, "utf8")))
      .map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });
});
