// Skill model (2026-11-10): every tool whose code calls a model declares it (`ToolSpec.usesModel`),
// so a skill over it is labelled AI, never deterministic. Two checks, no database:
//   1. the source scan: the files of the platform's, the packs' and the connectors' tools that
//      reach a model are exactly the ones inventoried here (a new one fails until it is listed);
//   2. the inventoried tools declare `usesModel`, and nothing else does (no stale declaration).
// At run time the runtime's `onUndeclaredModelCall` catches the rest: the test harnesses throw.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createPlatform, deploymentConnectors } from "./platform";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const SCANNED = ["packages/agents/src/tools", "packages/connectors/src", "packs"];

/** What reaches a model from a tool's code: a model client, or the step's model-call recorders. */
const MODEL_CALL =
  /\bllm\.callTool\(|\bcreateLlmClient\(|recordModelCall\?\.\(|recordUsage\?\.\(|\bctx\.llm\b|\bdeps\.llm\b|\bctx\.recordModelCall\b|\bctx\.recordUsage\b/;

/**
 * Each file of tool code that reaches a model, and the tools in it that do. `comms.converse` is
 * declared without code here: its turns are written by the runtime's conversation engine.
 */
const INVENTORY: Record<string, readonly string[]> = {
  "packages/agents/src/tools/docs.ts": ["docs.extract", "docs.read"],
  "packages/agents/src/tools/translate.ts": ["comms.translate"],
  "packages/agents/src/tools/web.ts": ["web.search", "web.fetch"],
  "packs/materials/src/catalog/match.ts": ["materials.match_line", "materials.match_lines"],
  "packs/materials/src/catalog/model.ts": ["materials.catalog.create_item", "materials.match_line"],
  "packs/materials/src/tools.ts": [
    "materials.catalog.create_item",
    "materials.match_line",
    "materials.match_lines",
  ],
};
const DECLARED_WITHOUT_CODE = ["comms.converse"];

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...files(path));
    else if (/\.ts$/.test(name) && !/\.test\.ts$|test-helper\.ts$|\.d\.ts$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

describe("tools that call a model declare it", () => {
  it("finds model calls only in the inventoried files", () => {
    const found = SCANNED.flatMap((d) => files(resolve(ROOT, d)))
      .filter((f) => MODEL_CALL.test(readFileSync(f, "utf8")))
      .map((f) => relative(ROOT, f))
      .sort();
    expect(found).toEqual(Object.keys(INVENTORY).sort());
  });

  it("every inventoried tool declares usesModel, and no other tool does", () => {
    const platform = createPlatform({ connectors: deploymentConnectors({}, false) });
    const declared = platform.tools
      .list()
      .filter((t) => t.spec.usesModel !== undefined)
      .map((t) => t.spec.id)
      .sort();
    const expected = [...new Set([...Object.values(INVENTORY).flat(), ...DECLARED_WITHOUT_CODE])];
    expect(declared).toEqual(expected.sort());
  });
});
