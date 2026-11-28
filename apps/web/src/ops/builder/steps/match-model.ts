// A Match step's settings as the form changes them (docs/step-model-plan.md §7). Pure.

import { steps } from "@countersign/core";
import type { MatchProfile, MatchSettings } from "./types";

export const MATCH_TYPE_WORDS: Record<MatchSettings["type"], string> = {
  exact: "Exact match",
  semantic: "Semantic match",
  hybrid: "Hybrid: exact first, then semantic",
};

/** Fresh settings for a profile: its first allowed type, the schema's defaults for the rest. */
export function settingsFor(profile: MatchProfile): MatchSettings {
  return steps.MatchSettings.parse({ to: profile.id, type: profile.types[0] ?? "exact" });
}

/** Moving to another profile: the keys are the old profile's, so they reset; the type is clamped. */
export function changeProfile(current: MatchSettings, profile: MatchProfile): MatchSettings {
  const { keys: _keys, ...rest } = current;
  const type = profile.types.includes(current.type) ? current.type : (profile.types[0] ?? "exact");
  return { ...rest, to: profile.id, type };
}

/** Moving to exact drops what only a semantic match uses. */
export function changeType(current: MatchSettings, type: MatchSettings["type"]): MatchSettings {
  if (type !== "exact") return { ...current, type };
  const { secondOpinion: _s, searchFloor: _f, ...rest } = current;
  return { ...rest, type };
}

export function moveKey(keys: readonly string[], from: number, by: -1 | 1): string[] {
  const to = from + by;
  if (to < 0 || to >= keys.length) return [...keys];
  const out = [...keys];
  const [k] = out.splice(from, 1);
  if (k !== undefined) out.splice(to, 0, k);
  return out;
}

/** A whole percent from 1 to 100, or undefined. */
export function percent(text: string): number | undefined {
  if (!/^\d{1,3}$/.test(text.trim())) return undefined;
  const n = Number(text);
  return n >= 1 && n <= 100 ? n : undefined;
}
