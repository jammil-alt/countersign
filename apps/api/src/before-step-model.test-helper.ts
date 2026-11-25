// ONE-OFF (step model, docs/step-model-plan.md §13b): installs a platform agent's version as seeded
// before the step model (v3 workflows, v4 processes), by the back office's own install rules
// (`installPlatformTemplate`), for the tests that run those versions until the executor runs v5.
// Wave 4 deletes it with `fixtures/platform-agents-v4`.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { withOperator } from "@countersign/db";
import { SEED_DIR_BEFORE_STEP_MODEL } from "@countersign/db/seed";
import { installPlatformTemplate, type SeededFiles } from "./account/templates";
import type { ApiHarness } from "./api.test-helper";
import { HttpError } from "./http";

function filesBefore(): SeededFiles {
  const out: Record<string, Record<number, unknown>> = {};
  for (const file of readdirSync(SEED_DIR_BEFORE_STEP_MODEL)) {
    const m = /^([a-z0-9-]+)\.v(\d{1,4})\.json$/.exec(file);
    if (!m?.[1] || !m[2]) continue;
    const versions = out[m[1]] ?? {};
    versions[Number(m[2])] = JSON.parse(
      readFileSync(join(SEED_DIR_BEFORE_STEP_MODEL, file), "utf8"),
    );
    out[m[1]] = versions;
  }
  return out;
}

const FILES = filesBefore();

/** The install route's answer for a version as seeded before the step model: status and body. */
export async function installBeforeStepModel(
  H: ApiHarness,
  slug: string,
  version: number,
): Promise<{ status: number; json: unknown }> {
  try {
    const json = await withOperator(H.db, [], (tx) =>
      installPlatformTemplate(tx, { slug, version, actorId: null, platform: H.platform }, FILES),
    );
    return { status: 200, json };
  } catch (e) {
    if (e instanceof HttpError) {
      return { status: e.status, json: { error: { code: e.code, message: e.message } } };
    }
    throw e;
  }
}
