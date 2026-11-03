// Node-only: the file-backed fixture store for tests and `LLM_MODE=record` scripts. Never import
// this from code that runs in the Worker; it uses node:fs.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FixtureStore, RecordedCall } from "./record";

/** `<repo>/fixtures/llm`. */
export const DEFAULT_FIXTURE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/llm",
);

const HASH_RE = /^[0-9a-f]{64}$/;

/** One `<hash>.json` per recorded call. */
export function fileFixtureStore(dir: string = DEFAULT_FIXTURE_DIR): FixtureStore {
  const pathOf = (hash: string) => {
    if (!HASH_RE.test(hash)) throw new Error(`not a request hash: ${hash}`);
    return join(dir, `${hash}.json`);
  };
  return {
    async read(hash) {
      try {
        return JSON.parse(await readFile(pathOf(hash), "utf8")) as RecordedCall;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async write(call) {
      await mkdir(dir, { recursive: true });
      const path = pathOf(call.hash);
      // Written whole, then renamed, so a crash never leaves half a fixture for replay to trip on.
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify(call, null, 2)}\n`, "utf8");
      await rename(tmp, path);
    },
  };
}
