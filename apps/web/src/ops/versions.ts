import { AgentBundle } from "@countersign/core";
import type { AgentSummary, VersionDetail, VersionSummary } from "../api/routes";
import type { Tone } from "../ui/primitives";

export interface VersionBadge {
  label: string;
  tone: Tone;
}

/**
 * The live/draft badges (design screens 5 and 7): "LIVE · V4" when a version is live, plus
 * "DRAFT · V5" when a newer draft waits; "DRAFT · V1" before the first publish.
 */
export function versionBadges(
  live: Pick<VersionSummary, "version"> | null,
  draft: Pick<VersionSummary, "version"> | null,
): VersionBadge[] {
  const out: VersionBadge[] = [];
  if (live) out.push({ label: `Live · v${live.version}`, tone: "positive" });
  if (draft) out.push({ label: `Draft · v${draft.version}`, tone: "neutral" });
  if (out.length === 0) out.push({ label: "No versions", tone: "warning" });
  return out;
}

/** A list row knows only whether a version is live, not its number. */
export function summaryBadge(agent: Pick<AgentSummary, "liveVersionId">): VersionBadge {
  return agent.liveVersionId
    ? { label: "Live", tone: "positive" }
    : { label: "Draft", tone: "neutral" };
}

/** The live version and the newest draft after it. */
export function liveAndDraft(
  agent: Pick<AgentSummary, "liveVersionId">,
  versions: readonly VersionSummary[],
): { live: VersionSummary | null; draft: VersionSummary | null } {
  const live = versions.find((v) => v.id === agent.liveVersionId) ?? null;
  const draft =
    [...versions]
      .sort((a, b) => b.version - a.version)
      .find((v) => v.status === "draft" && v.version > (live?.version ?? 0)) ?? null;
  return { live, draft };
}

export type ParsedBundle = { ok: true; bundle: AgentBundle } | { ok: false; message: string };

/**
 * The API sends a version's bundle as stored; the screens check it against core's schema before
 * reading it, so a bundle the app does not understand says so instead of half-rendering.
 */
export function parseBundle(version: Pick<VersionDetail, "bundle">): ParsedBundle {
  const parsed = AgentBundle.safeParse(version.bundle);
  if (parsed.success) return { ok: true, bundle: parsed.data };
  const first = parsed.error.issues[0];
  return {
    ok: false,
    message: `This bundle does not match the agent bundle schema${
      first ? ` (${first.path.join(".") || "root"}: ${first.message})` : ""
    }.`,
  };
}
