// v0.17 (ARCHITECTURE §10.15, docs/plan.md §1.96): an area owner's settings, kept in its immutable
// versions (`area_owner_version.definition`), and which settings a run uses when a process's own
// definition and its area's owner both have a say.

import { z } from "zod";
import { DecimalString } from "../money";
import {
  NEW_AGENT_OVERSIGHT,
  OVERSIGHT_DEFAULT_MAX_COST_USD,
  OVERSIGHT_DEFAULT_MAX_PER_RUN,
  OversightReview,
  OversightSettings,
} from "../oversight/decision";
import { type Owner, ownerOfBundle } from "../process/owner";
import type { AnyAgentBundle } from "../schemas/agent";
import { holdsProcess } from "../schemas/agent";
import { ModelChoice } from "../schemas/skill";
import type { OwnerArea } from "./areas";

/** The owner's notes: Markdown the operator writes about this client's area. */
export const OWNER_NOTES_MAX = 20_000;
/** Memory notes an owner's review reads, newest first. */
export const OWNER_MEMORY_IN_REVIEW = 20;

/** `area_owner_version.definition`. */
export const OwnerDefinition = z
  .strictObject({
    /**
     * What the owner reasons on: any model packages/llm prices (Anthropic, OpenAI, xAI, Google).
     * Absent: each process's own model, so an owner created for an existing client changes no
     * agent's reviews until the operator picks one.
     */
    // DECISION (O3): no default model. A default (say Sonnet) would move every existing agent's
    // reviews off its own model the moment its area's owner was created.
    model: ModelChoice.optional(),
    /** Markdown the operator writes; trusted text, in the review's instructions. */
    notes: z.string().max(OWNER_NOTES_MAX).default(""),
    /**
     * The area's defaults for processes that saved none. Absent: new-model processes (v4) are
     * reviewed on failures and stored v3 ones stay off, exactly as before (v0.13's DECISION).
     */
    oversight: z
      .strictObject({
        review: OversightReview,
        maxPerRun: z.number().int().min(0).max(10).default(OVERSIGHT_DEFAULT_MAX_PER_RUN),
        maxCostUsd: DecimalString.default(OVERSIGHT_DEFAULT_MAX_COST_USD),
      })
      .optional(),
  })
  .meta({ id: "OwnerDefinition" });
export type OwnerDefinition = z.infer<typeof OwnerDefinition>;
export type OwnerDefinitionInput = z.input<typeof OwnerDefinition>;

/** A new owner's first version: no model of its own yet, no notes, no area defaults. */
export function defaultOwnerDefinition(): OwnerDefinition {
  return OwnerDefinition.parse({});
}

/** The area owner a run is watched by, as pinned at its start. */
export interface PinnedAreaOwner {
  ownerId: string;
  versionId: string;
  name: string;
  area: OwnerArea;
  definition: OwnerDefinition;
}

/** The owner as a run uses it: v0.16's owner of the process, with the area owner's say merged in. */
export interface RunOwner extends Owner {
  /** The area owner, when the process has one. */
  area?: { ownerId: string; versionId: string; name: string; area: OwnerArea; notes: string };
}

/**
 * Which settings a run uses (docs/plan.md §1.96 "Precedence"):
 * - review and limits: the process's saved `definition.oversight`, else the owner's, else the
 *   new-model default (`failures`) for a v4 process, else off (a stored v3 one, as before);
 * - model: the process's saved `oversight.model`, else the owner's model, else the process's.
 * A step's own `review` still applies on top, in the executor.
 */
export function runOwnerOf(
  bundle: Pick<AnyAgentBundle, "definition" | "workflows">,
  owner: PinnedAreaOwner | undefined,
): RunOwner {
  const base = ownerOfBundle(bundle);
  if (!owner) return base;
  const saved = bundle.definition.oversight;
  const model = {
    id: saved?.model?.id ?? owner.definition.model?.id ?? bundle.definition.model.id,
    maxTokens:
      saved?.model?.maxTokens ??
      owner.definition.model?.maxTokens ??
      bundle.definition.model.maxTokens,
  };
  const areaDefaults = owner.definition.oversight;
  const fromOwner = !saved && areaDefaults;
  const fallback = !saved && !areaDefaults && holdsProcess(bundle) ? NEW_AGENT_OVERSIGHT : null;
  const settings: OversightSettings | undefined = saved
    ? OversightSettings.parse({ ...saved, model: saved.model ?? model })
    : fromOwner
      ? OversightSettings.parse({ ...areaDefaults, model })
      : fallback
        ? OversightSettings.parse({ ...fallback, model })
        : undefined;
  const review = settings?.review ?? "off";
  return {
    ...base,
    model,
    review,
    settings,
    maxPerRun: settings?.maxPerRun ?? base.maxPerRun,
    maxCostUsd: settings?.maxCostUsd ?? base.maxCostUsd,
    watch: holdsProcess(bundle) && review !== "off",
    area: {
      ownerId: owner.ownerId,
      versionId: owner.versionId,
      name: owner.name,
      area: owner.area,
      notes: owner.definition.notes,
    },
  };
}
