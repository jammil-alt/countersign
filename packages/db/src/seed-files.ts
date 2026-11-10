// R9 (docs/plan.md §1.86, §9): the seeded version files (packages/db/seed/agents/<slug>.v<n>.json
// and seed/clients/). A file is a whole bundle (every v1, and the later versions written before
// R9), or what changed from an earlier version of the same agent:
//
//   { "extends": 3, "workflows": [ … ] }
//   { "extends": 1, "definition": { "skills": [] } }
//
// The bundle it stands for is the earlier version's with `definition` keys replaced one by one
// (shallow) and `workflows` / `people` replaced whole where the file has them. Pure, so the seed
// (Node) and the back office's install route (the Worker, which bundles the files) read the same
// bundle and the same hash. Worker-safe: no Node imports.
//
// DECISION: later versions name the earlier one instead of repeating it, so a v4 version shows
// only what moved to v4 (its processes) and an unchanged definition (its model among it) is
// visibly the earlier version's, never retyped.

/** A later version file's own fields. */
export interface SeedVersionPatch {
  extends: number;
  definition?: Record<string, unknown>;
  workflows?: unknown[];
  people?: unknown[];
}

const PATCH_KEYS = new Set(["extends", "definition", "workflows", "people"]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Whether a version file names an earlier version rather than holding a whole bundle. */
export function isSeedVersionPatch(raw: unknown): raw is SeedVersionPatch {
  return isObject(raw) && Object.hasOwn(raw, "extends");
}

/**
 * The whole bundle a seeded version stands for, from the agent's version files by number. Throws
 * when a version is missing, extends itself or a later one, or a patch has an unknown key. The
 * result is plain JSON for the caller to validate (and hash).
 */
export function seedVersionBundle(
  files: Readonly<Record<number, unknown>>,
  version: number,
  what = "seed",
): unknown {
  const raw = Object.hasOwn(files, version) ? files[version] : undefined;
  if (raw === undefined) throw new Error(`${what}: no version ${version}`);
  if (!isSeedVersionPatch(raw)) return raw;
  for (const key of Object.keys(raw)) {
    if (!PATCH_KEYS.has(key)) throw new Error(`${what} v${version}: unknown key "${key}"`);
  }
  const from = raw.extends;
  if (!Number.isInteger(from) || from < 1 || from >= version) {
    throw new Error(`${what} v${version}: extends must name an earlier version`);
  }
  const base = seedVersionBundle(files, from, what);
  if (!isObject(base) || !isObject(base.definition)) {
    throw new Error(`${what} v${from}: not a bundle`);
  }
  if (raw.definition !== undefined && !isObject(raw.definition)) {
    throw new Error(`${what} v${version}: definition must be an object`);
  }
  return {
    ...base,
    definition: { ...base.definition, ...(raw.definition ?? {}) },
    ...(raw.workflows !== undefined ? { workflows: raw.workflows } : {}),
    ...(raw.people !== undefined ? { people: raw.people } : {}),
  };
}
